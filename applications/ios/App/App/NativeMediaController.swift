import UIKit
import WebKit
import AVFoundation
import AVKit
import MediaPlayer
import GChatCore

@MainActor protocol NativeMediaFiles: AnyObject {
    func createCapture(extension suffix: String) async throws -> URL
    func commitCapture(_ url: URL) async throws -> [String: Any]
    func abortCapture(_ url: URL) async
    func disposeDocument() async
}

@MainActor final class NativeMediaController: NSObject, UIAdaptivePresentationControllerDelegate {
    private let files: any NativeMediaFiles
    private let webView: () -> WKWebView?
    private let capture: any NativeCameraCapturing
    private let applicationState: () -> UIApplication.State
    private let preview = AVSampleBufferDisplayLayer()
    private var source: String?
    private var ownership = CameraOwnership()
    private let surface = NativeCameraSurface()
    private let picture = NativeCallPictureInPicture()
    private var multitasking = false
    private var pipClosedInBackground = false
    private var cameraError: String?
    private var stateRevision = 0
    private var stateFingerprint: Data?
    private var ending: Task<Void,Never>?
    private var endingGeneration = 0
    private var voipAudioActive = false
    private var facing = "front"
    private var status = "released"
    private var format: [String: Any]?
    private var epoch = 0
    private var testing = false
    private var opening = false
    private var closing = false
    private var recording: (id: String, url: URL)?
    private var saving: Task<[String: Any], Error>?
    private var saved: [String: [String: Any]] = [:]
    private var previewOwner: String?
    private var previewPriority = "view"
    private var volumeControl: UIViewController?
    private var routePicker: NativeAudioRoutePicker?
    private var routeIDs: [String: String] = [:]
    private var observers: [NSObjectProtocol] = []
    private var volumeObserver: NSKeyValueObservation?
    var onEvent: (([String: Any]) -> Void)?
    var pictureInPictureDiagnostics: String { picture.diagnostics }

