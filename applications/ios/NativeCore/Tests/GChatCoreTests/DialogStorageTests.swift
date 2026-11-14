import XCTest
import CSQLite
@testable import GChatCore

final class DialogStorageTests: XCTestCase {
    @MainActor func testSchemaOneMigrationPreservesDraftOutboxAndMessageMetadata() throws {
        let suite = "gchat-dialogs-migrate-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("dialogs.sqlite")
        let account = UUID().uuidString, session = UUID().uuidString, device = UUID().uuidString, cycle = UUID().uuidString, id = UUID().uuidString
        let storage = try DialogStorage(url: url, server: "https://test.invalid", defaults: defaults)
        let context = try storage.context(account: account, session: session, device: device, cycle: cycle)
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(url.path, &db), SQLITE_OK)
        defer { sqlite3_close(db) }
        func sql(_ value: String) throws {
            guard sqlite3_exec(db, value, nil, nil, nil) == SQLITE_OK else { throw DialogStorageFailure("TEST_SQL") }
        }
        try sql("CREATE TABLE dialog_records (namespace TEXT NOT NULL, epoch INTEGER NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(namespace,epoch,id))")
        try sql("CREATE TABLE dialog_messages (namespace TEXT NOT NULL, epoch INTEGER NOT NULL, dialog_id TEXT NOT NULL, id TEXT NOT NULL, sequence INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(namespace,epoch,id), UNIQUE(namespace,epoch,dialog_id,sequence))")
        let pending: [String: Any] = ["client_message_id": UUID().uuidString, "content": ["kind": "text", "text": "pending"], "created_at": "2026-11-14T00:00:00Z", "state": "unknown", "error": NSNull()]
        let record: [String: Any] = ["revision": 7, "dialog": NSNull(), "permissions": NSNull(), "initialized": true, "sync_sequence": 1, "ranges": [[1,1]], "before_sequence": 1, "has_older": false, "draft": ["text": "draft preserved", "revision": 4], "outbox": [pending], "read": 1, "peer_read": 1]
        let messageId = UUID().uuidString
        let legacy: [String: Any] = ["message_id": messageId, "dialog_id": id, "client_message_id": UUID().uuidString, "sequence": 1, "sender_id": account, "created_at": "2026-11-14T00:00:00Z", "content": ["kind": "text", "text": "before"], "status": "read"]
        func body(_ value: [String: Any]) throws -> String { String(data: try JSONSerialization.data(withJSONObject: value), encoding: .utf8)! }
        let namespace = context["namespaceId"] as! String, epoch = context["epoch"] as! Int
        try sql("INSERT INTO dialog_records VALUES('\(namespace)',\(epoch),'\(id)',7,'\(try body(record))')")
        try sql("INSERT INTO dialog_messages VALUES('\(namespace)',\(epoch),'\(id)','\(messageId)',1,'\(try body(legacy))')")
        try sql("PRAGMA user_version=1")
        func call(_ command: String, _ args: [String: Any]) throws -> [String: Any] {
            let envelope: [String: Any] = ["version": 2, "cycleId": cycle, "operationId": UUID().uuidString, "namespaceId": namespace, "epoch": epoch, "adapterEpoch": context["adapterEpoch"]!, "command": command, "args": args]
            return try storage.execute(envelope, account: account, session: session, device: device, cycle: cycle)["data"] as! [String: Any]
        }
        let migrated = try call("readDialog", ["id": id])
        XCTAssertEqual(migrated["edit_sync_sequence"] as? Int, 0)
        XCTAssertEqual(migrated["revision"] as? Int, 7)
        XCTAssertEqual((migrated["draft"] as? [String: Any])?["text"] as? String, "draft preserved")
        XCTAssertEqual((migrated["outbox"] as? [[String: Any]])?.first?["client_message_id"] as? String, pending["client_message_id"] as? String)
        let page = try call("readMessages", ["id": id, "after": 0, "limit": 30])
        let current = (page["messages"] as! [[String: Any]])[0]
        XCTAssertEqual(current["version"] as? Int, 1)
        XCTAssertEqual(current["edit_sequence"] as? Int, 0)
        XCTAssertTrue(current["edited_at"] is NSNull)
        var nextRecord = migrated
        nextRecord["revision"] = 8
        nextRecord["edit_sync_sequence"] = 1
        var edited = current
        edited["version"] = 2; edited["edited_at"] = "2026-11-14T01:00:00Z"; edited["edit_sequence"] = 1; edited["last_edit_id"] = UUID().uuidString
        edited["content"] = ["kind": "text", "text": "after"]
        _ = try call("commitEdits", ["id": id, "expectedRevision": 7, "record": nextRecord, "messages": [edited]])
        XCTAssertEqual(try call("readDialog", ["id": id])["edit_sync_sequence"] as? Int, 1)
        XCTAssertThrowsError(try call("commitEdits", ["id": id, "expectedRevision": 7, "record": nextRecord, "messages": [edited]]))
        let stored = try call("readMessages", ["id": id, "after": 0, "limit": 30])
        XCTAssertEqual((stored["messages"] as? [[String: Any]])?.first?["version"] as? Int, 2)
    }

    @MainActor func testCASRollbackAndPersistentFallback() throws {
        let suite = "gchat-dialogs-test-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("dialogs.sqlite")
        let account = UUID().uuidString, session = UUID().uuidString, device = UUID().uuidString, cycle = UUID().uuidString, id = UUID().uuidString
        let storage = try DialogStorage(url: url, server: "https://test.invalid", defaults: defaults)
        let context = try storage.context(account: account, session: session, device: device, cycle: cycle)
        func call(_ command: String, _ args: [String: Any], _ override: [String: Any] = [:]) throws -> Any {
            var envelope: [String: Any] = ["version": 2, "cycleId": cycle, "operationId": UUID().uuidString, "namespaceId": context["namespaceId"]!, "epoch": context["epoch"]!, "adapterEpoch": context["adapterEpoch"]!, "command": command, "args": args]
            envelope.merge(override) { _, new in new }
            return try storage.execute(envelope, account: account, session: session, device: device, cycle: cycle)["data"]!
        }
        var record = try XCTUnwrap(try call("readDialog", ["id": id]) as? [String: Any])
        record["revision"] = 1
        record["draft"] = ["text": "черновик", "revision": 1]
        _ = try call("saveDraft", ["id": id, "expectedRevision": 0, "record": record, "messages": []])
        XCTAssertThrowsError(try call("saveDraft", ["id": id, "expectedRevision": 0, "record": record, "messages": []])) { error in
            XCTAssertEqual((error as? DialogStorageFailure)?.code, "STORAGE_CONFLICT")
        }
        let stored = try XCTUnwrap(try call("readDialog", ["id": id]) as? [String: Any])
        XCTAssertEqual((stored["draft"] as? [String: Any])?["text"] as? String, "черновик")
        let transition = try XCTUnwrap(try call("beginFallback", [:]) as? [String: Any])
        XCTAssertThrowsError(try call("saveDraft", ["id": id, "expectedRevision": 0, "record": record, "messages": []]))
        _ = try call("selectIndexedDb", [:], ["adapterEpoch": transition["adapterEpoch"]!])
        let reopened = try DialogStorage(url: url, server: "https://test.invalid", defaults: defaults)
        XCTAssertEqual(try reopened.context(account: account, session: session, device: device, cycle: UUID().uuidString)["adapter"] as? String, "indexeddb")
    }

    @MainActor func testLastMessageRoundTripAndValidation() throws {
        let suite = "gchat-dialogs-preview-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
        defer { try? FileManager.default.removeItem(at: root) }
        let storage = try DialogStorage(url: root.appendingPathComponent("dialogs.sqlite"), server: "https://test.invalid", defaults: defaults)
        let account = UUID().uuidString, session = UUID().uuidString, device = UUID().uuidString, cycle = UUID().uuidString, id = UUID().uuidString
        let context = try storage.context(account: account, session: session, device: device, cycle: cycle)
        func call(_ command: String, _ args: [String: Any]) throws -> [String: Any] {
            let envelope: [String: Any] = ["version": 2, "cycleId": cycle, "operationId": UUID().uuidString, "namespaceId": context["namespaceId"]!, "epoch": context["epoch"]!, "adapterEpoch": context["adapterEpoch"]!, "command": command, "args": args]
            let response = try storage.execute(envelope, account: account, session: session, device: device, cycle: cycle)
            return try XCTUnwrap(response["data"] as? [String: Any])
        }
        var record = try call("readDialog", ["id": id])
        var dialog: [String: Any] = ["dialog_id": id, "peer_id": UUID().uuidString, "peer_display_name": "Peer", "has_unread_messages": true, "created_at": "now", "last_message_at": "now", "last_sequence": 1, "last_read_sequence": 0, "peer_last_read_sequence": 0]
        let message: [String: Any] = ["message_id": UUID().uuidString, "dialog_id": id, "client_message_id": UUID().uuidString, "sequence": 1, "sender_id": account, "created_at": "now", "content": ["kind": "text", "text": "Начало\n😀"], "status": "sent", "version": 1, "edited_at": NSNull(), "edit_sequence": 0, "last_edit_id": NSNull()]
        dialog["last_message"] = message
        record["dialog"] = dialog
        record["revision"] = 1
        _ = try call("commitMetadata", ["id": id, "expectedRevision": 0, "record": record, "messages": []])
        let list = try call("readDialogs", ["limit": 30, "offset": 0])
        let saved = try XCTUnwrap((list["dialogs"] as? [[String: Any]])?.first?["last_message"] as? [String: Any])
        XCTAssertEqual((saved["content"] as? [String: Any])?["text"] as? String, "Начало\n😀")
        record["revision"] = 2
        dialog["last_sequence"] = 2
        record["dialog"] = dialog
        XCTAssertThrowsError(try call("commitMetadata", ["id": id, "expectedRevision": 1, "record": record, "messages": []]))
        dialog["last_message"] = NSNull()
        record["dialog"] = dialog
        _ = try call("commitMetadata", ["id": id, "expectedRevision": 1, "record": record, "messages": []])
        let cleared = try call("readDialog", ["id": id])
        XCTAssertTrue((cleared["dialog"] as? [String: Any])?["last_message"] is NSNull)
    }

    @MainActor func testPurgeQuarantinesOldEpochAndDoesNotReopenOldSessionData() throws {
        let suite = "gchat-dialogs-purge-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
        defer { try? FileManager.default.removeItem(at: root) }
        let storage = try DialogStorage(url: root.appendingPathComponent("dialogs.sqlite"), server: "https://test.invalid", defaults: defaults)
        let account = UUID().uuidString, session = UUID().uuidString, device = UUID().uuidString, cycle = UUID().uuidString
        let before = try storage.context(account: account, session: session, device: device, cycle: cycle)
        try storage.purge(account: account)
        let envelope: [String: Any] = ["version": 2, "cycleId": cycle, "operationId": UUID().uuidString, "namespaceId": before["namespaceId"]!, "epoch": before["epoch"]!, "adapterEpoch": before["adapterEpoch"]!, "command": "readDialogs", "args": [:]]
        XCTAssertThrowsError(try storage.execute(envelope, account: account, session: session, device: device, cycle: cycle)) { error in
            XCTAssertEqual((error as? DialogStorageFailure)?.code, "STORAGE_STALE_CONTEXT")
        }
        let after = try storage.context(account: account, session: UUID().uuidString, device: device, cycle: cycle)
        XCTAssertGreaterThan(after["epoch"] as! Int, before["epoch"] as! Int)
    }

    @MainActor func testDeferredWebPurgeIsAvailableToNextAccountWithoutExposingMessages() throws {
        let suite = "gchat-dialogs-accounts-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
        defer { try? FileManager.default.removeItem(at: root) }
        let storage = try DialogStorage(url: root.appendingPathComponent("dialogs.sqlite"), server: "https://test.invalid", defaults: defaults)
        let old = UUID().uuidString, account = UUID().uuidString, session = UUID().uuidString, device = UUID().uuidString, cycle = UUID().uuidString
        _ = try storage.context(account: old, session: UUID().uuidString, device: device, cycle: cycle)
        try storage.purge(account: old)
        let context = try storage.context(account: account, session: session, device: device, cycle: cycle)
        XCTAssertEqual(context["pendingWebPurges"] as? [String], [old])
        let envelope: [String: Any] = ["version": 2, "cycleId": cycle, "operationId": UUID().uuidString, "namespaceId": context["namespaceId"]!, "epoch": context["epoch"]!, "adapterEpoch": context["adapterEpoch"]!, "command": "completeIndexedDbPurge", "args": ["accounts": [old]]]
        _ = try storage.execute(envelope, account: account, session: session, device: device, cycle: cycle)
        XCTAssertEqual(try storage.context(account: account, session: session, device: device, cycle: cycle)["pendingWebPurges"] as? [String], [])
    }

    @MainActor func testUnavailableSQLiteStillPersistsFallbackAndPendingPurge() throws {
        let suite = "gchat-dialogs-unavailable-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let storage = try DialogStorage(url: root, server: "https://test.invalid", defaults: defaults)
        let account = UUID().uuidString, session = UUID().uuidString, device = UUID().uuidString, cycle = UUID().uuidString
        let context = try storage.context(account: account, session: session, device: device, cycle: cycle)
        var envelope: [String: Any] = ["version": 2, "cycleId": cycle, "operationId": UUID().uuidString, "namespaceId": context["namespaceId"]!, "epoch": context["epoch"]!, "adapterEpoch": context["adapterEpoch"]!, "command": "beginFallback", "args": [:]]
        let transition = try XCTUnwrap(try storage.execute(envelope, account: account, session: session, device: device, cycle: cycle)["data"] as? [String: Any])
        XCTAssertTrue(transition["migrationHandle"] is NSNull)
        envelope["command"] = "selectIndexedDb"; envelope["adapterEpoch"] = transition["adapterEpoch"]
        _ = try storage.execute(envelope, account: account, session: session, device: device, cycle: cycle)
        try storage.purge(account: account)
        let next = try storage.context(account: account, session: session, device: device, cycle: cycle)
        XCTAssertEqual(next["adapter"] as? String, "indexeddb")
        XCTAssertEqual(next["purgePending"] as? Bool, true)
    }
}
