import Capacitor
import Foundation
import GChatCore

@objc(GChatPlugin)
@MainActor final class GChatPlugin: CAPPlugin, CAPBridgedPlugin {
    nonisolated let identifier = "GChatPlugin"
    nonisolated let jsName = "GChat"
    nonisolated var pluginMethods: [CAPPluginMethod] { [
        CAPPluginMethod(name: "getCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "webReady", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "login", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "logout", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAccessToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "placeCall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendWsMessage", returnType: CAPPluginReturnPromise)
    ] }

    private let server: ServerOrigin
    private let sessions: SessionManager
    private let transport: SharedWebSocket
    private var cycle: String?
    private var authRevision = 0
    private var lastRoute = "/calls"

    init(server: ServerOrigin, sessions: SessionManager, transport: SharedWebSocket) {
        self.server = server
        self.sessions = sessions
        self.transport = transport
        super.init()
        transport.onWebMessage = { [weak self] cycle, message in
            guard let self, self.cycle == cycle else { return }
            self.notifyListeners("wsMessage", data: ["cycleId": cycle, "message": message])
        }
        transport.onState = { [weak self] status in
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

    func invalidateCycle() { cycle = nil; transport.attach(cycle: nil) }

    // Capacitor invokes Objective-C selectors on its background bridge queue.
    @objc nonisolated func getCapabilities(_ call: CAPPluginCall) {
        Task { @MainActor in self.handleGetCapabilities(call) }
    }

    private func handleGetCapabilities(_ call: CAPPluginCall) {
        call.resolve(["bridgeVersion": 1, "platform": "ios", "nativeAuth": true, "nativeCalls": false, "nativeWebSocket": true])
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
        self.cycle = cycle
        transport.attach(cycle: cycle)
        let revision = authRevision
        // Keep React Router's current page across foreground resynchronization.
        if let url = webView?.url, server.allowsDocument(url) {
            let path = String(url.path.dropFirst("/apps/client".count))
            if path == "/calls" || path == "/admin" || path == "/admin/users" ||
                (path.hasPrefix("/admin/users/") && UUID(uuidString: String(path.dropFirst("/admin/users/".count))) != nil) {
                lastRoute = path
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

    private func sendLoggedOut(_ cycle: String) {
        transport.stop()
        lastRoute = "/calls"
        notifyListeners("loggedOut", data: ["cycleId": cycle])
    }

    private func sendState(_ session: NativeSession?, cycle: String) {
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
