import Foundation
import CoreFoundation

public struct NativeHTTPFailure: Error, Sendable {
    public let kind: String
    public let code: String
    public let diagnosticTransportCode: Int?
    public init(_ kind: String, _ code: String, diagnosticTransportCode: Int? = nil) { self.kind = kind; self.code = code; self.diagnosticTransportCode = diagnosticTransportCode }
    public var json: [String: String] { ["kind": kind, "code": code] }
    public static let cancelled = NativeHTTPFailure("aborted", "CANCELLED")
}

/// The HTTP wire profile is deliberately separate from device commands and WSS limits.
public struct NativeHTTPRequest: Sendable {
    public static let bodyLimit = 8 * 1024 * 1024
    public let cycle: String
    public let id: String
    public let url: URL
    public let method: String
    public let headers: [[String]]
    public let body: Data?
    public let authenticated: Bool

    public init(_ envelope: [String: Any], server: ServerOrigin) throws {
        (cycle, id) = try Self.identity(envelope, request: true)
        guard let request = envelope["request"] as? [String: Any],
              Set(request.keys) == ["url", "method", "headers", "bodyBase64"],
              let rawURL = request["url"] as? String, rawURL.utf8.count <= 8192,
              let url = URL(string: rawURL, relativeTo: server.url)?.absoluteURL,
              server.contains(url), url.fragment == nil,
              let method = request["method"] as? String, Self.token(method),
              let headers = request["headers"] as? [[String]], headers.count <= 128 else { throw Self.invalid }
        // Auth endpoints belong exclusively to SessionManager, including public login.
        let decodedPath = URLComponents(url: url, resolvingAgainstBaseURL: true)?.percentEncodedPath.removingPercentEncoding ?? url.path
        var segments: [String] = []
        for segment in decodedPath.split(separator: "/") {
            if segment == ".." { if !segments.isEmpty { segments.removeLast() } }
            else if segment != "." { segments.append(String(segment).lowercased()) }
        }
        guard segments.prefix(2) != ["api", "auth"] else { throw NativeHTTPFailure("invalid", "FORBIDDEN") }
        guard !["CONNECT", "TRACE", "TRACK"].contains(method.uppercased()) else { throw Self.invalid }
        var names = Set<String>()
        var headerBytes = 0
        for pair in headers {
            guard pair.count == 2, Self.token(pair[0]), !pair[1].unicodeScalars.contains(where: { $0.value == 0 || $0.value == 10 || $0.value == 13 }) else { throw Self.invalid }
            let name = pair[0].lowercased()
            guard !["host", "cookie", "cookie2", "content-length", "transfer-encoding", "connection", "upgrade"].contains(name),
                  !names.contains(name) else { throw Self.invalid }
            names.insert(name)
            headerBytes += pair[0].utf8.count + pair[1].utf8.count
        }
        guard headerBytes <= 65536 else { throw Self.invalid }
        let body: Data?
        if request["bodyBase64"] is NSNull { body = nil }
        else {
            guard let encoded = request["bodyBase64"] as? String else { throw Self.invalid }
            guard encoded.utf8.count <= ((Self.bodyLimit + 2) / 3) * 4 else { throw Self.tooLarge }
            guard let decoded = Data(base64Encoded: encoded), decoded.base64EncodedString() == encoded else { throw Self.invalid }
            guard decoded.count <= Self.bodyLimit else { throw Self.tooLarge }
            body = decoded
        }
        guard !["GET", "HEAD"].contains(method.uppercased()) || body == nil else { throw Self.invalid }
        self.url = url; self.method = method.uppercased(); self.headers = headers; self.body = body
        authenticated = names.contains("authorization")
    }

