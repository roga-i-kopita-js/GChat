import UIKit
import AVFoundation
import CoreLocation
import UserNotifications
import UniformTypeIdentifiers
import GChatCore

@MainActor final class DeviceController: NSObject, NativeMediaFiles, @preconcurrency CLLocationManagerDelegate, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    private static let sharedFiles = DeviceFiles()
    private static let sharedFileQueue = DispatchQueue(label: "gchat.device.files", qos: .userInitiated)
    static func prepareStorage() {
        let files = sharedFiles
        sharedFileQueue.async { try? files.prepareStorage() }
    }
    private let files = DeviceController.sharedFiles
    private let fileQueue = DeviceController.sharedFileQueue
    private let presenter: () -> UIViewController?
    private let location = CLLocationManager()
    private var locationRequest: CheckedContinuation<Void, Never>?
    private var pickerRequest: CheckedContinuation<[URL]?, Error>?
    private var picker: UIDocumentPickerViewController?
    private var dialog = false
    private var generation = 0
    private var revision = 0
    private var cancelledWaits = Set<String>()
    private var lastChanges: [String: Int] = [:]
    private var pending: (request: String, after: Int, continuation: CheckedContinuation<[String: Any], Error>, timeout: Task<Void, Never>)?
    private var test: [String: Any]?
    private var audioEngine: AVAudioEngine?
    private var player: AVAudioPlayer?
    private var testTask: Task<Void, Never>?
    private var ownsAudio = false
    private var observers: [NSObjectProtocol] = []
    private static let blocks = ["microphone", "camera", "geolocation", "audio", "push", "files"]

    init(presenter: @escaping () -> UIViewController?) {
        self.presenter = presenter
        super.init()
        location.delegate = self
        files.changed = { [weak self] in Task { @MainActor in self?.touch("files") } }
        for name in [UIApplication.didBecomeActiveNotification, UIApplication.willResignActiveNotification, AVAudioSession.routeChangeNotification, AVAudioSession.interruptionNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                Task { @MainActor in
                    guard let self else { return }
                    if notification.name == AVAudioSession.routeChangeNotification,
                       let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                       reason == AVAudioSession.RouteChangeReason.categoryChange.rawValue { self.touch("audio"); return }
                    if notification.name != UIApplication.didBecomeActiveNotification { self.stopTest(); self.cancelWait() }
                    if notification.name == AVAudioSession.routeChangeNotification { self.test = nil }
                    self.touch(Self.blocks)
                }
            })
        }
    }

    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }

    func reset() {
        generation += 1; stopTest(); cancelWait(); revision = 0; lastChanges.removeAll(); test = nil; cancelledWaits.removeAll()
        picker?.dismiss(animated: false); picker = nil
        pickerRequest?.resume(throwing: DeviceCommandError("CANCELLED")); pickerRequest = nil
        locationRequest?.resume(); locationRequest = nil
        fileQueue.async { [files] in files.reset() }
    }

    private func touch(_ block: String) { touch([block]) }
    private func touch(_ blocks: [String]) {
        revision += 1
        for block in blocks { lastChanges[block] = revision }
        if let pending, revision > pending.after {
            self.pending = nil; pending.timeout.cancel()
            pending.continuation.resume(returning: changes(after: pending.after, timedOut: false))
        }
    }
    private func changes(after: Int, timedOut: Bool) -> [String: Any] { ["revision": revision, "changed": Self.blocks.filter { (lastChanges[$0] ?? 0) > after }, "timedOut": timedOut] }
    private func cancelWait() { if let pending { self.pending = nil; pending.timeout.cancel(); pending.continuation.resume(throwing: DeviceCommandError("CANCELLED")) } }

    private func permission(_ resource: String) -> [String: Any] {
        var status = "unknown"
        if resource == "microphone" {
            switch AVAudioSession.sharedInstance().recordPermission { case .granted: status = "granted"; case .denied: status = "denied"; case .undetermined: status = "prompt"; @unknown default: break }
        } else if resource == "camera" {
            switch AVCaptureDevice.authorizationStatus(for: .video) { case .authorized: status = "granted"; case .denied: status = "denied"; case .restricted: status = "restricted"; case .notDetermined: status = "prompt"; @unknown default: break }
        } else {
            switch location.authorizationStatus { case .authorizedAlways, .authorizedWhenInUse: status = "granted"; case .denied: status = "denied"; case .restricted: status = "restricted"; case .notDetermined: status = "prompt"; @unknown default: break }
        }
        var result: [String: Any] = ["permission": status, "settingsHint": "appSettings"]
        if resource == "geolocation" {
            result["accuracy"] = status == "granted" ? (location.accuracyAuthorization == .fullAccuracy ? "full" : "reduced") : "unknown"
            result["service"] = "unknown"
        }
        return result
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { touch("geolocation"); if manager.authorizationStatus != .notDetermined { locationRequest?.resume(); locationRequest = nil } }

    private func requestPermission(_ resource: String) async throws -> [String: Any] {
        guard UIApplication.shared.applicationState == .active else { throw DeviceCommandError("CANCELLED") }
        let current = permission(resource)
        guard current["permission"] as? String == "prompt" else { return current }
        guard !dialog else { throw DeviceCommandError("BUSY") }
        dialog = true; defer { dialog = false }
        let epoch = generation
        if resource == "microphone" { _ = await withCheckedContinuation { continuation in AVAudioSession.sharedInstance().requestRecordPermission { continuation.resume(returning: $0) } } }
        else if resource == "camera" { _ = await AVCaptureDevice.requestAccess(for: .video) }
        else { await withCheckedContinuation { continuation in locationRequest = continuation; location.requestWhenInUseAuthorization() } }
        guard epoch == generation else { throw DeviceCommandError("CANCELLED") }
        touch(resource)
        return permission(resource)
    }

    private func pushState() async -> [String: Any] {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        let permission: String
        switch settings.authorizationStatus { case .authorized: permission = "granted"; case .denied: permission = "denied"; case .notDetermined: permission = "prompt"; case .provisional, .ephemeral: permission = "limited"; @unknown default: permission = "unknown" }
        func setting(_ value: UNNotificationSetting) -> String { value == .enabled ? "enabled" : value == .disabled ? "disabled" : "unknown" }
        return ["permission": permission, "alert": setting(settings.alertSetting), "sound": setting(settings.soundSetting), "badge": setting(settings.badgeSetting), "delivery": ChatNotifications.shared.delivery]
    }

    private func fileWork<T>(_ work: @escaping (DeviceFiles) throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in fileQueue.async { [files] in continuation.resume(with: Result { try work(files) }) } }
    }

    func disposeDocument() async {
        reset()
        _ = try? await fileWork { _ in () }
    }

    func createCapture(extension suffix: String) async throws -> URL { try await fileWork { try $0.createCapture(extension: suffix) } }
    func commitCapture(_ url: URL) async throws -> [String: Any] { try await fileWork { try $0.commitCapture(url) } }
    func abortCapture(_ url: URL) async { _ = try? await fileWork { $0.abortCapture(url) } }

    private func state() async throws -> [String: Any] {
        let push = await pushState()
        let count = try await fileWork { $0.count }
        let route = AVAudioSession.sharedInstance().currentRoute.outputs.map(\.portName).joined(separator: ", ")
        let routeName: Any = route.isEmpty ? NSNull() : route
        return ["revision": revision, "microphone": permission("microphone"), "camera": permission("camera"), "geolocation": permission("geolocation"), "audio": ["routeName": routeName, "test": test as Any? ?? NSNull()], "push": push, "files": ["retainedCount": count]]
    }

    private func startTest(_ kind: String) throws -> [String: Any] {
        guard test?["status"] as? String != "running", !dialog, UIApplication.shared.applicationState == .active else { throw DeviceCommandError("BUSY") }
        if kind == "microphone", permission("microphone")["permission"] as? String != "granted" { throw DeviceCommandError("PERMISSION_DENIED", ["settingsHint": "appSettings"]) }
        let id = UUID().uuidString
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(kind == "microphone" ? .playAndRecord : .playback, mode: .default, options: [])
            try session.setActive(true); ownsAudio = true
            if kind == "microphone" {
                let engine = AVAudioEngine()
                let input = engine.inputNode; let format = input.outputFormat(forBus: 0)
                guard format.sampleRate > 0, format.channelCount > 0 else { throw DeviceCommandError("DEVICE_UNAVAILABLE") }
                input.installTap(onBus: 0, bufferSize: 1024, format: format) { _, _ in }
                audioEngine = engine; try engine.start()
            } else {
                let data = Self.tone()
                let player = try AVAudioPlayer(data: data); self.player = player
                guard player.play() else { throw DeviceCommandError("DEVICE_UNAVAILABLE") }
            }
        } catch { releaseAudio(); throw DeviceCommandError("DEVICE_UNAVAILABLE") }
        test = ["id": id, "kind": kind, "status": "running", "errorCode": NSNull()]; touch("audio")
        testTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard !Task.isCancelled, let self, self.test?["id"] as? String == id, self.test?["status"] as? String == "running" else { return }
            self.releaseAudio(); self.test?["status"] = "completed"; self.touch("audio")
        }
        return ["testId": id]
    }

    private static func tone() -> Data {
        let sampleRate: UInt32 = 44100; let count = Int(sampleRate)
        var payload = Data()
        for index in 0..<count {
            let t = Double(index) / Double(sampleRate); let envelope = min(1, t / 0.05, (1 - t) / 0.1)
            var sample = Int16(sin(2 * .pi * 440 * t) * 1600 * max(0, envelope)).littleEndian
            withUnsafeBytes(of: &sample) { payload.append(contentsOf: $0) }
        }
        var data = Data("RIFF".utf8)
        func append<T: FixedWidthInteger>(_ number: T) { var value = number.littleEndian; withUnsafeBytes(of: &value) { data.append(contentsOf: $0) } }
        append(UInt32(payload.count + 36)); data.append(Data("WAVEfmt ".utf8)); append(UInt32(16)); append(UInt16(1)); append(UInt16(1)); append(sampleRate); append(sampleRate * 2); append(UInt16(2)); append(UInt16(16)); data.append(Data("data".utf8)); append(UInt32(payload.count)); data.append(payload)
        return data
    }
    private func releaseAudio() {
        player?.stop(); player = nil
        if let engine = audioEngine { engine.inputNode.removeTap(onBus: 0); engine.stop() }; audioEngine = nil
        if ownsAudio { ownsAudio = false; try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    }
    private func stopTest() { testTask?.cancel(); testTask = nil; releaseAudio(); if test?["status"] as? String == "running" { test?["status"] = "cancelled"; touch("audio") } }

    private func pick(_ controller: UIDocumentPickerViewController) async throws -> [URL]? {
        guard !dialog, let view = presenter(), view.presentedViewController == nil else { throw DeviceCommandError("BUSY") }
        dialog = true; defer { dialog = false; picker = nil }
        picker = controller; controller.delegate = self; controller.presentationController?.delegate = self
        return try await withCheckedThrowingContinuation { continuation in pickerRequest = continuation; view.present(controller, animated: true) { controller.presentationController?.delegate = self } }
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { pickerRequest?.resume(returning: urls); pickerRequest = nil }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { pickerRequest?.resume(returning: nil); pickerRequest = nil }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { pickerRequest?.resume(returning: nil); pickerRequest = nil }

    func execute(_ command: DeviceCommand, requestId: String) async throws -> [String: Any] {
        let epoch = generation
        switch command.name {
        case "device.state.read": return try await state()
        case "permission.read": return permission(command.string("resource"))
        case "permission.request": return ["outcome": "completed", "state": try await requestPermission(command.string("resource"))]
        case "device.settings.open":
            guard let url = URL(string: UIApplication.openSettingsURLString) else { throw DeviceCommandError("UNSUPPORTED") }
            let opened = await UIApplication.shared.open(url); guard opened else { throw DeviceCommandError("UNSUPPORTED") }; return ["outcome": "completed"]
        case "audio.test.start": return try startTest(command.string("kind"))
        case "audio.test.stop": if test?["id"] as? String == command.string("testId") { stopTest() }; return ["outcome": "completed"]
        case "audio.output.select": throw DeviceCommandError("UNSUPPORTED")
        case "push.enable", "push.disable":
            try await ChatNotifications.shared.setEnabled(command.name == "push.enable")
            guard epoch == generation else { throw DeviceCommandError("CANCELLED") }
            return ["outcome": "completed", "push": await pushState()]
        case "call.prepareOutgoing":
            let microphone = try await requestPermission("microphone")
            guard microphone["permission"] as? String == "granted" else { throw DeviceCommandError("PERMISSION_DENIED", ["settingsHint": "appSettings"]) }
            return ["outcome": "completed", "microphone": microphone]
        case "device.changes.cancel":
            if pending?.request == requestId { cancelWait() }
            else { cancelledWaits.insert(requestId) }
            return ["outcome": "completed"]
        case "device.changes.wait":
            if cancelledWaits.remove(requestId) != nil { throw DeviceCommandError("CANCELLED") }
            guard pending == nil else { throw DeviceCommandError("BUSY") }
            let after = command.integer("afterRevision"); guard after <= revision else { throw DeviceCommandError("INVALID_ARGUMENT") }
            if after < revision { return changes(after: after, timedOut: false) }
            return try await withCheckedThrowingContinuation { continuation in
                let timeout = Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: UInt64(command.integer("timeoutMs")) * 1_000_000)
                    guard !Task.isCancelled, let self, self.pending?.request == requestId else { return }
                    self.pending = nil; continuation.resume(returning: self.changes(after: after, timedOut: true))
                }
                pending = (requestId, after, continuation, timeout)
            }
        case "file.pick", "directory.pick":
            let accept = command.args["accept"] as? [String] ?? []
            let types = command.name == "directory.pick" ? [UTType.folder] : accept.compactMap { UTType(mimeType: $0) }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: types.isEmpty ? [.item] : types, asCopy: false)
            picker.allowsMultipleSelection = command.bool("multiple")
            let urls = try await pick(picker)
            guard epoch == generation else { throw DeviceCommandError("CANCELLED") }
            let entries = try await fileWork { files in try (urls ?? []).map { try files.grant($0) } }
            return command.name == "directory.pick" ? ["outcome": urls == nil ? "cancelled" : "completed", "entry": entries.first as Any? ?? NSNull()] : ["outcome": urls == nil ? "cancelled" : "completed", "entries": entries]
        case "file.saveAs", "file.export":
            let source = try await fileWork { try $0.exportURL(command.string("sourceFileId")) }
            guard epoch == generation else { try? FileManager.default.removeItem(at: source); throw DeviceCommandError("CANCELLED") }
            let named = source.deletingLastPathComponent().appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: named, withIntermediateDirectories: true)
            let exported = named.appendingPathComponent(command.string("suggestedName")); try FileManager.default.moveItem(at: source, to: exported)
            defer { try? FileManager.default.removeItem(at: named) }
            let picker = UIDocumentPickerViewController(forExporting: [exported], asCopy: true)
            let urls = try await pick(picker)
            guard epoch == generation else { throw DeviceCommandError("CANCELLED") }
            if command.name == "file.export" { return ["outcome": urls == nil ? "cancelled" : "completed"] }
            let entry = try await fileWork { files in try urls?.first.map { try files.grant($0) } }
            return ["outcome": urls == nil ? "cancelled" : "completed", "entry": entry as Any? ?? NSNull()]
        default: return try await fileWork { try $0.execute(command) }
        }
    }
}
