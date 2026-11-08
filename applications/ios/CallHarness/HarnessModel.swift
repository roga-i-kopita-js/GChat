import AVFoundation
import Combine
import GChatCore
import UIKit

@MainActor final class HarnessModel: ObservableObject {
    @Published var serverURL = UserDefaults.standard.string(forKey: "gchat.harness.server") ?? (Bundle.main.object(forInfoDictionaryKey: "GChatHarnessServer") as? String ?? "")
    @Published var login = Bundle.main.object(forInfoDictionaryKey: "GChatHarnessLogin") as? String ?? ""
    @Published var password = ""
    @Published var peerID = Bundle.main.object(forInfoDictionaryKey: "GChatHarnessPeerID") as? String ?? ""
    @Published private(set) var online = false
    @Published private(set) var signedIn = false
    @Published private(set) var working = false
    @Published private(set) var phase = "нет звонка"
    @Published private(set) var audioConnected = false
    @Published private(set) var muted = false
    @Published private(set) var incoming = false
    @Published private(set) var outputDevice = ""
    @Published private(set) var lastCallEvent = "событий звонка ещё нет"
    @Published var error = ""
    private let media = WebRTCMedia()
    private let system = CallSystem()
    private var sessions: SessionManager?
    private var socket: SharedWebSocket?
    private var calls: DirectCallController?
    private var accountID: UUID?
    private var sceneState = "unknown"
    private var transportMessages = 0
    private var lastTransportEvent = "нет"
    private var systemResets = 0
    private var lastCurrent = "нет"

    var diagnostics: String {
        let bundle = Bundle.main
        let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        let origin = (try? ServerOrigin(serverURL).url.absoluteString) ?? "не задан или некорректен"
        return [
            "GChat Audio Test · diagnostics v2",
            "Время: " + ISO8601DateFormatter().string(from: Date()),
            "Приложение: \(version) (\(build)); iOS: \(UIDevice.current.systemVersion)",
            "Сервер: " + origin,
            "Вход: \(signedIn); операция: \(working)",
            "Аккаунт: " + (accountID?.uuidString.lowercased() ?? "нет"),
            "WSS: " + (socket?.status ?? "offline"),
            "Экран: " + sceneState,
            "Получено WSS: \(transportMessages); последнее: \(lastTransportEvent)",
            "Сбросов CallKit: \(systemResets); call.current: \(lastCurrent)",
            "CallKit: " + system.diagnostics,
            "Звонок: " + (calls?.state.call?.call_id.uuidString.lowercased() ?? "нет"),
            "Состояние: " + phase,
            "Медиа: \(audioConnected ? "connected" : "disconnected"); выбранное устройство: \(calls?.selected ?? false)",
            "Входящий: \(incoming); другое устройство: \(calls?.unavailableOnDevice ?? false)",
            "Mute: \(muted); громкая связь: \(media.speakerEnabled)",
            "Аудиовыход: " + media.outputRoute,
            "Маршрутизация: " + media.routeDiagnostics,
            "Последние аудиособытия (монотонное время):\n" + media.audioEventDiagnostics,
            "Микрофон: " + String(AVAudioSession.sharedInstance().recordPermission.rawValue),
            "Последнее событие: " + lastCallEvent,
            "Результат: " + (error.isEmpty ? "нет" : error),
        ].joined(separator: "\n")
    }

