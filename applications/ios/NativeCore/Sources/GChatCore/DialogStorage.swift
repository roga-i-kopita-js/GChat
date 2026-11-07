import Foundation
import CSQLite

public struct DialogStorageFailure: Error {
    public let code: String
    public init(_ code: String) { self.code = code }
}

/// Serialized by NativeCore's main actor. Control metadata is independent of SQLite availability.
@MainActor public final class DialogStorage {
    private struct Area: Codable {
        var namespace: String
        var account: String
        var session: String
        var device: String
        var epoch: Int
        var purgePending: Bool
        var webPurgePending: Bool?
    }
    private struct Control: Codable {
        var adapter = "sqlite"
        var adapterEpoch = 0
        var fallbackPending = false
        var areas: [String: Area] = [:]
    }
    private let url: URL
    private let defaults: UserDefaults
    private let key: String
    private var control: Control
    private var db: OpaquePointer?
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    public init(url: URL, server: String, defaults: UserDefaults = .standard) throws {
        self.url = url; self.defaults = defaults; key = "gchat.dialog-storage.v1." + server
        if let data = defaults.data(forKey: key) {
            guard let value = try? JSONDecoder().decode(Control.self, from: data) else { throw DialogStorageFailure("STORAGE_UNAVAILABLE") }
            control = value
        } else { control = Control() }
    }
    deinit { if let db { sqlite3_close(db) } }
    private func persist() throws {
        defaults.set(try JSONEncoder().encode(control), forKey: key)
        guard defaults.synchronize() else { throw DialogStorageFailure("STORAGE_UNAVAILABLE") }
    }
    private func failure(_ status: Int32) -> DialogStorageFailure {
        DialogStorageFailure(status == SQLITE_FULL ? "STORAGE_FULL" : "STORAGE_UNAVAILABLE")
    }
    private func open() throws {
        if db != nil { return }
        do { try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true) }
        catch { throw DialogStorageFailure("STORAGE_UNAVAILABLE") }
        var connection: OpaquePointer?
        let status = sqlite3_open_v2(url.path, &connection, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil)
        guard status == SQLITE_OK, let connection else { if let connection { sqlite3_close(connection) }; throw failure(status) }
        db = connection
        do {
            let version = try rows("PRAGMA user_version", []).first?[0] ?? "0"
            guard version == "0" || version == "1" else { throw DialogStorageFailure("STORAGE_VERSION_UNSUPPORTED") }
            try execute("PRAGMA journal_mode=WAL", [])
            try execute("PRAGMA synchronous=FULL", [])
            try execute("CREATE TABLE IF NOT EXISTS dialog_records (namespace TEXT NOT NULL, epoch INTEGER NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(namespace,epoch,id))", [])
            try execute("CREATE TABLE IF NOT EXISTS dialog_messages (namespace TEXT NOT NULL, epoch INTEGER NOT NULL, dialog_id TEXT NOT NULL, id TEXT NOT NULL, sequence INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(namespace,epoch,id), UNIQUE(namespace,epoch,dialog_id,sequence))", [])
            try execute("PRAGMA user_version=1", [])
        } catch { sqlite3_close(connection); db = nil; throw error }
    }
    private func statement(_ sql: String, _ values: [String]) throws -> OpaquePointer {
        guard let db else { throw DialogStorageFailure("STORAGE_UNAVAILABLE") }
        var statement: OpaquePointer?
        let status = sqlite3_prepare_v2(db, sql, -1, &statement, nil)
        guard status == SQLITE_OK, let statement else { throw failure(status) }
        for (index, value) in values.enumerated() {
            let status = value.withCString { sqlite3_bind_text(statement, Int32(index + 1), $0, -1, transient) }
            if status != SQLITE_OK { sqlite3_finalize(statement); throw failure(status) }
        }
        return statement
    }
    private func execute(_ sql: String, _ values: [String]) throws {
        let query = try statement(sql, values); defer { sqlite3_finalize(query) }
        var status = sqlite3_step(query)
        while status == SQLITE_ROW { status = sqlite3_step(query) }
        guard status == SQLITE_DONE else { throw failure(status) }
    }
    private func rows(_ sql: String, _ values: [String]) throws -> [[String]] {
        let query = try statement(sql, values); defer { sqlite3_finalize(query) }
        var result: [[String]] = []
        while true {
            let status = sqlite3_step(query)
            if status == SQLITE_DONE { return result }
            guard status == SQLITE_ROW else { throw failure(status) }
            result.append((0..<sqlite3_column_count(query)).map { column in
                sqlite3_column_text(query, column).map { String(cString: $0) } ?? ""
            })
        }
    }
    private func json(_ value: Any) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        guard data.count <= 524288, let text = String(data: data, encoding: .utf8) else { throw DialogStorageFailure("STORAGE_FULL") }
        return text
    }
    private func object(_ text: String) throws -> [String: Any] {
        guard let data = text.data(using: .utf8), let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw DialogStorageFailure("STORAGE_UNAVAILABLE") }
        return result
    }
    private func empty() -> [String: Any] {
        ["revision": 0, "dialog": NSNull(), "permissions": NSNull(), "initialized": false,
         "sync_sequence": 0, "ranges": [], "before_sequence": NSNull(), "has_older": false,
         "draft": ["text": "", "revision": 0], "outbox": [], "read": 0, "peer_read": 0]
    }
    private func number(_ value: Any?) -> Int? {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.doubleValue.isFinite, value.doubleValue.rounded() == value.doubleValue,
              value.doubleValue >= 0, value.doubleValue <= 9007199254740991 else { return nil }
        return value.intValue
    }
    private func validate(_ record: [String: Any], id: String, expected: Int) throws {
        guard Set(record.keys) == ["revision", "dialog", "permissions", "initialized", "sync_sequence", "ranges", "before_sequence", "has_older", "draft", "outbox", "read", "peer_read"],
              number(record["revision"]) == expected + 1,
              number(record["sync_sequence"]) != nil, number(record["read"]) != nil, number(record["peer_read"]) != nil,
              record["initialized"] is Bool, record["has_older"] is Bool,
              let ranges = record["ranges"] as? [[Any]], ranges.allSatisfy({ $0.count == 2 && number($0[0]) != nil && number($0[1]) != nil && number($0[0])! <= number($0[1])! }),
              record["before_sequence"] is NSNull || number(record["before_sequence"]) != nil,
              let draft = record["draft"] as? [String: Any], Set(draft.keys) == ["text", "revision"], draft["text"] is String, number(draft["revision"]) != nil,
              let pending = record["outbox"] as? [[String: Any]] else { throw DialogStorageFailure("STORAGE_INVALID_ARGUMENT") }
        if let dialog = record["dialog"] as? [String: Any] {
            guard Set(dialog.keys) == ["dialog_id", "peer_id", "peer_display_name", "has_unread_messages", "created_at", "last_message_at", "last_sequence", "last_read_sequence", "peer_last_read_sequence"],
                  dialog["dialog_id"] as? String == id, let peer = dialog["peer_id"] as? String, UUID(uuidString: peer) != nil,
                  let name = dialog["peer_display_name"] as? String, name.unicodeScalars.count <= 80,
                  dialog["has_unread_messages"] is Bool, dialog["created_at"] is String,
                  dialog["last_message_at"] is NSNull || dialog["last_message_at"] is String,
                  number(dialog["last_sequence"]) != nil, number(dialog["last_read_sequence"]) != nil, number(dialog["peer_last_read_sequence"]) != nil else { throw DialogStorageFailure("STORAGE_INVALID_ARGUMENT") }
        }
        else if !(record["dialog"] is NSNull) { throw DialogStorageFailure("STORAGE_INVALID_ARGUMENT") }
        if let permissions = record["permissions"] as? [String: Any] {
            guard Set(permissions.keys) == ["can_read", "can_send"], permissions.values.allSatisfy({ $0 is Bool }) else { throw DialogStorageFailure("STORAGE_INVALID_ARGUMENT") }
        } else if !(record["permissions"] is NSNull) { throw DialogStorageFailure("STORAGE_INVALID_ARGUMENT") }
        for item in pending {
            guard Set(item.keys) == ["client_message_id", "content", "created_at", "state", "error"],
                  let client = item["client_message_id"] as? String, UUID(uuidString: client) != nil,
                  let state = item["state"] as? String, ["prepared", "sending", "unknown", "rejected"].contains(state),
                  item["created_at"] is String, item["error"] is NSNull || item["error"] is String,
                  let content = item["content"] as? [String: Any] else { throw DialogStorageFailure("STORAGE_INVALID_ARGUMENT") }
            try validateContent(content)
        }
    }
    private func validateContent(_ content: [String: Any]) throws {
        if content["kind"] as? String == "text" {
            guard Set(content.keys) == ["kind", "text"], let text = content["text"] as? String,
                  text.unicodeScalars.count <= 4000, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw DialogStorageFailure("STORAGE_INVALID_ARGUMENT") }
        } else {
            guard content["kind"] as? String == "sticker", Set(content.keys) == ["kind", "sticker_id"], content["sticker_id"] is String else { throw DialogStorageFailure("STORAGE_INVALID_ARGUMENT") }
        }
    }
    public func context(account: String, session: String, device: String, cycle: String) throws -> [String: Any] {
        guard UUID(uuidString: account) != nil, UUID(uuidString: session) != nil, UUID(uuidString: device) != nil else { throw DialogStorageFailure("STORAGE_STALE_CONTEXT") }
        // A different authenticated cycle cannot reuse old data after revocation or database recovery.
        let stale = control.areas.filter { $0.value.account == account && $0.value.session != session }
        if !stale.isEmpty {
            for (id, var area) in stale { area.epoch += 1; area.purgePending = true; area.webPurgePending = true; area.session = session; control.areas[id] = area }
            try persist()
        }
        let areaKey = account + ":" + device
        if control.areas[areaKey] == nil {
            control.areas[areaKey] = Area(namespace: UUID().uuidString.lowercased(), account: account, session: session, device: device, epoch: 1, purgePending: false, webPurgePending: false)
            try persist()
        }
        try cleanupIfAvailable()
        guard let area = control.areas[areaKey] else { throw DialogStorageFailure("STORAGE_STALE_CONTEXT") }
        return ["cycleId": cycle, "accountId": account, "sessionId": session, "deviceId": device,
                "namespaceId": area.namespace, "epoch": area.epoch, "adapterEpoch": control.adapterEpoch,
                "schemaVersion": 1, "adapter": control.adapter, "purgePending": control.areas.values.contains { $0.purgePending || $0.webPurgePending == true },
                "pendingWebPurges": Array(Set(control.areas.values.filter { $0.webPurgePending == true }.map { $0.account })).sorted()]
    }
    private func cleanupIfAvailable() throws {
        guard control.areas.values.contains(where: { $0.purgePending }) else { return }
        do {
            try open()
            for (key, var area) in control.areas where area.purgePending {
                try execute("BEGIN IMMEDIATE", [])
                do {
                    try execute("DELETE FROM dialog_records WHERE namespace=? AND epoch<?", [area.namespace, String(area.epoch)])
                    try execute("DELETE FROM dialog_messages WHERE namespace=? AND epoch<?", [area.namespace, String(area.epoch)])
                    try execute("COMMIT", [])
                } catch { try? execute("ROLLBACK", []); throw error }
                area.purgePending = false; control.areas[key] = area
            }
            try persist()
        } catch let error as DialogStorageFailure {
            if error.code == "STORAGE_VERSION_UNSUPPORTED" { throw error }
            // Quarantine stays durable; no old generation can be read even if physical deletion failed.
        }
    }
    public func purge(account: String) throws {
        for (id, var area) in control.areas where area.account == account {
            area.epoch += 1; area.purgePending = true; area.webPurgePending = true; control.areas[id] = area
        }
        try persist()
        try cleanupIfAvailable()
    }
    public func execute(_ envelope: [String: Any], account: String, session: String, device: String, cycle: String) throws -> [String: Any] {
        guard Set(envelope.keys) == ["version", "cycleId", "operationId", "namespaceId", "epoch", "adapterEpoch", "command", "args"], number(envelope["version"]) == 1,
              envelope["cycleId"] as? String == cycle,
              let operation = envelope["operationId"] as? String, UUID(uuidString: operation) != nil,
              let namespace = envelope["namespaceId"] as? String,
              let epoch = number(envelope["epoch"]), let adapterEpoch = number(envelope["adapterEpoch"]),
              let command = envelope["command"] as? String, let args = envelope["args"] as? [String: Any],
              let area = control.areas[account + ":" + device], area.namespace == namespace, area.epoch == epoch, area.session == session else { throw DialogStorageFailure("STORAGE_STALE_CONTEXT") }
        _ = try json(envelope)
        let response: (Any) -> [String: Any] = { ["version": 1, "cycleId": cycle, "operationId": operation, "data": $0] }
        if command == "beginFallback" {
            if !control.fallbackPending && control.adapter != "indexeddb" { control.adapterEpoch += 1; control.fallbackPending = true; try persist() }
            let readable = (try? open()) != nil
            return response(["adapterEpoch": control.adapterEpoch, "migrationHandle": readable ? namespace as Any : NSNull()])
        }
        guard adapterEpoch == control.adapterEpoch else { throw DialogStorageFailure("STORAGE_STALE_CONTEXT") }
        if command == "selectIndexedDb" { control.adapter = "indexeddb"; control.fallbackPending = false; try persist(); return response([:]) }
        if command == "completeIndexedDbPurge" {
            guard Set(args.keys) == ["accounts"], let accounts = args["accounts"] as? [String], accounts.allSatisfy({ UUID(uuidString: $0) != nil }) else { throw DialogStorageFailure("STORAGE_INVALID_ARGUMENT") }
            for (key, var pending) in control.areas where accounts.contains(pending.account) { pending.webPurgePending = false; control.areas[key] = pending }
            try persist()
            return response(["purgePending": control.areas.values.contains { $0.purgePending || $0.webPurgePending == true }])
        }
        if command == "purge" { try purge(account: account); return response(["purgePending": control.areas.values.contains { $0.purgePending || $0.webPurgePending == true }]) }
        try open(); try cleanupIfAvailable()
        let binding = [namespace, String(epoch)]
        if command == "exportFallbackPage" {
            guard control.fallbackPending, args["migrationHandle"] as? String == namespace else { throw DialogStorageFailure("STORAGE_STALE_CONTEXT") }
            let offset = (args["cursor"] as? String).flatMap(Int.init) ?? 0
            let records = try rows("SELECT id,body FROM dialog_records WHERE namespace=? AND epoch=? ORDER BY id", binding)
            // One dialog per export page; history is bounded separately through the composite cursor.
            let parts = (args["cursor"] as? String ?? "0:0").split(separator: ":").compactMap { Int($0) }
            let index = parts.first ?? offset, after = parts.count > 1 ? parts[1] : 0
            guard index >= 0, index <= records.count, after >= 0 else { throw DialogStorageFailure("STORAGE_INVALID_ARGUMENT") }
            if index == records.count { return response(["entries": [], "nextCursor": NSNull(), "has_more": false]) }
            let row = records[index], history = try history(namespace: namespace, epoch: epoch, id: row[0], after: after, limit: 30)
            let messages = history["messages"] as? [[String: Any]] ?? []
            let more = history["has_more"] as? Bool ?? false
            let next = more ? "\(index):\(messages.last?["sequence"] as? Int ?? after)" : "\(index + 1):0"
            return response(["entries": [["id": row[0], "record": try object(row[1]), "messages": messages]], "nextCursor": next, "has_more": more || index + 1 < records.count])
        }
        guard control.adapter == "sqlite", !control.fallbackPending else { throw DialogStorageFailure("STORAGE_STALE_CONTEXT") }
        if command == "readDialogs" {
            guard Set(args.keys) == ["limit", "offset"], let limit = number(args["limit"]), (1...100).contains(limit), let offset = number(args["offset"]) else { throw DialogStorageFailure("STORAGE_INVALID_ARGUMENT") }
            let records = try rows("SELECT body FROM dialog_records WHERE namespace=? AND epoch=? ORDER BY id LIMIT ? OFFSET ?", binding + [String(limit + 1), String(offset)])
            let dialogs = try records.prefix(limit).compactMap { try object($0[0])["dialog"] as? [String: Any] }
            return response(["dialogs": dialogs, "has_more": records.count > limit, "nextOffset": offset + min(limit, records.count)])
        }
        guard let id = args["id"] as? String, UUID(uuidString: id) != nil else { throw DialogStorageFailure("STORAGE_INVALID_ARGUMENT") }
        if command == "readDialog" {
            return response(try rows("SELECT body FROM dialog_records WHERE namespace=? AND epoch=? AND id=?", binding + [id]).first.map { try object($0[0]) } ?? empty())
        }
        if command == "readMessages" {
            guard let after = number(args["after"]), let limit = number(args["limit"]), (1...100).contains(limit) else { throw DialogStorageFailure("STORAGE_INVALID_ARGUMENT") }
            return response(try history(namespace: namespace, epoch: epoch, id: id, after: after, limit: limit))
        }
        guard ["commitPage", "commitMetadata", "saveDraft", "prepareSend", "markAttempt", "commitSent", "confirmRead"].contains(command),
              Set(args.keys) == ["id", "expectedRevision", "record", "messages"],
              let expected = number(args["expectedRevision"]), let record = args["record"] as? [String: Any],
              let messages = args["messages"] as? [[String: Any]], messages.count <= 100 else { throw DialogStorageFailure("STORAGE_INVALID_ARGUMENT") }
        try validate(record, id: id, expected: expected)
        for message in messages {
            guard Set(message.keys) == ["message_id", "dialog_id", "client_message_id", "sequence", "sender_id", "created_at", "content", "status"],
                  message["dialog_id"] as? String == id, let sequence = number(message["sequence"]), sequence > 0,
                  let identifier = message["message_id"] as? String, UUID(uuidString: identifier) != nil,
                  let sender = message["sender_id"] as? String, UUID(uuidString: sender) != nil,
                  let client = message["client_message_id"] as? String, UUID(uuidString: client) != nil,
                  message["created_at"] is String, let status = message["status"] as? String, ["sent", "read"].contains(status),
                  let content = message["content"] as? [String: Any] else { throw DialogStorageFailure("STORAGE_INVALID_ARGUMENT") }
            try validateContent(content)
        }
        try execute("BEGIN IMMEDIATE", [])
        do {
            let revision = try rows("SELECT revision FROM dialog_records WHERE namespace=? AND epoch=? AND id=?", binding + [id]).first.flatMap { Int($0[0]) } ?? 0
            guard revision == expected else { throw DialogStorageFailure("STORAGE_CONFLICT") }
            try execute("INSERT INTO dialog_records(namespace,epoch,id,revision,body) VALUES(?,?,?,?,?) ON CONFLICT(namespace,epoch,id) DO UPDATE SET revision=excluded.revision,body=excluded.body", binding + [id, String(expected + 1), try json(record)])
            for message in messages {
                try execute("INSERT INTO dialog_messages(namespace,epoch,dialog_id,id,sequence,body) VALUES(?,?,?,?,?,?) ON CONFLICT(namespace,epoch,id) DO UPDATE SET body=excluded.body", binding + [id, message["message_id"] as! String, String(number(message["sequence"])!), try json(message)])
            }
            try execute("COMMIT", [])
        } catch { try? execute("ROLLBACK", []); throw error }
        return response([:])
    }
    private func history(namespace: String, epoch: Int, id: String, after: Int, limit: Int) throws -> [String: Any] {
        let values = try rows("SELECT body FROM dialog_messages WHERE namespace=? AND epoch=? AND dialog_id=? AND sequence>? ORDER BY sequence LIMIT ?", [namespace, String(epoch), id, String(after), String(limit + 1)])
        var messages: [[String: Any]] = []
        for value in values.prefix(limit) {
            let candidate = try object(value[0])
            let page: [String: Any] = ["messages": messages + [candidate], "has_more": true]
            guard (try? json(page)) != nil else { break }
            messages.append(candidate)
        }
        guard !messages.isEmpty || values.isEmpty else { throw DialogStorageFailure("STORAGE_FULL") }
        return ["messages": messages, "has_more": values.count > messages.count]
    }
}
