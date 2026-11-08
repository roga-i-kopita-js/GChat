import AVFoundation
import AVKit
import UIKit

@MainActor private final class CameraPictureContent: AVPictureInPictureVideoCallViewController {
    let display = AVSampleBufferDisplayLayer()
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .black
        display.videoGravity = .resizeAspect; view.layer.addSublayer(display)
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); display.frame = view.bounds }
}

/// Only native camera buffers enter this surface. Delegate callbacks are the source of truth.
@MainActor final class NativeCallPictureInPicture: NSObject, @preconcurrency AVPictureInPictureControllerDelegate {
    private var content = CameraPictureContent()
    private var controller: AVPictureInPictureController?
    private var suspension: NSKeyValueObservation?
    private(set) var status = "inactive"
    private var enabled = false
    private weak var sourceView: UIView?
    private var controllerGeneration = 0
    var changed: ((String) -> Void)?
    var restore: (() -> Void)?
    var supported: Bool { AVPictureInPictureController.isPictureInPictureSupported() }
    var continuing: Bool { ["starting","active","suspended"].contains(status) }
    var diagnostics: String {
        "generation: \(controllerGeneration); enabled: \(enabled); controller: \(controller != nil); possible: \(controller?.isPictureInPicturePossible ?? false); active: \(controller?.isPictureInPictureActive ?? false); suspended: \(controller?.isPictureInPictureSuspended ?? false); sourceWindow: \(sourceView?.window != nil)"
    }

    func bind(_ source: UIView, enabled: Bool) {
        sourceView = source
        self.enabled = enabled
        guard enabled else { stop(); return }
        guard supported else { if enabled { publish("error") }; return }
        if controller == nil {
            controllerGeneration += 1
            // Each controller owns a fresh presentation hierarchy. AVKit may retain
            // the previous view controller after the terminal stop animation.
            content = CameraPictureContent()
            content.loadViewIfNeeded()
            content.preferredContentSize = CGSize(width:720,height:1280)
            let configuration = AVPictureInPictureController.ContentSource(activeVideoCallSourceView:source, contentViewController:content)
            let controller = AVPictureInPictureController(contentSource:configuration)
            controller.delegate = self; self.controller = controller
            suspension = controller.observe(\.isPictureInPictureSuspended, options:[.new]) { [weak self] controller, _ in
                Task { @MainActor in
                    guard let self, self.controller === controller, controller.isPictureInPictureActive else { return }
                    self.publish(controller.isPictureInPictureSuspended ? "suspended" : "active")
                }
            }
        }
        controller?.canStartPictureInPictureAutomaticallyFromInline = enabled
        if !enabled { stop() }
    }

    func frame(_ sample: CMSampleBuffer) {
        guard enabled else { return }
        let display = content.display
        if display.status == .failed { display.flush() }
        if display.isReadyForMoreMediaData { display.enqueue(sample) }
    }

    func background() {
        guard enabled, supported, let controller, !controller.isPictureInPictureActive else { return }
        if controller.isPictureInPicturePossible { controller.startPictureInPicture() }
    }

    func stop() {
        enabled = false
        guard let controller else { publish("inactive"); return }
        controller.canStartPictureInPictureAutomaticallyFromInline = false
        // Also cancel an automatic start in flight. Detach the terminal source so
        // AVKit cannot keep presenting the ended call after capture has stopped.
        controller.stopPictureInPicture()
        controller.contentSource = nil
        if !controller.isPictureInPictureActive && status != "starting" { stopped(controller) }
    }
    func shutdown() async {
        var backgroundTask = UIBackgroundTaskIdentifier.invalid
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName:"GChat PiP shutdown") {
            Task { @MainActor in
                if backgroundTask != .invalid { UIApplication.shared.endBackgroundTask(backgroundTask); backgroundTask = .invalid }
            }
        }
        defer { if backgroundTask != .invalid { UIApplication.shared.endBackgroundTask(backgroundTask) } }
        stop()
        // Keep the source view and controller alive through AVKit's stop animation.
        // The background call owner may already have released its audio session.
        for _ in 0..<100 {
            guard controller != nil else { return }
            try? await Task.sleep(nanoseconds:50_000_000)
        }
        if let controller, !controller.isPictureInPictureActive { stopped(controller) }
        else if controller != nil { publish("error") }
    }
    private func stopped(_ stoppedController:AVPictureInPictureController) {
        guard controller === stoppedController else { return }
        suspension = nil; stoppedController.delegate = nil; controller = nil
        content.display.flushAndRemoveImage(); publish("inactive")
    }
    private func publish(_ value:String) { guard value != status else { return }; status = value; changed?(value) }
    func pictureInPictureControllerWillStartPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        guard controller === pictureInPictureController else { return }
        publish("starting")
    }
    func pictureInPictureControllerDidStartPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        guard controller === pictureInPictureController else { return }
        publish("active")
        if !enabled { stop() }
    }
    func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error) {
        guard controller === pictureInPictureController else { return }
        if !enabled { stopped(pictureInPictureController) } else { publish("error") }
    }
    func pictureInPictureControllerDidStopPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        guard controller === pictureInPictureController else { return }
        if enabled { publish("inactive") } else { stopped(pictureInPictureController) }
    }
    func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void) { restore?(); completionHandler(true) }
}
