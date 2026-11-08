import XCTest
@testable import GChatCore

/// Uses only a new temporary directory and isolated defaults, never real grants/providers.
private final class FileFixture {
    let base: URL
    let area: URL
    let defaults: UserDefaults
    let suite: String
    let files: DeviceFiles
    let root: String

    init() throws {
        base = FileManager.default.temporaryDirectory.appendingPathComponent("gchat-file-matrix-" + UUID().uuidString)
        area = base.appendingPathComponent("area")
        try FileManager.default.createDirectory(at: area, withIntermediateDirectories: true)
        suite = "gchat.file-matrix." + UUID().uuidString
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        files = DeviceFiles(defaults: defaults, staging: base.appendingPathComponent("staging"))
        root = try Self.id(files.grant(area))
    }
    deinit { defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: base) }
    static func id(_ metadata: [String: Any]) throws -> String {
        try XCTUnwrap((metadata["ref"] as? [String: Any])?["id"] as? String)
    }
    @discardableResult func run(_ name: String, _ args: [String: Any]) throws -> [String: Any] {
        try files.execute(DeviceCommand(name: name, args: args))
    }
    func create(_ name: String, parent: String? = nil, directory: Bool = false) throws -> String {
        try Self.id(run(directory ? "directory.create" : "file.create", ["directoryId": parent ?? root, "name": name]))
    }
    func write(_ id: String, _ bytes: Data) throws {
        let begun = try run("file.write.begin", ["fileId": id, "mode": "replace", "expectedVersion": NSNull()])
        let write = try XCTUnwrap(begun["writeId"] as? String)
        for offset in stride(from: 0, to: bytes.count, by: 262144) {
            let chunk = bytes.subdata(in: offset..<min(bytes.count, offset + 262144))
            let result = try run("file.write.chunk", ["writeId": write, "offset": offset, "dataBase64": chunk.base64EncodedString()])
            XCTAssertEqual(result["bytesWritten"] as? Int, chunk.count)
        }
        _ = try run("file.write.commit", ["writeId": write])
    }
    func read(_ id: String) throws -> Data {
        var bytes = Data()
        while true {
            let result = try run("file.read", ["fileId": id, "offset": bytes.count, "length": 262144])
            let chunk = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(result["dataBase64"] as? String)))
            bytes.append(chunk)
            if result["eof"] as? Bool == true { return bytes }
            XCTAssertFalse(chunk.isEmpty)
            if chunk.isEmpty { throw DeviceCommandError("IO_ERROR") }
        }
    }
}

