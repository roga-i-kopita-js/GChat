import Capacitor
import GChatCore

@objc(GChatPlugin)
final class GChatPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "GChatPlugin"
    let jsName = "GChat"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "webReady", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "login", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "logout", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAccessToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "placeCall", returnType: CAPPluginReturnPromise)
    ]

    private let server: ServerOrigin
    private let sessions: SessionManager
    private var cycle: String?
    private var authRevision = 0
    private var lastRoute = "/calls"

    init(server: ServerOrigin, sessions: SessionManager) {
        self.server = server
        self.sessions = sessions
        super.init()
    }

    func invalidateCycle() { cycle = nil }

    @objc func getCapabilities(_ call: CAPPluginCall) {
        call.resolve(["bridgeVersion": 1, "platform": "ios", "nativeAuth": true, "nativeCalls": false])
    }

    @objc func webReady(_ call: CAPPluginCall) {
        guard call.getInt("bridgeVersion") == 1 else {
            call.reject("Unsupported bridge", "UNSUPPORTED_VERSION")
            return
        }
        guard let cycle = call.getString("cycleId"), UUID(uuidString: cycle) != nil else {
            reject(call, NativeError.validation)
            return
        }
        self.cycle = cycle
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

    @objc func login(_ call: CAPPluginCall) {
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

    @objc func logout(_ call: CAPPluginCall) {
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

    @objc func getAccessToken(_ call: CAPPluginCall) {
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

    @objc func placeCall(_ call: CAPPluginCall) {
        // No call.create or fake successful acknowledgement until Gate 1 provides an engine.
        call.reject("Native calls are not installed", "BRIDGE_UNAVAILABLE")
    }

    private func sendLoggedOut(_ cycle: String) {
        lastRoute = "/calls"
        notifyListeners("loggedOut", data: ["cycleId": cycle])
    }

    private func sendState(_ session: NativeSession?, cycle: String) {
        var route: [String: Any] = [
            "cycleId": cycle, "path": session == nil ? server.loginRoute : lastRoute, "replace": true
        ]
        if let session { route["accessToken"] = session.tokens.access_token }
        notifyListeners("route", data: route)
        notifyListeners("callSnapshot", data: [
            "cycleId": cycle, "call": NSNull(), "runtime": ["status": "offline", "muted": false]
        ])
    }

    private func reject(_ call: CAPPluginCall, _ error: Error) {
        if let failure = error as? AuthFailure {
            call.reject("Authentication failed", failure.code, nil, ["retryAfter": failure.retryAfter])
        } else {
            call.reject("Native operation failed", (error as? NativeError)?.rawValue ?? NativeError.network.rawValue)
        }
    }
}
