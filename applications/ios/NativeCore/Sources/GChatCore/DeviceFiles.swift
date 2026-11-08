import Foundation

/// All calls run on one serial file queue, separate from the main actor.
public final class DeviceFiles: @unchecked Sendable {
    private let lock = NSRecursiveLock()
    private struct Entry { var url: URL; var root: String; var name: String; var persistent: Bool; var captureMime: String? = nil }
    private struct Write { let id: String; let temp: URL; let expected: String?; var size: Int }
    private let defaults: UserDefaults
    private let key = "gchat.device.file-grants.v1"
    private var entries: [String: Entry] = [:]
    private var lost: [String: [String: Any]] = [:]
    private var captures = Set<URL>()
    private var writes: [String: Write] = [:]
    private var revision = 0
    private let internalKey = "gchat.device.internal-refs.v1"
    private let storageLocations: DeviceStorageLocations?
    private var storageSession: DeviceStorageSession?
    private var internalAreas: [String: String] = [:]
    private var temporaryCleanupNeeded = false
    private let staging: URL
    private var onChanged: (() -> Void)?
    public var changed: (() -> Void)? {
        get { lock.lock(); defer { lock.unlock() }; return onChanged }
        set { lock.lock(); defer { lock.unlock() }; onChanged = newValue }
    }

    public init(defaults: UserDefaults = .standard, staging: URL? = nil, storageLocations: DeviceStorageLocations? = nil) {
        self.storageLocations = storageLocations
        self.defaults = defaults
        self.staging = staging ?? FileManager.default.temporaryDirectory.appendingPathComponent("gchat-device-writes", isDirectory: true)
        try? FileManager.default.createDirectory(at: self.staging, withIntermediateDirectories: true)
        for url in (try? FileManager.default.contentsOfDirectory(at: self.staging, includingPropertiesForKeys: nil)) ?? [] { try? FileManager.default.removeItem(at: url) }
        for (id, data) in defaults.dictionary(forKey: key) ?? [:] {
            guard UUID(uuidString: id) != nil else { continue }
            let record = data as? [String: Any]
            guard let bookmark = record?["bookmark"] as? Data ?? data as? Data else { continue }
            var stale = false
            if let url = try? URL(resolvingBookmarkData: bookmark, options: [.withoutUI], relativeTo: nil, bookmarkDataIsStale: &stale) {
                entries[id] = Entry(url: url, root: id, name: url.lastPathComponent, persistent: true)
                if stale { save(id) }
            } else {
                lost[id] = ["id": id, "name": record?["name"] as? String ?? "Файл", "kind": record?["kind"] as? String ?? "file", "persistence": "persistent"]
            }
        }
    }

    public var count: Int { lock.lock(); defer { lock.unlock() }; return entries.filter { $0.key == $0.value.root && internalAreas[$0.value.root] == nil }.count + lost.count }

    private func touch() { revision += 1; changed?() }
    private func save(_ id: String) {
        if let entry = entries[id], internalAreas[entry.root] != nil { persistInternal(); return }
        guard var entry = entries[id], entry.root == id else { return }
        var saved = defaults.dictionary(forKey: key) ?? [:]
        if let bookmark = try? entry.url.bookmarkData(options: [.minimalBookmark], includingResourceValuesForKeys: nil, relativeTo: nil) { saved[id] = ["bookmark": bookmark, "name": entry.name, "kind": ((try? entry.url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true) ? "directory" : "file"]; defaults.set(saved, forKey: key); entry.persistent = true; entries[id] = entry }
    }

    public func grant(_ url: URL) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
        if let existing = entries.first(where: { $0.value.url.standardizedFileURL == url.standardizedFileURL }) { return try metadata(existing.key) }
        let id = UUID().uuidString
        entries[id] = Entry(url: url, root: id, name: url.lastPathComponent, persistent: false)
        save(id); touch()
        return try metadata(id)
    }

