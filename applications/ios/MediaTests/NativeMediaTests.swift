import AVFoundation
import ImageIO
import UIKit
import XCTest
import GChatCore

final class NativeCaptureFileTests: XCTestCase {
    private func sample(_ frame: Int) throws -> CMSampleBuffer {
        var pixel: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 320, 240, kCVPixelFormatType_32BGRA,
            [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pixel), kCVReturnSuccess)
        let buffer = try XCTUnwrap(pixel)
        CVPixelBufferLockBaseAddress(buffer, [])
        if let bytes = CVPixelBufferGetBaseAddress(buffer) { memset(bytes, frame.isMultiple(of: 2) ? 80 : 160, CVPixelBufferGetDataSize(buffer)) }
        CVPixelBufferUnlockBaseAddress(buffer, [])
        var format: CMVideoFormatDescription?
        XCTAssertEqual(CMVideoFormatDescriptionCreateForImageBuffer(allocator:kCFAllocatorDefault, imageBuffer:buffer, formatDescriptionOut:&format), noErr)
        var timing = CMSampleTimingInfo(duration:CMTime(value:1,timescale:30), presentationTimeStamp:CMTime(value:Int64(frame),timescale:30), decodeTimeStamp:.invalid)
        var result: CMSampleBuffer?
        XCTAssertEqual(CMSampleBufferCreateReadyWithImageBuffer(allocator:kCFAllocatorDefault, imageBuffer:buffer,
            formatDescription:try XCTUnwrap(format), sampleTiming:&timing, sampleBufferOut:&result), noErr)
        return try XCTUnwrap(result)
    }
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at:url,withIntermediateDirectories:true)
        addTeardownBlock { try? FileManager.default.removeItem(at:url) }
        return url
    }
    func testPhotoIsDecodableJPEGOfActualFrameDimensions() async throws {
        let capture = NativeCameraCapture()
        capture.receive(try sample(0))
        let format = try await capture.waitForFrame()
        XCTAssertEqual(format["width"] as? Int,320)
        let url = try directory().appendingPathComponent("photo.jpg")
        try await capture.photo(to:url)
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL,nil))
        XCTAssertEqual(CGImageSourceGetType(source) as String?,"public.jpeg")
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source,0,nil))
        XCTAssertEqual(image.width,320); XCTAssertEqual(image.height,240)
    }
    func testMP4HasDecodableH264VideoAndNoAudioAndConcurrentStopIsIdempotent() async throws {
        let capture = NativeCameraCapture()
        capture.receive(try sample(0)); _ = try await capture.waitForFrame()
        let url = try directory().appendingPathComponent("video.mp4")
        try await capture.record(to:url)
        for frame in 1...15 {
            capture.receive(try sample(frame)); _ = try await capture.waitForFrame()
            if frame == 7 {
                let photo = url.deletingLastPathComponent().appendingPathComponent("during-recording.jpg")
                try await capture.photo(to:photo)
                XCTAssertNotNil(CGImageSourceCreateWithURL(photo as CFURL,nil))
            }
        }
        async let first: Void = capture.stopRecording()
        async let second: Void = capture.stopRecording()
        _ = try await (first,second)
        try await capture.stopRecording()
        let asset = AVURLAsset(url:url)
        let tracks = try await asset.loadTracks(withMediaType:.video)
        XCTAssertEqual(tracks.count,1)
        let audio = try await asset.loadTracks(withMediaType:.audio)
        XCTAssertTrue(audio.isEmpty)
        let duration = try await asset.load(.duration)
        XCTAssertGreaterThan(duration.seconds,0)
        let track = try XCTUnwrap(tracks.first)
        let descriptions = try await track.load(.formatDescriptions)
        XCTAssertEqual(CMFormatDescriptionGetMediaSubType(try XCTUnwrap(descriptions.first)),kCMVideoCodecType_H264)
        let reader = try AVAssetReader(asset:asset)
        let output = AVAssetReaderTrackOutput(track:track,outputSettings:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA])
        reader.add(output); XCTAssertTrue(reader.startReading())
        var decoded = 0
        while output.copyNextSampleBuffer() != nil { decoded += 1 }
        XCTAssertEqual(reader.status,.completed); XCTAssertGreaterThan(decoded,1)
    }
    func testEmptyRecordingFailsConsistentlyAndNextRecordingCanRecover() async throws {
        let capture = NativeCameraCapture()
        capture.receive(try sample(0)); _ = try await capture.waitForFrame()
        let base = try directory()
        try await capture.record(to:base.appendingPathComponent("empty.mp4"))
        for _ in 0..<2 {
            do { try await capture.stopRecording(); XCTFail("An empty recording must not be saved") }
            catch { XCTAssertEqual((error as? DeviceCommandError)?.code,"IO_ERROR") }
        }
        try await capture.record(to:base.appendingPathComponent("next.mp4"))
        for frame in 1...4 { capture.receive(try sample(frame)); _ = try await capture.waitForFrame() }
        try await capture.stopRecording()
    }
}

