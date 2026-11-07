import Capacitor
import Foundation
import GChatCore

@objc(GChatPlugin)
@MainActor final class GChatPlugin: CAPPlugin, CAPBridgedPlugin {
    nonisolated let identifier = "GChatPlugin"
    nonisolated let jsName = "GChat"
    nonisolated var pluginMethods: [CAPPluginMethod] { [
        CAPPluginMethod(name: "getDialogStorageContext", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dialogStorage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "consumeDialogNotificationIntent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "webReady", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "login", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "logout", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAccessToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "placeCall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendWsMessage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "executeDeviceCommand", returnType: CAPPluginReturnPromise)
    ] }

    private lazy var device = DeviceController(presenter: { [weak self] in self?.bridge?.viewController })
    private var deviceRequests = Set<String>()
    private let server: ServerOrigin
    private let sessions: SessionManager
    private let transport: SharedWebSocket
    private var cycle: String?
    private var authRevision = 0
    private var lastRoute = "/calls"
    private var dialogs: DialogStorage?
    private var dialogAccount: String?
    private var notificationObserver: NSObjectProtocol?
    private var notificationIntent: [String: String]?
    private var notificationAccount: String?

    private func dialogStore() throws -> DialogStorage {
        if let dialogs { return dialogs }
        let store = try ChatLocalStorage.forServer(server)
        dialogs = store
        return store
    }

    init(server: ServerOrigin, sessions: SessionManager, transport: SharedWebSocket) {
        self.server = server
        self.sessions = sessions
        self.transport = transport
        super.init()
        ChatNotifications.shared.attach(transport)
        ChatNotifications.shared.visibleDialog = { [weak self] in
            guard let self, UIApplication.shared.applicationState == .active, let url = self.webView?.url,
                  self.server.allowsDocument(url), url.path.hasPrefix("/apps/client/dialogs/") else { return nil }
            let id = String(url.path.dropFirst("/apps/client/dialogs/".count))
            return UUID(uuidString: id) != nil ? id : nil
        }
        notificationObserver = NotificationCenter.default.addObserver(forName: .gchatDialogIntent, object: nil, queue: .main) { [weak self] notification in
            MainActor.assumeIsolated {
                guard let self, let dialog = notification.userInfo?["dialogId"] as? String, UUID(uuidString: dialog) != nil else { return }
                self.notificationIntent = ["intentId": UUID().uuidString.lowercased(), "dialogId": dialog]
                _ = ChatNotifications.shared.takePending()
                self.notificationAccount = self.dialogAccount
                self.deliverNotificationIntent()
            }
        }
        transport.onWebMessage = { [weak self] cycle, message in
            guard let self, self.cycle == cycle else { return }
            self.notifyListeners("wsMessage", data: ["cycleId": cycle, "message": message])
        }
        transport.onState = { [weak self] status in
            ChatNotifications.shared.connectionChanged()
            guard let self, let cycle = self.cycle else { return }
            self.notifyListeners("wsState", data: ["cycleId": cycle, "status": status])
        }
        transport.onInvalidSession = { [weak self] in
            guard let self else { return }
            self.authRevision += 1
            let revision = self.authRevision
            if let cycle = self.cycle { self.sendLoggedOut(cycle) }
            Task { @MainActor in
                do {
                    try await self.sessions.invalidate()
                    guard self.authRevision == revision, let cycle = self.cycle else { return }
                    self.sendState(nil, cycle: cycle)
                } catch {
                    // Storage failure must not route Web back into the revoked session.
                    self.invalidateCycle()
                }
            }
        }
    }

    func invalidateCycle() { device.reset(); cycle = nil; transport.attach(cycle: nil) }

    // Capacitor invokes Objective-C selectors on its background bridge queue.
    @objc nonisolated func getCapabilities(_ call: CAPPluginCall) {
        Task { @MainActor in self.handleGetCapabilities(call) }
    }

    private func handleGetCapabilities(_ call: CAPPluginCall) {
        call.resolve(["bridgeVersion": 1, "platform": "ios", "nativeAuth": true, "nativeCalls": false, "nativeWebSocket": true, "dialogStorageVersion": 1, "dialogNotificationsVersion": 1])
    }

