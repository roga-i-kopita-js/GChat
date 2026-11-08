import XCTest
@testable import GChatCore

private final class StorageFixture {
    let base = FileManager.default.temporaryDirectory.appendingPathComponent("gchat-storage-test-" + UUID().uuidString)
    let suite = "gchat.storage-test." + UUID().uuidString
    let defaults: UserDefaults
    let locations: DeviceStorageLocations
    let files: DeviceFiles
    init() throws {
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        locations = DeviceStorageLocations(data: base.appendingPathComponent("data"), temporary: base.appendingPathComponent("tmp"), cache: base.appendingPathComponent("cache"))
        files = DeviceFiles(defaults: defaults, staging: base.appendingPathComponent("staging"), storageLocations: locations)
    }
    deinit { defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: base) }
    @discardableResult func run(_ name: String, _ args: [String: Any], files: DeviceFiles? = nil) throws -> [String: Any] {
        try (files ?? self.files).execute(DeviceCommand(name: name, args: args))
    }
    func root(_ area: String) throws -> String {
        let value = try run("storage.getRoot", ["area": area])
        return try XCTUnwrap(value["id"] as? String)
    }
    static func id(_ metadata: [String: Any]) throws -> String { try XCTUnwrap((metadata["ref"] as? [String: Any])?["id"] as? String) }
    func file(_ root: String, name: String = "test.dat", bytes: Data = Data([1, 2, 3])) throws -> String {
        let id = try Self.id(run("file.create", ["directoryId": root, "name": name]))
        let write = try XCTUnwrap(run("file.write.begin", ["fileId": id, "mode": "replace", "expectedVersion": NSNull()])["writeId"] as? String)
        _ = try run("file.write.chunk", ["writeId": write, "offset": 0, "dataBase64": bytes.base64EncodedString()])
        _ = try run("file.write.commit", ["writeId": write])
        return id
    }
    func read(_ id: String, files: DeviceFiles? = nil) throws -> Data {
        let result = try run("file.read", ["fileId": id, "offset": 0, "length": 262144], files: files)
        return try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(result["dataBase64"] as? String)))
    }
    func restarted() -> DeviceFiles { DeviceFiles(defaults: defaults, staging: base.appendingPathComponent(UUID().uuidString), storageLocations: locations) }
}