    init() {
        system.onPrepareAudio = { [weak self] in
            guard let self else { throw NativeError.unavailable }
            try self.media.prepareAudio()
        }
        media.onRouteChanged = { [weak self] in
            guard let self else { return }
            self.outputDevice = self.media.outputDevice
            self.saveDiagnostics()
        }
        system.onStatus = { [weak self] in self?.saveDiagnostics() }
        system.onAnswer = { [weak self] in
            guard let calls = self?.calls else { throw NativeError.unavailable }
            try await calls.acceptCall()
        }
        system.onEnd = { [weak self] in
            guard let calls = self?.calls else { throw NativeError.unavailable }
            try await calls.endCall()
        }
        system.onMute = { [weak self] in self?.calls?.setMuted($0) }
        system.onAudio = { [weak self] active, session in
            self?.media.audioActivated(active, session: session)
            self?.changed()
        }
        system.onError = { [weak self] code in
            self?.error = "CallKit: " + code
            self?.saveDiagnostics()
            Task { @MainActor in try? await self?.calls?.endCall() }
        }
        system.onReset = { [weak self] in
            guard let self else { return }
            self.systemResets += 1
            let calls = self.calls
            let socket = self.socket
            let call = calls?.state.call
            let phase = calls?.state.phase
            calls?.invalidate()
            Task { @MainActor [weak self] in
                if let call, phase != .ended {
                    let command = phase == .ringing ? (call.caller_id == self?.accountID ? "call.cancel" : "call.reject") : "call.end"
                    _ = try? await socket?.request(command, payload: ["call_id": call.call_id.uuidString.lowercased()], publish: false)
                }
                guard let self, self.signedIn, self.calls === calls, self.socket === socket else { return }
                // Reset closes local call resources, but does not revoke the signed-in WSS.
                calls?.connectionChanged(socket?.status ?? "offline")
            }
            self.changed()
        }
    }

    func connect() async {
        guard !working, !signedIn else { return }
        working = true; error = ""
        defer { working = false; password = "" }
        do {
            let granted = await withCheckedContinuation { continuation in
                AVAudioSession.sharedInstance().requestRecordPermission { continuation.resume(returning: $0) }
            }
            guard granted else { error = "Нужен доступ к микрофону в настройках iOS."; return }
            let server = try ServerOrigin(serverURL)
            let manager = SessionManager(server: server,
                storage: KeychainSessionStorage(service: Bundle.main.bundleIdentifier! + ".auth"),
                transport: HTTPAuthTransport())
            let restored = try await manager.restore()
            let session: NativeSession?
            if let restored { session = restored }
            else { session = try await manager.login(login: login, password: password) }
            guard let session, let sessionID = session.sessionID, let account = session.accountID.flatMap(UUID.init(uuidString:)) else {
                throw NativeError.invalidSession
            }
            let prefix = "gchat.harness." + server.url.absoluteString + "." + sessionID
            let sequences = try HarnessSequences(prefix: prefix)
            let socket = SharedWebSocket(server: server,
                access: { force in try await manager.restore(force: force)?.tokens.access_token },
                readDevice: { _ in UserDefaults.standard.string(forKey: prefix + ".device") },
                saveDevice: { _, value in UserDefaults.standard.set(value, forKey: prefix + ".device") })
            let calls = DirectCallController(accountID: account,
                request: { [weak self] type, payload in
                    let response = try await socket.request(type, payload: payload, publish: false)
                    if type == "call.current" {
                        let phase = (response["call"] as? [String: Any])?["state"] as? String
                        self?.lastCurrent = ["ringing", "connecting", "active", "ended"].contains(phase ?? "") ? phase! : "null"
                        self?.saveDiagnostics()
                    }
                    return response
                },
                media: media,
                readSequence: { sequences.read($0) }, saveSequence: { try sequences.write($0, $1) })
            self.sessions = manager; self.socket = socket; self.calls = calls; accountID = account
            calls.onChange = { [weak self] in self?.changed() }
            calls.onError = { [weak self] code in
                self?.error = "Ошибка звонка: " + code
                self?.saveDiagnostics()
            }
            socket.onState = { [weak self] value in
                self?.online = value == "online"
                self?.calls?.connectionChanged(value)
                self?.saveDiagnostics()
            }
            socket.onNativeMessage = { [weak self, weak calls] message in
                self?.transportMessages += 1
                let type = message["type"] as? String ?? "other"
                let safeType = ["response", "call.updated", "rtc.offer", "rtc.answer", "rtc.ice", "rtc.restart"].contains(type) ? type : "other"
                self?.lastTransportEvent = Date().formatted(date: .omitted, time: .standard) + " · " + safeType
                if let type = message["type"] as? String,
                   ["call.updated", "rtc.offer", "rtc.answer", "rtc.ice", "rtc.restart"].contains(type) {
                    self?.lastCallEvent = Date().formatted(date: .omitted, time: .standard) + " · " + type
                }
                calls?.receive(message)
                self?.saveDiagnostics()
            }
            socket.onInvalidSession = { [weak self] in
                self?.calls?.invalidate(); self?.signedIn = false
                Task { try? await manager.invalidate() }
            }
            UserDefaults.standard.set(server.url.absoluteString, forKey: "gchat.harness.server")
            signedIn = true
            socket.start(sessionID: sessionID)
        } catch { show(error) }
    }