private final class ControlledCapture: NativeCameraCapturing {
    var authorized = true
    var onFrame: ((CMSampleBuffer)->Void)?
    var onLimit: (()->Void)?
    var onInterruption: ((Bool)->Void)?
    var onReset: (()->Void)?
    var starts = 0; var stops = 0; var resumes = 0; var recordings = 0; var finalized = 0
    var permissionRequests = 0
    var frameError: Error?
    var frameGate: CheckedContinuation<[String:Any],Error>?
    var onFrameWait: (() -> Void)?
    var didResume: (() -> Void)?
    func requestPermission() async throws { permissionRequests += 1; if !authorized { throw DeviceCommandError("PERMISSION_DENIED") } }
    func start(facing:String) async throws -> [String:Any] { starts += 1; return [:] }
    func waitForFrame() async throws -> [String:Any] {
        if let frameError { throw frameError }
        if let onFrameWait { return try await withCheckedThrowingContinuation { frameGate = $0; onFrameWait() } }
        return ["width":720,"height":1280,"frameRate":30.0]
    }
    func multitaskingSupport() async -> Bool? { true }
    func setMultitasking(_ enabled:Bool) async -> Bool { enabled }
    func resume() async throws { resumes += 1; didResume?() }
    func shutdown() async { stops += 1 }
    func photo(to url:URL) async throws { try Data([1]).write(to:url) }
    func record(to url:URL) async throws { recordings += 1; try Data([2]).write(to:url) }
    func stopRecording() async throws { finalized += 1 }
}

@MainActor private final class CaptureFiles: NativeMediaFiles {
    let base = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    var commits = 0; var aborts = 0
    var stageGate: CheckedContinuation<URL,Error>?
    var onStage: (() -> Void)?
    func createCapture(extension suffix:String) async throws -> URL {
        try FileManager.default.createDirectory(at:base,withIntermediateDirectories:true)
        let url = base.appendingPathComponent(UUID().uuidString+"."+suffix)
        if let onStage {
            return try await withCheckedThrowingContinuation { stageGate = $0; onStage() }
        }
        return url
    }
    func commitCapture(_ url:URL) async throws -> [String:Any] { commits += 1; return ["id":UUID().uuidString,"kind":"file","persistence":"persistent"] }
    func abortCapture(_ url:URL) async { aborts += 1; try? FileManager.default.removeItem(at:url) }
    func disposeDocument() async {}
    deinit { try? FileManager.default.removeItem(at:base) }
}

