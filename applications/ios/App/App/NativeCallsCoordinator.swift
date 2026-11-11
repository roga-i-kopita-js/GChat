import AVFoundation
import GChatCore
import UIKit

/// Owned by the shell, independently of the current Web document and its cycle.
@MainActor final class NativeCallsCoordinator {
    private let transport: SharedWebSocket
    private let server: ServerOrigin
    private let media = WebRTCMedia()
    private let system = CallSystem()
    private var controller: DirectCallController?
    private var account: UUID?
    private var sessionID: String?
    private var sequenceStore: CallSequenceStore?
    private var generation = 0
    var onChange: (() -> Void)?
    var onError: ((String) -> Void)?

    init(server: ServerOrigin, transport: SharedWebSocket) {
        self.server = server
        self.transport = transport
        transport.onNativeState = { [weak self] status in self?.controller?.connectionChanged(status); self?.changed() }
        transport.onNativeMessage = { [weak self] message in self?.controller?.receive(message) }
        transport.onNativeInvalidSession = { [weak self] in self?.bind(nil) }
        system.onPrepareAudio = { [weak self] in
            guard let self else { throw NativeError.unavailable }
            try self.media.prepareAudio()
        }
        system.onAnswer = { [weak self] in
            guard let self, let controller = self.controller, let call = controller.state.call else { throw NativeError.unavailable }
            let revision = self.generation
            try await self.requireMicrophone()
            guard self.generation == revision, self.controller === controller,
                  controller.state.call?.call_id == call.call_id, controller.state.phase == .ringing else { throw NativeError.unavailable }
            try await controller.acceptCall()
        }
        system.onEnd = { [weak self] in
            guard let controller = self?.controller else { throw NativeError.unavailable }
            try await controller.endCall()
        }
        system.onMute = { [weak self] value in self?.controller?.setMuted(value) }
        system.onAudio = { [weak self] active, session in
            self?.media.audioActivated(active, session: session)
            self?.changed()
        }
        system.onError = { [weak self] _ in self?.onError?("Не удалось выполнить системное действие звонка") }
        system.onReset = { [weak self] in self?.resetSystem() }
    }

    var call: DirectCallRecord? {
        guard let controller, let call = controller.state.call else { return nil }
        // A compact terminal ping is not a full terminal DTO; never fabricate one.
        if controller.state.phase == .ended && call.state != .ended { return nil }
        return call
    }
    var phase: DirectCallPhase? { controller?.state.phase }
    var muted: Bool { controller?.muted ?? false }
    var connected: Bool { media.connected }
    var selectedCallID: UUID? { hasLocalCall && controller?.selected == true ? call?.call_id : nil }
    var incoming: Bool { call?.state == .ringing && call?.recipient_id == account }
    var hasLocalCall: Bool {
        guard let controller, controller.state.phase != .ended, controller.state.phase != nil,
              !controller.unavailableOnDevice else { return false }
        return controller.selected || controller.state.phase == .ringing
    }
    var runtime: [String: Any] {
        ["status": controller == nil ? "offline" : transport.status, "muted": muted,
         "selected": hasLocalCall && !incoming]
    }
    var callObject: Any { call?.bridgeObject as Any? ?? NSNull() }

    func bind(_ session: NativeSession?) {
        guard let session, let sid = session.sessionID,
              let account = session.accountID.flatMap(UUID.init(uuidString:)) else {
            clear()
            return
        }
        if sessionID == sid, self.account == account, controller != nil { return }
        clear()
        do {
            let store = try CallSequenceStore(server: server, account: account, sessionID: sid)
            self.sequenceStore = store
            self.account = account
            self.sessionID = sid
            let controller = DirectCallController(accountID: account,
                request: { [weak self] type, payload in
                    guard let self, self.sessionID == sid, self.account == account else { throw NativeError.unavailable }
                    return try await self.transport.request(type, payload: payload, publish: false)
                }, media: media, readSequence: { store.read($0) }, saveSequence: { try store.write($0, $1) })
            self.controller = controller
            controller.onChange = { [weak self] in self?.changed() }
            controller.onError = { [weak self] _ in self?.onError?("Не удалось выполнить действие звонка. Проверьте соединение.") }
            controller.connectionChanged(transport.status)
            changed()
        } catch { clear(); onError?("Не удалось подготовить нативные звонки") }
    }

    private func clear() {
        generation += 1
        webControl = nil
        webControlAuthorized = nil
        let previous = controller
        controller = nil; sessionID = nil; account = nil; sequenceStore = nil
        previous?.onChange = nil; previous?.onError = nil
        previous?.invalidate()
        media.close()
        media.audioActivated(false, session: AVAudioSession.sharedInstance())
        system.update(call: nil, phase: nil, accountID: UUID(), selected: false, connected: false, unavailable: false)
        onChange?()
    }

