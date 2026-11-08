import Foundation

public struct DirectIceServer: Decodable, Sendable {
    public let urls: [String]
    public let username: String
    public let credential: String
}

public struct DirectIceCandidate: Codable, Sendable {
    public let candidate: String
    public let sdp_mid: String?
    public let sdp_mline_index: Int32?

    public init(candidate: String, mid: String?, line: Int32?) {
        self.candidate = candidate; sdp_mid = mid; sdp_mline_index = line
    }

    private enum CodingKeys: String, CodingKey { case candidate, sdp_mid, sdp_mline_index }
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(candidate, forKey: .candidate)
        try c.encode(sdp_mid, forKey: .sdp_mid)
        try c.encode(sdp_mline_index, forKey: .sdp_mline_index)
    }
}

@MainActor public protocol DirectCallMedia: AnyObject {
    var onCandidate: ((DirectIceCandidate?) -> Void)? { get set }
    var onConnection: ((Bool) -> Void)? { get set }
    var connected: Bool { get }
    func configure(servers: [DirectIceServer]) async throws
    func offer(restart: Bool) async throws -> String
    func answer(offer: String) async throws -> String
    func applyAnswer(_ sdp: String) async throws
    func addCandidate(_ candidate: DirectIceCandidate) async throws
    func setMuted(_ value: Bool)
    func close()
}

/// Native signaling orchestrator. Its transport is the session's existing SharedWebSocket.
@MainActor public final class DirectCallController {
    public typealias Request = (String, [String: Any]) async throws -> [String: Any]
    public private(set) var state = DirectCallProjection()
    public private(set) var selected = false
    public private(set) var muted = false
    public private(set) var unavailableOnDevice = false
    public var onChange: (() -> Void)?
    public var onError: ((String) -> Void)?

    private let accountID: UUID
    private let request: Request
    private let media: any DirectCallMedia
    private let readSequence: (UUID) -> Int64
    private let saveSequence: (UUID, Int64) throws -> Void
    private var online = false
    private var generation = 0
    private var mediaEpoch = 0
    private var queue: Task<Void, Never>?
    private var heartbeat: DirectCallHeartbeat?
    private var heartbeatTask: Task<Void, Never>?
    private var iceRefreshTask: Task<Void, Never>?
    private var negotiation: UUID?
    private var knownNegotiations: Set<UUID> = []
    private var descriptionSent = false
    private var remoteDescriptionSet = false
    private var localICE: [DirectIceCandidate?] = []
    private var remoteICE: [UUID: [DirectIceCandidate]] = [:]
    private var confirmed: UUID?
    private var busy: Set<String> = []

    public init(accountID: UUID, request: @escaping Request, media: any DirectCallMedia,
                readSequence: @escaping (UUID) -> Int64,
                saveSequence: @escaping (UUID, Int64) throws -> Void) {
        self.accountID = accountID; self.request = request; self.media = media
        self.readSequence = readSequence; self.saveSequence = saveSequence
        media.onCandidate = { [weak self] candidate in
            guard let self else { return }
            let epoch = self.mediaEpoch
            self.enqueue { [weak self] in
                guard let self, epoch == self.mediaEpoch, self.selected else { return }
                if self.descriptionSent { try await self.sendCandidate(candidate) }
                else if self.localICE.count < 128 { self.localICE.append(candidate) }
            }
        }
        media.onConnection = { [weak self] _ in
            guard let self else { return }
            let epoch = self.mediaEpoch
            self.enqueue { [weak self] in
                guard let self, epoch == self.mediaEpoch, self.selected else { return }
                if self.media.connected { try await self.confirm() }
                try await self.ping()
                if !self.media.connected && self.state.phase == .active { try await self.restart() }
                self.onChange?()
            }
        }
    }

    public func connectionChanged(_ value: String) {
        let wasOnline = online
        online = value == "online"
        onChange?()
        if online && !wasOnline {
            enqueue { [weak self] in
                guard let self else { return }
                try await self.synchronize()
                if self.selected && self.state.phase == .active { try await self.restart() }
            }
        }
    }

