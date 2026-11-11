import Foundation

public enum DirectCallPhase: String, Codable, Sendable {
    case ringing, connecting, active, ended

    fileprivate var order: Int {
        switch self {
        case .ringing: return 0
        case .connecting: return 1
        case .active: return 2
        case .ended: return 3
        }
    }
}

/// Safe server DTO only. SDP, ICE and credentials never belong in call UI state.
public struct DirectCallRecord: Decodable, Equatable, Sendable {
    public let call_id: UUID
    public let state: DirectCallPhase
    public let caller_id: UUID
    public let recipient_id: UUID
    public let created_at: String
    public let started_at: String?
    public let ended_at: String?
    public let end_reason: String?
    public let recovery_id: UUID?
    public let recovery_deadline: String?
    public let ringing_deadline: String?
    public let connecting_deadline: String?
    public let version: Int

    /// Full safe bridge DTO. Optional server fields remain explicit JSON nulls.
    public var bridgeObject: [String: Any] {
        ["call_id": call_id.uuidString.lowercased(), "state": state.rawValue,
         "caller_id": caller_id.uuidString.lowercased(), "recipient_id": recipient_id.uuidString.lowercased(),
         "created_at": created_at, "started_at": started_at as Any? ?? NSNull(),
         "ended_at": ended_at as Any? ?? NSNull(), "end_reason": end_reason as Any? ?? NSNull(),
         "recovery_id": recovery_id?.uuidString.lowercased() as Any? ?? NSNull(),
         "recovery_deadline": recovery_deadline as Any? ?? NSNull(),
         "ringing_deadline": ringing_deadline as Any? ?? NSNull(),
         "connecting_deadline": connecting_deadline as Any? ?? NSNull(), "version": version]
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case call_id, state, caller_id, recipient_id, created_at, started_at, ended_at, end_reason
        case recovery_id, recovery_deadline, ringing_deadline, connecting_deadline, version
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard CodingKeys.allCases.allSatisfy(c.contains) else { throw NativeError.validation }
        call_id = try c.decode(UUID.self, forKey: .call_id)
        state = try c.decode(DirectCallPhase.self, forKey: .state)
        caller_id = try c.decode(UUID.self, forKey: .caller_id)
        recipient_id = try c.decode(UUID.self, forKey: .recipient_id)
        created_at = try c.decode(String.self, forKey: .created_at)
        started_at = try c.decodeIfPresent(String.self, forKey: .started_at)
        ended_at = try c.decodeIfPresent(String.self, forKey: .ended_at)
        end_reason = try c.decodeIfPresent(String.self, forKey: .end_reason)
        recovery_id = try c.decodeIfPresent(UUID.self, forKey: .recovery_id)
        recovery_deadline = try c.decodeIfPresent(String.self, forKey: .recovery_deadline)
        ringing_deadline = try c.decodeIfPresent(String.self, forKey: .ringing_deadline)
        connecting_deadline = try c.decodeIfPresent(String.self, forKey: .connecting_deadline)
        version = try c.decode(Int.self, forKey: .version)
        let reasons = ["cancelled", "rejected", "no_answer", "connection_timeout", "hangup", "connection_lost", "session_revoked", "account_disabled"]
        guard version >= 0, caller_id != recipient_id,
              (recovery_id == nil) == (recovery_deadline == nil),
              (state == .ringing) == (ringing_deadline != nil),
              (state == .connecting) == (connecting_deadline != nil),
              (state == .ended) == (ended_at != nil),
              (state == .ended) == (end_reason != nil),
              end_reason == nil || reasons.contains(end_reason!),
              state != .active || started_at != nil else { throw NativeError.validation }
    }
}

public struct DirectCallPing: Decodable, Equatable, Sendable {
    public let state: DirectCallPhase
    public let version: Int
    public let recovery_id: UUID?
    public let recovery_deadline: String?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case state, version, recovery_id, recovery_deadline
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard CodingKeys.allCases.allSatisfy(c.contains) else { throw NativeError.validation }
        state = try c.decode(DirectCallPhase.self, forKey: .state)
        version = try c.decode(Int.self, forKey: .version)
        recovery_id = try c.decodeIfPresent(UUID.self, forKey: .recovery_id)
        recovery_deadline = try c.decodeIfPresent(String.self, forKey: .recovery_deadline)
        guard version >= 0, (recovery_id == nil) == (recovery_deadline == nil) else { throw NativeError.validation }
    }
}

/// Scoped to one native session. Its owner resets it when that session changes.
public struct DirectCallProjection: Sendable {
    public enum Update: Equatable { case applied, ignored, requiresCurrent }
    public private(set) var call: DirectCallRecord?
    public private(set) var ping: DirectCallPing?
    private var retired: Set<UUID> = []

    public init() {}

    public var version: Int? { ping?.version ?? call?.version }
    public var phase: DirectCallPhase? { ping?.state ?? call?.state }
    public var recoveryID: UUID? { ping.map { $0.recovery_id } ?? call?.recovery_id }
    public var needsFullSnapshot: Bool { ping != nil }

    /// A different call.updated is never enough to claim a call on this device.
    @discardableResult public mutating func applyUpdate(_ next: DirectCallRecord) -> Update {
        guard !retired.contains(next.call_id) else { return .ignored }
        guard call?.call_id == next.call_id else { return .requiresCurrent }
        return merge(next)
    }

    /// Only call.current (or a successful local call command) can select another call.
    @discardableResult public mutating func applyCurrent(_ next: DirectCallRecord?) -> Update {
        guard let next else {
            if let call { retired.insert(call.call_id) }
            call = nil; ping = nil
            return .applied
        }
        if call?.call_id == next.call_id { return merge(next) }
        guard !retired.contains(next.call_id) else { return .ignored }
        if let call { retired.insert(call.call_id) }
        call = next; ping = nil
        return .applied
    }

    private mutating func merge(_ next: DirectCallRecord) -> Update {
        guard let version, let phase, next.version >= version,
              next.state.order >= phase.order else { return .ignored }
        if next.version == version {
            guard ping != nil, next.state == phase, next.recovery_id == recoveryID,
                  next.recovery_deadline == ping?.recovery_deadline else { return .ignored }
        }
        call = next; ping = nil
        return .applied
    }

    /// Associate each ping response with the call that originated its request.
    @discardableResult public mutating func applyPing(_ next: DirectCallPing, callID: UUID) -> Update {
        guard call?.call_id == callID, let version, let phase,
              next.version > version, next.state.order >= phase.order else { return .ignored }
        ping = next
        return .applied
    }
}

/// Never recreated for a negotiation or reconnect of the same call.
public struct DirectCallHeartbeat: Sendable {
    public let callID: UUID
    public private(set) var sequence: Int64 = 0

    /// The owner persists the returned sequence before sending and restores it after process restart.
    public init(callID: UUID, restoredSequence: Int64 = 0) throws {
        guard (0...9_007_199_254_740_991).contains(restoredSequence) else { throw NativeError.validation }
        self.callID = callID
        sequence = restoredSequence
    }

    public mutating func next(audioConnected: Bool, recoveryID: UUID?) throws -> [String: Any] {
        guard sequence < 9_007_199_254_740_991 else { throw NativeError.unavailable }
        sequence += 1
        return ["call_id": callID.uuidString.lowercased(), "sequence": sequence,
                "audio_connected": audioConnected, "recovery_id": recoveryID.map { $0.uuidString.lowercased() } as Any? ?? NSNull()]
    }
}