    init(files: any NativeMediaFiles, webView: @escaping () -> WKWebView?, capture: any NativeCameraCapturing = NativeCameraCapture(), applicationState: @escaping () -> UIApplication.State = { UIApplication.shared.applicationState }) {
        self.files = files; self.webView = webView; self.capture = capture; self.applicationState = applicationState
        super.init()
        preview.videoGravity = .resizeAspectFill
        surface.layer.addSublayer(preview)
        surface.relayout = { [weak self] in guard let self else { return }; self.preview.frame = self.surface.bounds }
        picture.changed = { [weak self] status in
            guard let self else { return }
            self.emit("pip",extra:["pip":status])
            if self.ownership.hasCall && self.applicationState() == .background && ["inactive","error"].contains(status) {
                if status == "inactive" { self.pipClosedInBackground = true }
                Task { @MainActor in await self.interrupt(reason:"background",code:status == "error" ? (self.picture.supported && self.multitasking ? "DEVICE_UNAVAILABLE" : "UNSUPPORTED") : nil) }
            } else if status == "active" { Task { @MainActor in await self.resumeIfAllowed() } }
        }
        picture.restore = { [weak self] in self?.surface.isHidden = false }
        capture.onFrame = { [weak self] sample in
            guard let self, self.source != nil else { return }
            if self.preview.status == .failed { self.preview.flush() }
            if !self.preview.isHidden && self.preview.isReadyForMoreMediaData { self.preview.enqueue(sample) }
            self.picture.frame(sample)
        }
        capture.onLimit = { [weak self] in Task { @MainActor in _ = try? await self?.stopRecording() } }
        observers.append(NotificationCenter.default.addObserver(forName:UIApplication.didEnterBackgroundNotification,object:nil,queue:.main) { [weak self] _ in
            Task { @MainActor in await self?.background() }
        })
        observers.append(NotificationCenter.default.addObserver(forName:UIApplication.didBecomeActiveNotification,object:nil,queue:.main) { [weak self] _ in
            Task { @MainActor in self?.pipClosedInBackground = false; await self?.resumeIfAllowed() }
        })
        capture.onInterruption = { [weak self] interrupted in
            Task { @MainActor in
                if interrupted { let permitted = self?.capture.authorized == true; await self?.interrupt(reason:permitted ? "unknown" : "permissionLost",code:permitted ? nil : "PERMISSION_DENIED",stopCapture:false) }
                else { await self?.resumeIfAllowed() }
            }
        }
        capture.onReset = { [weak self] in Task { @MainActor in
            await self?.interrupt(reason:"unknown",code:nil,stopCapture:false); await self?.resumeIfAllowed()
        } }
        volumeObserver = AVAudioSession.sharedInstance().observe(\.outputVolume, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.onEvent?(["kind": "audioChanged"]) }
        }
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.onEvent?(["kind": "audioChanged"]) }
        })
    }

    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }

    private func state() -> [String: Any] {
        var value: [String:Any] = ["facing": facing, "status": status, "recording": saving != nil ? "stopping" : recording == nil ? "idle" : "recording", "format": format as Any? ?? NSNull(), "error": cameraError.map { ["code":$0] } as Any? ?? NSNull()]
        let observed = value.merging(["sourceId":source as Any? ?? NSNull(),"call":ownership.hasCall,"pip":picture.status]) { _, new in new }
        let fingerprint = try? JSONSerialization.data(withJSONObject:observed,options:.sortedKeys)
        if fingerprint != stateFingerprint { stateRevision += 1; stateFingerprint = fingerprint }
        value["revision"] = stateRevision
        return value
    }

    private func emit(_ kind: String, extra: [String: Any] = [:]) {
        guard let source else { return }
        onEvent?(["sourceId": source, "kind": kind, "state": state(),"call":ownership.hasCall].merging(extra) { _, new in new })
    }

    private func requireSession(_ args: [String: Any]) throws {
        guard let session = args["sessionId"] as? String, UUID(uuidString:session).map(ownership.contains) == true, source != nil else { throw DeviceCommandError("INVALID_STATE") }
    }

    private func requireKeys(_ args: [String: Any], _ keys: Set<String>) throws {
        guard Set(args.keys) == keys else { throw DeviceCommandError("INVALID_ARGUMENT") }
    }

    private func requireFacing(_ args: [String: Any]) throws -> String {
        guard let facing = args["facing"] as? String, ["front", "back"].contains(facing) else { throw DeviceCommandError("INVALID_ARGUMENT") }
        return facing
    }

    private func permission() async throws {
        try await capture.requestPermission()
    }

    private func start(_ requested: String) async throws {
        let generation = epoch
        opening = true; status = "starting"; emit("stateChanged")
        defer { opening = false }
        do {
            _ = try await capture.start(facing: requested)
            format = try await capture.waitForFrame()
            try Task.checkCancellation()
            guard generation == epoch else { throw DeviceCommandError("CANCELLED") }
            facing = requested; status = "streaming"; cameraError = nil; emit("stateChanged")
        } catch {
            if generation == epoch {
                await capture.shutdown(); status = "error"; cameraError = (error as? DeviceCommandError)?.code ?? "DEVICE_UNAVAILABLE"; emit("stateChanged")
            }
            throw error
        }
    }

    func execute(_ command: String, args: [String: Any]) async throws -> [String: Any] {
        await ending?.value
        try Task.checkCancellation()
        switch command {
        case "camera.check":
            try requireKeys(args, ["facing"]); _ = try requireFacing(args)
            let support = await capture.multitaskingSupport()
            return ["checks": [["check":"capture","status":"notChecked","reason":source == nil ? "permissionRequired" : "resourceInUse"], ["check":"pictureInPicture","status":"notChecked","reason":picture.supported ? "userConfirmationRequired" : "unsupported"], ["check":"multitasking","status":"notChecked","reason":support == false ? "unsupported" : "userConfirmationRequired"]]]
        case "camera.test":
            try requireKeys(args, ["facing"]); let requested = try requireFacing(args)
            guard source == nil, !opening, !closing, !testing else { throw DeviceCommandError("BUSY") }
            testing = true; defer { testing = false }
            let generation = epoch
            try await permission()
            guard generation == epoch, applicationState() != .background else { throw DeviceCommandError("CANCELLED") }
            try await start(requested)
            do { _ = try await capture.waitForFrame(); await capture.shutdown(); status = "released" }
            catch { await capture.shutdown(); status = "released"; throw error }
            return ["outcome": "completed"]
        case "camera.open":
            try requireKeys(args, ["facing", "lifetime"]); let requested = try requireFacing(args)
            guard let lifetime = args["lifetime"] as? String, ["view", "call"].contains(lifetime) else { throw DeviceCommandError("INVALID_ARGUMENT") }
            let selectedCall = ownership.selectedCall
            guard lifetime != "call" || selectedCall != nil else { throw DeviceCommandError("INVALID_STATE") }
            guard applicationState() != .background else { throw DeviceCommandError("INVALID_STATE") }
            guard !opening, !closing, !testing, source == nil || facing == requested else { throw DeviceCommandError("BUSY") }
            let generation = epoch
            if source == nil {
                opening = true
                do {
                    try await permission()
                    guard generation == epoch, applicationState() != .background else { throw DeviceCommandError("CANCELLED") }
                    source = UUID().uuidString; try await start(requested)
                }
                catch { opening = false; source = nil; throw error }
            }
            do { try Task.checkCancellation(); guard generation == epoch else { throw DeviceCommandError("CANCELLED") } } catch { await close(); throw error }
            guard lifetime != "call" || ownership.selectedCall == selectedCall else { await close(); throw DeviceCommandError("CANCELLED") }
            let session = try ownership.acquire(call:lifetime == "call")
            if ownership.hasCall { multitasking = await capture.setMultitasking(true); picture.bind(surface,enabled:true) }
            return ["sessionId": session.uuidString, "sourceId": source!, "state": state(),"call":ownership.hasCall]
        case "camera.current":
            try requireKeys(args, []); return ["sourceId":source as Any? ?? NSNull(),"state":state(),"call":ownership.hasCall]
        case "camera.state":
            try requireKeys(args, ["sessionId"]); try requireSession(args); return state()
        case "camera.facing":
            try requireKeys(args, ["sessionId", "facing"]); try requireSession(args); let requested = try requireFacing(args)
            guard recording == nil, saving == nil, !opening, !closing else { throw DeviceCommandError("BUSY") }
            if requested != facing { try await start(requested) }
            return state()
        case "camera.photo":
            try requireKeys(args, ["sessionId"]); try requireSession(args)
            guard status == "streaming", !opening else { throw DeviceCommandError("INVALID_STATE") }
            let current = source; let generation = epoch; let url = try await files.createCapture(extension: "jpg")
            do {
                try Task.checkCancellation()
                guard source == current, generation == epoch, !closing else { throw DeviceCommandError("CANCELLED") }
                try await capture.photo(to: url); try Task.checkCancellation()
                guard source == current, generation == epoch, !closing else { throw DeviceCommandError("CANCELLED") }
                return try await files.commitCapture(url)
            } catch { await files.abortCapture(url); throw error }
        case "camera.record":
            try requireKeys(args, ["sessionId"]); try requireSession(args)
            guard status == "streaming", !opening, recording == nil, saving == nil else { throw DeviceCommandError("BUSY") }
            opening = true; defer { opening = false }
            let current = source; let generation = epoch; let url = try await files.createCapture(extension: "mp4")
            var writerStarted = false
            do {
                try Task.checkCancellation()
                guard source == current, generation == epoch, !closing else { throw DeviceCommandError("CANCELLED") }
                try await capture.record(to: url); writerStarted = true; try Task.checkCancellation()
                guard source == current, generation == epoch, !closing else { throw DeviceCommandError("CANCELLED") }
                let id = UUID().uuidString; recording = (id, url); saved.removeAll(); emit("stateChanged")
                return ["recordingId": id]
            } catch { if writerStarted { _ = try? await capture.stopRecording() }; await files.abortCapture(url); throw error }
        case "camera.stopRecording":
            try requireKeys(args, ["recordingId"])
            guard let id = args["recordingId"] as? String else { throw DeviceCommandError("INVALID_ARGUMENT") }
            if let result = saved[id] { return result }
            guard recording?.id == id else { throw DeviceCommandError("INVALID_STATE") }
            return try await stopRecording()
        case "camera.release":
            try requireKeys(args, ["sessionId"])
            guard let id = args["sessionId"] as? String, UUID(uuidString: id) != nil else { throw DeviceCommandError("INVALID_ARGUMENT") }
            if let session = UUID(uuidString:id) { ownership.release(session) }; if !ownership.retained { await close() }
            return ["outcome": "completed"]
        case "document.dispose":
            try requireKeys(args, []); await releaseViews(); await files.disposeDocument(); return ["outcome":"completed"]
        case "camera.close", "camera.dispose":
            try requireKeys(args, []); await close(); return ["outcome": "completed"]
        case "camera.preview":
            try bind(args); return ["outcome": "completed"]
        case "audio.state":
            try requireKeys(args, []); return audioState()
        case "audio.pick":
            try requireKeys(args, [])
            guard routePicker == nil else { throw DeviceCommandError("BUSY") }
            guard let root = (webView()?.window ?? surface.window)?.rootViewController else { throw DeviceCommandError("DEVICE_UNAVAILABLE") }
            var presenter = root
            while let next = presenter.presentedViewController { presenter = next }
            let picker = NativeAudioRoutePicker(); picker.allowsBuiltIn = { [weak self] in self?.voipAudioActive == true }; routePicker = picker
            return try await withTaskCancellationHandler(operation: {
                let selected = try await withCheckedThrowingContinuation { (continuation:CheckedContinuation<Bool,Error>) in
                    picker.completed = { continuation.resume(with:$0) }
                    presenter.present(picker,animated:true) { picker.presentationController?.delegate = picker }
                }
                self.routePicker = nil
                try Task.checkCancellation()
                return ["outcome":selected ? "completed" : "cancelled","output":selected ? self.audioState()["output"]! : NSNull()]
            }, onCancel: { Task { @MainActor in picker.finish(.success(false)) } })
        case "audio.volume":
            try requireKeys(args, [])
            guard voipAudioActive, ownership.selectedCall != nil, AVAudioSession.sharedInstance().category == .playAndRecord else { throw DeviceCommandError("UNSUPPORTED") }
            guard volumeControl == nil, let root = (webView()?.window ?? surface.window)?.rootViewController else { throw DeviceCommandError("BUSY") }
            var presenter = root; while let next = presenter.presentedViewController { presenter = next }
            let content = UIViewController(); content.title = "Громкость разговора"; content.view.backgroundColor = .systemBackground
            let volume = MPVolumeView(); volume.showsRouteButton = false; volume.translatesAutoresizingMaskIntoConstraints = false; content.view.addSubview(volume)
            NSLayoutConstraint.activate([volume.leadingAnchor.constraint(equalTo:content.view.leadingAnchor,constant:24),volume.trailingAnchor.constraint(equalTo:content.view.trailingAnchor,constant:-24),volume.centerYAnchor.constraint(equalTo:content.view.centerYAnchor),volume.heightAnchor.constraint(equalToConstant:44)])
            let navigation = UINavigationController(rootViewController:content)
            content.navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem:.done,primaryAction:UIAction { [weak self,weak navigation] _ in navigation?.dismiss(animated:true); self?.volumeControl = nil })
            navigation.sheetPresentationController?.detents = [.medium()]; volumeControl = navigation; presenter.present(navigation,animated:true) { navigation.presentationController?.delegate = self }
            return ["outcome":"completed"]
        default: throw DeviceCommandError("INVALID_ARGUMENT")
        }
    }

    private func stopRecording() async throws -> [String: Any] {
        if let saving { return try await saving.value }
        guard let recording else { throw DeviceCommandError("INVALID_STATE") }
        let task = Task { @MainActor in
            do {
                try await self.capture.stopRecording()
                let ref = try await self.files.commitCapture(recording.url)
                self.saved[recording.id] = ref
                self.emit("recordingSaved", extra: ["file": ref])
                return ref
            } catch { await self.files.abortCapture(recording.url); throw error }
        }
        saving = task; emit("stateChanged")
        defer { saving = nil; self.recording = nil; emit("stateChanged") }
        return try await task.value
    }

    func releaseViews() async {
        routePicker?.finish(.success(false)); routePicker = nil; volumeControl?.dismiss(animated:false); volumeControl = nil; ownership.releaseViews(); previewOwner = nil; preview.isHidden = true
        if !ownership.retained { await close() }
    }

    /// Called only by the actual native call owner; Web cannot manufacture a call lease.
    func selectCall(_ id: UUID?, audioActive: Bool) {
        voipAudioActive = audioActive
        if !audioActive { volumeControl?.dismiss(animated:false); volumeControl = nil }
        guard ownership.selectCall(id) else { return }
        endingGeneration += 1; let generation = endingGeneration; let previous = ending
        ending = Task { @MainActor in
            await previous?.value; await self.close()
            if self.endingGeneration == generation { self.ending = nil }
        }
    }
    func bindNativePreview(_ view: UIView) {
        if surface.superview !== view { surface.removeFromSuperview(); view.addSubview(surface) }
        surface.frame = view.bounds; surface.autoresizingMask = [.flexibleWidth,.flexibleHeight]
        preview.isHidden = false
        picture.bind(surface,enabled:ownership.hasCall)
    }
    private func background() async {
        if !ownership.hasCall { await releaseViews(); return }
        ownership.releaseViews()
        // Automatic inline PiP belongs to the system's background transition, not every inactive UI overlay.
        if !pipClosedInBackground && multitasking && picture.supported && !picture.continuing {
            picture.background()
            for _ in 0..<5 {
                if picture.continuing || pipClosedInBackground || applicationState() == .active { break }
                try? await Task.sleep(nanoseconds:100_000_000)
            }
        }
        if applicationState() == .active { return }
        if pipClosedInBackground || !picture.continuing || !multitasking { await interrupt(reason:"background",code:picture.supported && multitasking ? nil : "UNSUPPORTED") }
    }
    private func interrupt(reason:String,code:String?,stopCapture:Bool = true) async {
        guard source != nil, !closing else { return }
        status = "interrupted"; cameraError = code; emit("interrupted",extra:["reason":reason])
        if stopCapture { await capture.shutdown() }
        if recording != nil { _ = try? await stopRecording() }
    }
    private func resumeIfAllowed() async {
        guard source != nil, ownership.retained, !closing, !opening,
              status == "interrupted", capture.authorized,
              applicationState() == .active || (ownership.hasCall && picture.continuing && !pipClosedInBackground) else { return }
        opening = true; defer { opening = false }
        let generation = epoch
        do {
            try await capture.resume(); let actual = try await capture.waitForFrame()
            guard epoch == generation, source != nil, ownership.retained else { return }
            format = actual; status = "streaming"; cameraError = nil; emit("stateChanged")
        } catch { cameraError = "DEVICE_UNAVAILABLE"; emit("stateChanged") }
    }

    private func close() async {
        epoch += 1
        if closing { if let saving { _ = try? await saving.value }; return }
        closing = true; defer { closing = false }
        ownership.close(); previewOwner = nil
        let stopPicture = Task { @MainActor in await picture.shutdown() }
        await capture.shutdown(); status = "interrupted"; emit("stateChanged")
        if recording != nil { _ = try? await stopRecording() }
        await stopPicture.value
        preview.isHidden = true; surface.removeFromSuperview()
        status = "released"; format = nil; cameraError = nil; emit("stateChanged"); source = nil
    }

    private func bind(_ args: [String: Any]) throws {
        try requireKeys(args, ["sourceId", "previewId", "rect", "visible", "priority"])
        guard let id = args["sourceId"] as? String, id == source, let owner = args["previewId"] as? String, !owner.isEmpty, owner.count < 128,
              let rect = args["rect"] as? [String: Any], Set(rect.keys) == ["x", "y", "width", "height"],
              let x = rect["x"] as? Double, let y = rect["y"] as? Double, let width = rect["width"] as? Double, let height = rect["height"] as? Double,
              [x,y,width,height].allSatisfy({ $0.isFinite && abs($0) <= 100000 }), width >= 0, height >= 0,
              let visible = args["visible"] as? Bool, let priority = args["priority"] as? String, ["view","call"].contains(priority) else { throw DeviceCommandError("INVALID_ARGUMENT") }
        if !visible { if previewOwner == owner { previewOwner = nil; preview.isHidden = true; if !ownership.hasCall { surface.removeFromSuperview() } }; return }
        if previewOwner != nil && previewOwner != owner {
            if priority == "call" { return }
            guard previewPriority == "call" else { throw DeviceCommandError("BUSY") }
        }
        guard let web = webView(), let container = web.superview else { throw DeviceCommandError("DEVICE_UNAVAILABLE") }
        previewOwner = owner; previewPriority = priority; surface.frame = container.convert(CGRect(x:x, y:y, width:width, height:height), from:web)
        web.isOpaque = false; web.backgroundColor = .clear; web.scrollView.backgroundColor = .clear
        container.insertSubview(surface,belowSubview:web); preview.isHidden = false
        picture.bind(surface,enabled:ownership.hasCall)
    }

    func presentationControllerDidDismiss(_ presentationController:UIPresentationController) {
        if presentationController.presentedViewController === volumeControl { volumeControl = nil }
    }

    private func audioState() -> [String: Any] {
        let audio = AVAudioSession.sharedInstance()
        let port = audio.currentRoute.outputs.first
        var selected: [String: Any]?
        if let port {
            let id = routeIDs[port.uid] ?? UUID().uuidString; routeIDs[port.uid] = id
            let kind: String
            switch port.portType {
            case .builtInSpeaker: kind = "speaker"
            case .builtInReceiver: kind = "receiver"
            case .headphones, .headsetMic: kind = "wiredHeadphones"
            case .bluetoothA2DP, .bluetoothHFP, .bluetoothLE: kind = "bluetooth"
            case .usbAudio: kind = "usb"
            case .airPlay: kind = "airPlay"
            default: kind = "other"
            }
            selected = ["id":id,"name":port.portName,"kind":kind]
        }
        return ["volume":["level":Double(audio.outputVolume)],"output":selected as Any? ?? NSNull(),"outputs":NSNull()]
    }
}

@MainActor private final class NativeCameraSurface: UIView {
    var relayout: (() -> Void)?
    override func layoutSubviews() { super.layoutSubviews(); relayout?() }
}