    private func resetSystem() {
        let previous = controller
        let call = previous?.state.call
        let oldAccount = account
        let revision = generation
        previous?.invalidate()
        media.audioActivated(false, session: AVAudioSession.sharedInstance())
        changed()
        Task { @MainActor [weak self] in
            guard let self, generation == revision, self.controller === previous else { return }
            if let call, call.state != .ended {
                let type = call.state == .ringing ? (call.caller_id == oldAccount ? "call.cancel" : "call.reject") : "call.end"
                _ = try? await transport.request(type, payload: ["call_id": call.call_id.uuidString.lowercased()], publish: false)
            }
            guard generation == revision, self.controller === previous else { return }
            previous?.connectionChanged(transport.status)
        }
    }

    private func changed() {
        if let controller, let account {
            system.update(call: controller.state.call, phase: controller.state.phase, accountID: account,
                selected: controller.selected, connected: media.connected, unavailable: controller.unavailableOnDevice)
        }
        onChange?()
    }

    func place(_ peer: UUID, stillAuthorized: @MainActor () -> Bool) async throws {
        guard let controller else { throw NativeError.invalidSession }
        let revision = generation
        try await requireMicrophone()
        guard generation == revision, self.controller === controller, stillAuthorized() else { throw NativeError.unavailable }
        try await controller.placeCall(peerID: peer)
    }
    enum WebControl { case answer, end, mute(Bool) }
    private var webControl: UUID?
    private var webControlAuthorized: (@MainActor () -> Bool)?

    func control(_ operation: WebControl, callID: UUID,
                 stillAuthorized: @escaping @MainActor () -> Bool) async throws {
        guard webControl == nil || webControlAuthorized?() == false else { throw DeviceCommandError("BUSY") }
        guard let controller, call?.call_id == callID, hasLocalCall else { throw DeviceCommandError("INVALID_STATE") }
        let revision = generation
        let requestID = UUID()
        webControl = requestID
        defer { if webControl == requestID { webControl = nil; webControlAuthorized = nil } }
        let authorized: @MainActor () -> Bool = { [weak self] in
            guard let self else { return false }
            return self.generation == revision && self.controller === controller &&
                self.call?.call_id == callID && self.hasLocalCall && stillAuthorized()
        }
        webControlAuthorized = authorized
        guard authorized() else { throw DeviceCommandError("CANCELLED") }
        do {
            switch operation {
            case .answer:
                guard incoming else { throw DeviceCommandError("INVALID_STATE") }
                try await requireMicrophone()
                guard authorized(), incoming else { throw DeviceCommandError("CANCELLED") }
                try await system.answer(authorized: authorized)
            case .end:
                try await system.end(authorized: authorized)
            case .mute(let value):
                guard controller.selected, phase == .active || phase == .connecting else { throw DeviceCommandError("INVALID_STATE") }
                if muted != value { try await system.mute(value, authorized: authorized) }
            }
        } catch {
            if generation == revision, self.controller === controller { controller.refreshCurrent() }
            throw error
        }
    }
    func foreground() { controller?.refreshCurrent(); changed() }
    func prepareLogout() async throws {
        if hasLocalCall { try await controller?.endCall() }
    }
    private func requireMicrophone() async throws {
        if AVAudioSession.sharedInstance().recordPermission == .granted { return }
        let granted = await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard granted else {
            onError?("Разрешите доступ к микрофону для GChat в настройках iPhone.")
            throw DeviceCommandError("PERMISSION_DENIED")
        }
    }
}

/// Each write reaches disk before the corresponding ping can be sent.
@MainActor private final class CallSequenceStore {
    private let url: URL
    private let key: String
    private var values: [String: Int64]
    init(server: ServerOrigin, account: UUID, sessionID: String) throws {
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true).appendingPathComponent("GChat/calls", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        url = directory.appendingPathComponent("sequences.json")
        key = server.url.absoluteString + "|" + account.uuidString + "|" + sessionID + "|"
        values = FileManager.default.fileExists(atPath: url.path) ? try JSONDecoder().decode([String: Int64].self, from: Data(contentsOf: url)) : [:]
    }
    func read(_ call: UUID) -> Int64 { values[key + call.uuidString] ?? 0 }
    func write(_ call: UUID, _ sequence: Int64) throws {
        var next = values; next[key + call.uuidString] = sequence
        try JSONEncoder().encode(next).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        values = next
    }
}
