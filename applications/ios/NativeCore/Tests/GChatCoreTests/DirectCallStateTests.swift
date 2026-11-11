import XCTest
@testable import GChatCore

final class DirectCallStateTests: XCTestCase {
    private let id = UUID()
    private let caller = UUID()
    private let recipient = UUID()

    private func record(_ state: String = "ringing", version: Int = 0, callID: UUID? = nil,
                        recovery: UUID? = nil) throws -> DirectCallRecord {
        let date = "2026-11-07T20:00:00.000Z"
        let value: [String: Any] = [
            "call_id": (callID ?? id).uuidString, "state": state,
            "caller_id": caller.uuidString, "recipient_id": recipient.uuidString,
            "created_at": date, "started_at": state == "active" || state == "ended" ? date as Any : NSNull(),
            "ended_at": state == "ended" ? date as Any : NSNull(),
            "end_reason": state == "ended" ? "hangup" as Any : NSNull(),
            "recovery_id": recovery?.uuidString as Any? ?? NSNull(),
            "recovery_deadline": recovery == nil ? NSNull() : date as Any,
            "ringing_deadline": state == "ringing" ? date as Any : NSNull(),
            "connecting_deadline": state == "connecting" ? date as Any : NSNull(), "version": version
        ]
        return try JSONDecoder().decode(DirectCallRecord.self, from: JSONSerialization.data(withJSONObject: value))
    }

    private func ping(_ state: String, version: Int, recovery: UUID? = nil) throws -> DirectCallPing {
        let value: [String: Any] = ["state": state, "version": version,
            "recovery_id": recovery?.uuidString as Any? ?? NSNull(),
            "recovery_deadline": recovery == nil ? NSNull() : "2026-11-07T20:00:00.000Z" as Any]
        return try JSONDecoder().decode(DirectCallPing.self, from: JSONSerialization.data(withJSONObject: value))
    }

    func testDelayedRingingCannotResurrectEndedCall() throws {
        var state = DirectCallProjection()
        state.applyCurrent(try record("active", version: 3))
        state.applyUpdate(try record("ended", version: 4))
        XCTAssertEqual(state.applyUpdate(try record(version: 1)), .ignored)
        XCTAssertEqual(state.applyUpdate(try record("active", version: 5)), .ignored)
        XCTAssertEqual(state.phase, .ended)
    }

    func testCompactPingBlocksOlderDTOAndAcceptsFullDTOAtSameVersion() throws {
        var state = DirectCallProjection()
        let recovery = UUID()
        state.applyCurrent(try record("active", version: 3))
        state.applyPing(try ping("active", version: 5, recovery: recovery), callID: id)
        XCTAssertEqual(state.applyUpdate(try record("active", version: 4)), .ignored)
        XCTAssertEqual(state.recoveryID, recovery)
        XCTAssertTrue(state.needsFullSnapshot)
        XCTAssertEqual(state.applyUpdate(try record("active", version: 5)), .ignored)
        XCTAssertEqual(state.applyUpdate(try record("active", version: 5, recovery: recovery)), .applied)
        XCTAssertFalse(state.needsFullSnapshot)
    }

    func testRecoveryClearingDoesNotReusePreviousWindow() throws {
        var state = DirectCallProjection()
        let recovery = UUID()
        state.applyCurrent(try record("active", version: 3, recovery: recovery))
        state.applyPing(try ping("active", version: 4), callID: id)
        XCTAssertNil(state.recoveryID)
        XCTAssertEqual(state.applyPing(try ping("active", version: 3, recovery: recovery), callID: id), .ignored)
        XCTAssertNil(state.recoveryID)
    }

    func testDifferentUpdatedCallRequiresServerReconciliation() throws {
        var state = DirectCallProjection()
        state.applyCurrent(try record())
        let other = try record(callID: UUID())
        XCTAssertEqual(state.applyUpdate(other), .requiresCurrent)
        XCTAssertEqual(state.call?.call_id, id)
        state.applyCurrent(other)
        XCTAssertEqual(state.applyCurrent(try record()), .ignored)
        XCTAssertEqual(state.applyPing(try ping("ended", version: 9), callID: id), .ignored)
    }

    func testDuplicateFullDTOIsNotAppliedAndCurrentNullRetiresCall() throws {
        var state = DirectCallProjection()
        state.applyCurrent(try record())
        XCTAssertEqual(state.applyUpdate(try record()), .ignored)
        state.applyCurrent(nil)
        XCTAssertNil(state.call)
        XCTAssertEqual(state.applyUpdate(try record()), .ignored)
    }

    func testHeartbeatRemainsMonotonicAcrossRecoveryChanges() throws {
        var heartbeat = try DirectCallHeartbeat(callID: id)
        let first = try heartbeat.next(audioConnected: false, recoveryID: nil)
        let next = try heartbeat.next(audioConnected: true, recoveryID: UUID())
        XCTAssertEqual(first["sequence"] as? Int64, 1)
        XCTAssertEqual(next["sequence"] as? Int64, 2)
        XCTAssertTrue(first["recovery_id"] is NSNull)
        XCTAssertEqual(next["audio_connected"] as? Bool, true)
        var restored = try DirectCallHeartbeat(callID: id, restoredSequence: heartbeat.sequence)
        XCTAssertEqual(try restored.next(audioConnected: true, recoveryID: nil)["sequence"] as? Int64, 3)
    }

    func testBridgeDTOContainsOnlyFullSafeServerFieldsAndExplicitNulls() throws {
        let expected: Set<String> = ["call_id", "state", "caller_id", "recipient_id", "created_at", "started_at",
            "ended_at", "end_reason", "recovery_id", "recovery_deadline", "ringing_deadline", "connecting_deadline", "version"]
        for phase in ["ringing", "active", "ended"] {
            let call = try record(phase, version: 3)
            let value = call.bridgeObject
            XCTAssertEqual(Set(value.keys), expected)
            XCTAssertTrue(value["recovery_id"] is NSNull)
            XCTAssertTrue(value["recovery_deadline"] is NSNull)
            XCTAssertEqual(value["call_id"] as? String, call.call_id.uuidString.lowercased())
            let roundTrip = try JSONDecoder().decode(DirectCallRecord.self,
                from: JSONSerialization.data(withJSONObject: value))
            XCTAssertEqual(roundTrip, call)
        }
        let recovery = try record("active", version: 4, recovery: UUID())
        XCTAssertEqual(try JSONDecoder().decode(DirectCallRecord.self,
            from: JSONSerialization.data(withJSONObject: recovery.bridgeObject)), recovery)
    }

    func testMalformedServerDataAndInvalidSequenceAreRejected() throws {
        XCTAssertThrowsError(try record(version: -1))
        XCTAssertThrowsError(try record("unknown"))
        let missing = Data("{\"state\":\"active\",\"version\":1,\"recovery_id\":null}".utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(DirectCallPing.self, from: missing))
        XCTAssertThrowsError(try DirectCallHeartbeat(callID: id, restoredSequence: -1))
        var exhausted = try DirectCallHeartbeat(callID: id, restoredSequence: 9_007_199_254_740_991)
        XCTAssertThrowsError(try exhausted.next(audioConnected: true, recoveryID: nil))
    }
}
