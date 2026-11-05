import Foundation

public struct AuthFailure: Error, Sendable {
    public let code: String
    public let retryAfter: Double
}

public final class HTTPAuthTransport: NSObject, AuthTransport, URLSessionTaskDelegate, @unchecked Sendable {
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.timeoutIntervalForRequest = 20
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    public override init() { super.init() }

    public func login(server: ServerOrigin, login: String, password: String) async throws -> Tokens {
        try await tokens(server, "login", ["login": login, "password": password])
    }

    public func refresh(server: ServerOrigin, pending: PendingRefresh) async throws -> Tokens {
        try await tokens(server, "refresh", ["refresh_token": pending.refresh_token, "request_id": pending.request_id])
    }

    public func logout(server: ServerOrigin, refreshToken: String) async throws {
        _ = try await post(server, "logout", ["refresh_token": refreshToken])
    }

    private func tokens(_ server: ServerOrigin, _ endpoint: String, _ body: [String: String]) async throws -> Tokens {
        let data = try await post(server, endpoint, body)
        guard let tokens = try? JSONDecoder().decode(Tokens.self, from: data) else { throw NativeError.validation }
        return tokens
    }

    private func post(_ server: ServerOrigin, _ endpoint: String, _ body: [String: String]) async throws -> Data {
        var request = URLRequest(url: server.url.appendingPathComponent("api/auth/" + endpoint))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let result: (Data, URLResponse)
        do { result = try await session.data(for: request) }
        catch { throw NativeError.network }
        guard let response = result.1 as? HTTPURLResponse else { throw NativeError.network }
        let expected = endpoint == "logout" ? 204 : 200
        guard response.statusCode == expected else {
            let json = (try? JSONSerialization.jsonObject(with: result.0)) as? [String: Any]
            let details = json?["error"] as? [String: Any]
            let code = details?["code"] as? String ?? "NETWORK_ERROR"
            if code == "SESSION_INVALID" { throw NativeError.invalidSession }
            throw AuthFailure(code: code, retryAfter: Double(response.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 0)
        }
        return result.0
    }

    // Never replay credentials at a redirect destination, including a same-origin redirect.
    public func urlSession(_ session: URLSession, task: URLSessionTask,
                           willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest,
                           completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
