import UIKit
import AVFoundation
import GChatCore

/// Only duplex routes with known output semantics become direct-selection candidates.
struct NativeAudioPort {
    let uid: String
    let name: String
    let type: AVAudioSession.Port
}

@MainActor protocol NativeAudioSessionRouting: AnyObject {
    var inputs: [NativeAudioPort] { get }
    var currentInputs: [NativeAudioPort] { get }
    var currentOutputs: [NativeAudioPort] { get }
    var voiceSession: Bool { get }
    var hasReceiver: Bool { get }
    func preferInput(_ uid: String) throws
    func overrideSpeaker(_ enabled: Bool) throws
    func authorize() async -> Bool
    func activateSetup() throws
    func deactivateSetup()
    func systemRoute() throws
}

extension NativeAudioSessionRouting {
    func authorize() async -> Bool { true }
    func activateSetup() throws {}
    func deactivateSetup() {}
    func systemRoute() throws { try overrideSpeaker(false) }
}

@MainActor final class SystemAudioSessionRouting: NativeAudioSessionRouting {
    private var session: AVAudioSession { AVAudioSession.sharedInstance() }
    private var previous: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)?
    func authorize() async -> Bool {
        if session.recordPermission == .granted { return true }
        if session.recordPermission == .denied { return false }
        return await withCheckedContinuation { continuation in session.requestRecordPermission { continuation.resume(returning: $0) } }
    }
    func activateSetup() throws {
        previous = (session.category, session.mode, session.categoryOptions)
        do {
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
            try session.setActive(true)
        } catch { deactivateSetup(); throw error }
    }
    func deactivateSetup() {
        guard let previous else { return }
        self.previous = nil
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        try? session.setCategory(previous.0, mode: previous.1, options: previous.2)
    }
    func systemRoute() throws {
        try session.overrideOutputAudioPort(.none)
        try session.setPreferredInput(nil)
    }
    private func port(_ value: AVAudioSessionPortDescription) -> NativeAudioPort {
        NativeAudioPort(uid: value.uid, name: value.portName, type: value.portType)
    }
    var inputs: [NativeAudioPort] { (session.availableInputs ?? []).map(port) }
    var currentInputs: [NativeAudioPort] { session.currentRoute.inputs.map(port) }
    var currentOutputs: [NativeAudioPort] { session.currentRoute.outputs.map(port) }
    var voiceSession: Bool { session.category == .playAndRecord }
    var hasReceiver: Bool { UIDevice.current.userInterfaceIdiom == .phone }
    func preferInput(_ uid: String) throws {
        guard let input = session.availableInputs?.first(where: { $0.uid == uid }) else {
            throw DeviceCommandError("DEVICE_UNAVAILABLE")
        }
        try session.setPreferredInput(input)
    }
    func overrideSpeaker(_ enabled: Bool) throws {
        try session.overrideOutputAudioPort(enabled ? .speaker : .none)
    }
}

/// IDs never contain system port identifiers; currentRoute confirms every selection.
@MainActor final class NativeAudioDevices {
    private enum Target {
        case speaker, receiver, headset(String), bluetooth(String)
    }
    private struct Entry {
        let key: String
        let name: String
        let kind: String
        let target: Target
    }
    let session: any NativeAudioSessionRouting
    private let wait: () async throws -> Void
    private let attempts: Int
    private var ids: [String: String] = [:]
    private let defaults: UserDefaults
    private let preferenceKey = "gchat.audio.preferred-output.v1"

    init(session: (any NativeAudioSessionRouting)? = nil, defaults: UserDefaults = .standard, attempts: Int = 100,
         wait: @escaping () async throws -> Void = { try await Task.sleep(nanoseconds: 50_000_000) }) {
        self.session = session ?? SystemAudioSessionRouting(); self.defaults = defaults; self.attempts = attempts; self.wait = wait
    }