    @objc nonisolated func webReady(_ call: CAPPluginCall) {
        Task { @MainActor in self.handleWebReady(call) }
    }

    private func handleWebReady(_ call: CAPPluginCall) {
        guard call.getInt("bridgeVersion") == 1 else {
            call.reject("Unsupported bridge", "UNSUPPORTED_VERSION")
            return
        }
        guard let cycle = call.getString("cycleId"), UUID(uuidString: cycle) != nil else {
            reject(call, NativeError.validation)
            return
        }
        if self.cycle != cycle { device.reset() }
        self.cycle = cycle
        transport.attach(cycle: cycle)
        let revision = authRevision
        // Keep React Router's current page across foreground resynchronization.
        if let url = webView?.url, server.allowsDocument(url) {
            let path = String(url.path.dropFirst("/apps/client".count))
            if path == "/settings" || path == "/settings/general" || ["microphone", "audio", "push", "camera", "geolocation", "files"].contains(where: { path == "/settings/general/" + $0 }) || path == "/calls" || path == "/dialogs" || (path.hasPrefix("/dialogs/") && UUID(uuidString: String(path.dropFirst("/dialogs/".count))) != nil) || path == "/admin" || path == "/admin/users" ||
                (path.hasPrefix("/admin/users/") && UUID(uuidString: String(path.dropFirst("/admin/users/".count))) != nil) {
                lastRoute = path
                ChatNotifications.shared.openDialog = path.hasPrefix("/dialogs/") ? String(path.dropFirst("/dialogs/".count)) : nil
            }
        }
        Task { @MainActor in
            do {
                let session = try await sessions.restore(force: true)
                guard self.cycle == cycle, authRevision == revision else { reject(call, NativeError.unavailable); return }
                sendState(session, cycle: cycle)
                call.resolve()
            } catch {
                guard self.cycle == cycle, authRevision == revision else { reject(call, NativeError.unavailable); return }
                if case NativeError.invalidSession = error {
                    sendLoggedOut(cycle)
                    sendState(nil, cycle: cycle)
                    call.resolve()
                } else { reject(call, error) }
            }
        }
    }

    @objc nonisolated func login(_ call: CAPPluginCall) {
        Task { @MainActor in self.handleLogin(call) }
    }

    private func handleLogin(_ call: CAPPluginCall) {
        guard let cycle, let value = call.getString("serverUrl"),
              (try? ServerOrigin(value)) == server,
              let login = call.getString("login"), let password = call.getString("password") else {
            reject(call, NativeError.validation)
            return
        }
        authRevision += 1
        let revision = authRevision
        Task { @MainActor in
            do {
                let session = try await sessions.login(login: login, password: password)
                guard self.cycle == cycle, authRevision == revision else { reject(call, NativeError.unavailable); return }
                lastRoute = "/calls"
                sendState(session, cycle: cycle)
                call.resolve()
            } catch { reject(call, error) }
        }
    }

    @objc nonisolated func logout(_ call: CAPPluginCall) {
        Task { @MainActor in self.handleLogout(call) }
    }

    private func handleLogout(_ call: CAPPluginCall) {
        guard let cycle else { reject(call, NativeError.unavailable); return }
        authRevision += 1
        let revision = authRevision
        Task { @MainActor in
            do {
                try await sessions.logout()
                if self.cycle == cycle, authRevision == revision {
                    sendLoggedOut(cycle)
                    sendState(nil, cycle: cycle)
                }
                call.resolve()
            } catch {
                if self.cycle == cycle, authRevision == revision, case NativeError.invalidSession = error {
                    sendLoggedOut(cycle)
                    sendState(nil, cycle: cycle)
                }
                reject(call, error)
            }
        }
    }

    @objc nonisolated func getAccessToken(_ call: CAPPluginCall) {
        Task { @MainActor in self.handleGetAccessToken(call) }
    }

