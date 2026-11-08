import XCTest
@testable import GChatCore

@MainActor final class DirectCallControllerTests: XCTestCase {
    final class Media: DirectCallMedia {
        var onCandidate: ((DirectIceCandidate?) -> Void)?
        var onConnection: ((Bool) -> Void)?
        var connected = false
        var configured = 0
        func configure(servers: [DirectIceServer]) async throws { configured += 1 }
        func offer(restart: Bool) async throws -> String { "test offer" }
        func answer(offer: String) async throws -> String { "test answer" }
        func applyAnswer(_ sdp: String) async throws {}
        func addCandidate(_ candidate: DirectIceCandidate) async throws {}
        func setMuted(_ value: Bool) {}
        func close() { connected = false }
    }

    final class Server {
        let account = UUID()
        let peer = UUID()
        let callID = UUID()
        var commands: [(String, [String: Any])] = []
        var current: String? = "connecting"
        var version = 0
        var unknownCreate = false

        func call() -> [String: Any] {
            let phase = current ?? "ended"
            let time = "2026-11-07T20:00:00.000Z"
            return ["call_id": callID.uuidString, "caller_id": account.uuidString,
                    "recipient_id": peer.uuidString, "state": phase, "created_at": time,
                    "started_at": phase == "active" ? time as Any : NSNull(),
                    "ended_at": phase == "ended" ? time as Any : NSNull(),
                    "end_reason": phase == "ended" ? "hangup" as Any : NSNull(),
                    "ringing_deadline": phase == "ringing" ? time as Any : NSNull(),
                    "connecting_deadline": phase == "connecting" ? time as Any : NSNull(),
                    "recovery_id": NSNull(), "recovery_deadline": NSNull(), "version": version]
        }

        func request(_ type: String, _ payload: [String: Any]) async throws -> [String: Any] {
            commands.append((type, payload))
            switch type {
            case "call.current": return ["call": current == nil ? NSNull() : call() as Any]
            case "call.create":
                if unknownCreate { throw NativeError.network }
                current = "ringing"; return ["call": call()]
            case "call.ice_config":
                return ["ice_servers": [["urls": ["turn:turn.example:3478"], "username": "fixture", "credential": "fixture"]]]
            case "call.connected": current = "active"; version += 1; return ["call": call()]
            case "call.ping": return ["state": current ?? "ended", "version": version, "recovery_id": NSNull(), "recovery_deadline": NSNull()]
            default: return [:]
            }
        }
    }

    func testConnectedRequiresActualMediaAndMatchingAnswer() async throws {
        let server = Server()
        let media = Media()
        let controller = DirectCallController(accountID: server.account, request: server.request,
            media: media, readSequence: { _ in 0 }, saveSequence: { _, _ in })
        controller.connectionChanged("online")
        await controller.waitForIdle()
        XCTAssertFalse(server.commands.contains { $0.0 == "call.connected" })
        let offer = try XCTUnwrap(server.commands.first { $0.0 == "rtc.offer" }?.1)
        let negotiation = try XCTUnwrap(offer["negotiation_id"] as? String)
        controller.receive(["type": "rtc.answer", "payload": ["call_id": server.callID.uuidString,
            "negotiation_id": UUID().uuidString, "sdp": "stale answer"]])
        await controller.waitForIdle()
        media.connected = true
        media.onConnection?(true)
        await controller.waitForIdle()
        XCTAssertFalse(server.commands.contains { $0.0 == "call.connected" })
        controller.receive(["type": "rtc.answer", "payload": ["call_id": server.callID.uuidString,
            "negotiation_id": negotiation, "sdp": "answer"]])
        await controller.waitForIdle()
        media.onConnection?(true)
        await controller.waitForIdle()
        XCTAssertEqual(server.commands.filter { $0.0 == "call.connected" }.count, 1)
        XCTAssertEqual(controller.state.phase, .active)
        controller.invalidate()
    }