    public func invalidate() {
        generation += 1
        queue?.cancel(); queue = nil
        online = false
        closeMedia()
        state = DirectCallProjection()
        unavailableOnDevice = false
        busy.removeAll()
        onChange?()
    }

    public func refreshCurrent() {
        enqueue { [weak self] in try await self?.synchronize() }
    }

    public func receive(_ message: [String: Any]) {
        guard let type = message["type"] as? String, let payload = message["payload"] as? [String: Any],
              type == "call.updated" || type.hasPrefix("rtc.") else { return }
        enqueue { [weak self] in try await self?.handle(type, payload: payload) }
    }

    public func placeCall(peerID: UUID) async throws {
        guard online, !busy.contains("create"), state.phase == nil || state.phase == .ended else { throw NativeError.unavailable }
        busy.insert("create")
        defer { busy.remove("create") }
        let revision = generation
        do {
            let response = try await request("call.create", ["recipient_id": peerID.uuidString.lowercased()])
            guard revision == generation else { throw NativeError.unavailable }
            try await apply(decodeCall(response), authoritative: true)
        } catch {
            // Unknown creation is reconciled, never submitted a second time.
            if revision == generation { try? await synchronize() }
            throw error
        }
    }

    public func acceptCall() async throws { try await command("call.accept") }

    public func endCall() async throws {
        guard let call = state.call, state.phase != .ended else { return }
        let type = state.phase == .ringing ? (call.caller_id == accountID ? "call.cancel" : "call.reject") : "call.end"
        try await command(type)
    }

    public func setMuted(_ value: Bool) {
        muted = value; media.setMuted(value); onChange?()
    }

    private func command(_ type: String) async throws {
        guard online, let call = state.call, !busy.contains(type) else { throw NativeError.unavailable }
        busy.insert(type)
        defer { busy.remove(type) }
        let revision = generation
        let response = try await request(type, ["call_id": call.call_id.uuidString.lowercased()])
        guard revision == generation, state.call?.call_id == call.call_id else { throw NativeError.unavailable }
        try await apply(decodeCall(response), authoritative: false)
    }