    private func handleGetAccessToken(_ call: CAPPluginCall) {
        guard let cycle, let force = call.getBool("forceRefresh") else {
            reject(call, NativeError.validation)
            return
        }
        let revision = authRevision
        Task { @MainActor in
            do {
                guard let session = try await sessions.restore(force: force) else {
                    throw NativeError.invalidSession
                }
                guard self.cycle == cycle, authRevision == revision else { reject(call, NativeError.unavailable); return }
                call.resolve(["accessToken": session.tokens.access_token])
            } catch {
                if self.cycle == cycle, authRevision == revision, case NativeError.invalidSession = error {
                    sendLoggedOut(cycle)
                    sendState(nil, cycle: cycle)
                }
                reject(call, error)
            }
        }
    }

    @objc nonisolated func getDialogStorageContext(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                guard let cycle = call.getString("cycleId"), self.cycle == cycle,
                      let options = call.options as? [String: Any], Set(options.keys) == ["cycleId"],
                      let session = try await self.sessions.localSession(), let account = session.accountID,
                      let sid = session.sessionID, let device = self.transport.boundDeviceID else { throw DialogStorageFailure("STORAGE_STALE_CONTEXT") }
                guard self.cycle == cycle else { throw DialogStorageFailure("STORAGE_STALE_CONTEXT") }
                self.dialogAccount = account
                call.resolve(try self.dialogStore().context(account: account, session: sid, device: device, cycle: cycle))
            } catch { call.reject("Dialog storage unavailable", (error as? DialogStorageFailure)?.code ?? "STORAGE_UNAVAILABLE") }
        }
    }

    @objc nonisolated func dialogStorage(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                guard let options = call.options as? [String: Any], let cycle = options["cycleId"] as? String, self.cycle == cycle,
                      let session = try await self.sessions.localSession(), let account = session.accountID,
                      let sid = session.sessionID, let device = self.transport.boundDeviceID else { throw DialogStorageFailure("STORAGE_STALE_CONTEXT") }
                guard self.cycle == cycle else { throw DialogStorageFailure("STORAGE_STALE_CONTEXT") }
                call.resolve(try self.dialogStore().execute(options, account: account, session: sid, device: device, cycle: cycle))
            } catch { call.reject("Dialog storage operation failed", (error as? DialogStorageFailure)?.code ?? "STORAGE_UNAVAILABLE") }
        }
    }

    @objc nonisolated func consumeDialogNotificationIntent(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard let cycle = call.getString("cycleId"), self.cycle == cycle,
                  let id = call.getString("intentId"), let options = call.options as? [String: Any],
                  Set(options.keys) == ["cycleId", "intentId"] else { call.reject("Invalid intent", "VALIDATION_ERROR"); return }
            if self.notificationIntent?["intentId"] == id { self.notificationIntent = nil }
            call.resolve()
        }
    }

    private func deliverNotificationIntent() {
        if notificationIntent == nil, let dialog = ChatNotifications.shared.takePending() { notificationIntent = ["intentId": UUID().uuidString.lowercased(), "dialogId": dialog] }
        guard let cycle, let intent = notificationIntent else { return }
        notifyListeners("dialogNotificationIntent", data: ["cycleId": cycle, "intentId": intent["intentId"]!, "dialogId": intent["dialogId"]!])
    }

    @objc nonisolated func placeCall(_ call: CAPPluginCall) {
        Task { @MainActor in self.handlePlaceCall(call) }
    }

    private func handlePlaceCall(_ call: CAPPluginCall) {
        // No call.create or fake successful acknowledgement until Gate 1 provides an engine.
        call.reject("Native calls are not installed", "BRIDGE_UNAVAILABLE")
    }

    @objc nonisolated func sendWsMessage(_ call: CAPPluginCall) {
        Task { @MainActor in self.handleSendWsMessage(call) }
    }

    private func handleSendWsMessage(_ call: CAPPluginCall) {
        guard let cycle = call.getString("cycleId"), self.cycle == cycle,
              let message = call.getObject("message"),
              let options = call.options as? [String: Any],
              Set(options.keys) == ["cycleId", "message"] else {
            reject(call, NativeError.validation)
            return
        }
        Task { @MainActor in
            do {
                try await transport.sendWeb(cycle: cycle, message: message)
                call.resolve()
            } catch { reject(call, error) }
        }
    }

    @objc nonisolated func executeDeviceCommand(_ call: CAPPluginCall) {
        Task { @MainActor in
            let envelope: DeviceCommandEnvelope
            do { guard let options = call.options as? [String: Any] else { throw DeviceCommandError("INVALID_ARGUMENT") }; envelope = try DeviceCommandEnvelope(options) }
            catch { call.reject("Invalid device command", (error as? DeviceCommandError)?.code ?? "INVALID_ARGUMENT"); return }
            let cycle = envelope.cycle; let request = envelope.request
            guard self.cycle == cycle else { call.reject("Inactive document", "CANCELLED"); return }
            guard envelope.command.name == "device.changes.cancel" || (self.deviceRequests.count < 128 && !self.deviceRequests.contains(request)) else { call.reject("Too many device commands", "BUSY"); return }
            if envelope.command.name == "device.changes.cancel", !self.deviceRequests.contains(request) {
                call.resolve(["deviceBridgeVersion": 1, "cycleId": cycle, "requestId": request, "result": ["outcome": "completed"]]); return
            }
            let revision = self.authRevision
            if envelope.command.name != "device.changes.cancel" { self.deviceRequests.insert(request) }
            defer { if envelope.command.name != "device.changes.cancel" { self.deviceRequests.remove(request) } }
            var response: [String: Any] = ["deviceBridgeVersion": 1, "cycleId": cycle, "requestId": request]
            do {
                let command = envelope.command
                // Reading the local secure session avoids a network dependency for device settings.
                guard try await self.sessions.hasLocalDeviceSession() else { throw DeviceCommandError("UNAUTHENTICATED") }
                guard self.cycle == cycle, self.authRevision == revision else { throw DeviceCommandError("CANCELLED") }
                let result = try await self.device.execute(command, requestId: request)
                guard self.cycle == cycle, self.authRevision == revision else { throw DeviceCommandError("CANCELLED") }
                response["result"] = result
            } catch {
                if let failure = error as? DeviceCommandError { response["error"] = ["code": failure.code].merging(failure.details) { _, next in next } }
                else {
                    let value = error as NSError
                    let codes: [Int: String] = [NSFileNoSuchFileError: "NOT_FOUND", NSFileReadNoSuchFileError: "NOT_FOUND", NSFileReadNoPermissionError: "ACCESS_LOST", NSFileWriteNoPermissionError: "PERMISSION_DENIED", NSFileWriteOutOfSpaceError: "STORAGE_FULL", NSFileWriteFileExistsError: "ALREADY_EXISTS"]
                    response["error"] = ["code": value.domain == NSCocoaErrorDomain ? (codes[value.code] ?? "IO_ERROR") : "IO_ERROR"]
                }
            }
            call.resolve(response)
        }
    }

    private func sendLoggedOut(_ cycle: String) {
        notificationIntent = nil
        notificationAccount = nil
        ChatNotifications.shared.clearIntent()
        device.reset()
        transport.stop()
        lastRoute = "/calls"
        notifyListeners("loggedOut", data: ["cycleId": cycle])
    }

    private func sendState(_ session: NativeSession?, cycle: String) {
        if let session, let account = session.accountID {
            if let expected = notificationAccount, expected != account { notificationIntent = nil }
            notificationAccount = account
            dialogAccount = account
        }
        if let id = session?.sessionID { transport.start(sessionID: id) }
        else { transport.stop() }
        var route: [String: Any] = [
            "cycleId": cycle, "path": session == nil ? server.loginRoute : lastRoute, "replace": true
        ]
        if let session { route["accessToken"] = session.tokens.access_token }
        notifyListeners("route", data: route)
        notifyListeners("callSnapshot", data: [
            "cycleId": cycle, "call": NSNull(), "runtime": ["status": "offline", "muted": false]
        ])
        notifyListeners("wsState", data: ["cycleId": cycle, "status": transport.status])
    }

    private func reject(_ call: CAPPluginCall, _ error: Error) {
        if let failure = error as? AuthFailure {
            call.reject("Authentication failed", failure.code, nil, ["retryAfter": failure.retryAfter])
        } else {
            call.reject("Native operation failed", (error as? NativeError)?.rawValue ?? NativeError.network.rawValue)
        }
    }
}