    func testUnknownCreateReconcilesWithoutRetry() async throws {
        let server = Server(); server.current = nil; server.unknownCreate = true
        let controller = DirectCallController(accountID: server.account, request: server.request,
            media: Media(), readSequence: { _ in 0 }, saveSequence: { _, _ in })
        controller.connectionChanged("online")
        await controller.waitForIdle()
        do { try await controller.placeCall(peerID: server.peer); XCTFail("Must report unknown outcome") }
        catch { XCTAssertEqual(error as? NativeError, .network) }
        XCTAssertEqual(server.commands.filter { $0.0 == "call.create" }.count, 1)
        XCTAssertEqual(server.commands.filter { $0.0 == "call.current" }.count, 2)
        XCTAssertNil(controller.state.call)
        controller.invalidate()
    }

    func testForegroundRefreshFindsIncomingWithoutAnotherOnlineTransition() async {
        let server = Server(); server.current = nil
        let controller = DirectCallController(accountID: server.peer, request: server.request,
            media: Media(), readSequence: { _ in 0 }, saveSequence: { _, _ in })
        controller.connectionChanged("online")
        await controller.waitForIdle()
        XCTAssertNil(controller.state.call)
        server.current = "ringing"
        controller.refreshCurrent()
        await controller.waitForIdle()
        XCTAssertEqual(controller.state.call?.call_id, server.callID)
        XCTAssertEqual(controller.state.phase, .ringing)
        XCTAssertFalse(server.commands.contains { $0.0 == "call.accept" })
        controller.invalidate()
    }

    func testFailedSequencePersistencePreventsPingSend() async throws {
        let server = Server()
        let controller = DirectCallController(accountID: server.account, request: server.request,
            media: Media(), readSequence: { _ in 40 }, saveSequence: { _, _ in throw NativeError.unavailable })
        controller.connectionChanged("online")
        await controller.waitForIdle()
        await Task.yield()
        XCTAssertFalse(server.commands.contains { $0.0 == "call.ping" })
        controller.invalidate()
    }

    func testInvalidationDropsLateCurrentResponse() async throws {
        let server = Server()
        let media = Media()
        var pending: CheckedContinuation<[String: Any], Error>?
        let controller = DirectCallController(accountID: server.account, request: { _, _ in
            try await withCheckedThrowingContinuation { pending = $0 }
        }, media: media, readSequence: { _ in 0 }, saveSequence: { _, _ in })
        controller.connectionChanged("online")
        while pending == nil { await Task.yield() }
        controller.invalidate()
        pending?.resume(returning: ["call": server.call()])
        await Task.yield()
        XCTAssertNil(controller.state.call)
        XCTAssertEqual(media.configured, 0)
    }

    func testLateEmptyCurrentCannotEraseSuccessfulCreate() async throws {
        let server = Server(); server.current = nil
        var pending: CheckedContinuation<[String: Any], Error>?
        let controller = DirectCallController(accountID: server.account, request: { type, payload in
            if type == "call.current" {
                return try await withCheckedThrowingContinuation { pending = $0 }
            }
            return try await server.request(type, payload)
        }, media: Media(), readSequence: { _ in 0 }, saveSequence: { _, _ in })
        controller.connectionChanged("online")
        while pending == nil { await Task.yield() }
        try await controller.placeCall(peerID: server.peer)
        pending?.resume(returning: ["call": NSNull()])
        await controller.waitForIdle()
        XCTAssertEqual(controller.state.call?.call_id, server.callID)
        XCTAssertEqual(controller.state.phase, .ringing)
        controller.invalidate()
    }

    func testCandidateNilFieldsEncodeAsExplicitNull() throws {
        let data = try JSONEncoder().encode(DirectIceCandidate(candidate: "fixture", mid: nil, line: 0))
        let value = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertTrue(value["sdp_mid"] is NSNull)
        XCTAssertEqual(value["sdp_mline_index"] as? Int, 0)
    }
}