    func restoreIfPresent() async {
        guard !signedIn, !working,
              (try? KeychainSessionStorage(service: Bundle.main.bundleIdentifier! + ".auth").read()) != nil else { return }
        await connect()
    }

    func foreground() async {
        await restoreIfPresent()
        calls?.refreshCurrent()
    }

    func sceneChanged(_ value: String) {
        sceneState = value
        saveDiagnostics()
    }

    private func saveDiagnostics() {
        guard let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return }
        let directory = root.appendingPathComponent("GChatCallHarness", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try Data(diagnostics.utf8).write(to: directory.appendingPathComponent("diagnostics.txt"),
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch { /* Diagnostics must not interrupt a call. */ }
    }

    private func changed() {
        guard let calls, let accountID else { return }
        phase = calls.state.phase?.rawValue ?? "нет звонка"
        muted = calls.muted
        audioConnected = media.connected
        outputDevice = media.outputDevice
        incoming = calls.state.phase == .ringing && calls.state.call?.recipient_id == accountID
        if calls.unavailableOnDevice { error = "Звонок обслуживается другим устройством." }
        system.update(call: calls.state.call, phase: calls.state.phase, accountID: accountID,
            selected: calls.selected, connected: media.connected, unavailable: calls.unavailableOnDevice)
        saveDiagnostics()
    }

    func place() async {
        guard let id = UUID(uuidString: peerID), let calls else { error = "Нужен UUID тестового peer."; return }
        do { try await calls.placeCall(peerID: id) } catch { show(error) }
    }
    func answer() async {
        do { try await system.answer() } catch { show(error) }
    }
    func end() async {
        do { try await system.end() } catch { show(error) }
    }
    func mute() { calls?.setMuted(!muted) }
    func logout() async {
        guard let sessions else { return }
        do {
            if let calls, calls.state.phase != nil, calls.state.phase != .ended { try await calls.endCall() }
            try await sessions.logout()
            calls?.invalidate(); socket?.stop()
            signedIn = false; online = false
        } catch { show(error) }
    }
    private func show(_ cause: Error) {
        error = (cause as? AuthFailure)?.code ?? (cause as? NativeError)?.rawValue ?? "Операция недоступна"
        saveDiagnostics()
    }
}

/// Sequence writes complete before their corresponding ping can enter WSS.
@MainActor private final class HarnessSequences {
    private let prefix: String
    private let url: URL
    private var values: [String: Int64]

    init(prefix: String) throws {
        self.prefix = prefix
        let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true).appendingPathComponent("GChatCallHarness", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        url = root.appendingPathComponent("sequences.json")
        values = FileManager.default.fileExists(atPath: url.path) ? try JSONDecoder().decode([String: Int64].self, from: Data(contentsOf: url)) : [:]
    }
    func read(_ id: UUID) -> Int64 { values[prefix + "." + id.uuidString] ?? 0 }
    func write(_ id: UUID, _ value: Int64) throws {
        var next = values
        next[prefix + "." + id.uuidString] = value
        try JSONEncoder().encode(next).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        values = next
    }
}
