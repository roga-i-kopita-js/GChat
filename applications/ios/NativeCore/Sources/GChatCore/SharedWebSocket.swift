import Foundation

public struct WebSocketPolicy: Decodable {
    public struct Restriction: Decodable {
        public let direction: String
        public let message_pattern: String
    }
    public let restrictions: [Restriction]

    public init(data: Data) throws {
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.restrictions.count <= 512, value.restrictions.allSatisfy({
            ["send", "receive"].contains($0.direction) && $0.message_pattern.count <= 128 &&
            $0.message_pattern.range(of: "^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)*([.][*])?$", options: .regularExpression) != nil
        }) else { throw NativeError.validation }
        self = value
    }

    public func allows(_ direction: String, type: String) -> Bool {
        !restrictions.contains {
            guard $0.direction == direction else { return false }
            let pattern = $0.message_pattern
            return pattern.hasSuffix(".*") ? type.hasPrefix(String(pattern.dropLast())) : type == pattern
        }
    }
}

/// Injectable network boundary; all messages are text and limited before JSON parsing.
@MainActor public protocol NativeSocket: AnyObject {
    func send(_ text: String) async throws
    func receive() async throws -> String
    func close()
}

/// One connection per native session. WebView cycles only attach/detach consumers.
@MainActor public final class SharedWebSocket {
    public private(set) var status = "offline"
    public var boundDeviceID: String? { sessionID.flatMap { readDevice($0) } }
    public var onState: ((String) -> Void)?
    public var onNativeState: ((String) -> Void)?
    public var onWebMessage: ((String, [String: Any]) -> Void)?
    public var onNativeMessage: (([String: Any]) -> Void)?
    public var onInvalidSession: (() -> Void)?
    public var onNativeInvalidSession: (() -> Void)?

    private struct Pending {
        let type: String
        let webID: String?
        let cycle: String?
        let publish: Bool
        let continuation: CheckedContinuation<[String: Any], Error>?
        let timeout: Task<Void, Never>
    }
    private let server: ServerOrigin
    private let access: (Bool) async throws -> String?
    private let factory: @MainActor (URLRequest) -> any NativeSocket
    private let readDevice: (String) -> String?
    private let saveDevice: (String, String) -> Void
    private var sessionID: String?
    private var cycle: String?
    private var generation = 0
    private var runner: Task<Void, Never>?
    private var socket: (any NativeSocket)?
    private var pending: [String: Pending] = [:]
    private var policy: WebSocketPolicy?
    private var policyAt: Date?
    private var writeTail: Task<Void, Error>?
    private var queuedBytes = 0
    private var webSends: [Date] = []

    public init(server: ServerOrigin, access: @escaping (Bool) async throws -> String?,
                readDevice: @escaping (String) -> String?, saveDevice: @escaping (String, String) -> Void,
                factory: (@MainActor (URLRequest) -> any NativeSocket)? = nil) {
        self.server = server
        self.access = access
        self.factory = factory ?? { URLSessionNativeSocket(request: $0) }
        self.readDevice = readDevice
        self.saveDevice = saveDevice
    }

    public func attach(cycle: String?) { self.cycle = cycle }

    public func start(sessionID: String) {
        guard self.sessionID != sessionID || runner == nil else { return }
        stop()
        self.sessionID = sessionID
        let revision = generation
        runner = Task { [weak self] in
            guard let self else { return }
            await self.run(revision)
        }
    }

    public func stop() {
        generation += 1
        runner?.cancel(); runner = nil
        socket?.close(); socket = nil
        writeTail?.cancel(); writeTail = nil
        sessionID = nil
        policy = nil; policyAt = nil
        webSends.removeAll()
        failPending()
        setStatus("offline")
    }

    private func setStatus(_ value: String) {
        status = value
        onNativeState?(value)
        onState?(value)
    }

    private func failPending() {
        let requests = pending.values
        pending.removeAll()
        for item in requests {
            item.timeout.cancel()
            item.continuation?.resume(throwing: NativeError.unavailable)
        }
    }

    private var freshPolicy: WebSocketPolicy? {
        guard let policyAt, Date().timeIntervalSince(policyAt) < 60 else { return nil }
        return policy
    }

