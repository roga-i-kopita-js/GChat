import Foundation

public struct Tokens: Codable, Sendable {
    public let access_token: String
    public let refresh_token: String
    public let token_type: String

    public init(access: String, refresh: String) {
        access_token = access
        refresh_token = refresh
        token_type = "Bearer"
    }
}

public struct PendingRefresh: Codable, Sendable {
    public let refresh_token: String
    public let request_id: String
}

public struct NativeSession: Codable, Sendable {
    public let server: ServerOrigin
    public var tokens: Tokens
    public var pending: PendingRefresh?

    public var sessionID: String? { claims?["sid"] as? String }
    public var accountID: String? { claims?["sub"] as? String }
    private var claims: [String: Any]? {
        let parts = tokens.access_token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        var value = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        value += String(repeating: "=", count: (4 - value.count % 4) % 4)
        guard let data = Data(base64Encoded: value),
              let claims = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return claims
    }
}

public protocol SessionStorage: Sendable {
    func read() throws -> NativeSession?
    func write(_ session: NativeSession?) throws
}

public protocol AuthTransport: Sendable {
    func login(server: ServerOrigin, login: String, password: String) async throws -> Tokens
    func refresh(server: ServerOrigin, pending: PendingRefresh) async throws -> Tokens
    func logout(server: ServerOrigin, refreshToken: String) async throws
}

/// Every auth operation joins one queue. In particular, logout cannot race a rotation.
public actor SessionManager {
    private enum Operation: Sendable {
        case restore(Bool)
        case login(String, String)
        case logout
        case changeServer
        case invalidate
    }

    private let server: ServerOrigin
    private let storage: any SessionStorage
    private let transport: any AuthTransport
    private let onClear: @Sendable (NativeSession) async throws -> Void
    private var tail: Task<NativeSession?, Error>?
    private var blockedUntil: Date?

    public init(server: ServerOrigin, storage: any SessionStorage, transport: any AuthTransport, onClear: @escaping @Sendable (NativeSession) async throws -> Void = { _ in }) {
        self.server = server
        self.storage = storage
        self.transport = transport
        self.onClear = onClear
    }

    /// Device commands need the local session boundary without refreshing over the network.
    public func localSession() throws -> NativeSession? {
        let session = try storage.read()
        if let session, session.server != server { throw NativeError.validation }
        return session
    }

    public func hasLocalDeviceSession() throws -> Bool {
        guard let session = try storage.read() else { return false }
        guard session.server == server else { throw NativeError.validation }
        return true
    }

    public func restore(force: Bool = false) async throws -> NativeSession? {
        try await enqueue(.restore(force))
    }

    public func login(login: String, password: String) async throws -> NativeSession? {
        try await enqueue(.login(login, password))
    }

    public func logout() async throws {
        _ = try await enqueue(.logout)
    }

    public func prepareServerChange() async throws {
        _ = try await enqueue(.changeServer)
    }

    /// Only for a confirmed SESSION_INVALID response from the authenticated transport.
    public func invalidate() async throws { _ = try await enqueue(.invalidate) }

    private func enqueue(_ operation: Operation) async throws -> NativeSession? {
        let previous = tail
        let next = Task {
            _ = await previous?.result
            return try await executeWithRetryWindow(operation)
        }
        tail = next
        return try await next.value
    }

    private func executeWithRetryWindow(_ operation: Operation) async throws -> NativeSession? {
        do { return try await execute(operation) }
        catch let failure as AuthFailure {
            if failure.code == "RATE_LIMITED", failure.retryAfter.isFinite, failure.retryAfter > 0 {
                blockedUntil = Date().addingTimeInterval(failure.retryAfter)
            }
            throw failure
        }
    }

    private func checkRetryWindow() throws {
        if let blockedUntil, blockedUntil > Date() {
            throw AuthFailure(code: "RATE_LIMITED", retryAfter: blockedUntil.timeIntervalSinceNow)
        }
    }

    private func execute(_ operation: Operation) async throws -> NativeSession? {
        var session = try storage.read()
        if let session, session.server != server { throw NativeError.validation }

        switch operation {
        case .invalidate:
            if let session { try await onClear(session) }
            try storage.write(nil)
            return nil
        case .changeServer:
            guard session == nil else { throw NativeError.validation }
            return nil

        case .login(let login, let password):
            guard session == nil, !login.isEmpty, !password.isEmpty else {
                throw NativeError.validation
            }
            try checkRetryWindow()
            let tokens = try await transport.login(server: server, login: login, password: password)
            try validate(tokens)
            let next = NativeSession(server: server, tokens: tokens, pending: nil)
            try storage.write(next)
            return next

        case .restore(let force):
            guard var current = session else { return nil }
            if !force && current.pending == nil && isFresh(current.tokens.access_token) {
                return current
            }
            try checkRetryWindow()
            let pending = current.pending ?? PendingRefresh(
                refresh_token: current.tokens.refresh_token, request_id: UUID().uuidString
            )
            current.pending = pending
            // Persist before sending: an unknown response must retry the same request after restart.
            try storage.write(current)
            do {
                let tokens = try await transport.refresh(server: server, pending: pending)
                try validate(tokens)
                current.tokens = tokens
                current.pending = nil
                try storage.write(current)
                return current
            } catch NativeError.invalidSession {
                try await onClear(current)
                try storage.write(nil)
                throw NativeError.invalidSession
            }

        case .logout:
            guard let current = session else { return nil }
            // Resolve any unknown rotation before logout: an older token can yield 204
            // without revoking the current server session.
            if current.pending != nil { session = try await execute(.restore(true)) }
            guard let current = session else { return nil }
            try checkRetryWindow()
            try await transport.logout(server: server, refreshToken: current.tokens.refresh_token)
            try await onClear(current)
            try storage.write(nil)
            return nil
        }
    }

    private func validate(_ tokens: Tokens) throws {
        guard tokens.token_type == "Bearer", !tokens.refresh_token.isEmpty,
              claims(tokens.access_token) != nil else { throw NativeError.validation }
    }

    private func claims(_ token: String) -> [String: Any]? {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        var base64 = String(parts[1]).replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              value["sid"] is String, value["exp"] is NSNumber else { return nil }
        return value
    }

    private func isFresh(_ token: String) -> Bool {
        guard let expiration = claims(token)?["exp"] as? NSNumber else { return false }
        return expiration.doubleValue > Date().timeIntervalSince1970 + 15
    }
}
