import XCTest
@testable import GChatCore

private final class MemoryStorage: SessionStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var value: NativeSession?
    var failWrites = false

    func read() throws -> NativeSession? {
        lock.lock(); defer { lock.unlock() }
        return value
    }
    func write(_ session: NativeSession?) throws {
        lock.lock(); defer { lock.unlock() }
        if failWrites { throw NativeError.storage }
        value = session
    }
}

private func tokens(_ suffix: String) -> Tokens {
    let data = try! JSONSerialization.data(withJSONObject: [
        "sid": "test-session", "exp": Date().timeIntervalSince1970 + 3600
    ])
    let payload = data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    return Tokens(access: "e30.\(payload).signature", refresh: suffix)
}

private actor Transport: AuthTransport {
    var refreshes: [PendingRefresh] = []
    var logouts: [String] = []
    var failRefresh = false
    var failLogout = false
    var invalid = false
    var pause = false
    var continuation: CheckedContinuation<Void, Never>?
    var pauseWaiter: CheckedContinuation<Void, Never>?

    func configure(refresh: Bool = false, logout: Bool = false, invalid: Bool = false, pause: Bool = false) {
        failRefresh = refresh; failLogout = logout; self.invalid = invalid; self.pause = pause
    }
    func login(server: ServerOrigin, login: String, password: String) async throws -> Tokens { tokens("first") }
    func refresh(server: ServerOrigin, pending: PendingRefresh) async throws -> Tokens {
        refreshes.append(pending)
        if pause {
            await withCheckedContinuation {
                continuation = $0
                pauseWaiter?.resume()
                pauseWaiter = nil
            }
        }
        if invalid { throw NativeError.invalidSession }
        if failRefresh { throw NativeError.network }
        return tokens("rotated")
    }
    func logout(server: ServerOrigin, refreshToken: String) async throws {
        logouts.append(refreshToken)
        if failLogout { throw NativeError.network }
    }
    func resume() { continuation?.resume(); continuation = nil }
    func waitUntilPaused() async {
        if continuation != nil { return }
        await withCheckedContinuation { pauseWaiter = $0 }
    }
}

final class SessionTests: XCTestCase {
    private let server = try! ServerOrigin("https://chat.example")

    func testLogoutWaitsForCacheBarrierAndDoesNotPretendFailedCleanupSucceeded() async throws {
        let storage = MemoryStorage(), transport = Transport()
        let manager = SessionManager(server: server, storage: storage, transport: transport, onClear: { _ in throw NativeError.storage })
        _ = try await manager.login(login: "anna", password: "password")
        do { try await manager.logout(); XCTFail("Cleanup failure must be reported") }
        catch { XCTAssertEqual(error as? NativeError, .storage) }
        XCTAssertNotNil(try storage.read())
        let calls = await transport.logouts
        XCTAssertEqual(calls.count, 1)
    }

    func testServerBoundary() throws {
        XCTAssertEqual(try ServerOrigin("https://CHAT.example:443/"), server)
        for value in ["http://chat.example", "https://u:p@chat.example", "https://chat.example/path",
                      "https://chat.example?x=1", "https://chat.example#x", "https://chat.example:0"] {
            XCTAssertThrowsError(try ServerOrigin(value))
        }
        for value in ["https://chat.example.attacker/apps/client", "https://chat.example:444/apps/client",
                      "http://chat.example/apps/client", "https://chat.example/apps/client-malicious",
                      "https://chat.example/other"] {
            XCTAssertFalse(server.allowsDocument(URL(string: value)!))
        }
        XCTAssertTrue(server.allowsDocument(server.launchURL))
        XCTAssertEqual(URLComponents(url: server.launchURL, resolvingAgainstBaseURL: false)?.queryItems?.first?.value,
                       server.url.absoluteString)
    }

    func testUnknownRefreshReusesPersistedRequestAfterRestart() async throws {
        let store = MemoryStorage(), transport = Transport()
        let manager = SessionManager(server: server, storage: store, transport: transport)
        _ = try await manager.login(login: "test", password: "test")
        await transport.configure(refresh: true)
        do { _ = try await manager.restore(force: true); XCTFail("Expected network failure") }
        catch { XCTAssertEqual(error as? NativeError, .network) }
        let persisted = try XCTUnwrap(store.read()?.pending)
        await transport.configure()
        let restarted = SessionManager(server: server, storage: store, transport: transport)
        _ = try await restarted.restore()
        let calls = await transport.refreshes
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[0].request_id, persisted.request_id)
        XCTAssertEqual(calls[1].request_id, persisted.request_id)
        XCTAssertEqual(calls[1].refresh_token, persisted.refresh_token)
        XCTAssertNil(try store.read()?.pending)
    }

    func testLogoutWaitsForRefreshAndCannotResurrectSession() async throws {
        let store = MemoryStorage(), transport = Transport()
        let manager = SessionManager(server: server, storage: store, transport: transport)
        _ = try await manager.login(login: "test", password: "test")
        await transport.configure(pause: true)
        let refresh = Task { try await manager.restore(force: true) }
        await transport.waitUntilPaused()
        let logout = Task { try await manager.logout() }
        await transport.resume()
        _ = try await refresh.value
        try await logout.value
        let logouts = await transport.logouts
        XCTAssertEqual(logouts, ["rotated"])
        XCTAssertNil(try store.read())
    }

    func testUnknownLogoutRetainsSessionUntilConfirmed() async throws {
        let store = MemoryStorage(), transport = Transport()
        let manager = SessionManager(server: server, storage: store, transport: transport)
        _ = try await manager.login(login: "test", password: "test")
        await transport.configure(logout: true)
        do { try await manager.logout(); XCTFail("Expected network failure") }
        catch { XCTAssertEqual(error as? NativeError, .network) }
        XCTAssertNotNil(try store.read())
        await transport.configure()
        try await manager.logout()
        XCTAssertNil(try store.read())
    }

    func testStorageFailureDoesNotCompleteLogin() async throws {
        let store = MemoryStorage(), transport = Transport()
        store.failWrites = true
        let manager = SessionManager(server: server, storage: store, transport: transport)
        do { _ = try await manager.login(login: "test", password: "test"); XCTFail("Expected storage failure") }
        catch { XCTAssertEqual(error as? NativeError, .storage) }
        XCTAssertNil(try store.read())
    }

    func testInvalidSessionClearsTokensAndCrossServerAccessFails() async throws {
        let store = MemoryStorage(), transport = Transport()
        let manager = SessionManager(server: server, storage: store, transport: transport)
        _ = try await manager.login(login: "test", password: "test")
        let other = SessionManager(server: try ServerOrigin("https://other.example"), storage: store, transport: transport)
        do { _ = try await other.restore(); XCTFail("Expected origin mismatch") }
        catch { XCTAssertEqual(error as? NativeError, .validation) }
        await transport.configure(invalid: true)
        do { _ = try await manager.restore(force: true); XCTFail("Expected invalid session") }
        catch { XCTAssertEqual(error as? NativeError, .invalidSession) }
        XCTAssertNil(try store.read())
    }
}
