import Foundation
import Darwin

/// Paths are native-only. Tests inject a fresh sandbox, never the user's app directories.
public struct DeviceStorageLocations: Sendable {
    public let data: URL
    public let temporary: URL
    public let cache: URL
    public init(data: URL, temporary: URL, cache: URL) { self.data = data; self.temporary = temporary; self.cache = cache }
    public static var standard: DeviceStorageLocations {
        let files = FileManager.default
        return DeviceStorageLocations(
            data: files.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("GChatDeviceStorage/Data", isDirectory: true),
            temporary: files.temporaryDirectory.appendingPathComponent("GChatDeviceStorage", isDirectory: true),
            cache: files.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("GChatDeviceStorage/Cache", isDirectory: true))
    }
}

/// An OS advisory lock proves ownership, including across processes. Crash releases it.
/// Cleanup never touches a live owner's directory or unrecognized files in the namespace.
final class DeviceStorageSession {
    private let owner: URL
    private let ownerLock: Int32
    let data: URL
    let cache: URL
    let temporary: URL

    init(_ locations: DeviceStorageLocations) throws {
        let files = FileManager.default
        for url in [locations.data, locations.cache, locations.temporary] {
            try files.createDirectory(at: url, withIntermediateDirectories: true)
            guard try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]).isSymbolicLink != true else { throw DeviceCommandError("PERMISSION_DENIED") }
        }
        data = locations.data.resolvingSymlinksInPath().standardizedFileURL
        cache = locations.cache.resolvingSymlinksInPath().standardizedFileURL
        let base = locations.temporary.resolvingSymlinksInPath().standardizedFileURL
        let namespace = open(base.appendingPathComponent(".owners.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard namespace >= 0 else { throw DeviceCommandError("IO_ERROR") }
        defer { flock(namespace, LOCK_UN); close(namespace) }
        guard flock(namespace, LOCK_EX) == 0 else { throw DeviceCommandError("IO_ERROR") }
        for candidate in try files.contentsOfDirectory(at: base, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]) {
            guard UUID(uuidString: candidate.lastPathComponent) != nil,
                  let values = try? candidate.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]),
                  values.isDirectory == true, values.isSymbolicLink != true else { continue }
            let lock = open(candidate.appendingPathComponent(".owner.lock").path, O_RDWR | O_NOFOLLOW)
            guard lock >= 0 else {
                if errno == ENOENT { try files.removeItem(at: candidate) }
                continue
            }
            if flock(lock, LOCK_EX | LOCK_NB) == 0 {
                do { try files.removeItem(at: candidate) }
                catch { flock(lock, LOCK_UN); close(lock); throw error }
                flock(lock, LOCK_UN)
            }
            close(lock)
        }
        let owner = base.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try files.createDirectory(at: owner, withIntermediateDirectories: false)
        let descriptor = open(owner.appendingPathComponent(".owner.lock").path, O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { try? files.removeItem(at: owner); throw DeviceCommandError("IO_ERROR") }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            close(descriptor); try? files.removeItem(at: owner); throw DeviceCommandError("IO_ERROR")
        }
        let temporary = owner.appendingPathComponent("files", isDirectory: true)
        do { try files.createDirectory(at: temporary, withIntermediateDirectories: false) }
        catch { flock(descriptor, LOCK_UN); close(descriptor); try? files.removeItem(at: owner); throw error }
        self.owner = owner; ownerLock = descriptor; self.temporary = temporary
    }
    deinit {
        try? FileManager.default.removeItem(at: owner)
        flock(ownerLock, LOCK_UN); close(ownerLock)
    }
    func root(_ area: String) throws -> URL {
        let url: URL
        switch area { case "data": url = data; case "cache": url = cache; case "temporary": url = temporary; default: throw DeviceCommandError("INVALID_ARGUMENT") }
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        guard url.resolvingSymlinksInPath().standardizedFileURL == url else { throw DeviceCommandError("PERMISSION_DENIED") }
        return url
    }
    func clearTemporary() throws {
        if FileManager.default.fileExists(atPath: temporary.path) { try FileManager.default.removeItem(at: temporary) }
    }
    func usage(_ area: String) throws -> [String: Any] {
        let root = try root(area)
        let deadline = ContinuousClock.now.advanced(by: .seconds(30))
        var size = 0
        var unknown = false
        let walk = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey], errorHandler: { _, _ in unknown = true; return false })
        guard let walk else { return ["usedBytes": NSNull(), "quotaBytes": NSNull()] }
        for case let url as URL in walk {
            guard ContinuousClock.now < deadline else { throw DeviceCommandError("TIMEOUT") }
            do {
                let info = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
                if info.isSymbolicLink == true { walk.skipDescendants(); continue }
                if info.isRegularFile == true {
                    guard let bytes = info.fileSize, bytes >= 0, size <= 9007199254740991 - bytes else { unknown = true; break }
                    size += bytes
                }
            } catch { unknown = true; break }
        }
        return ["usedBytes": unknown ? NSNull() : size as Any, "quotaBytes": NSNull()]
    }
}