    private func entries() -> [Entry] {
        var result = [Entry(key: "speaker", name: "Громкая связь", kind: "speaker", target: .speaker)]
        let inputs = session.inputs
        // A wired accessory can prevent routing to the receiver even with a built-in mic selected.
        if session.hasReceiver, inputs.contains(where: { $0.type == .builtInMic }),
           !inputs.contains(where: { $0.type == .headsetMic || $0.type == .usbAudio }) {
            result.append(Entry(key: "receiver", name: "Телефон", kind: "receiver", target: .receiver))
        }
        for port in inputs {
            if port.type == .headsetMic {
                result.append(Entry(key: "input:" + port.uid, name: port.name, kind: "wiredHeadphones", target: .headset(port.uid)))
            } else if port.type == .bluetoothHFP {
                result.append(Entry(key: "input:" + port.uid, name: port.name, kind: "bluetooth", target: .bluetooth(port.uid)))
            }
        }
        return result
    }

    private func matches(_ target: Target) -> Bool {
        let outputs = session.currentOutputs
        switch target {
        case .speaker: return outputs.contains { $0.type == .builtInSpeaker }
        case .receiver: return outputs.contains { $0.type == .builtInReceiver }
        case .headset(let uid):
            return session.currentInputs.contains { $0.uid == uid } && outputs.contains { $0.type == .headphones }
        case .bluetooth(let uid):
            return session.currentInputs.contains { $0.uid == uid } && outputs.contains { $0.type == .bluetoothHFP }
        }
    }

    private func id(_ key: String) -> String {
        if let value = ids[key] { return value }
        let value = UUID().uuidString; ids[key] = value; return value
    }

    func devices(active: Bool) -> [String: Any] {
        let available = active && session.voiceSession ? entries() : []
        let port = session.currentOutputs.first
        let selectedEntry = available.first { matches($0.target) }
        let selectedKey = selectedEntry?.key ?? port.map {
            $0.type == .builtInSpeaker ? "speaker" : $0.type == .builtInReceiver ? "receiver" : "output:" + $0.uid
        }
        var valid = Set(available.map(\.key))
        if let selectedKey { valid.insert(selectedKey) }
        ids = ids.filter { valid.contains($0.key) }
        let outputs = available.map { ["id": id($0.key), "name": $0.name, "kind": $0.kind] }
        var selected: [String: Any]?
        if let port, let selectedKey {
            selected = ["id": id(selectedKey), "name": selectedEntry?.name ?? port.name, "kind": kind(port.type)]
        }
        return ["output": selected as Any? ?? NSNull(),
                "outputs": active && session.voiceSession ? outputs as Any : NSNull(), "preference": preference(active: active)]
    }

    var hasPreferred: Bool { defaults.dictionary(forKey: preferenceKey) != nil }

    func preference(active: Bool) -> [String: Any] {
        guard let value = defaults.dictionary(forKey: preferenceKey), let key = value["key"] as? String,
              let kind = value["kind"] as? String, let name = value["name"] as? String else { return ["mode": "system"] }
        let availability: String
        if active && session.voiceSession { availability = entries().contains { $0.key == key } ? "available" : "unavailable" }
        else if key == "speaker" { availability = "available" }
        else if key == "receiver" { availability = session.hasReceiver ? "available" : "unavailable" }
        else { availability = "unknown" }
        return ["mode": "device", "kind": kind, "name": name, "availability": availability]
    }

    func savePreferred(_ outputID: String?) throws {
        guard let outputID else { defaults.removeObject(forKey: preferenceKey); return }
        guard let entry = entries().first(where: { ids[$0.key] == outputID }), matches(entry.target) else {
            throw DeviceCommandError("DEVICE_UNAVAILABLE")
        }
        defaults.set(["key": entry.key, "kind": entry.kind, "name": entry.name], forKey: preferenceKey)
    }