    public static func identity(_ envelope: [String: Any], request: Bool) throws -> (String, String) {
        let keys: Set<String> = request ? ["httpVersion", "cycleId", "requestId", "request"] : ["httpVersion", "cycleId", "requestId"]
        guard Set(envelope.keys) == keys,
              let version = envelope["httpVersion"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(),
              let cycle = envelope["cycleId"] as? String, UUID(uuidString: cycle) != nil,
              let id = envelope["requestId"] as? String, UUID(uuidString: id) != nil else { throw invalid }
        guard version.doubleValue == 1 else { throw NativeHTTPFailure("unsupported", "UNSUPPORTED_VERSION") }
        return (cycle, id)
    }

    public func urlRequest(accessToken: String?) throws -> URLRequest {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.httpMethod = method; request.httpBody = body; request.httpShouldHandleCookies = false
        for pair in headers where pair[0].lowercased() != "authorization" { request.setValue(pair[1], forHTTPHeaderField: pair[0]) }
        if authenticated {
            guard let accessToken else { throw NativeHTTPFailure("network", "UNAUTHENTICATED") }
            request.setValue("Bearer " + accessToken, forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private static func token(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.allSatisfy { byte in
            (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte) || Array("!#$%&'*+-.^_`|~".utf8).contains(byte)
        }
    }
    static let invalid = NativeHTTPFailure("invalid", "INVALID_ARGUMENT")
    static let tooLarge = NativeHTTPFailure("unsupported", "UNSUPPORTED")
}

public struct NativeHTTPResponse: Sendable {
    public let status: Int
    public let headers: [[String]]
    public let body: Data
    public let url: String
    public var json: [String: Any] {
        // URLSession does not expose a reason phrase (HTTP/2 has none).
        // A localized description is not a valid Fetch statusText.
        ["status": status, "statusText": "",
         "headers": headers, "bodyBase64": body.base64EncodedString(), "url": url]
    }
}

/// Bounded incremental buffering. A fresh ephemeral session never shares cookies or cache.
private final class HTTPTransfer: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<NativeHTTPResponse, Error>?
    private var session: URLSession?
    private var response: HTTPURLResponse?
    private var data = Data()
    private var bodyAllowed = true
    private var ended = false

    func run(_ request: URLRequest, configuration: URLSessionConfiguration) async throws -> NativeHTTPResponse {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                lock.lock()
                guard !ended else { lock.unlock(); continuation.resume(throwing: NativeHTTPFailure.cancelled); return }
                self.continuation = continuation
                let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
                self.session = session
                let task = session.dataTask(with: request)
                lock.unlock()
                task.resume()
            }
        } onCancel: { self.finish(.failure(NativeHTTPFailure.cancelled)) }
    }

    private func finish(_ result: Result<NativeHTTPResponse, Error>) {
        lock.lock()
        guard !ended else { lock.unlock(); return }
        ended = true
        let continuation = self.continuation; self.continuation = nil
        let session = self.session; self.session = nil
        data = Data()
        lock.unlock()
        session?.invalidateAndCancel()
        continuation?.resume(with: result)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
        finish(.failure(NativeHTTPFailure("network", "NETWORK_ERROR")))
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse else {
            completionHandler(.cancel); finish(.failure(NativeHTTPFailure("network", "NETWORK_ERROR"))); return
        }
        guard ![301, 302, 303, 307, 308].contains(http.statusCode) else {
            completionHandler(.cancel); finish(.failure(NativeHTTPFailure("network", "NETWORK_ERROR"))); return
        }
        // HEAD/304 may advertise the size of a representation that is not transferred.
        let bodyAllowed = dataTask.originalRequest?.httpMethod != "HEAD" && ![204, 205, 304].contains(http.statusCode)
        guard !bodyAllowed || response.expectedContentLength <= NativeHTTPRequest.bodyLimit else {
            completionHandler(.cancel); finish(.failure(NativeHTTPRequest.tooLarge)); return
        }
        lock.lock(); self.response = http; self.bodyAllowed = bodyAllowed; let ended = self.ended; lock.unlock()
        completionHandler(ended ? .cancel : .allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
        lock.lock()
        guard !ended, bodyAllowed else { lock.unlock(); return }
        guard data.count <= NativeHTTPRequest.bodyLimit - chunk.count else {
            lock.unlock(); finish(.failure(NativeHTTPRequest.tooLarge)); return
        }
        data.append(chunk)
        lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error {
            let code = (error as NSError).code
            finish(.failure(code == NSURLErrorCancelled ? NativeHTTPFailure.cancelled : NativeHTTPFailure(code == NSURLErrorTimedOut ? "timeout" : "network", code == NSURLErrorTimedOut ? "TIMEOUT" : "NETWORK_ERROR", diagnosticTransportCode: (error as NSError).domain == NSURLErrorDomain ? code : nil)))
            return
        }
        lock.lock()
        let response = self.response; let bytes = data
        lock.unlock()
        guard let response, let url = response.url else { finish(.failure(NativeHTTPFailure("network", "NETWORK_ERROR"))); return }
        let headers = response.allHeaderFields.compactMap { key, value -> [String]? in
            let name = String(describing: key)
            guard !["set-cookie", "set-cookie2"].contains(name.lowercased()) else { return nil }
            return [name, String(describing: value)]
        }
        finish(.success(NativeHTTPResponse(status: response.statusCode, headers: headers,
                                          body: [204, 205, 304].contains(response.statusCode) ? Data() : bytes, url: url.absoluteString)))
    }
}

@MainActor public final class NativeHTTPBridge {
    private let server: ServerOrigin
    private let configuration: URLSessionConfiguration
    private var cycle: String?
    private var generation = UUID()
    private var requests: [String: Task<NativeHTTPResponse, Error>] = [:]
    private var cancelled = Set<String>()
    public init(server: ServerOrigin, protocolClasses: [AnyClass]? = nil) {
        self.server = server
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil; config.httpCookieStorage = nil; config.httpShouldSetCookies = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 30; config.timeoutIntervalForResource = 30
        config.protocolClasses = protocolClasses
        configuration = config
    }

    public func activate(cycle: String?) {
        let cycle = cycle?.lowercased()
        guard self.cycle != cycle else { return }
        reset(); self.cycle = cycle
    }

    public func reset() {
        generation = UUID(); cycle = nil
        for task in requests.values { task.cancel() }
        requests.removeAll(); cancelled.removeAll()
    }

    public func cancel(_ envelope: [String: Any]) throws {
        let (cycle, rawID) = try NativeHTTPRequest.identity(envelope, request: false)
        let id = rawID.lowercased()
        guard self.cycle == cycle.lowercased() else { throw NativeHTTPFailure.cancelled }
        // Fail closed instead of forgetting a cancellation before registration.
        guard cancelled.count < 4096 || cancelled.contains(id) else { reset(); throw NativeHTTPFailure.cancelled }
        cancelled.insert(id); requests[id]?.cancel()
    }

    public func execute(_ envelope: [String: Any], accessToken: @escaping @MainActor () async throws -> String?) async throws -> [String: Any] {
        let request = try NativeHTTPRequest(envelope, server: server)
        let id = request.id.lowercased()
        guard cycle == request.cycle.lowercased(), !cancelled.contains(id) else { throw NativeHTTPFailure.cancelled }
        guard requests[id] == nil, requests.count < 128 else { throw NativeHTTPRequest.invalid }
        let generation = self.generation
        let task = Task<NativeHTTPResponse, Error> { @MainActor in
            let token = request.authenticated ? try await accessToken() : nil
            try Task.checkCancellation()
            let request = try request.urlRequest(accessToken: token)
            return try await HTTPTransfer().run(request, configuration: configuration)
        }
        requests[id] = task
        defer { if self.generation == generation { requests.removeValue(forKey: id) } }
        do {
            let response = try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
            guard self.generation == generation, !cancelled.contains(id), !Task.isCancelled else { throw NativeHTTPFailure.cancelled }
            return ["httpVersion": 1, "cycleId": request.cycle, "requestId": request.id, "result": response.json]
        } catch is CancellationError { throw NativeHTTPFailure.cancelled }
    }
}