final class DeviceFilesMatrixTests: XCTestCase {
    private func code(_ expected: String, _ operation: () throws -> Any, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try operation(), file: file, line: line) {
            XCTAssertEqual(($0 as? DeviceCommandError)?.code, expected, file: file, line: line)
        }
    }

    func testEmptyAndMultipartBinaryRoundTripAndReadPastEnd() throws {
        let f = try FileFixture()
        let id = try f.create("binary.dat")
        XCTAssertEqual(try f.read(id), Data())
        let bytes = Data((0..<(3 * 262144 + 17)).map { UInt8($0 % 251) })
        try f.write(id, bytes)
        XCTAssertEqual(try f.read(id), bytes)
        let past = try f.run("file.read", ["fileId": id, "offset": bytes.count + 10, "length": 10])
        XCTAssertEqual(past["bytesRead"] as? Int, 0)
        XCTAssertEqual(past["eof"] as? Bool, true)
        try f.write(id, Data())
        XCTAssertEqual(try f.read(id), Data())
    }

    func testCopyRenameMoveKeepsReferencesAndNeverOverwrites() throws {
        let f = try FileFixture()
        let source = try f.create("source.bin")
        try f.write(source, Data([0, 255, 42]))
        let target = try f.create("destination", directory: true)
        let copied = try FileFixture.id(f.run("file.copy", ["id": source, "destinationDirectoryId": target, "name": "copy.bin"]))
        XCTAssertNotEqual(source, copied)
        XCTAssertEqual(try f.read(copied), try f.read(source))
        code("ALREADY_EXISTS") { try f.run("file.copy", ["id": source, "destinationDirectoryId": target, "name": "copy.bin"]) }
        _ = try f.run("file.rename", ["id": copied, "name": "renamed.bin"])
        let moved = try f.run("file.move", ["id": copied, "destinationDirectoryId": f.root, "name": "moved.bin"])
        XCTAssertEqual(try FileFixture.id(moved), copied)
        XCTAssertEqual(try f.read(copied), Data([0, 255, 42]))
        code("ALREADY_EXISTS") { try f.run("file.rename", ["id": copied, "name": "source.bin"]) }
        code("ALREADY_EXISTS") { try f.run("file.move", ["id": copied, "destinationDirectoryId": f.root, "name": "source.bin"]) }
        XCTAssertEqual(try f.read(source), Data([0, 255, 42]))
    }

    func testRecursiveCopySubtreeMoveProtectionAndDeletionInvalidation() throws {
        let f = try FileFixture()
        let folder = try f.create("folder", directory: true)
        let nested = try f.create("nested", parent: folder, directory: true)
        let child = try f.create("child.txt", parent: nested)
        try f.write(child, Data("fixture".utf8))
        code("INVALID_ARGUMENT") { try f.run("file.move", ["id": folder, "destinationDirectoryId": nested, "name": "loop"]) }
        let copy = try FileFixture.id(f.run("file.copy", ["id": folder, "destinationDirectoryId": f.root, "name": "copy"]))
        XCTAssertEqual(try Data(contentsOf: f.area.appendingPathComponent("copy/nested/child.txt")), Data("fixture".utf8))
        _ = try f.run("file.rename", ["id": folder, "name": "renamed"])
        XCTAssertEqual(try f.read(child), Data("fixture".utf8))
        code("CONFLICT") { try f.run("file.remove", ["id": folder, "recursive": false]) }
        _ = try f.run("file.remove", ["id": folder, "recursive": true])
        code("NOT_FOUND") { try f.files.metadata(child) }
        XCTAssertNoThrow(try f.files.metadata(copy))
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.area.appendingPathComponent("renamed").path))
    }

    func testWrongTypesAndDestinationConflictsAreTypedAndNonDestructive() throws {
        let f = try FileFixture()
        let id = try f.create("existing.txt")
        code("ALREADY_EXISTS") { try f.create("existing.txt") }
        code("WRONG_TYPE") { try f.run("file.read", ["fileId": f.root, "offset": 0, "length": 1]) }
        code("WRONG_TYPE") { try f.run("file.write.begin", ["fileId": f.root, "mode": "replace", "expectedVersion": NSNull()]) }
        code("WRONG_TYPE") { try f.create("child", parent: id) }
        code("WRONG_TYPE") { try f.run("directory.list", ["directoryId": id, "cursor": NSNull(), "limit": 20]) }
        XCTAssertEqual(try f.read(id), Data())
    }

    func testLostFileRestoreAndForgettingGrantPreserveOtherFiles() throws {
        let f = try FileFixture()
        let url = f.area.appendingPathComponent("external.txt")
        try Data("original".utf8).write(to: url)
        let id = try FileFixture.id(f.files.grant(url))
        try FileManager.default.removeItem(at: url)
        code("ACCESS_LOST") { try f.run("file.access.restore", ["id": id]) }
        let restored = DeviceFiles(defaults: f.defaults, staging: f.base.appendingPathComponent("restored-staging"))
        code("ACCESS_LOST") { try restored.execute(DeviceCommand(name: "file.access.restore", args: ["id": id])) }
        let sentinel = try f.create("keep.txt")
        try f.write(sentinel, Data("keep".utf8))
        _ = try f.run("file.access.forget", ["id": id])
        XCTAssertEqual(try f.read(sentinel), Data("keep".utf8))
    }

    func testBusyWriteResetAndStaleDirectoryCursor() throws {
        let f = try FileFixture()
        let id = try f.create("first.txt")
        _ = try f.create("second.txt")
        let list = try f.run("directory.list", ["directoryId": f.root, "cursor": NSNull(), "limit": 1])
        let cursor = try XCTUnwrap(list["nextCursor"] as? String)
        _ = try f.create("third.txt")
        code("CONFLICT") { try f.run("directory.list", ["directoryId": f.root, "cursor": cursor, "limit": 1]) }
        let begun = try f.run("file.write.begin", ["fileId": id, "mode": "replace", "expectedVersion": NSNull()])
        let write = try XCTUnwrap(begun["writeId"] as? String)
        code("BUSY") { try f.run("file.write.begin", ["fileId": id, "mode": "replace", "expectedVersion": NSNull()]) }
        _ = try f.run("file.write.chunk", ["writeId": write, "offset": 0, "dataBase64": Data("staged".utf8).base64EncodedString()])
        f.files.reset()
        code("NOT_FOUND") { try f.run("file.write.commit", ["writeId": write]) }
        XCTAssertEqual(try f.read(id), Data())
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: f.base.appendingPathComponent("staging").path).isEmpty)
        _ = try f.run("file.write.abort", ["writeId": write])
    }
}