@MainActor final class NativeMediaLifecycleTests: XCTestCase {
    private func opened(_ capture:ControlledCapture, _ files:CaptureFiles, lifetime:String = "view") async throws -> (NativeMediaController,String) {
        let controller = NativeMediaController(files:files,webView:{nil},capture:capture,applicationState:{.active})
        if lifetime == "call" { controller.selectCall(UUID(),audioActive:true) }
        let result = try await controller.execute("camera.open",args:["facing":"front","lifetime":lifetime])
        return (controller,try XCTUnwrap(result["sessionId"] as? String))
    }
    func testSharedSourceSwitchIsBlockedDuringRecordingAndStopReturnsSameCommittedFile() async throws {
        let capture = ControlledCapture(); let files = CaptureFiles()
        let (controller,id) = try await opened(capture,files)
        let second = try await controller.execute("camera.open",args:["facing":"front","lifetime":"view"])
        XCTAssertEqual(capture.starts,1)
        let recording = try await controller.execute("camera.record",args:["sessionId":id])
        do { _ = try await controller.execute("camera.facing",args:["sessionId":id,"facing":"back"]); XCTFail("Must not switch while recording") }
        catch { XCTAssertEqual((error as? DeviceCommandError)?.code,"BUSY") }
        _ = try await controller.execute("camera.photo",args:["sessionId":id])
        let first = try await controller.execute("camera.stopRecording",args:recording)
        let repeated = try await controller.execute("camera.stopRecording",args:recording)
        XCTAssertEqual(first["id"] as? String,repeated["id"] as? String)
        XCTAssertEqual(files.commits,2); XCTAssertEqual(capture.finalized,1)
        _ = try await controller.execute("camera.facing",args:["sessionId":id,"facing":"back"])
        let state = try await controller.execute("camera.state",args:["sessionId":second["sessionId"]!])
        XCTAssertEqual(state["facing"] as? String,"back")
        _ = try await controller.execute("camera.close",args:[:])
    }
    func testInterruptionFinalizesOnceAndRecoveryDoesNotRestartRecordingOrPrompt() async throws {
        let capture = ControlledCapture(); let files = CaptureFiles()
        let (controller,id) = try await opened(capture,files,lifetime:"call")
        let recording = try await controller.execute("camera.record",args:["sessionId":id])
        let saved = expectation(description:"interrupted recording committed")
        controller.onEvent = { event in if event["kind"] as? String == "recordingSaved" { saved.fulfill() } }
        capture.onInterruption?(true)
        await fulfillment(of:[saved],timeout:3)
        let file = try await controller.execute("camera.stopRecording",args:recording)
        XCTAssertNotNil(file["id"]); XCTAssertEqual(capture.finalized,1)
        let resumed = expectation(description:"fresh frame after interruption")
        controller.onEvent = { event in if event["kind"] as? String == "stateChanged", (event["state"] as? [String:Any])?["status"] as? String == "streaming" { resumed.fulfill() } }
        capture.onInterruption?(false)
        await fulfillment(of:[resumed],timeout:3)
        XCTAssertEqual(capture.resumes,1); XCTAssertEqual(capture.recordings,1); XCTAssertEqual(capture.permissionRequests,1)
        let state = try await controller.execute("camera.state",args:["sessionId":id])
        XCTAssertEqual(state["recording"] as? String,"idle")
        _ = try await controller.execute("camera.close",args:[:])
    }
    func testCloseWhileRecordingStageWaitsCannotLeaveAWriterOrPublishAFile() async throws {
        let capture = ControlledCapture(); let files = CaptureFiles()
        let (controller,id) = try await opened(capture,files)
        let staged = expectation(description:"stage suspended")
        files.onStage = { staged.fulfill() }
        let recording = Task { try await controller.execute("camera.record",args:["sessionId":id]) }
        await fulfillment(of:[staged],timeout:3)
        _ = try await controller.execute("camera.close",args:[:])
        files.stageGate?.resume(returning:files.base.appendingPathComponent("late.mp4"))
        do { _ = try await recording.value; XCTFail("Closed source cannot begin recording") }
        catch { XCTAssertEqual((error as? DeviceCommandError)?.code,"CANCELLED") }
        XCTAssertEqual(files.commits,0); XCTAssertEqual(files.aborts,1)
        XCTAssertEqual(capture.recordings,0,"A late stage must not start a writer after shutdown")
    }
    func testFrameFailureShutsCaptureDownAndCallEndRejectsOldSession() async throws {
        let capture = ControlledCapture(); let files = CaptureFiles()
        capture.frameError = DeviceCommandError("DEVICE_UNAVAILABLE")
        do { _ = try await opened(capture,files); XCTFail("No live frame must fail open") }
        catch { XCTAssertEqual((error as? DeviceCommandError)?.code,"DEVICE_UNAVAILABLE") }
        XCTAssertEqual(capture.stops,1)
        capture.frameError = nil
        let (controller,id) = try await opened(capture,files,lifetime:"call")
        controller.selectCall(nil,audioActive:false)
        let current = try await controller.execute("camera.current",args:[:])
        XCTAssertEqual((current["state"] as? [String:Any])?["status"] as? String,"released")
        do { _ = try await controller.execute("camera.state",args:["sessionId":id]); XCTFail("Ended call must invalidate its camera session") }
        catch { XCTAssertEqual((error as? DeviceCommandError)?.code,"INVALID_STATE") }
    }
    func testLateFrameAfterCloseCannotRestoreOrReplaceReleasedState() async throws {
        let capture = ControlledCapture(); let files = CaptureFiles()
        let controller = NativeMediaController(files:files,webView:{nil},capture:capture,applicationState:{.active})
        let waiting = expectation(description:"opening waits for a live frame")
        capture.onFrameWait = { waiting.fulfill() }
        let opening = Task { try await controller.execute("camera.open",args:["facing":"front","lifetime":"view"]) }
        await fulfillment(of:[waiting],timeout:3)
        _ = try await controller.execute("camera.close",args:[:])
        capture.frameGate?.resume(returning:["width":720,"height":1280,"frameRate":30])
        do { _ = try await opening.value; XCTFail("Old open must remain cancelled") }
        catch { XCTAssertEqual((error as? DeviceCommandError)?.code,"CANCELLED") }
        let current = try await controller.execute("camera.current",args:[:])
        XCTAssertEqual((current["state"] as? [String:Any])?["status"] as? String,"released")
        XCTAssertTrue(current["sourceId"] is NSNull)
    }
    func testViewBackgroundFinalizesRecordingAndReleasesCamera() async throws {
        let capture = ControlledCapture(); let files = CaptureFiles()
        var phase = UIApplication.State.active
        let controller = NativeMediaController(files:files,webView:{nil},capture:capture,applicationState:{phase})
        let opened = try await controller.execute("camera.open",args:["facing":"front","lifetime":"view"])
        let recording = try await controller.execute("camera.record",args:["sessionId":opened["sessionId"]!])
        let released = expectation(description:"view camera released in background")
        controller.onEvent = { event in if event["kind"] as? String == "stateChanged", (event["state"] as? [String:Any])?["status"] as? String == "released" { released.fulfill() } }
        phase = .background
        NotificationCenter.default.post(name:UIApplication.didEnterBackgroundNotification,object:nil)
        await fulfillment(of:[released],timeout:3)
        XCTAssertEqual(files.commits,1); XCTAssertEqual(capture.finalized,1)
        let file = try await controller.execute("camera.stopRecording",args:recording)
        XCTAssertNotNil(file["id"])
    }
    func testLostPermissionPreventsAutomaticResumeAndAnotherPrompt() async throws {
        let capture = ControlledCapture(); let files = CaptureFiles()
        let (controller,_) = try await opened(capture,files,lifetime:"call")
        capture.authorized = false
        let interrupted = expectation(description:"permission loss published")
        controller.onEvent = { event in if event["kind"] as? String == "interrupted" { interrupted.fulfill() } }
        capture.onInterruption?(true)
        await fulfillment(of:[interrupted],timeout:3)
        let forbidden = expectation(description:"no automatic resume without permission"); forbidden.isInverted = true
        capture.didResume = { forbidden.fulfill() }
        capture.onInterruption?(false)
        await fulfillment(of:[forbidden],timeout:0.2)
        XCTAssertEqual(capture.permissionRequests,1)
        _ = try await controller.execute("camera.close",args:[:])
    }
    func testRecordingLimitAndExplicitStopCommitOnce() async throws {
        let capture = ControlledCapture(); let files = CaptureFiles()
        let (controller,id) = try await opened(capture,files)
        let recording = try await controller.execute("camera.record",args:["sessionId":id])
        let saved = expectation(description:"automatic limit commits recording")
        controller.onEvent = { event in if event["kind"] as? String == "recordingSaved" { saved.fulfill() } }
        capture.onLimit?(); capture.onLimit?()
        await fulfillment(of:[saved],timeout:3)
        _ = try await controller.execute("camera.stopRecording",args:recording)
        XCTAssertEqual(capture.finalized,1); XCTAssertEqual(files.commits,1)
        _ = try await controller.execute("camera.close",args:[:])
    }
}
