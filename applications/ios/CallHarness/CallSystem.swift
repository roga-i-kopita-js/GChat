import AVFoundation
@preconcurrency import CallKit
import GChatCore

@MainActor final class CallSystem: NSObject, CXProviderDelegate, CXCallObserverDelegate {
    private var provider: CXProvider?
    private var controller = CXCallController()
    private var reported: UUID?
    private var active = false
    var onAnswer: (() async throws -> Void)?
    var onPrepareAudio: (() throws -> Void)?
    var onEnd: (() async throws -> Void)?
    var onMute: ((Bool) -> Void)?
    var onReset: (() -> Void)?
    var onAudio: ((Bool, AVAudioSession) -> Void)?
    var onError: ((String) -> Void)?
    var onStatus: (() -> Void)?
    private var providerState = "не создан"
    private var reportStatus = "нет"

    var diagnostics: String {
        let calls = controller.callObserver.calls
        let current = calls.first { $0.uuid == reported }
        return "provider: \(providerState); report: \(reportStatus); calls: \(calls.count); текущий в системе: \(current != nil); connected: \(current?.hasConnected ?? false); ended: \(current?.hasEnded ?? false)"
    }

    override init() {
        super.init()
        controller.callObserver.setDelegate(self, queue: .main)
    }

    private func ensureProvider() -> CXProvider {
        if let provider { return provider }
        let config = CXProviderConfiguration()
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        config.supportsVideo = false
        config.includesCallsInRecents = false
        let provider = CXProvider(configuration: config)
        self.provider = provider
        providerState = "создан"
        provider.setDelegate(self, queue: .main)
        return provider
    }

    private func failed(_ error: Error) {
        let cause = error as NSError
        onError?(cause.domain + " (" + String(cause.code) + ")")
    }

    nonisolated func callObserver(_ callObserver: CXCallObserver, callChanged call: CXCall) {
        Task { @MainActor [weak self] in self?.onStatus?() }
    }

    nonisolated func providerDidBegin(_ provider: CXProvider) {
        Task { @MainActor [weak self] in
            guard let self, self.provider === provider else { return }
            self.providerState = "began"; self.onStatus?()
        }
    }

    func update(call: DirectCallRecord?, phase: DirectCallPhase?, accountID: UUID, selected: Bool, connected: Bool, unavailable: Bool) {
        guard let call, phase != .ended, !unavailable else {
            if let reported { provider?.reportCall(with: reported, endedAt: Date(), reason: unavailable ? .answeredElsewhere : .remoteEnded) }
            reported = nil; active = false
            return
        }
        let provider = ensureProvider()
        if reported != call.call_id {
            // A restored selected active call is represented as an outgoing system call.
            guard phase == .ringing || selected else { return }
            do { try onPrepareAudio?() }
            catch { failed(error); return }
            reported = call.call_id
            if call.caller_id == accountID || phase != .ringing {
                reportStatus = "запрос исходящего"; onStatus?()
                let action = CXStartCallAction(call: call.call_id, handle: CXHandle(type: .generic, value: "GChat test peer"))
                controller.request(CXTransaction(action: action)) { [weak self] error in
                    if let error { Task { @MainActor in self?.failed(error) } }
                }
            } else {
                let update = CXCallUpdate()
                update.remoteHandle = CXHandle(type: .generic, value: "GChat test peer")
                update.hasVideo = false
                reportStatus = "reportNewIncomingCall отправлен"; onStatus?()
                provider.reportNewIncomingCall(with: call.call_id, update: update) { [weak self] error in
                    Task { @MainActor in
                        guard let self, self.provider === provider, self.reported == call.call_id else { return }
                        if let error {
                            self.reportStatus = "reportNewIncomingCall ошибка"
                            self.failed(error)
                        } else {
                            self.reportStatus = "reportNewIncomingCall success"
                        }
                        self.onStatus?()
                    }
                }
            }
        }
        if connected && !active {
            active = true
            if call.caller_id == accountID { provider.reportOutgoingCall(with: call.call_id, connectedAt: Date()) }
        }
    }

    nonisolated func providerDidReset(_ provider: CXProvider) {
        Task { @MainActor [weak self] in
            guard let self, self.provider === provider else { return }
            provider.setDelegate(nil, queue: nil)
            provider.invalidate()
            self.provider = nil
            self.controller = CXCallController()
            self.controller.callObserver.setDelegate(self, queue: .main)
            self.providerState = "reset"; self.onStatus?()
            self.reported = nil; self.active = false; self.onReset?()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        Task { @MainActor [weak self] in
            guard let self, self.reported == action.callUUID else { action.fail(); return }
            provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
            action.fulfill()
        }
    }
    nonisolated func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        Task { @MainActor [weak self] in
            guard let self, self.reported == action.callUUID else { action.fail(); return }
            do {
                try await self.onAnswer?()
                action.fulfill()
            } catch { action.fail(); self.failed(error) }
        }
    }
    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        Task { @MainActor [weak self] in
            guard let self, self.reported == action.callUUID else { action.fail(); return }
            do { try await self.onEnd?(); action.fulfill() }
            catch { action.fail(); self.failed(error) }
        }
    }
    nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        Task { @MainActor [weak self] in
            guard let self, self.reported == action.callUUID else { action.fail(); return }
            self.onMute?(action.isMuted); action.fulfill()
        }
    }
    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        Task { @MainActor [weak self] in self?.onAudio?(true, audioSession) }
    }
    nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        Task { @MainActor [weak self] in self?.onAudio?(false, audioSession) }
    }

    func answer() async throws {
        guard let reported else { throw NativeError.unavailable }
        try await controller.request(CXTransaction(action: CXAnswerCallAction(call: reported)))
    }

    func end() async throws {
        guard let reported else { throw NativeError.unavailable }
        try await controller.request(CXTransaction(action: CXEndCallAction(call: reported)))
    }
}