    /// Resolves only after network send, never implies a server ACK or retries a command.
    public func sendWeb(cycle: String, message: [String: Any]) async throws {
        guard self.cycle == cycle, sessionID != nil else { throw NativeError.unavailable }
        guard status == "online", let policy = freshPolicy else { throw NativeError.unavailable }
        guard Set(message.keys) == ["type", "request_id", "payload"],
              let type = message["type"] as? String, !type.isEmpty, type.count <= 64,
              let id = message["request_id"] as? String, !id.isEmpty, id.count <= 128,
              let payload = message["payload"] as? [String: Any],
              JSONSerialization.isValidJSONObject(message) else { throw NativeError.validation }
        guard policy.allows("send", type: type) else { throw NativeError.forbidden }
        guard !pending.values.contains(where: { $0.cycle == cycle && $0.webID == id }) else {
            throw NativeError.validation
        }
        webSends.removeAll { Date().timeIntervalSince($0) >= 1 }
        guard webSends.count < 32 else { throw AuthFailure(code: "RATE_LIMITED", retryAfter: 1) }
        webSends.append(Date())
        let revision = generation
        let wireID = try reserve(type: type, webID: id, publish: true, continuation: nil)
        do { try await write(["type": type, "request_id": wireID, "payload": payload], revision: revision, requiredCycle: cycle) }
        catch { remove(wireID, error: error); throw error }
        guard revision == generation, self.cycle == cycle else { throw NativeError.unavailable }
    }

    /// Native modules bypass Web restrictions, while sharing request correlation and limits.
    public func request(_ type: String, payload: [String: Any], publish: Bool = true) async throws -> [String: Any] {
        let revision = generation
        return try await withCheckedThrowingContinuation { continuation in
            do {
                let id = try reserve(type: type, webID: nil, publish: publish, continuation: continuation)
                Task {
                    do { try await write(["type": type, "request_id": id, "payload": payload], revision: revision) }
                    catch { remove(id, error: error) }
                }
            } catch { continuation.resume(throwing: error) }
        }
    }