    func applyPreferred(active: () -> Bool) async throws {
        _ = devices(active: true)
        guard let key = defaults.dictionary(forKey: preferenceKey)?["key"] as? String,
              let entry = entries().first(where: { $0.key == key }) else {
            try session.systemRoute(); return
        }
        do { try await select(id(entry.key), active: active) }
        catch {
            if active(), !Task.isCancelled { try? session.systemRoute() }
            throw error
        }
    }

    private func kind(_ type: AVAudioSession.Port) -> String {
        switch type {
        case .builtInSpeaker: return "speaker"
        case .builtInReceiver: return "receiver"
        case .headphones, .headsetMic: return "wiredHeadphones"
        case .bluetoothA2DP, .bluetoothHFP, .bluetoothLE: return "bluetooth"
        case .usbAudio: return "usb"
        case .airPlay: return "airPlay"
        default: return "other"
        }
    }

    func select(_ outputID: String, active: () -> Bool) async throws {
        try Task.checkCancellation()
        guard active(), session.voiceSession else { throw DeviceCommandError("INVALID_STATE") }
        _ = devices(active: true) // Invalidate IDs of disconnected candidates before looking up a request.
        guard let entry = entries().first(where: { ids[$0.key] == outputID }) else {
            throw DeviceCommandError("DEVICE_UNAVAILABLE")
        }
        if matches(entry.target) { return }
        do {
            switch entry.target {
            case .speaker:
                if let mic = session.inputs.first(where: { $0.type == .builtInMic }) { try session.preferInput(mic.uid) }
                try session.overrideSpeaker(true)
            case .receiver:
                guard let mic = session.inputs.first(where: { $0.type == .builtInMic }) else { throw DeviceCommandError("DEVICE_UNAVAILABLE") }
                try session.overrideSpeaker(false)
                try session.preferInput(mic.uid)
            case .headset(let uid), .bluetooth(let uid):
                try session.overrideSpeaker(false)
                try session.preferInput(uid)
            }
        } catch { throw DeviceCommandError("DEVICE_UNAVAILABLE") }
        // Bounded confirmation only while selecting; open panels update from session notifications.
        for attempt in 0...attempts {
            try Task.checkCancellation()
            guard active(), session.voiceSession else { throw DeviceCommandError("CANCELLED") }
            guard entries().contains(where: { $0.key == entry.key }) else { throw DeviceCommandError("DEVICE_UNAVAILABLE") }
            if matches(entry.target) { return }
            if attempt < attempts { try await wait() }
        }
        throw DeviceCommandError("DEVICE_UNAVAILABLE")
    }
}

/// The only owner allowed to activate an audio test; CallKit retains call activation.
@MainActor final class NativeAudioOwner {
    let devices: NativeAudioDevices
    private(set) var setupID: UUID?
    private var testID: UUID?
    private var owned = false
    private var generation = 0
    private var reserved = false
    private var callActive = false
    private var callID: UUID?
    private var appliedCall: UUID?
    private(set) var selecting = false
    private let foreground: () -> Bool
    private var observers: [NSObjectProtocol] = []
    var changed: (() -> Void)?
    var stopTests: (() -> Void)?
    var permissionChanged: (() -> Void)?
    var hasRoute: Bool { callActive || owned }
    var hasCall: Bool { reserved }

