import XCTest
@testable import GChatCore

final class DeviceCommandTests: XCTestCase {
    func testRejectsTraversalBooleansAndUnexpectedFields() throws {
        for args: [String: Any] in [["directoryId": UUID().uuidString, "name": "../private"], ["directoryId": UUID().uuidString, "name": ".."], ["directoryId": UUID().uuidString, "name": "a\\b"]] {
            XCTAssertThrowsError(try DeviceCommand(name: "file.create", args: args))
        }
        XCTAssertThrowsError(try DeviceCommand(name: "file.read", args: ["fileId": UUID().uuidString, "offset": true, "length": 10]))
        XCTAssertThrowsError(try DeviceCommand(name: "permission.request", args: ["resource": "camera", "url": "file:///private"]))
        XCTAssertThrowsError(try DeviceCommand(name: "selector", args: [:]))
        XCTAssertThrowsError(try DeviceCommand(name: "file.write.chunk", args: ["writeId": UUID().uuidString, "offset": 0, "dataBase64": Data(repeating: 1, count: 262145).base64EncodedString()]))
    }

    func testEnvelopeRejectsBooleanVersionAndUnknownFields() throws {
        let valid: [String: Any] = ["deviceBridgeVersion": 1, "cycleId": UUID().uuidString, "requestId": UUID().uuidString, "command": "device.state.read", "args": [:]]
        XCTAssertNoThrow(try DeviceCommandEnvelope(valid))
        var invalid = valid; invalid["deviceBridgeVersion"] = true
        XCTAssertThrowsError(try DeviceCommandEnvelope(invalid))
        invalid = valid; invalid["callback"] = "selector"
        XCTAssertThrowsError(try DeviceCommandEnvelope(invalid))
    }

    func testFileWritesAreStagedAndAbortKeepsOriginal() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("original.txt"); try Data("original".utf8).write(to: source)
        let suite = "gchat.device.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let files = DeviceFiles(defaults: defaults, staging: root.appendingPathComponent("staging"))
        let meta = try files.grant(source); let ref = try XCTUnwrap(meta["ref"] as? [String: Any]); let id = try XCTUnwrap(ref["id"] as? String)
        let begun = try files.execute(DeviceCommand(name: "file.write.begin", args: ["fileId": id, "mode": "replace", "expectedVersion": meta["version"]!]))
        let writeId = try XCTUnwrap(begun["writeId"] as? String)
        _ = try files.execute(DeviceCommand(name: "file.write.chunk", args: ["writeId": writeId, "offset": 0, "dataBase64": Data("new".utf8).base64EncodedString()]))
        XCTAssertEqual(try String(contentsOf: source), "original")
        _ = try files.execute(DeviceCommand(name: "file.write.abort", args: ["writeId": writeId]))
        XCTAssertEqual(try String(contentsOf: source), "original")
        _ = try files.execute(DeviceCommand(name: "file.access.forget", args: ["id": id]))
        XCTAssertEqual(try String(contentsOf: source), "original")
        XCTAssertEqual(files.count, 0)
    }

    func testCommitRoundTripAndVersionConflict() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("original.txt"); try Data("original".utf8).write(to: source)
        let suite = "gchat.device.test.\(UUID().uuidString)"; let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let files = DeviceFiles(defaults: defaults, staging: root.appendingPathComponent("staging"))
        let meta = try files.grant(source); let ref = try XCTUnwrap(meta["ref"] as? [String: Any]); let id = try XCTUnwrap(ref["id"] as? String)
        func begin(_ version: Any) throws -> String {
            let value = try files.execute(DeviceCommand(name: "file.write.begin", args: ["fileId": id, "mode": "replace", "expectedVersion": version]))
            return try XCTUnwrap(value["writeId"] as? String)
        }
        let writeId = try begin(meta["version"]!)
        _ = try files.execute(DeviceCommand(name: "file.write.chunk", args: ["writeId": writeId, "offset": 0, "dataBase64": Data("updated".utf8).base64EncodedString()]))
        _ = try files.execute(DeviceCommand(name: "file.write.commit", args: ["writeId": writeId]))
        XCTAssertEqual(try String(contentsOf: source), "updated")
        let current = try files.metadata(id)
        let second = try begin(current["version"]!)
        try Data("external modification".utf8).write(to: source)
        XCTAssertThrowsError(try files.execute(DeviceCommand(name: "file.write.commit", args: ["writeId": second]))) { error in XCTAssertEqual((error as? DeviceCommandError)?.code, "CONFLICT") }
        files.reset()
        XCTAssertEqual(try String(contentsOf: source), "external modification")
        let restored = DeviceFiles(defaults: defaults, staging: root.appendingPathComponent("other-staging"))
        XCTAssertEqual(restored.count, 1)
        XCTAssertNoThrow(try restored.metadata(id))
    }

    func testSymlinkCannotEscapeGrantedDirectory() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let granted = root.appendingPathComponent("granted"); try FileManager.default.createDirectory(at: granted, withIntermediateDirectories: true)
        let outside = root.appendingPathComponent("outside.txt"); try Data("private".utf8).write(to: outside)
        try FileManager.default.createSymbolicLink(at: granted.appendingPathComponent("escape.txt"), withDestinationURL: outside)
        let suite = "gchat.device.test.\(UUID().uuidString)"; let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let files = DeviceFiles(defaults: defaults, staging: root.appendingPathComponent("staging"))
        let meta = try files.grant(granted); let ref = try XCTUnwrap(meta["ref"] as? [String: Any]); let id = try XCTUnwrap(ref["id"] as? String)
        XCTAssertThrowsError(try files.execute(DeviceCommand(name: "directory.list", args: ["directoryId": id, "cursor": NSNull(), "limit": 20]))) { error in XCTAssertEqual((error as? DeviceCommandError)?.code, "PERMISSION_DENIED") }
    }
}
