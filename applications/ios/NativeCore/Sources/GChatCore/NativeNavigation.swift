import Foundation
import CoreFoundation

/// Native boundary validation. The application's Web resolver also checks route access.
public struct NativeNavigationTarget {
    public let path: String
    public let search: String
    public var value: String { path + search }
    public init(_ value: String, server: ServerOrigin, allowLogin: Bool = true) throws {
        guard value.utf8.count <= 4096, value.hasPrefix("/"), !value.hasPrefix("//"),
              !value.contains("\\"), !value.contains("#"),
              !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              let parts = URLComponents(string: value), parts.scheme == nil, parts.host == nil else { throw DeviceCommandError("INVALID_ARGUMENT") }
        let rawPath = String(value.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0])
        guard rawPath.range(of: "%(2f|5c|00)", options: [.regularExpression, .caseInsensitive]) == nil,
              !parts.path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == "." || $0 == ".." }),
              !parts.path.contains("//") else { throw DeviceCommandError("INVALID_ARGUMENT") }
        let path = parts.path
        let uuidRoute = path.hasPrefix("/dialogs/") && UUID(uuidString: String(path.dropFirst(9))) != nil ||
            path.hasPrefix("/admin/users/") && UUID(uuidString: String(path.dropFirst(13))) != nil
        let fixed = ["/", "/login", "/calls", "/admin", "/admin/users", "/dialogs", "/settings", "/settings/general"] +
            ["microphone", "audio", "push", "camera", "geolocation", "files"].map { "/settings/general/" + $0 }
        guard fixed.contains(path) || uuidRoute, allowLogin || path != "/login" else { throw DeviceCommandError("INVALID_ARGUMENT") }
        var query: [String: String] = [:]
        for item in parts.queryItems ?? [] {
            guard query[item.name] == nil else { throw DeviceCommandError("INVALID_ARGUMENT") }
            query[item.name] = item.value ?? ""
        }
        let permitted: Set<String> = path == "/login" ? ["serverUrl", "returnTo"] : path == "/calls" ? ["group"] :
            (path == "/admin/users" || path.hasPrefix("/admin/users/")) ? ["q", "status", "offset"] : []
        guard Set(query.keys).isSubset(of: permitted) else { throw DeviceCommandError("INVALID_ARGUMENT") }
        if let origin = query["serverUrl"] {
            guard (try? ServerOrigin(origin)) == server else { throw DeviceCommandError("INVALID_ARGUMENT") }
            query["serverUrl"] = server.url.absoluteString
        }
        if let target = query["returnTo"] { query["returnTo"] = try NativeNavigationTarget(target, server: server, allowLogin: false).value }
        if let group = query["group"], group != "all", UUID(uuidString: group) == nil { throw DeviceCommandError("INVALID_ARGUMENT") }
        if let q = query["q"] {
            let trimmed = q.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed.utf16.count <= 80, !trimmed.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw DeviceCommandError("INVALID_ARGUMENT") }
            query["q"] = trimmed.isEmpty ? nil : trimmed
        }
        if let status = query["status"] {
            guard ["all", "active", "disabled"].contains(status) else { throw DeviceCommandError("INVALID_ARGUMENT") }
            if status == "all" { query.removeValue(forKey: "status") }
        }
        if let offset = query["offset"] {
            guard !offset.isEmpty, offset.utf8.allSatisfy({ (48...57).contains($0) }), let number = Int(offset), number <= 9007199254740991, number % 25 == 0 else { throw DeviceCommandError("INVALID_ARGUMENT") }
            query["offset"] = number == 0 ? nil : String(number)
        }
        var output = URLComponents(); output.path = path
        if !query.isEmpty { output.queryItems = query.keys.sorted().map { URLQueryItem(name: $0, value: query[$0]) } }
        self.path = path
        self.search = output.percentEncodedQuery.map { "?" + $0 } ?? ""
    }
}

public struct NativeNavigationLocation {
    public let pathname: String
    public let search: String
    public let hash: String
    public var json: [String: Any] { ["pathname": pathname, "search": search, "hash": hash] }
    public init(_ value: [String: Any], server: ServerOrigin) throws {
        guard Set(value.keys) == ["pathname", "search", "hash"], let path = value["pathname"] as? String,
              let search = value["search"] as? String, search.isEmpty || search.hasPrefix("?"),
              let hash = value["hash"] as? String, hash.isEmpty || hash.hasPrefix("#"), hash.utf8.count <= 4096,
              !hash.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw DeviceCommandError("INVALID_ARGUMENT") }
        _ = try NativeNavigationTarget(path + search, server: server)
        pathname = path; self.search = search; self.hash = hash
    }
}

