import Foundation
import CoreFoundation

public struct DeviceCommandError: Error {
    public let code: String
    public let details: [String: Any]
    public init(_ code: String, _ details: [String: Any] = [:]) { self.code = code; var context: [String: Any] = code == "OUTCOME_UNKNOWN" ? ["outcome": "unknown"] : code == "PARTIAL_FAILURE" ? ["outcome": "partial"] : [:]; context.merge(details) { _, value in value }; self.details = context }
}

/// The native boundary validates independently of TypeScript and never dispatches selectors.
public struct DeviceCommand {
    public let name: String
    public let args: [String: Any]
    private static let fields: [String: Set<String>] = [
        "device.state.read": [], "device.changes.cancel": [], "device.settings.open": [],
        "permission.read": ["resource"], "permission.request": ["resource"],
        "device.changes.wait": ["afterRevision", "timeoutMs"], "audio.test.start": ["kind"], "audio.test.stop": ["testId"],
        "audio.output.select": [], "call.prepareOutgoing": [], "push.enable": [], "push.disable": [],
        "file.pick": ["multiple", "accept"], "directory.pick": [],
        "file.access.list": ["cursor", "limit"], "file.access.restore": ["id"], "file.access.forget": ["id"], "file.stat": ["id"],
        "directory.list": ["directoryId", "cursor", "limit"], "file.read": ["fileId", "offset", "length"],
        "file.create": ["directoryId", "name"], "directory.create": ["directoryId", "name"],
        "file.write.begin": ["fileId", "mode", "expectedVersion"], "file.write.chunk": ["writeId", "offset", "dataBase64"],
        "file.write.commit": ["writeId"], "file.write.abort": ["writeId"],
        "file.saveAs": ["sourceFileId", "suggestedName"], "file.export": ["sourceFileId", "suggestedName"],
        "file.copy": ["id", "destinationDirectoryId", "name"], "file.move": ["id", "destinationDirectoryId", "name"],
        "file.rename": ["id", "name"], "file.remove": ["id", "recursive"]
    ]

    public init(name: String, args: [String: Any]) throws {
        guard let fields = Self.fields[name], fields == Set(args.keys) else { throw DeviceCommandError("INVALID_ARGUMENT") }
        self.name = name; self.args = args
        for key in ["id", "fileId", "directoryId", "destinationDirectoryId", "sourceFileId", "writeId", "testId"] where fields.contains(key) {
            guard let text = args[key] as? String, UUID(uuidString: text) != nil else { throw DeviceCommandError("INVALID_ARGUMENT") }
        }
        for key in ["offset", "length", "limit", "afterRevision", "timeoutMs"] where fields.contains(key) {
            guard let number = args[key] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
                  number.doubleValue.rounded() == number.doubleValue, number.doubleValue >= 0, number.doubleValue <= 9007199254740991 else { throw DeviceCommandError("INVALID_ARGUMENT") }
        }
        if fields.contains("limit"), !(1...200).contains(integer("limit")) { throw DeviceCommandError("INVALID_ARGUMENT") }
        if fields.contains("length"), !(1...262144).contains(integer("length")) { throw DeviceCommandError("INVALID_ARGUMENT") }
        if fields.contains("timeoutMs"), !(1000...30000).contains(integer("timeoutMs")) { throw DeviceCommandError("INVALID_ARGUMENT") }
        for key in ["name", "suggestedName"] where fields.contains(key) {
            guard let value = args[key] as? String, !value.isEmpty, value != ".", value != "..", !value.contains("/"), !value.contains("\\"), !value.contains("\0") else { throw DeviceCommandError("INVALID_ARGUMENT") }
        }
        for key in ["cursor", "expectedVersion"] where fields.contains(key) {
            guard args[key] is NSNull || args[key] is String else { throw DeviceCommandError("INVALID_ARGUMENT") }
        }
        for key in ["multiple", "recursive"] where fields.contains(key) {
            guard let value = args[key] as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { throw DeviceCommandError("INVALID_ARGUMENT") }
        }
        if fields.contains("resource"), !["microphone", "camera", "geolocation"].contains(string("resource")) { throw DeviceCommandError("INVALID_ARGUMENT") }
        if fields.contains("kind"), !["microphone", "sound"].contains(string("kind")) { throw DeviceCommandError("INVALID_ARGUMENT") }
        if fields.contains("mode"), !["replace", "update"].contains(string("mode")) { throw DeviceCommandError("INVALID_ARGUMENT") }
        if fields.contains("accept") {
            guard let values = args["accept"] as? [String], values.count <= 50, values.allSatisfy({ $0.range(of: "^[A-Za-z0-9_.+-]+/[A-Za-z0-9_.+*-]+$", options: .regularExpression) != nil }) else { throw DeviceCommandError("INVALID_ARGUMENT") }
        }
        if fields.contains("dataBase64") {
            let value = string("dataBase64")
            guard args["dataBase64"] is String, value.utf8.count <= 349528,
                  let data = Data(base64Encoded: value), data.count <= 262144, data.base64EncodedString() == value else { throw DeviceCommandError("INVALID_ARGUMENT") }
        }
    }

    public func string(_ key: String) -> String { args[key] as? String ?? "" }
    public func integer(_ key: String) -> Int { (args[key] as? NSNumber)?.intValue ?? 0 }
    public func bool(_ key: String) -> Bool { (args[key] as? NSNumber)?.boolValue ?? false }
}

public struct DeviceCommandEnvelope {
    public let cycle: String
    public let request: String
    public let command: DeviceCommand

    public init(_ value: [String: Any]) throws {
        guard Set(value.keys) == ["deviceBridgeVersion", "cycleId", "requestId", "command", "args"],
              let version = value["deviceBridgeVersion"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(),
              let cycle = value["cycleId"] as? String, UUID(uuidString: cycle) != nil,
              let request = value["requestId"] as? String, UUID(uuidString: request) != nil,
              let name = value["command"] as? String, let args = value["args"] as? [String: Any] else { throw DeviceCommandError("INVALID_ARGUMENT") }
        guard version.doubleValue == 1 else { throw DeviceCommandError("UNSUPPORTED_VERSION") }
        self.cycle = cycle; self.request = request
        self.command = try DeviceCommand(name: name, args: args)
    }
}