    private func reserve(type: String, webID: String?, publish: Bool,
                         continuation: CheckedContinuation<[String: Any], Error>?) throws -> String {
        guard socket != nil, pending.count < 128 else { throw NativeError.unavailable }
        let id = UUID().uuidString
        let timeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { return }
            // Unknown outcomes are never retried. Reconnect invalidates all pending requests.
            self?.socket?.close()
            self?.remove(id, error: NativeError.unavailable)
        }
        pending[id] = Pending(type: type, webID: webID, cycle: cycle, publish: publish,
                              continuation: continuation, timeout: timeout)
        return id
    }

    private func remove(_ id: String, error: Error) {
        guard let item = pending.removeValue(forKey: id) else { return }
        item.timeout.cancel()
        item.continuation?.resume(throwing: error)
    }

    private func write(_ message: [String: Any], revision: Int, requiredCycle: String? = nil) async throws {
        let data = try JSONSerialization.data(withJSONObject: message)
        guard data.count <= 131072 else { throw NativeError.validation }
        guard let socket, revision == generation, queuedBytes + data.count <= 1048576 else {
            throw NativeError.unavailable
        }
        let previous = writeTail
        queuedBytes += data.count
        defer { queuedBytes -= data.count }
        let task = Task {
            _ = try? await previous?.value
            guard revision == generation, !Task.isCancelled,
                  requiredCycle == nil || requiredCycle == cycle else { throw NativeError.unavailable }
            do { try await socket.send(String(decoding: data, as: UTF8.self)) }
            catch { socket.close(); throw error }
        }
        writeTail = task
        try await task.value
    }

    private func receive(_ message: [String: Any]) throws {
        guard let type = message["type"] as? String else { throw NativeError.validation }
        var forwarded = message
        var originalType = type
        var targetCycle = cycle
        var publish = true
        if type == "response" {
            guard let id = message["request_id"] as? String,
                  let item = pending.removeValue(forKey: id) else { return }
            item.timeout.cancel()
            originalType = item.type
            targetCycle = item.cycle
            publish = item.publish
            if let webID = item.webID { forwarded["request_id"] = webID }
            if let error = message["error"] as? [String: Any] {
                let code = error["code"] as? String ?? "NETWORK_ERROR"
                item.continuation?.resume(throwing: AuthFailure(code: code, retryAfter: 0))
            } else if let payload = message["payload"] as? [String: Any] {
                item.continuation?.resume(returning: payload)
            } else {
                item.continuation?.resume(throwing: NativeError.validation)
                throw NativeError.validation
            }
        } else if message["request_id"] != nil { throw NativeError.validation }
        onNativeMessage?(message)
        guard publish, let cycle, cycle == targetCycle,
              let policy = freshPolicy, policy.allows("receive", type: originalType) else { return }
        onWebMessage?(cycle, forwarded)
    }

    private func refreshPolicy() async throws {
        let revision = generation
        let payload = try await request("native.bridge_policy", payload: [:], publish: false)
        guard revision == generation else { throw NativeError.unavailable }
        let next = try WebSocketPolicy(data: JSONSerialization.data(withJSONObject: payload))
        policy = next
        policyAt = Date()
    }

    private func run(_ revision: Int) async {
        var attempts = 0
        while revision == generation && !Task.isCancelled {
            setStatus("connecting")
            var reader: Task<Void, Never>?
            var updater: Task<Void, Never>?
            var retryAfter: Double = 0
            do {
                guard let token = try await access(attempts > 0), revision == generation else { throw NativeError.invalidSession }
                var parts = URLComponents(url: server.url, resolvingAgainstBaseURL: false)!
                parts.scheme = "wss"; parts.path = "/ws"
                var request = URLRequest(url: parts.url!)
                request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
                let connection = factory(request)
                socket = connection
                reader = Task { [weak self] in
                    do {
                        while !Task.isCancelled {
                            let raw = try await connection.receive()
                            guard let self, revision == self.generation else { return }
                            guard raw.utf8.count <= 131072,
                                  let data = raw.data(using: .utf8),
                                  let message = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                                throw NativeError.validation
                            }
                            try self.receive(message)
                        }
                    } catch {
                        guard let self, revision == self.generation else { return }
                        connection.close()
                        self.policy = nil; self.policyAt = nil
                        self.failPending()
                    }
                }
                guard let identity = sessionID else { throw NativeError.invalidSession }
                let registration = try await self.request("device.register", payload: ["device_id": readDevice(identity) as Any? ?? NSNull()])
                guard revision == generation else { return }
                guard let id = registration["device_id"] as? String, UUID(uuidString: id) != nil else {
                    throw NativeError.validation
                }
                saveDevice(identity, id)
                try await refreshPolicy()
                _ = try await self.request("call.current", payload: [:])
                guard revision == generation else { return }
                attempts = 0
                setStatus("online")
                updater = Task { [weak self] in
                    do {
                        while !Task.isCancelled {
                            try await Task.sleep(nanoseconds: 30_000_000_000)
                            guard let self, revision == self.generation else { return }
                            try await self.refreshPolicy()
                        }
                    } catch {
                        guard let self, revision == self.generation, !Task.isCancelled else { return }
                        self.policy = nil; self.policyAt = nil
                        connection.close()
                    }
                }
                await reader?.value
            } catch {
                if let failure = error as? AuthFailure, failure.retryAfter.isFinite { retryAfter = max(0, failure.retryAfter) }
                if (error as? NativeError) == .invalidSession || (error as? AuthFailure)?.code == "SESSION_INVALID" {
                    if revision == generation { stop(); onNativeInvalidSession?(); onInvalidSession?() }
                    return
                }
            }
            reader?.cancel(); updater?.cancel()
            socket?.close()
            await reader?.value
            await updater?.value
            guard revision == generation, !Task.isCancelled else { return }
            socket?.close(); socket = nil
            writeTail?.cancel(); writeTail = nil
            policy = nil; policyAt = nil
            failPending()
            setStatus("connecting")
            let delay = max(Double(min(10, 1 << min(4, attempts))), retryAfter)
            attempts += 1
            do { try await Task.sleep(nanoseconds: UInt64(min(delay, 86400) * 1_000_000_000)) } catch { return }
        }
    }
}

/// Ephemeral native WSS with no cookies/cache and no credential-bearing redirects.
@MainActor public final class URLSessionNativeSocket: NSObject, NativeSocket, URLSessionTaskDelegate {
    private var session: URLSession!
    private var task: URLSessionWebSocketTask!

    public init(request: URLRequest) {
        super.init()
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.urlCache = nil
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        task = session.webSocketTask(with: request)
        task.maximumMessageSize = 131072
        task.resume()
    }
    public func send(_ text: String) async throws { try await task.send(.string(text)) }
    public func receive() async throws -> String {
        switch try await task.receive() {
        case .string(let value): return value
        default: throw NativeError.validation
        }
    }
    public func close() { task.cancel(with: .goingAway, reason: nil); session.invalidateAndCancel() }
    nonisolated public func urlSession(_ session: URLSession, task: URLSessionTask,
                                      willPerformHTTPRedirection response: HTTPURLResponse,
                                      newRequest request: URLRequest,
                                      completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