    private func entry(_ id: String) throws -> Entry {
        if entries[id] == nil, let registry = defaults.dictionary(forKey: internalKey),
           let records = registry["entries"] as? [String: Any], records[id] != nil { try ensureStorage() }
        guard let value = entries[id] else { throw DeviceCommandError(lost[id] == nil ? "NOT_FOUND" : "ACCESS_LOST") }
        if internalAreas[value.root] != nil, !FileManager.default.fileExists(atPath: value.url.path) { throw DeviceCommandError("NOT_FOUND") }
        return value
    }

    public func prepareStorage() throws {
        lock.lock(); defer { lock.unlock() }
        try ensureStorage()
    }

    private func ensureStorage() throws {
        guard storageSession == nil else { return }
        let session = try DeviceStorageSession(storageLocations ?? .standard)
        let saved = defaults.dictionary(forKey: internalKey) ?? [:]
        let roots = saved["roots"] as? [String: String] ?? [:]
        for area in ["data", "cache"] {
            let id = roots[area].flatMap { UUID(uuidString: $0) != nil ? $0 : nil } ?? UUID().uuidString
            let url = try session.root(area)
            internalAreas[id] = area
            entries[id] = Entry(url: url, root: id, name: area, persistent: true)
        }
        for (id, record) in saved["entries"] as? [String: [String: Any]] ?? [:] {
            guard UUID(uuidString: id) != nil, let area = record["area"] as? String,
                  let root = internalAreas.first(where: { $0.value == area })?.key,
                  let components = record["components"] as? [String],
                  components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("/") && !$0.contains("\\") && !$0.contains("\0") }) else { continue }
            if components.isEmpty { continue }
            var url = try session.root(area)
            for component in components { url.appendPathComponent(component) }
            entries[id] = Entry(url: url, root: root, name: components.last!, persistent: true, captureMime: record["captureMime"] as? String)
        }
        storageSession = session
        persistInternal()
    }

    private func persistInternal() {
        guard storageSession != nil else { return }
        var roots: [String: String] = [:]
        var records: [String: [String: Any]] = [:]
        for (id, area) in internalAreas where area != "temporary" { roots[area] = id }
        for (id, value) in entries {
            guard let area = internalAreas[value.root], area != "temporary", let root = entries[value.root] else { continue }
            let components = value.url.pathComponents
            let prefix = root.url.pathComponents
            guard components.starts(with: prefix) else { continue }
            records[id] = ["area": area, "components": Array(components.dropFirst(prefix.count))]
            if let mime = value.captureMime { records[id]?["captureMime"] = mime }
        }
        defaults.set(["roots": roots, "entries": records], forKey: internalKey)
    }

    private func storageRoot(_ area: String) throws -> [String: Any] {
        try ensureStorage()
        guard let storageSession else { throw DeviceCommandError("IO_ERROR") }
        if area == "temporary", temporaryCleanupNeeded {
            try storageSession.clearTemporary(); temporaryCleanupNeeded = false
        }
        if let id = internalAreas.first(where: { $0.value == area })?.key {
            _ = try storageSession.root(area)
            return try reference(id)
        }
        let id = UUID().uuidString
        internalAreas[id] = area
        entries[id] = Entry(url: try storageSession.root(area), root: id, name: area, persistent: area != "temporary")
        persistInternal(); touch()
        return try reference(id)
    }

    private func scoped<T>(_ id: String, writing: Bool = false, _ body: (URL) throws -> T) throws -> T {
        let value = try entry(id); let root = try entry(value.root)
        let access = root.url.startAccessingSecurityScopedResource(); defer { if access { root.url.stopAccessingSecurityScopedResource() } }
        if internalAreas[value.root] != nil,
           root.url.resolvingSymlinksInPath().standardizedFileURL != root.url.standardizedFileURL { throw DeviceCommandError("PERMISSION_DENIED") }
        let resolved = value.url.resolvingSymlinksInPath().standardizedFileURL
        let rootURL = root.url.resolvingSymlinksInPath().standardizedFileURL
        guard resolved == rootURL || resolved.path.hasPrefix(rootURL.path + "/") else { throw DeviceCommandError("PERMISSION_DENIED") }
        var result: Result<T, Error>?
        var coordination: NSError?
        let coordinator = NSFileCoordinator()
        if writing { coordinator.coordinate(writingItemAt: resolved, options: [], error: &coordination) { url in result = Result { try body(url) } } }
        else { coordinator.coordinate(readingItemAt: resolved, options: [], error: &coordination) { url in result = Result { try body(url) } } }
        if let coordination { throw coordination }
        guard let result else { throw DeviceCommandError("ACCESS_LOST") }
        return try result.get()
    }

    private func retain(_ url: URL, root: String) -> String {
        if let existing = entries.first(where: { $0.value.url.standardizedFileURL == url.standardizedFileURL }) { return existing.key }
        let id = UUID().uuidString
        entries[id] = Entry(url: url, root: root, name: url.lastPathComponent, persistent: internalAreas[root].map { $0 != "temporary" } ?? false)
        persistInternal()
        return id
    }

    private func reference(_ id: String) throws -> [String: Any] {
        let item = try entry(id)
        let directory = try scoped(id) { try FileManager.default.attributesOfItem(atPath: $0.path)[.type] as? FileAttributeType == .typeDirectory }
        return ["id": id, "name": item.name, "kind": directory ? "directory" : "file", "persistence": item.persistent ? "persistent" : "session"]
    }

    public func metadata(_ id: String) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let ref = try reference(id)
        return try scoped(id) { url in
            let values = try FileManager.default.attributesOfItem(atPath: url.path)
            let directory = values[.type] as? FileAttributeType == .typeDirectory
            let size = (values[.size] as? NSNumber)?.intValue ?? 0
            let modified = values[.modificationDate] as? Date
            return ["ref": ref, "size": directory ? NSNull() : size, "modifiedAt": modified.map { ISO8601DateFormatter().string(from: $0) } as Any? ?? NSNull(), "mimeType": entries[id]?.captureMime as Any? ?? NSNull(), "version": directory ? NSNull() : "\(size):\(modified?.timeIntervalSince1970 ?? 0)"]
        }
    }

    /// Native capture owns this path. It is never accepted as bridge input or returned to Web.
    public func createCapture(extension suffix: String) throws -> URL {
        lock.lock(); defer { lock.unlock() }
        guard ["jpg", "mp4"].contains(suffix) else { throw DeviceCommandError("INVALID_ARGUMENT") }
        let url = staging.appendingPathComponent(UUID().uuidString + "." + suffix)
        captures.insert(url)
        return url
    }

    public func abortCapture(_ url: URL) {
        lock.lock(); defer { lock.unlock() }
        guard captures.remove(url) != nil else { return }
        try? FileManager.default.removeItem(at: url)
    }

    public func commitCapture(_ url: URL) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        guard captures.contains(url) else { throw DeviceCommandError("INVALID_ARGUMENT") }
        let values = try FileManager.default.attributesOfItem(atPath: url.path)
        guard let size = values[.size] as? NSNumber, size.intValue > 0 else { throw DeviceCommandError("IO_ERROR") }
        try ensureStorage()
        guard let root = internalAreas.first(where: { $0.value == "data" })?.key,
              let directory = entries[root]?.url else { throw DeviceCommandError("IO_ERROR") }
        let destination = directory.appendingPathComponent("camera-" + UUID().uuidString + "." + url.pathExtension)
        try FileManager.default.moveItem(at: url, to: destination)
        let id = retain(destination, root: root)
        entries[id]?.captureMime = url.pathExtension == "jpg" ? "image/jpeg" : "video/mp4"
        persistInternal(); captures.remove(url); touch()
        return try reference(id)
    }

    public func exportURL(_ id: String) throws -> URL {
        lock.lock(); defer { lock.unlock() }
        guard try reference(id)["kind"] as? String == "file" else { throw DeviceCommandError("WRONG_TYPE") }
        let destination = staging.appendingPathComponent(UUID().uuidString + "-export")
        try scoped(id) { try FileManager.default.copyItem(at: $0, to: destination) }
        return destination
    }

    private func page(_ values: [[String: Any]], cursor: String?, limit: Int, scope: String) throws -> [String: Any] {
        var offset = 0
        if let cursor {
            guard let data = Data(base64Encoded: cursor), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any], value["scope"] as? String == scope, value["revision"] as? Int == revision, let next = value["offset"] as? Int, next >= 0, next <= values.count else { throw DeviceCommandError("CONFLICT") }
            offset = next
        }
        let end = min(values.count, offset + limit)
        let next: Any = end < values.count ? try JSONSerialization.data(withJSONObject: ["scope": scope, "revision": revision, "offset": end]).base64EncodedString() : NSNull()
        return ["entries": Array(values[offset..<end]), "nextCursor": next]
    }

    public func execute(_ command: DeviceCommand) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let a = command
        switch a.name {
        case "storage.getRoot": return try storageRoot(a.string("area"))
        case "storage.getUsage":
            _ = try storageRoot(a.string("area"))
            guard let storageSession else { throw DeviceCommandError("IO_ERROR") }
            return try storageSession.usage(a.string("area"))
        case "file.access.list":
            let roots = entries.filter { $0.key == $0.value.root && internalAreas[$0.value.root] == nil }.sorted { $0.key < $1.key }
            // A lost grant must still be listed, so the user can forget or select it again.
            let refs: [[String: Any]] = roots.map { id, value in ["id": id, "name": value.name, "kind": (try? reference(id)["kind"]) ?? "file", "persistence": value.persistent ? "persistent" : "session"] } + lost.sorted { $0.key < $1.key }.map { $0.value }
            return try page(refs, cursor: a.args["cursor"] as? String, limit: a.integer("limit"), scope: "grants")
        case "file.access.restore", "file.stat":
            if a.name == "file.access.restore" {
                _ = try? entry(a.string("id"))
                if let value = entries[a.string("id")], internalAreas[value.root] != nil { throw DeviceCommandError("INVALID_ARGUMENT") }
            }
            do { return try metadata(a.string("id")) }
            catch let error as NSError where a.name == "file.access.restore" && error.domain == NSCocoaErrorDomain { throw DeviceCommandError("ACCESS_LOST") }
        case "file.access.forget":
            let id = a.string("id")
            _ = try? entry(id)
            if let value = entries[id], internalAreas[value.root] != nil { throw DeviceCommandError("INVALID_ARGUMENT") }
            lost.removeValue(forKey: id)
            for (writeId, write) in writes where entries[write.id]?.root == id || write.id == id { try? FileManager.default.removeItem(at: write.temp); writes.removeValue(forKey: writeId) }
            for (key, value) in entries where key == id || value.root == id { entries.removeValue(forKey: key) }
            var saved = defaults.dictionary(forKey: key) ?? [:]; saved.removeValue(forKey: id); defaults.set(saved, forKey: key); touch()
            return ["outcome": "completed"]
        case "directory.list":
            let id = a.string("directoryId"); let value = try entry(id)
            let urls = try scoped(id) { url in
                guard try url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else { throw DeviceCommandError("WRONG_TYPE") }
                return try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: [.isDirectoryKey]).sorted { $0.lastPathComponent < $1.lastPathComponent }
            }
            let values = try urls.map { try metadata(retain($0, root: value.root)) }
            return try page(values, cursor: a.args["cursor"] as? String, limit: a.integer("limit"), scope: id)
        case "file.read":
            let id = a.string("fileId")
            let meta = try metadata(id)
            guard (meta["ref"] as? [String: Any])?["kind"] as? String == "file" else { throw DeviceCommandError("WRONG_TYPE") }
            let version = meta["version"] ?? NSNull()
            return try scoped(id) { url in
                let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
                let size = try handle.seekToEnd(); try handle.seek(toOffset: UInt64(a.integer("offset")))
                let data = try handle.read(upToCount: a.integer("length")) ?? Data()
                return ["dataBase64": data.base64EncodedString(), "bytesRead": data.count, "eof": UInt64(a.integer("offset")) + UInt64(data.count) >= size, "version": version]
            }
        case "file.create", "directory.create":
            let parent = try entry(a.string("directoryId"))
            let url = try scoped(a.string("directoryId"), writing: true) { directory -> URL in
                guard try directory.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else { throw DeviceCommandError("WRONG_TYPE") }
                let url = directory.appendingPathComponent(a.string("name"))
                guard !FileManager.default.fileExists(atPath: url.path) else { throw DeviceCommandError("ALREADY_EXISTS") }
                if a.name == "directory.create" { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false) }
                else { try Data().write(to: url, options: [.withoutOverwriting]) }
                return url
            }
            touch(); return try metadata(retain(url, root: parent.root))
        case "file.write.begin":
            let id = a.string("fileId")
            guard !writes.values.contains(where: { $0.id == id }) else { throw DeviceCommandError("BUSY") }
            let meta = try metadata(id)
            guard (meta["ref"] as? [String: Any])?["kind"] as? String == "file" else { throw DeviceCommandError("WRONG_TYPE") }
            let expected = a.args["expectedVersion"] as? String
            if let expected, meta["version"] as? String != expected { throw DeviceCommandError("CONFLICT") }
            let writeId = UUID().uuidString; let temp = staging.appendingPathComponent(writeId)
            if a.string("mode") == "update" { try scoped(id) { try FileManager.default.copyItem(at: $0, to: temp) } } else { try Data().write(to: temp) }
            let size = (try FileManager.default.attributesOfItem(atPath: temp.path)[.size] as? NSNumber)?.intValue ?? 0
            writes[writeId] = Write(id: id, temp: temp, expected: expected, size: size)
            return ["writeId": writeId]
        case "file.write.chunk":
            let id = a.string("writeId")
            guard var write = writes[id], let data = Data(base64Encoded: a.string("dataBase64")), a.integer("offset") <= write.size else { throw DeviceCommandError("INVALID_ARGUMENT") }
            let handle = try FileHandle(forWritingTo: write.temp); defer { try? handle.close() }
            try handle.seek(toOffset: UInt64(a.integer("offset"))); try handle.write(contentsOf: data)
            write.size = max(write.size, a.integer("offset") + data.count); writes[id] = write
            return ["bytesWritten": data.count]
        case "file.write.commit":
            let id = a.string("writeId")
            guard let write = writes[id] else { throw DeviceCommandError("NOT_FOUND") }
            if let expected = write.expected, try metadata(write.id)["version"] as? String != expected { throw DeviceCommandError("CONFLICT") }
            do {
                try scoped(write.id, writing: true) { url in
                    let sibling = url.deletingLastPathComponent().appendingPathComponent(".gchat-\(UUID().uuidString)")
                    try FileManager.default.copyItem(at: write.temp, to: sibling)
                    defer { try? FileManager.default.removeItem(at: sibling) }
                    _ = try FileManager.default.replaceItemAt(url, withItemAt: sibling)
                }
            } catch { throw DeviceCommandError("OUTCOME_UNKNOWN") }
            writes.removeValue(forKey: id); try? FileManager.default.removeItem(at: write.temp); save(write.id); touch()
            return try metadata(write.id)
        case "file.write.abort":
            if let write = writes.removeValue(forKey: a.string("writeId")) { try? FileManager.default.removeItem(at: write.temp) }
            return ["outcome": "completed"]
        case "file.copy", "file.move", "file.rename":
            let id = a.string("id"); let source = try entry(id)
            guard internalAreas[id] == nil || source.root != id || a.name == "file.copy" else { throw DeviceCommandError("INVALID_ARGUMENT") }
            let destinationDirectory = a.name == "file.rename" ? source.url.deletingLastPathComponent() : try scoped(a.string("destinationDirectoryId")) { url in
                guard try url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else { throw DeviceCommandError("WRONG_TYPE") }; return url
            }
            let destination = destinationDirectory.appendingPathComponent(a.string("name"))
            guard !destination.resolvingSymlinksInPath().path.hasPrefix(source.url.resolvingSymlinksInPath().path + "/") else { throw DeviceCommandError("INVALID_ARGUMENT") }
            if a.name == "file.rename", source.root == id { throw DeviceCommandError("UNSUPPORTED") }
            let targetRoot = a.name == "file.rename" ? source.root : try entry(a.string("destinationDirectoryId")).root
            let target = try entry(targetRoot); let access = target.url.startAccessingSecurityScopedResource(); defer { if access { target.url.stopAccessingSecurityScopedResource() } }
            try scoped(id, writing: a.name != "file.copy") { url in
                guard !FileManager.default.fileExists(atPath: destination.path) else { throw DeviceCommandError("ALREADY_EXISTS") }
                do {
                    if a.name == "file.copy" { try FileManager.default.copyItem(at: url, to: destination) }
                    else { try FileManager.default.moveItem(at: url, to: destination) }
                } catch {
                    if FileManager.default.fileExists(atPath: destination.path) {
                        let created = retain(destination, root: targetRoot); touch()
                        throw DeviceCommandError(a.name == "file.copy" ? "PARTIAL_FAILURE" : "OUTCOME_UNKNOWN", ["completedIds": [], "destinationId": created])
                    }
                    throw error
                }
            }
            let newId: String
            if a.name == "file.copy" { newId = retain(destination, root: targetRoot) }
            else {
                newId = id
                for (key, value) in entries where value.url == source.url || value.url.path.hasPrefix(source.url.path + "/") {
                    let suffix = String(value.url.path.dropFirst(source.url.path.count)); entries[key]?.url = URL(fileURLWithPath: destination.path + suffix)
                    if value.root == source.root {
                        entries[key]?.root = source.root == id && internalAreas[targetRoot] == nil ? id : targetRoot
                        if let root = entries[key]?.root, let area = internalAreas[root] { entries[key]?.persistent = area != "temporary" }
                        else if value.root != key { entries[key]?.persistent = false }
                    }
                }
                entries[id]?.name = a.string("name")
                if let root = entries[id]?.root, internalAreas[root] != nil, source.root == id {
                    var saved = defaults.dictionary(forKey: key) ?? [:]; saved.removeValue(forKey: id); defaults.set(saved, forKey: key)
                }
                for (key, value) in entries where value.persistent && value.root == key && (value.url == destination || value.url.path.hasPrefix(destination.path + "/")) { save(key) }
            }
            persistInternal(); touch(); return try metadata(newId)
        case "file.remove":
            let id = a.string("id"); let source = try entry(id)
            guard internalAreas[id] == nil || source.root != id else { throw DeviceCommandError("INVALID_ARGUMENT") }
            try scoped(id, writing: true) { url in
                if !a.bool("recursive"), (try url.resourceValues(forKeys: [.isDirectoryKey])).isDirectory == true, !(try FileManager.default.contentsOfDirectory(atPath: url.path)).isEmpty { throw DeviceCommandError("CONFLICT") }
                try FileManager.default.removeItem(at: url)
            }
            for (key, value) in entries where value.url == source.url || value.url.path.hasPrefix(source.url.path + "/") { entries.removeValue(forKey: key) }
            var saved = defaults.dictionary(forKey: key) ?? [:]; saved.removeValue(forKey: id); defaults.set(saved, forKey: key); persistInternal(); touch()
            return ["outcome": "completed"]
        default: throw DeviceCommandError("UNSUPPORTED")
        }
    }

    public func reset() {
        lock.lock(); defer { lock.unlock() }
        for write in writes.values { try? FileManager.default.removeItem(at: write.temp) }; writes.removeAll()
        if let root = internalAreas.first(where: { $0.value == "temporary" })?.key {
            for (id, value) in entries where value.root == root { entries.removeValue(forKey: id) }
            internalAreas.removeValue(forKey: root)
            temporaryCleanupNeeded = true
            do { try storageSession?.clearTemporary(); temporaryCleanupNeeded = false } catch { /* Retry before granting a new temporary root. */ }
            touch()
        }
    }
}
