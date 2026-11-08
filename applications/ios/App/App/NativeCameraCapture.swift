import AVFoundation
import CoreImage
import UIKit
import GChatCore

protocol NativeCameraCapturing: AnyObject {
    var authorized: Bool { get }
    var onFrame: ((CMSampleBuffer) -> Void)? { get set }
    var onLimit: (() -> Void)? { get set }
    var onInterruption: ((Bool) -> Void)? { get set }
    var onReset: (() -> Void)? { get set }
    func requestPermission() async throws
    func start(facing: String) async throws -> [String: Any]
    func waitForFrame() async throws -> [String: Any]
    func multitaskingSupport() async -> Bool?
    func setMultitasking(_ enabled: Bool) async -> Bool
    func resume() async throws
    func shutdown() async
    func photo(to url: URL) async throws
    func record(to url: URL) async throws
    func stopRecording() async throws
}

/// Session operations use sessionQueue; buffers and the writer use queue, without blocking each other.
final class NativeCameraCapture: NSObject, NativeCameraCapturing, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    private let queue = DispatchQueue(label: "gchat.camera.frames", qos: .userInitiated)
    private let sessionQueue = DispatchQueue(label: "gchat.camera.session", qos: .userInitiated)
    private var frameRate = 30.0
    private let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    private var last: CMSampleBuffer?
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var recordingStart: CMTime?
    private var timer: DispatchWorkItem?
    private var finishing = false
    private var stopWaiters: [(Result<Void, Error>) -> Void] = []
    private var recordingResult: Result<Void, Error>?
    private let previewLock = NSLock()
    private var previewPending = false
    var onFrame: ((CMSampleBuffer) -> Void)?
    var onLimit: (() -> Void)?
    var authorized: Bool { AVCaptureDevice.authorizationStatus(for:.video) == .authorized }
    func requestPermission() async throws {
        switch AVCaptureDevice.authorizationStatus(for:.video) {
        case .authorized: break
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for:.video) else { throw DeviceCommandError("PERMISSION_DENIED") }
        default: throw DeviceCommandError("PERMISSION_DENIED")
        }
        try Task.checkCancellation()
    }

    func start(facing: String) async throws -> [String: Any] {
        try await withCheckedThrowingContinuation { continuation in
            sessionQueue.async {
                do {
                    self.session.automaticallyConfiguresApplicationAudioSession = false
                    self.session.beginConfiguration()
                    defer { self.session.commitConfiguration() }
                    for input in self.session.inputs { self.session.removeInput(input) }
                    let position: AVCaptureDevice.Position = facing == "front" ? .front : .back
                    guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position) else { throw DeviceCommandError("DEVICE_UNAVAILABLE") }
                    let input = try AVCaptureDeviceInput(device: device)
                    guard self.session.canAddInput(input) else { throw DeviceCommandError("DEVICE_UNAVAILABLE") }
                    self.session.addInput(input)
                    if self.session.canSetSessionPreset(.hd1280x720) { self.session.sessionPreset = .hd1280x720 }
                    if self.session.outputs.isEmpty {
                        self.output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
                        self.output.alwaysDiscardsLateVideoFrames = true
                        self.output.setSampleBufferDelegate(self, queue: self.queue)
                        guard self.session.canAddOutput(self.output) else { throw DeviceCommandError("DEVICE_UNAVAILABLE") }
                        self.session.addOutput(self.output)
                    }
                    if let connection = self.output.connection(with: .video), connection.isVideoOrientationSupported { connection.videoOrientation = .portrait }
                    // This property may only be changed before startRunning (AVCaptureSession contract).
                    // View sources still close in background; preconfiguration lets a later Call lease reuse the source.
                    if !self.session.isRunning && self.session.isMultitaskingCameraAccessSupported && !self.session.isMultitaskingCameraAccessEnabled {
                        self.session.isMultitaskingCameraAccessEnabled = true
                    }
                    self.sessionQueue.async {
                        do {
                            let ranges = device.activeFormat.videoSupportedFrameRateRanges
                            let range = ranges.min { abs(min(max(30,$0.minFrameRate),$0.maxFrameRate)-30) < abs(min(max(30,$1.minFrameRate),$1.maxFrameRate)-30) }
                            guard let range else { throw DeviceCommandError("DEVICE_UNAVAILABLE") }
                            let duration = range.maxFrameRate < 30 ? range.minFrameDuration : range.minFrameRate > 30 ? range.maxFrameDuration : CMTime(value:1,timescale:30)
                            try device.lockForConfiguration()
                            device.activeVideoMinFrameDuration = duration; device.activeVideoMaxFrameDuration = duration
                            device.unlockForConfiguration()
                        } catch { continuation.resume(throwing:error); return }
                        let duration = device.activeVideoMinFrameDuration.seconds
                        let rate = duration > 0 && duration.isFinite ? 1 / duration : 30
                        self.queue.sync { self.last = nil; self.frameRate = rate }
                        self.session.startRunning()
                        guard self.session.isRunning else { continuation.resume(throwing: DeviceCommandError("DEVICE_UNAVAILABLE")); return }
                        let dimensions = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
                        continuation.resume(returning: ["width": Int(dimensions.height), "height": Int(dimensions.width), "frameRate": rate])
                    }
                } catch { continuation.resume(throwing: error) }
            }
        }
    }

    func multitaskingSupport() async -> Bool? {
        await withCheckedContinuation { continuation in sessionQueue.async {
            continuation.resume(returning:self.session.inputs.isEmpty ? nil : self.session.isMultitaskingCameraAccessSupported)
        } }
    }
    func setMultitasking(_ enabled: Bool) async -> Bool {
        await withCheckedContinuation { continuation in sessionQueue.async {
            let supported = self.session.isMultitaskingCameraAccessSupported
            if supported && !self.session.isRunning && self.session.isMultitaskingCameraAccessEnabled != enabled { self.session.isMultitaskingCameraAccessEnabled = enabled }
            continuation.resume(returning:supported && self.session.isMultitaskingCameraAccessEnabled)
        } }
    }
    func resume() async throws {
        try await withCheckedThrowingContinuation { (continuation:CheckedContinuation<Void,Error>) in sessionQueue.async {
            guard !self.session.inputs.isEmpty else { continuation.resume(throwing:DeviceCommandError("INVALID_STATE")); return }
            self.queue.sync { self.last = nil }
            if !self.session.isRunning { self.session.startRunning() }
            continuation.resume(returning:())
        } }
    }
    var onInterruption: ((Bool) -> Void)?
    var onReset: (() -> Void)?
    private var observers: [NSObjectProtocol] = []
    override init() {
        super.init()
        for name in [AVCaptureSession.wasInterruptedNotification,AVCaptureSession.runtimeErrorNotification,AVCaptureSession.interruptionEndedNotification] {
            observers.append(NotificationCenter.default.addObserver(forName:name,object:session,queue:nil) { [weak self] notification in
                guard let self else { return }
                let interrupted = notification.name != AVCaptureSession.interruptionEndedNotification
                let reset = (notification.userInfo?[AVCaptureSessionErrorKey] as? AVError)?.code == .mediaServicesWereReset
                self.queue.async {
                    if interrupted { self.last = nil }
                    if reset { self.onReset?() } else { self.onInterruption?(interrupted) }
                }
            })
        }
    }
    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }

    func waitForFrame() async throws -> [String: Any] {
        for _ in 0..<20 {
            try Task.checkCancellation()
            let frame: [String: Any]? = await withCheckedContinuation { continuation in queue.async {
                guard let sample = self.last, let description = CMSampleBufferGetFormatDescription(sample) else { continuation.resume(returning:nil); return }
                let dimensions = CMVideoFormatDescriptionGetDimensions(description)
                continuation.resume(returning:["width":Int(dimensions.width),"height":Int(dimensions.height),"frameRate":self.frameRate])
            } }
            if let frame { return frame }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw DeviceCommandError("DEVICE_UNAVAILABLE")
    }

    func shutdown() async {
        await withCheckedContinuation { continuation in
            sessionQueue.async { self.session.stopRunning(); self.queue.sync { self.last = nil }; continuation.resume() }
        }
    }

    func photo(to url: URL) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                do {
                    guard let sample = self.last, let buffer = CMSampleBufferGetImageBuffer(sample) else { throw DeviceCommandError("DEVICE_UNAVAILABLE") }
                    let image = CIImage(cvPixelBuffer: buffer)
                    let context = CIContext()
                    guard let cg = context.createCGImage(image, from: image.extent), let jpeg = UIImage(cgImage: cg).jpegData(compressionQuality: 0.9) else { throw DeviceCommandError("IO_ERROR") }
                    try jpeg.write(to: url, options: .atomic)
                    continuation.resume()
                } catch { continuation.resume(throwing: error) }
            }
        }
    }

    func record(to url: URL) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                do {
                    guard self.writer == nil, !self.finishing else { throw DeviceCommandError("BUSY") }
                    guard let sample = self.last, let description = CMSampleBufferGetFormatDescription(sample) else { throw DeviceCommandError("DEVICE_UNAVAILABLE") }
                    let dimensions = CMVideoFormatDescriptionGetDimensions(description)
                    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
                    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: Int(dimensions.width), AVVideoHeightKey: Int(dimensions.height)])
                    input.expectsMediaDataInRealTime = true
                    guard writer.canAdd(input) else { throw DeviceCommandError("UNSUPPORTED") }
                    writer.add(input)
                    guard writer.startWriting() else { throw DeviceCommandError("IO_ERROR") }
                    self.writer = writer; self.input = input; self.recordingStart = nil; self.recordingResult = nil
                    let timer = DispatchWorkItem { [weak owner = self] in owner?.onLimit?() }
                    self.timer = timer; self.queue.asyncAfter(deadline: .now() + 300, execute: timer)
                    continuation.resume()
                } catch { continuation.resume(throwing: error) }
            }
        }
    }

    func stopRecording() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                if let result = self.recordingResult { continuation.resume(with: result); return }
                self.stopWaiters.append { continuation.resume(with: $0) }
                if self.finishing { return }
                guard let writer = self.writer else { self.complete(.failure(DeviceCommandError("INVALID_STATE"))); return }
                self.finishing = true; self.timer?.cancel(); self.timer = nil
                guard self.recordingStart != nil, writer.status == .writing else {
                    writer.cancelWriting(); self.complete(.failure(DeviceCommandError("IO_ERROR"))); return
                }
                self.input?.markAsFinished()
                writer.finishWriting {
                    self.queue.async { self.complete(writer.status == .completed ? .success(()) : .failure(DeviceCommandError("IO_ERROR"))) }
                }
            }
        }
    }

    private func complete(_ result: Result<Void, Error>) {
        writer = nil; input = nil; finishing = false; recordingResult = result
        let waiters = stopWaiters; stopWaiters.removeAll()
        for waiter in waiters { waiter(result) }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
        receive(sample)
    }

    /// Camera delivery and other native frame producers share the same serial writer.
    func receive(_ sample: CMSampleBuffer) {
        queue.async { self.consume(sample) }
    }

    private func consume(_ sample: CMSampleBuffer) {
        last = sample
        if let writer, let input, !finishing {
            let time = CMSampleBufferGetPresentationTimeStamp(sample)
            if recordingStart == nil { recordingStart = time; writer.startSession(atSourceTime: time) }
            if writer.status != .writing || (input.isReadyForMoreMediaData && !input.append(sample)) { onLimit?() }
            if let url = writer.outputURL as URL?, let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize, size >= 256 * 1024 * 1024 { onLimit?() }
        }
        previewLock.lock()
        let deliver = !previewPending
        if deliver { previewPending = true }
        previewLock.unlock()
        if deliver {
            DispatchQueue.main.async {
                self.onFrame?(sample)
                self.previewLock.lock(); self.previewPending = false; self.previewLock.unlock()
            }
        }
    }
}