final class DeviceStorageTests: XCTestCase {
    private func code(_ expected: String, _ operation: () throws -> Any, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try operation(), file: file, line: line) { XCTAssertEqual(($0 as? DeviceCommandError)?.code, expected, file: file, line: line) }
    }
    func testCaptureCommitsPersistentRefAndMimeWithoutExposingNativePath() throws {
        let f = try StorageFixture()
        let url = try f.files.createCapture(extension: "jpg")
        try Data([0xff, 0xd8, 0xff, 0xd9]).write(to: url)
        let ref = try f.files.commitCapture(url)
        let id = try XCTUnwrap(ref["id"] as? String)
        XCTAssertEqual(Set(ref.keys), ["id", "name", "kind", "persistence"])
        XCTAssertEqual(ref["persistence"] as? String, "persistent")
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        XCTAssertEqual(try f.files.metadata(id)["mimeType"] as? String, "image/jpeg")
        let next = f.restarted()
        XCTAssertEqual(try next.metadata(id)["mimeType"] as? String, "image/jpeg")
        XCTAssertEqual(try f.read(id, files: next), Data([0xff, 0xd8, 0xff, 0xd9]))
        code("INVALID_ARGUMENT") { try f.files.commitCapture(url) }
    }

    func testCaptureRejectsUnownedPathsEmptyFilesAndCleansAbortedStage() throws {
        let f = try StorageFixture()
        let arbitrary = f.base.appendingPathComponent("unowned.jpg")
        try Data([1]).write(to: arbitrary)
        code("INVALID_ARGUMENT") { try f.files.commitCapture(arbitrary) }
        f.files.abortCapture(arbitrary)
        XCTAssertTrue(FileManager.default.fileExists(atPath: arbitrary.path))
        let url = try f.files.createCapture(extension: "mp4")
        try Data().write(to: url)
        code("IO_ERROR") { try f.files.commitCapture(url) }
        f.files.abortCapture(url); f.files.abortCapture(url)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        code("INVALID_ARGUMENT") { try f.files.createCapture(extension: "../escape") }
    }

    func testAreaValidationAndNoNativePathsInRootResult() throws {
        let f = try StorageFixture()
        for value: Any in ["documents", "../data", true, 1, NSNull()] {
            code("INVALID_ARGUMENT") { try f.run("storage.getRoot", ["area": value]) }
        }
        code("INVALID_ARGUMENT") { try f.run("storage.getUsage", ["area": "data", "path": "/private"]) }
        for area in ["data", "cache", "temporary"] {
            let root = try f.run("storage.getRoot", ["area": area])
            XCTAssertEqual(Set(root.keys), ["id", "name", "kind", "persistence"])
            XCTAssertEqual(root["kind"] as? String, "directory")
            XCTAssertEqual(root["persistence"] as? String, area == "temporary" ? "session" : "persistent")
            XCTAssertNotNil(UUID(uuidString: root["id"] as? String ?? ""))
        }
    }
    func testRootsCannotBeRemovedMovedRenamedOrForgottenAndAreNotExternalGrants() throws {
        let f = try StorageFixture()
        let data = try f.root("data"); let cache = try f.root("cache")
        for area in ["data", "cache", "temporary"] {
            let id = try f.root(area)
            code("INVALID_ARGUMENT") { try f.run("file.remove", ["id": id, "recursive": true]) }
            code("INVALID_ARGUMENT") { try f.run("file.rename", ["id": id, "name": "changed"]) }
            code("INVALID_ARGUMENT") { try f.run("file.move", ["id": id, "destinationDirectoryId": cache, "name": "changed"]) }
            code("INVALID_ARGUMENT") { try f.run("file.access.forget", ["id": id]) }
            code("INVALID_ARGUMENT") { try f.run("file.access.restore", ["id": id]) }
        }
        _ = try f.file(data)
        XCTAssertEqual(f.files.count, 0)
        let list = try f.run("file.access.list", ["cursor": NSNull(), "limit": 20])
        XCTAssertEqual((list["entries"] as? [[String: Any]])?.count, 0)
    }
    func testPersistentFileResolvesAfterRestartWithoutRootReadOrPrompt() throws {
        let f = try StorageFixture()
        let root = try f.root("data")
        let id = try f.file(root)
        let next = f.restarted()
        XCTAssertEqual(try f.read(id, files: next), Data([1, 2, 3]))
        XCTAssertEqual(try f.run("storage.getRoot", ["area": "data"], files: next)["id"] as? String, root)
        XCTAssertEqual((try next.metadata(id)["ref"] as? [String: Any])?["persistence"] as? String, "persistent")
    }
    func testResetClearsOnlyOwnTemporaryFilesAndKeepsDataCacheAndExternalGrant() throws {
        let f = try StorageFixture()
        let data = try f.file(f.root("data"))
        let cache = try f.file(f.root("cache"))
        let temporary = try f.root("temporary")
        let tempFile = try f.file(temporary)
        let outside = f.base.appendingPathComponent("external.txt"); try Data([9]).write(to: outside)
        let external = try StorageFixture.id(f.files.grant(outside))
        f.files.reset()
        code("NOT_FOUND") { try f.files.metadata(tempFile) }
        code("NOT_FOUND") { try f.files.metadata(temporary) }
        XCTAssertNotEqual(try f.root("temporary"), temporary)
        XCTAssertEqual(try f.read(data), Data([1, 2, 3]))
        XCTAssertEqual(try f.read(cache), Data([1, 2, 3]))
        XCTAssertEqual(try f.read(external), Data([9]))
        XCTAssertEqual(f.files.count, 1)
        XCTAssertEqual(try f.run("storage.getUsage", ["area": "temporary"])["usedBytes"] as? Int, 0)
    }
    func testLiveOwnerSurvivesAnotherOwnerAndStaleCrashDirectoriesAreCleaned() throws {
        let f = try StorageFixture()
        let file = try f.file(f.root("temporary"))
        let stale = f.locations.temporary.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: stale, withIntermediateDirectories: true)
        try Data().write(to: stale.appendingPathComponent(".owner.lock"))
        let incomplete = f.locations.temporary.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: incomplete, withIntermediateDirectories: true)
        let unknown = f.locations.temporary.appendingPathComponent("foreign-data")
        try FileManager.default.createDirectory(at: unknown, withIntermediateDirectories: true)
        let second = f.restarted()
        _ = try f.run("storage.getRoot", ["area": "temporary"], files: second)
        XCTAssertFalse(FileManager.default.fileExists(atPath: stale.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: incomplete.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: unknown.path))
        XCTAssertEqual(try f.read(file), Data([1, 2, 3]))
        second.reset()
        XCTAssertEqual(try f.read(file), Data([1, 2, 3]))
    }
    func testUsageIsPerAreaLogicalBytesAndQuotaIsUnknown() throws {
        let f = try StorageFixture()
        let data = try f.root("data")
        _ = try f.file(data, bytes: Data(repeating: 1, count: 1000))
        let directory = try StorageFixture.id(f.run("directory.create", ["directoryId": data, "name": "nested"]))
        _ = try f.file(directory, bytes: Data(repeating: 2, count: 17))
        _ = try f.file(f.root("cache"), bytes: Data(repeating: 3, count: 9))
        let usage = try f.run("storage.getUsage", ["area": "data"])
        XCTAssertEqual(usage["usedBytes"] as? Int, 1017)
        XCTAssertTrue(usage["quotaBytes"] is NSNull)
        XCTAssertEqual(try f.run("storage.getUsage", ["area": "cache"])["usedBytes"] as? Int, 9)
    }
    func testMoveAndRenamePersistentReferencesSurviveRestartAndDeletedIdsStayInvalid() throws {
        let f = try StorageFixture()
        let id = try f.file(f.root("data"))
        let cache = try f.root("cache")
        _ = try f.run("file.move", ["id": id, "destinationDirectoryId": cache, "name": "moved.dat"])
        _ = try f.run("file.rename", ["id": id, "name": "renamed.dat"])
        let next = f.restarted()
        XCTAssertEqual(try f.read(id, files: next), Data([1, 2, 3]))
        _ = try f.run("file.remove", ["id": id, "recursive": false], files: next)
        let after = f.restarted()
        code("NOT_FOUND") { try after.metadata(id) }
    }
    func testMovingBetweenExternalGrantAndInternalStorageUpdatesRegistry() throws {
        let f = try StorageFixture()
        let data = try f.root("data")
        let externalURL = f.base.appendingPathComponent("external.txt")
        try Data([4, 5]).write(to: externalURL)
        let id = try StorageFixture.id(f.files.grant(externalURL))
        XCTAssertEqual(f.files.count, 1)
        _ = try f.run("file.move", ["id": id, "destinationDirectoryId": data, "name": "imported.txt"])
        XCTAssertEqual(f.files.count, 0)
        let next = f.restarted()
        XCTAssertEqual(try f.read(id, files: next), Data([4, 5]))
        XCTAssertEqual((try next.metadata(id)["ref"] as? [String: Any])?["persistence"] as? String, "persistent")
        let directory = f.base.appendingPathComponent("external-directory")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let target = try StorageFixture.id(next.grant(directory))
        let moved = try f.run("file.move", ["id": id, "destinationDirectoryId": target, "name": "exported.txt"], files: next)
        XCTAssertEqual((moved["ref"] as? [String: Any])?["persistence"] as? String, "session")
        XCTAssertEqual(try f.read(id, files: next), Data([4, 5]))
        let after = f.restarted()
        code("NOT_FOUND") { try after.metadata(id) }
    }
    func testPersistedInternalReferenceCannotIntroduceTraversal() throws {
        let f = try StorageFixture()
        _ = try f.root("data")
        let outside = f.base.appendingPathComponent("outside.txt")
        try Data([9]).write(to: outside)
        var registry = try XCTUnwrap(f.defaults.dictionary(forKey: "gchat.device.internal-refs.v1"))
        var entries = try XCTUnwrap(registry["entries"] as? [String: [String: Any]])
        let bad = UUID().uuidString
        entries[bad] = ["area": "data", "components": ["..", "outside.txt"]]
        registry["entries"] = entries
        f.defaults.set(registry, forKey: "gchat.device.internal-refs.v1")
        let next = f.restarted()
        code("NOT_FOUND") { try f.read(bad, files: next) }
        XCTAssertEqual(try Data(contentsOf: outside), Data([9]))
    }
    func testInternalSymlinkAndRootReplacementCannotEscapeSandbox() throws {
        let f = try StorageFixture()
        let root = try f.root("data")
        let id = try f.file(root)
        let outside = f.base.appendingPathComponent("outside")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try Data([9]).write(to: outside.appendingPathComponent("test.dat"))
        try FileManager.default.moveItem(at: f.locations.data, to: f.base.appendingPathComponent("saved-data"))
        try FileManager.default.createSymbolicLink(at: f.locations.data, withDestinationURL: outside)
        code("PERMISSION_DENIED") { try f.read(id) }
        code("PERMISSION_DENIED") { try f.root("data") }
        XCTAssertEqual(try Data(contentsOf: outside.appendingPathComponent("test.dat")), Data([9]))
    }
}