/// One current command, explicit readiness and bounded replay results. No router or token lives here.
@MainActor public final class NativeNavigation {
    private struct Completion { let result: [String: Any]?; let error: String? }
    private final class Request {
        let id: String; let target: String; let replace: Bool
        var waiters: [CheckedContinuation<[String: Any], Error>] = []
        var completion: Completion?
        init(id: String, target: String, replace: Bool) { self.id = id; self.target = target; self.replace = replace }
    }
    private let server: ServerOrigin
    private var cycle: String?
    private var ready = false
    private var records: [String: Request] = [:]
    private var completed: [String] = []
    private var retired = Set<String>()
    private var current: String?
    private var location: NativeNavigationLocation
    public var onCommand: (([String: Any]) -> Void)?
    public var isReady: Bool { ready }

    public init(server: ServerOrigin) {
        self.server = server
        location = try! NativeNavigationLocation(["pathname": "/calls", "search": "", "hash": ""], server: server)
    }
    public func activate(cycle: String) throws {
        guard UUID(uuidString: cycle) != nil else { throw DeviceCommandError("INVALID_ARGUMENT") }
        if self.cycle?.lowercased() == cycle.lowercased() { return }
        reset(); self.cycle = cycle
    }
    public func reset() {
        cancelPending(code: "INVALID_STATE")
        cycle = nil; ready = false; records.removeAll(); completed.removeAll(); retired.removeAll()
    }
    public func cancelPending(code: String = "CANCELLED") {
        if let current { finish(current, Completion(result: nil, error: code)) }
    }
    private func identity(_ value: [String: Any]) throws {
        guard let version = value["navigationVersion"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID() else { throw DeviceCommandError("INVALID_ARGUMENT") }
        guard version.doubleValue == 1 else { throw DeviceCommandError("UNSUPPORTED_VERSION") }
        guard let cycle = value["cycleId"] as? String, UUID(uuidString: cycle) != nil else { throw DeviceCommandError("INVALID_ARGUMENT") }
        guard self.cycle?.lowercased() == cycle.lowercased() else { throw DeviceCommandError("INVALID_STATE") }
    }
    public func webReady(_ value: [String: Any]) throws {
        try identity(value)
        guard let phase = value["phase"] as? String else { throw DeviceCommandError("INVALID_ARGUMENT") }
        if phase == "failed" {
            guard Set(value.keys) == ["navigationVersion", "cycleId", "phase"] else { throw DeviceCommandError("INVALID_ARGUMENT") }
            ready = false
            if let current { finish(current, Completion(result: result(id: records[current]!.id, outcome: "failed", code: "INTEGRATION_ERROR"), error: nil)) }
            return
        }
        guard phase == "ready", Set(value.keys) == ["navigationVersion", "cycleId", "phase", "location"],
              let raw = value["location"] as? [String: Any] else { throw DeviceCommandError("INVALID_ARGUMENT") }
        location = try NativeNavigationLocation(raw, server: server)
        let wasReady = ready; ready = true
        if !wasReady, let current, let request = records[current] { deliver(request) }
    }
    public func navigate(to: String, replace: Bool = false, requestID: String = UUID().uuidString.lowercased()) async throws -> [String: Any] {
        guard let cycle else { throw DeviceCommandError("INVALID_STATE") }
        guard UUID(uuidString: requestID) != nil else { throw DeviceCommandError("INVALID_ARGUMENT") }
        let target = try NativeNavigationTarget(to, server: server).value
        let key = requestID.lowercased()
        guard !retired.contains(key), retired.count < 4096 else { throw DeviceCommandError("INVALID_STATE") }
        if let existing = records[key] {
            guard existing.target == target, existing.replace == replace else { throw DeviceCommandError("INVALID_ARGUMENT") }
            if let completion = existing.completion { return try unwrap(completion) }
            guard existing.waiters.count < 128 else { throw DeviceCommandError("BUSY") }
            return try await withCheckedThrowingContinuation { existing.waiters.append($0) }
        }
        if let current, let previous = records[current] {
            finish(current, Completion(result: result(id: previous.id, outcome: "superseded"), error: nil))
        }
        let request = Request(id: requestID, target: target, replace: replace)
        records[key] = request; current = key
        return try await withCheckedThrowingContinuation { continuation in
            request.waiters.append(continuation)
            if self.cycle == cycle, ready { deliver(request) }
        }
    }
    private func deliver(_ request: Request) {
        guard let cycle else { return }
        onCommand?(["navigationVersion": 1, "cycleId": cycle, "requestId": request.id, "command": "navigate", "args": ["to": request.target, "replace": request.replace]])
    }
    private func result(id: String, outcome: String, code: String? = nil) -> [String: Any] {
        var result: [String: Any] = ["id": id, "outcome": outcome, "location": location.json]
        if let code { result["error"] = ["code": code, "service": "navigation", "operation": "navigate", "message": "Не удалось выполнить переход"] }
        return result
    }
    private func failureCode(_ value: [String: Any]) throws -> String {
        guard Set(value.keys) == ["code", "service", "operation", "message"],
              value["service"] as? String == "navigation", value["operation"] as? String == "navigate",
              let message = value["message"] as? String, message.utf8.count <= 512,
              let code = value["code"] as? String,
              ["INVALID_ARGUMENT", "INVALID_STATE", "CANCELLED", "UNSUPPORTED", "UNSUPPORTED_VERSION", "INTEGRATION_ERROR", "BRIDGE_UNAVAILABLE"].contains(code) else { throw DeviceCommandError("INVALID_ARGUMENT") }
        return code
    }
    public func complete(_ value: [String: Any]) throws {
        try identity(value)
        guard let id = value["requestId"] as? String, UUID(uuidString: id) != nil else { throw DeviceCommandError("INVALID_ARGUMENT") }
        let key = id.lowercased()
        guard let request = records[key] else { throw DeviceCommandError("INVALID_STATE") }
        let completion: Completion
        if let raw = value["result"] as? [String: Any] {
            guard Set(value.keys) == ["navigationVersion", "cycleId", "requestId", "result"],
                  Set(raw.keys).isSubset(of: ["id", "outcome", "location", "error"]),
                  (raw["id"] as? String)?.lowercased() == key, let outcome = raw["outcome"] as? String,
                  ["committed", "redirected", "blocked", "superseded", "failed"].contains(outcome),
                  let rawLocation = raw["location"] as? [String: Any] else { throw DeviceCommandError("INVALID_ARGUMENT") }
            let next = try NativeNavigationLocation(rawLocation, server: server)
            var safe: [String: Any] = ["id": request.id, "outcome": outcome, "location": next.json]
            if let error = raw["error"] {
                guard outcome == "failed", let failure = error as? [String: Any] else { throw DeviceCommandError("INVALID_ARGUMENT") }
                let code = try failureCode(failure)
                safe["error"] = ["code": code, "service": "navigation", "operation": "navigate", "message": "Не удалось выполнить переход"]
            }
            completion = Completion(result: safe, error: nil)
            if request.completion == nil, current == key { location = next }
        } else if let error = value["error"] as? [String: Any] {
            guard Set(value.keys) == ["navigationVersion", "cycleId", "requestId", "error"] else { throw DeviceCommandError("INVALID_ARGUMENT") }
            completion = Completion(result: nil, error: try failureCode(error))
        } else { throw DeviceCommandError("INVALID_ARGUMENT") }
        // Superseded/cancelled completions are immutable; late Web results cannot restore them.
        if request.completion == nil { finish(key, completion) }
    }
    private func unwrap(_ value: Completion) throws -> [String: Any] {
        if let code = value.error { throw DeviceCommandError(code) }
        guard let result = value.result else { throw DeviceCommandError("INTEGRATION_ERROR") }
        return result
    }
    private func finish(_ key: String, _ completion: Completion) {
        guard let request = records[key], request.completion == nil else { return }
        request.completion = completion
        if current == key { current = nil }
        completed.append(key)
        for waiter in request.waiters { waiter.resume(with: Result { try unwrap(completion) }) }
        request.waiters.removeAll()
        while completed.count > 128 {
            let removed = completed.removeFirst(); records.removeValue(forKey: removed); retired.insert(removed)
        }
    }
}