    private func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value))
    }

    private func decodeCall(_ response: [String: Any]) throws -> DirectCallRecord {
        guard let value = response["call"] as? [String: Any] else { throw NativeError.validation }
        return try decode(DirectCallRecord.self, value)
    }

    private func enqueue(_ action: @escaping @MainActor () async throws -> Void) {
        let previous = queue
        let revision = generation
        queue = Task { [weak self] in
            await previous?.value
            guard let self, revision == self.generation, !Task.isCancelled else { return }
            do { try await action() }
            catch { if revision == self.generation { self.report(error) } }
        }
    }

    func waitForIdle() async { await queue?.value }

    private func report(_ error: Error) {
        onError?((error as? AuthFailure)?.code ?? (error as? NativeError)?.rawValue ?? "NETWORK_ERROR")
    }

    private func synchronize() async throws {
        guard online else { return }
        let revision = generation
        let previousID = state.call?.call_id
        let previousVersion = state.version
        let response = try await request("call.current", [:])
        guard revision == generation else { return }
        guard let value = response["call"], value is NSNull || value is [String: Any] else { throw NativeError.validation }
        let next = value is NSNull ? nil : try decode(DirectCallRecord.self, value)
        if previousID != state.call?.call_id || previousVersion != state.version {
            // A late startup/current result cannot clear or replace a call selected after its request.
            guard let next, next.call_id == state.call?.call_id else { return }
        }
        if value is NSNull {
            state.applyCurrent(nil); closeMedia(); onChange?()
        } else if let next { try await apply(next, authoritative: true) }
    }

    private func apply(_ call: DirectCallRecord, authoritative: Bool) async throws {
        let previousID = state.call?.call_id
        let result = authoritative ? state.applyCurrent(call) : state.applyUpdate(call)
        if result == .requiresCurrent { try await synchronize(); return }
        guard result == .applied else { return }
        if previousID != call.call_id { closeMedia(); unavailableOnDevice = false }
        if state.phase == .ended { closeMedia() }
        onChange?()
        guard state.phase == .connecting || state.phase == .active else { return }
        try await configureMedia()
        if selected && call.caller_id == accountID && negotiation == nil { try await negotiate() }
    }

    private func configureMedia() async throws {
        guard online, let call = state.call, state.phase == .connecting || state.phase == .active else { return }
        let revision = generation
        let epoch = mediaEpoch
        let response: [String: Any]
        do { response = try await request("call.ice_config", ["call_id": call.call_id.uuidString.lowercased()]) }
        catch {
            if (error as? AuthFailure)?.code == "FORBIDDEN" { closeMedia(); unavailableOnDevice = true; onChange?(); return }
            throw error
        }
        guard revision == generation, epoch == mediaEpoch, state.call?.call_id == call.call_id, state.phase != .ended else { return }
        guard let servers = response["ice_servers"] as? [[String: Any]], !servers.isEmpty else { throw NativeError.validation }
        try await media.configure(servers: decode([DirectIceServer].self, servers))
        guard revision == generation, epoch == mediaEpoch, state.phase != .ended else { media.close(); return }
        selected = true
        unavailableOnDevice = false
        if let expires = response["expires_at"] as? String {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            guard let expiry = formatter.date(from: expires) else { throw NativeError.validation }
            let delay = max(1, min(86400, expiry.timeIntervalSinceNow - 30))
            iceRefreshTask?.cancel()
            iceRefreshTask = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) } catch { return }
                guard let self, revision == self.generation, epoch == self.mediaEpoch, self.selected else { return }
                self.enqueue { [weak self] in try await self?.configureMedia() }
            }
        }
        if heartbeat == nil {
            heartbeat = try DirectCallHeartbeat(callID: call.call_id, restoredSequence: readSequence(call.call_id))
            heartbeatTask = Task { [weak self] in
                while !Task.isCancelled {
                    guard let self, revision == self.generation, epoch == self.mediaEpoch else { return }
                    do { try await self.ping() } catch { self.report(error) }
                    do { try await Task.sleep(nanoseconds: 10_000_000_000) } catch { return }
                }
            }
        }
        onChange?()
    }

    private func handle(_ type: String, payload: [String: Any]) async throws {
        if type == "call.updated" { try await apply(decodeCall(payload), authoritative: false); return }
        guard let call = state.call, state.phase == .connecting || state.phase == .active,
              (payload["call_id"] as? String).flatMap(UUID.init(uuidString:)) == call.call_id else { return }
        if !selected { try await configureMedia() }
        guard selected else { return }
        if type == "rtc.restart" {
            if call.caller_id == accountID { try await negotiate() }
            return
        }
        guard let value = payload["negotiation_id"] as? String, let incoming = UUID(uuidString: value) else { throw NativeError.validation }
        if type == "rtc.offer" {
            guard call.recipient_id == accountID, let sdp = payload["sdp"] as? String,
                  incoming == negotiation || !knownNegotiations.contains(incoming) else { return }
            if incoming == negotiation && descriptionSent { return }
            negotiation = incoming; knownNegotiations.insert(incoming)
            confirmed = nil; descriptionSent = false; localICE.removeAll(); remoteDescriptionSet = false
            let epoch = mediaEpoch
            let answer = try await media.answer(offer: sdp)
            guard epoch == mediaEpoch, negotiation == incoming else { return }
            remoteDescriptionSet = true
            try await flushRemoteICE()
            _ = try await request("rtc.answer", ["call_id": call.call_id.uuidString.lowercased(), "negotiation_id": incoming.uuidString.lowercased(), "sdp": answer])
            try await flushLocalICE()
            try await confirm()
        } else if type == "rtc.answer" {
            guard incoming == negotiation, call.caller_id == accountID, !remoteDescriptionSet,
                  let sdp = payload["sdp"] as? String else { return }
            try await media.applyAnswer(sdp)
            remoteDescriptionSet = true
            try await flushRemoteICE()
            try await confirm()
        } else if type == "rtc.ice" {
            guard let value = payload["candidate"], !(value is NSNull) else { return }
            let candidate = try decode(DirectIceCandidate.self, value)
            if incoming == negotiation && remoteDescriptionSet { try await media.addCandidate(candidate) }
            else if !knownNegotiations.contains(incoming) || incoming == negotiation {
                if remoteICE.count < 16 && (remoteICE[incoming]?.count ?? 0) < 128 {
                    remoteICE[incoming, default: []].append(candidate)
                }
            }
        }
    }

    private func negotiate() async throws {
        guard selected, let call = state.call, call.caller_id == accountID else { return }
        let attempt = UUID()
        negotiation = attempt; knownNegotiations.insert(attempt)
        confirmed = nil; descriptionSent = false; remoteDescriptionSet = false; localICE.removeAll()
        let epoch = mediaEpoch
        let sdp = try await media.offer(restart: true)
        guard epoch == mediaEpoch, negotiation == attempt else { return }
        _ = try await request("rtc.offer", ["call_id": call.call_id.uuidString.lowercased(), "negotiation_id": attempt.uuidString.lowercased(), "sdp": sdp])
        try await flushLocalICE()
        try await confirm()
    }

    private func sendCandidate(_ candidate: DirectIceCandidate?) async throws {
        guard let call = state.call, let negotiation, selected else { return }
        let value: Any = try candidate.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) } ?? NSNull()
        _ = try await request("rtc.ice", ["call_id": call.call_id.uuidString.lowercased(), "negotiation_id": negotiation.uuidString.lowercased(), "candidate": value])
    }

    private func flushLocalICE() async throws {
        descriptionSent = true
        let pending = localICE; localICE.removeAll()
        for candidate in pending { try await sendCandidate(candidate) }
    }

    private func flushRemoteICE() async throws {
        guard let negotiation else { return }
        let pending = remoteICE.removeValue(forKey: negotiation) ?? []
        for candidate in pending { try await media.addCandidate(candidate) }
    }

    private func confirm() async throws {
        guard selected, media.connected, remoteDescriptionSet, let negotiation,
              confirmed != negotiation, let call = state.call else { return }
        confirmed = negotiation
        do {
            let response = try await request("call.connected", ["call_id": call.call_id.uuidString.lowercased(), "negotiation_id": negotiation.uuidString.lowercased()])
            try await apply(decodeCall(response), authoritative: false)
        } catch { confirmed = nil; throw error }
    }

    private func restart() async throws {
        guard online, selected, let call = state.call else { return }
        try await configureMedia()
        if call.caller_id == accountID { try await negotiate() }
        else { _ = try await request("rtc.restart", ["call_id": call.call_id.uuidString.lowercased()]) }
    }

    private var pingRunning = false
    private func ping() async throws {
        guard !pingRunning, online, selected, var heartbeat, let call = state.call,
              state.phase == .connecting || state.phase == .active else { return }
        pingRunning = true
        defer { pingRunning = false }
        let revision = generation
        let payload = try heartbeat.next(audioConnected: media.connected, recoveryID: state.recoveryID)
        try saveSequence(call.call_id, heartbeat.sequence)
        self.heartbeat = heartbeat
        let response = try await request("call.ping", payload)
        guard revision == generation, state.call?.call_id == call.call_id else { return }
        let next = try decode(DirectCallPing.self, response)
        if state.applyPing(next, callID: call.call_id) == .applied {
            if state.phase == .ended { closeMedia() }
            onChange?()
            if state.needsFullSnapshot { try await synchronize() }
        }
    }

    private func closeMedia() {
        mediaEpoch += 1
        heartbeatTask?.cancel(); heartbeatTask = nil; heartbeat = nil
        iceRefreshTask?.cancel(); iceRefreshTask = nil
        media.close(); selected = false; muted = false
        negotiation = nil; confirmed = nil; knownNegotiations.removeAll()
        descriptionSent = false; remoteDescriptionSet = false
        localICE.removeAll(); remoteICE.removeAll()
    }
}