    init(devices: NativeAudioDevices? = nil, foreground: @escaping () -> Bool = { UIApplication.shared.applicationState == .active }) {
        self.devices = devices ?? NativeAudioDevices(); self.foreground = foreground
        for name in [UIApplication.didEnterBackgroundNotification, AVAudioSession.interruptionNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.cancelSetup() }
            })
        }
    }
    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }

    private func activate(_ epoch: Int) async throws {
        let authorized = await devices.session.authorize()
        permissionChanged?()
        guard authorized else { throw DeviceCommandError("PERMISSION_DENIED", ["settingsHint": "appSettings"]) }
        try Task.checkCancellation()
        guard generation == epoch, !reserved, foreground() else { throw DeviceCommandError("CANCELLED") }
        do { try devices.session.activateSetup(); owned = true }
        catch { throw DeviceCommandError("DEVICE_UNAVAILABLE") }
        // A missing saved accessory falls back to the system route without blocking setup.
        selecting = true
        defer { selecting = false }
        try? await devices.applyPreferred(active: { self.generation == epoch && self.owned && !self.reserved })
        try Task.checkCancellation()
        guard generation == epoch, owned, !reserved else { throw DeviceCommandError("CANCELLED") }
    }

    func beginSetup() async throws -> UUID {
        guard setupID == nil, testID == nil, !selecting else { throw DeviceCommandError("BUSY") }
        guard !reserved || (callActive && callID != nil) else { throw DeviceCommandError("BUSY") }
        let id = UUID(); setupID = id
        let epoch = generation
        do {
            if !callActive { try await activate(epoch) }
            changed?(); return id
        } catch {
            if setupID == id { closeSetup(id) }
            throw error
        }
    }

    func closeSetup(_ id: UUID) {
        guard setupID == id else { return }
        cancelSetup()
    }

    func cancelSetup() {
        let hadSetup = setupID != nil || testID != nil || owned
        generation += 1; setupID = nil; testID = nil
        stopTests?()
        if owned { owned = false; devices.session.deactivateSetup() }
        if hadSetup { changed?() }
    }

    func beginTest() async throws -> UUID {
        guard !reserved, testID == nil, !selecting else { throw DeviceCommandError("BUSY") }
        guard setupID == nil || owned else { throw DeviceCommandError("BUSY") }
        let id = UUID(); testID = id
        let epoch = generation
        do {
            if !owned { try await activate(epoch) }
            guard testID == id else { throw DeviceCommandError("CANCELLED") }
            changed?(); return id
        } catch { endTest(id); throw error }
    }

    func endTest(_ id: UUID) {
        guard testID == id else { return }
        testID = nil
        if setupID == nil && owned { owned = false; devices.session.deactivateSetup() }
        changed?()
    }

    func prepareCall() {
        cancelSetup()
        reserved = true
    }

    func updateCall(_ id: UUID?, active: Bool) {
        if id != nil, reserved, callID == id, callActive == active { return }
        if id == nil {
            if active {
                if !reserved { prepareCall() }
                reserved = true; callActive = true; callID = nil; changed?(); return
            }
            guard reserved || callID != nil || callActive else { return }
            cancelSetup(); reserved = false; callActive = false; callID = nil; appliedCall = nil; changed?(); return
        }
        if !reserved { prepareCall() }
        if callID != id || (callActive && !active) { cancelSetup() }
        callID = id; callActive = active; reserved = true
        changed?()
        guard active, appliedCall != id else { return }
        appliedCall = id
        if !devices.hasPreferred { try? devices.session.systemRoute(); return }
        let epoch = generation
        Task { @MainActor in
            while self.selecting {
                guard self.generation == epoch, self.callActive, self.callID == id else { return }
                try? await Task.sleep(nanoseconds: 10_000_000)
            }
            guard self.generation == epoch, self.callActive, self.callID == id else { return }
            self.selecting = true
            defer { self.selecting = false; self.changed?() }
            try? await self.devices.applyPreferred(active: { self.generation == epoch && self.callActive && self.callID == id })
        }
    }

    func select(_ id: String?, save: Bool) async throws {
        guard !selecting else { throw DeviceCommandError("BUSY") }
        guard id == nil || hasRoute else { throw DeviceCommandError("INVALID_STATE") }
        selecting = true
        // An explicit user selection supersedes a queued initial call preference.
        generation += 1
        let epoch = generation
        defer { selecting = false; changed?() }
        if let id {
            try await devices.select(id, active: { self.generation == epoch && self.hasRoute })
        } else if hasRoute { try devices.session.systemRoute() }
        try Task.checkCancellation()
        guard generation == epoch else { throw DeviceCommandError("CANCELLED") }
        if save { try devices.savePreferred(id) }
    }
}
