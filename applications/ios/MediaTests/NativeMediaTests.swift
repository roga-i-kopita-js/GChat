import AVFoundation
import ImageIO
import UIKit
import XCTest
import GChatCore

@MainActor final class CallSystemPreparationTests: XCTestCase {
    private func record(state: String, account: UUID) throws -> DirectCallRecord {
        let date = "2026-11-10T21:00:00.000Z"
        let value: [String: Any] = [
            "call_id": UUID().uuidString, "caller_id": UUID().uuidString,
            "recipient_id": account.uuidString, "state": state, "version": 0,
            "created_at": date, "started_at": state == "active" ? date as Any : NSNull(),
            "ended_at": NSNull(), "end_reason": NSNull(),
            "ringing_deadline": state == "ringing" ? date as Any : NSNull(),
            "connecting_deadline": NSNull(), "recovery_id": NSNull(), "recovery_deadline": NSNull(),
        ]
        return try JSONDecoder().decode(DirectCallRecord.self,
            from: JSONSerialization.data(withJSONObject: value))
    }

    func testAudioPreparationFailureDoesNotCreateSystemProvider() throws {
        let system = CallSystem()
        let account = UUID()
        var preparations = 0
        var errors = 0
        system.onPrepareAudio = { [unowned system] in
            preparations += 1
            XCTAssertTrue(system.diagnostics.contains("provider: не создан"))
            throw NativeError.unavailable
        }
        system.onError = { _ in errors += 1 }

        system.update(call: try record(state: "ringing", account: account), phase: .ringing,
            accountID: account, selected: false, connected: false, unavailable: false)

        XCTAssertEqual(preparations, 1)
        XCTAssertEqual(errors, 1)
        XCTAssertTrue(system.diagnostics.contains("provider: не создан"))
        // A later reconciliation can retry preparation without a stale provider.
        system.update(call: try record(state: "ringing", account: account), phase: .ringing,
            accountID: account, selected: false, connected: false, unavailable: false)
        XCTAssertEqual(preparations, 2)
    }

    func testUnselectedRestoredCallDoesNotCreateSystemProvider() throws {
        let system = CallSystem()
        let account = UUID()
        system.onPrepareAudio = { XCTFail("Another device owns this active call") }

        system.update(call: try record(state: "active", account: account), phase: .active,
            accountID: account, selected: false, connected: false, unavailable: false)

        XCTAssertTrue(system.diagnostics.contains("provider: не создан"))
    }
}

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

@MainActor private final class ControlledAudioSession: NativeAudioSessionRouting {
    let mic = NativeAudioPort(uid: "private-mic-uid", name: "Microphone", type: .builtInMic)
    let bluetooth = NativeAudioPort(uid: "private-bt-uid", name: "Headset", type: .bluetoothHFP)
    var inputs: [NativeAudioPort] = []
    var currentInputs: [NativeAudioPort] = []
    var currentOutputs = [NativeAudioPort(uid: "private-receiver-uid", name: "iPhone", type: .builtInReceiver)]
    var voiceSession = true
    var hasReceiver = true
    var preferences: [String] = []
    var overrides: [Bool] = []
    var permission = true
    var permissionGate: CheckedContinuation<Bool, Never>?
    var waitForPermission = false
    var activationCount = 0
    var deactivationCount = 0
    var immediateRoute = false
    func authorize() async -> Bool {
        if waitForPermission { return await withCheckedContinuation { permissionGate = $0 } }
        return permission
    }
    func activateSetup() throws { activationCount += 1; voiceSession = true }
    func deactivateSetup() { deactivationCount += 1 }
    func preferInput(_ uid: String) throws {
        preferences.append(uid)
        if immediateRoute, let port = inputs.first(where: { $0.uid == uid }) {
            currentInputs = [port]
            if port.type == .bluetoothHFP { currentOutputs = [port] }
            else if currentOutputs.first?.type != .builtInSpeaker {
                currentOutputs = [NativeAudioPort(uid: "receiver", name: "Phone", type: .builtInReceiver)]
            }
        }
    }
    func overrideSpeaker(_ enabled: Bool) throws {
        overrides.append(enabled)
        if immediateRoute {
            currentOutputs = [NativeAudioPort(uid: enabled ? "speaker" : "receiver", name: "Phone", type: enabled ? .builtInSpeaker : .builtInReceiver)]
        }
    }
    init() { inputs = [mic, bluetooth]; currentInputs = [mic] }
}

@MainActor final class NativeAudioDevicesTests: XCTestCase {
    private func output(_ devices: [String: Any], kind: String) throws -> String {
        let values = try XCTUnwrap(devices["outputs"] as? [[String: Any]])
        return try XCTUnwrap(values.first(where: { $0["kind"] as? String == kind })?["id"] as? String)
    }

    func testNativeListUsesKnownDuplexRoutesAndOpaqueStableIDs() throws {
        let session = ControlledAudioSession()
        session.inputs.append(NativeAudioPort(uid: "unknown", name: "Unknown", type: .lineIn))
        let audio = NativeAudioDevices(session: session)
        let first = audio.devices(active: true)
        let second = audio.devices(active: true)
        XCTAssertEqual(try output(first, kind: "speaker"), try output(second, kind: "speaker"))
        XCTAssertEqual(try output(first, kind: "receiver"), (first["output"] as? [String: Any])?["id"] as? String)
        XCTAssertEqual((first["outputs"] as? [[String: Any]])?.count, 3)
        let data = try JSONSerialization.data(withJSONObject: first)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("private-"))
        XCTAssertTrue(audio.devices(active: false)["outputs"] is NSNull)
        session.hasReceiver = false
        XCTAssertFalse((audio.devices(active: true)["outputs"] as? [[String: Any]])?.contains { $0["kind"] as? String == "receiver" } ?? true)
    }

    func testSelectionWaitsForActualRouteAndConfirmsPairedHeadset() async throws {
        let session = ControlledAudioSession()
        var waits = 0
        let audio = NativeAudioDevices(session: session, attempts: 2, wait: {
            waits += 1
            session.currentInputs = [session.bluetooth]
            session.currentOutputs = [NativeAudioPort(uid: "different-output-uid", name: "Headset", type: .bluetoothHFP)]
        })
        let id = try output(audio.devices(active: true), kind: "bluetooth")
        try await audio.select(id, active: { true })
        XCTAssertEqual(waits, 1)
        XCTAssertEqual(session.preferences, [session.bluetooth.uid])
        XCTAssertEqual(session.overrides, [false])
        XCTAssertEqual((audio.devices(active: true)["output"] as? [String: Any])?["id"] as? String, id)
    }

    func testSuccessfulOverrideDoesNotConfirmAnUnchangedOutput() async throws {
        let session = ControlledAudioSession()
        let audio = NativeAudioDevices(session: session, attempts: 1, wait: {})
        let id = try output(audio.devices(active: true), kind: "speaker")
        do { try await audio.select(id, active: { true }); XCTFail("Route never changed") }
        catch { XCTAssertEqual((error as? DeviceCommandError)?.code, "DEVICE_UNAVAILABLE") }
        XCTAssertEqual(session.overrides, [true])
        XCTAssertEqual((audio.devices(active: true)["output"] as? [String: Any])?["kind"] as? String, "receiver")
    }

    func testSpeakerAndReceiverSelectionsConfirmTheirActualOutput() async throws {
        for (kind, type) in [("speaker", AVAudioSession.Port.builtInSpeaker), ("receiver", .builtInReceiver)] {
            let session = ControlledAudioSession()
            session.currentOutputs = [NativeAudioPort(uid: "initial", name: "Initial", type: type == .builtInSpeaker ? .builtInReceiver : .builtInSpeaker)]
            let audio = NativeAudioDevices(session: session, attempts: 1, wait: {
                session.currentOutputs = [NativeAudioPort(uid: "selected", name: "Selected", type: type)]
            })
            let id = try output(audio.devices(active: true), kind: kind)
            try await audio.select(id, active: { true })
            XCTAssertEqual(session.overrides, [kind == "speaker"])
            XCTAssertEqual(session.preferences, [session.mic.uid])
            XCTAssertEqual((audio.devices(active: true)["output"] as? [String: Any])?["id"] as? String, id)
        }
    }

    func testSelectingTheCurrentRouteIsAlreadyConfirmedWithoutMutation() async throws {
        let session = ControlledAudioSession()
        let audio = NativeAudioDevices(session: session)
        let id = try output(audio.devices(active: true), kind: "receiver")
        try await audio.select(id, active: { true })
        XCTAssertTrue(session.overrides.isEmpty)
        XCTAssertTrue(session.preferences.isEmpty)
    }

    func testPreferredInputAloneDoesNotConfirmAHeadsetOutput() async throws {
        let session = ControlledAudioSession()
        let audio = NativeAudioDevices(session: session, attempts: 1, wait: {
            session.currentInputs = [session.bluetooth]
        })
        let id = try output(audio.devices(active: true), kind: "bluetooth")
        do { try await audio.select(id, active: { true }); XCTFail("Output still uses receiver") }
        catch { XCTAssertEqual((error as? DeviceCommandError)?.code, "DEVICE_UNAVAILABLE") }
    }

    func testDisconnectedIDIsInvalidatedAndReconnectGetsNewID() async throws {
        let session = ControlledAudioSession()
        let audio = NativeAudioDevices(session: session)
        let id = try output(audio.devices(active: true), kind: "bluetooth")
        session.inputs = [session.mic]
        do { try await audio.select(id, active: { true }); XCTFail("Headset disconnected") }
        catch { XCTAssertEqual((error as? DeviceCommandError)?.code, "DEVICE_UNAVAILABLE") }
        session.inputs.append(session.bluetooth)
        XCTAssertNotEqual(try output(audio.devices(active: true), kind: "bluetooth"), id)
        XCTAssertTrue(session.preferences.isEmpty)
    }

    func testInactiveSessionAndCancellationDoNotChangeAudio() async throws {
        let session = ControlledAudioSession()
        let audio = NativeAudioDevices(session: session)
        let id = try output(audio.devices(active: true), kind: "speaker")
        do { try await audio.select(id, active: { false }); XCTFail("No active call") }
        catch { XCTAssertEqual((error as? DeviceCommandError)?.code, "INVALID_STATE") }
        let pending = Task { @MainActor in try await audio.select(id, active: { true }) }
        pending.cancel()
        do { try await pending.value; XCTFail("Cancelled") } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertTrue(session.overrides.isEmpty)
    }

    func testEndingCallWhileWaitingCancelsConfirmation() async throws {
        let session = ControlledAudioSession()
        var active = true
        let audio = NativeAudioDevices(session: session, attempts: 2, wait: { active = false })
        let id = try output(audio.devices(active: true), kind: "speaker")
        do { try await audio.select(id, active: { active }); XCTFail("Call ended") }
        catch { XCTAssertEqual((error as? DeviceCommandError)?.code, "CANCELLED") }
    }

    func testDispatcherRejectsConcurrentSelectionAndCancelsDisposedSelection() async throws {
        let session = ControlledAudioSession()
        let waiting = expectation(description: "selection waits for currentRoute")
        var resume: CheckedContinuation<Void, Never>?
        let audio = NativeAudioDevices(session: session, wait: {
            await withCheckedContinuation { resume = $0; waiting.fulfill() }
        })
        let controller = NativeMediaController(files: CaptureFiles(), webView: { nil }, capture: ControlledCapture(), audioDevices: audio)
        let call = UUID()
        controller.selectCall(call, audioActive: true)
        let devices = try await controller.execute("getAudioDevices", args: [:])
        let id = try output(devices, kind: "speaker")
        let pending = Task { @MainActor in try await controller.execute("selectAudioDevice", args: ["outputId": id]) }
        await fulfillment(of: [waiting], timeout: 2)
        do { _ = try await controller.execute("selectAudioDevice", args: ["outputId": id]); XCTFail("Concurrent selection") }
        catch { XCTAssertEqual((error as? DeviceCommandError)?.code, "BUSY") }
        do { _ = try await controller.execute("audio.pick", args: [:]); XCTFail("Native must not present custom UI") }
        catch { XCTAssertEqual((error as? DeviceCommandError)?.code, "UNSUPPORTED") }
        await controller.releaseViews()
        resume?.resume()
        do { _ = try await pending.value; XCTFail("Document disposed") }
        catch { XCTAssertEqual((error as? DeviceCommandError)?.code, "CANCELLED") }
    }

    func testDispatcherValidatesArgumentsAndPublishesActivityChanges() async throws {
        let controller = NativeMediaController(files: CaptureFiles(), webView: { nil }, capture: ControlledCapture())
        var changes = 0
        controller.onEvent = { if $0["kind"] as? String == "audioChanged" { changes += 1 } }
        let call = UUID()
        controller.selectCall(call, audioActive: false)
        controller.selectCall(call, audioActive: true)
        controller.selectCall(call, audioActive: true)
        controller.selectCall(nil, audioActive: false)
        XCTAssertEqual(changes, 3)
        for (command, args) in [("getAudioDevices", ["extra": "value"]), ("selectAudioDevice", ["outputId": ""])] {
            do { _ = try await controller.execute(command, args: args); XCTFail("Invalid arguments") }
            catch { XCTAssertEqual((error as? DeviceCommandError)?.code, "INVALID_ARGUMENT") }
        }
    }
}

@MainActor final class NativeAudioOwnerTests: XCTestCase {
    private func fixture() throws -> (ControlledAudioSession, NativeAudioDevices, NativeAudioOwner, UserDefaults) {
        let name = "gchat-audio-test-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        addTeardownBlock { defaults.removePersistentDomain(forName: name) }
        let session = ControlledAudioSession(); session.immediateRoute = true
        let devices = NativeAudioDevices(session: session, defaults: defaults, attempts: 1, wait: {})
        let owner = NativeAudioOwner(devices: devices, foreground: { true })
        return (session, devices, owner, defaults)
    }
    private func id(_ devices: NativeAudioDevices, _ kind: String) throws -> String {
        let values = try XCTUnwrap(devices.devices(active: true)["outputs"] as? [[String: Any]])
        return try XCTUnwrap(values.first { $0["kind"] as? String == kind }?["id"] as? String)
    }

    func testSetupDoesNotActivateUntilExplicitBeginAndKeepsOwnershipThroughTone() async throws {
        let (session, devices, owner, _) = try fixture()
        XCTAssertTrue(devices.devices(active: owner.hasRoute)["outputs"] is NSNull)
        XCTAssertEqual(session.activationCount, 0)
        let setup = try await owner.beginSetup()
        XCTAssertEqual(session.activationCount, 1)
        let test = try await owner.beginTest()
        owner.endTest(test)
        XCTAssertEqual(session.activationCount, 1)
        XCTAssertEqual(session.deactivationCount, 0)
        owner.closeSetup(setup); owner.closeSetup(setup)
        XCTAssertEqual(session.deactivationCount, 1)
        XCTAssertFalse(owner.hasRoute)
    }

    func testPreferencePersistsAndAppliesOnceToTheNextCall() async throws {
        let (session, devices, owner, defaults) = try fixture()
        let setup = try await owner.beginSetup()
        try await owner.select(id(devices, "speaker"), save: true)
        owner.closeSetup(setup)
        let restored = NativeAudioDevices(session: session, defaults: defaults, attempts: 1, wait: {})
        XCTAssertEqual(restored.preference(active: false)["kind"] as? String, "speaker")
        let next = NativeAudioOwner(devices: restored, foreground: { true })
        session.currentOutputs = [NativeAudioPort(uid: "receiver", name: "Phone", type: .builtInReceiver)]
        let applied = expectation(description: "saved speaker is applied after CallKit activation")
        var observed = false
        next.changed = {
            if !observed, session.currentOutputs.first?.type == .builtInSpeaker {
                observed = true; applied.fulfill()
            }
        }
        let call = UUID(); next.prepareCall(); next.updateCall(call, active: true)
        await fulfillment(of: [applied], timeout: 2)
        let changes = session.overrides.count
        session.currentOutputs = [NativeAudioPort(uid: "receiver", name: "Phone", type: .builtInReceiver)]
        next.updateCall(call, active: true)
        await Task.yield()
        XCTAssertEqual(session.overrides.count, changes)
        XCTAssertEqual(session.currentOutputs.first?.type, .builtInReceiver)
    }

    func testCallPreemptsSetupAndLateCloseCannotDeactivateCall() async throws {
        let (session, _, owner, _) = try fixture()
        let setup = try await owner.beginSetup()
        let test = try await owner.beginTest()
        var stops = 0; owner.stopTests = { stops += 1 }
        owner.prepareCall(); owner.updateCall(UUID(), active: true)
        let deactivations = session.deactivationCount
        owner.endTest(test); owner.closeSetup(setup)
        XCTAssertEqual(session.deactivationCount, deactivations)
        XCTAssertEqual(deactivations, 1)
        XCTAssertTrue(owner.hasRoute)
        XCTAssertGreaterThanOrEqual(stops, 1)
        do { _ = try await owner.beginTest(); XCTFail("Tone must not run during call") }
        catch { XCTAssertEqual((error as? DeviceCommandError)?.code, "BUSY") }
    }

    func testSetupDuringCallBorrowsAudioAndDoesNotDeactivateIt() async throws {
        let (session, _, owner, _) = try fixture()
        owner.prepareCall(); owner.updateCall(UUID(), active: true)
        await Task.yield()
        let setup = try await owner.beginSetup()
        owner.closeSetup(setup)
        XCTAssertEqual(session.activationCount, 0)
        XCTAssertEqual(session.deactivationCount, 0)
        XCTAssertTrue(owner.hasRoute)
    }

    func testPermissionDenialDoesNotActivateOrChangePreference() async throws {
        let (session, devices, owner, _) = try fixture()
        session.permission = false
        do { _ = try await owner.beginSetup(); XCTFail("Permission denied") }
        catch { XCTAssertEqual((error as? DeviceCommandError)?.code, "PERMISSION_DENIED") }
        XCTAssertEqual(session.activationCount, 0)
        XCTAssertEqual(devices.preference(active: false)["mode"] as? String, "system")
    }

    func testIncomingWhilePermissionPromptIsPendingPreventsLateActivation() async throws {
        let (session, _, owner, _) = try fixture()
        session.waitForPermission = true
        let pending = Task { @MainActor in try await owner.beginSetup() }
        for _ in 0..<100 where session.permissionGate == nil { await Task.yield() }
        XCTAssertNotNil(session.permissionGate)
        owner.prepareCall()
        session.permissionGate?.resume(returning: true)
        do { _ = try await pending.value; XCTFail("Old setup must be cancelled") }
        catch { XCTAssertEqual((error as? DeviceCommandError)?.code, "CANCELLED") }
        XCTAssertEqual(session.activationCount, 0)
        XCTAssertEqual(session.deactivationCount, 0)
    }

    func testFailedSelectionDoesNotPersistAndSystemChoiceClearsPreference() async throws {
        let (session, devices, owner, _) = try fixture()
        let setup = try await owner.beginSetup()
        session.immediateRoute = false
        do { try await owner.select(id(devices, "speaker"), save: true); XCTFail("Route not confirmed") }
        catch { XCTAssertEqual((error as? DeviceCommandError)?.code, "DEVICE_UNAVAILABLE") }
        XCTAssertEqual(devices.preference(active: true)["mode"] as? String, "system")
        session.immediateRoute = true
        try await owner.select(id(devices, "speaker"), save: true)
        try await owner.select(nil, save: true)
        XCTAssertEqual(devices.preference(active: true)["mode"] as? String, "system")
        owner.closeSetup(setup)
    }

    func testMissingSavedAccessoryFallsBackAndDoesNotBlockCall() async throws {
        let (session, devices, owner, _) = try fixture()
        let setup = try await owner.beginSetup()
        try await owner.select(id(devices, "bluetooth"), save: true)
        owner.closeSetup(setup)
        session.inputs = [session.mic]
        let fallback = expectation(description: "fallback keeps the call usable")
        var seen = false
        owner.changed = { [weak owner] in
            if let owner, owner.hasCall && owner.hasRoute && !owner.selecting && !seen,
               session.currentOutputs.first?.type == .builtInReceiver {
                seen = true; fallback.fulfill()
            }
        }
        owner.prepareCall(); owner.updateCall(UUID(), active: true)
        await fulfillment(of: [fallback], timeout: 2)
        XCTAssertTrue(owner.hasRoute)
        XCTAssertEqual(devices.preference(active: true)["availability"] as? String, "unavailable")
    }
    func testEndingCallRetainsPriorityUntilCallKitDeactivates() async throws {
        let (session, _, owner, _) = try fixture()
        owner.prepareCall(); owner.updateCall(UUID(), active: true)
        owner.updateCall(nil, active: true)
        do { _ = try await owner.beginSetup(); XCTFail("CallKit has not deactivated yet") }
        catch { XCTAssertEqual((error as? DeviceCommandError)?.code, "BUSY") }
        XCTAssertEqual(session.activationCount, 0)
        owner.updateCall(nil, active: false)
        let setup = try await owner.beginSetup()
        XCTAssertEqual(session.activationCount, 1)
        owner.closeSetup(setup)
    }

    func testBackgroundAndInterruptionReleaseSetupWithoutResuming() async throws {
        for name in [UIApplication.didEnterBackgroundNotification, AVAudioSession.interruptionNotification] {
            let (session, _, owner, _) = try fixture()
            let setup = try await owner.beginSetup()
            let released = expectation(description: "test lease released")
            var seen = false
            owner.changed = { [weak owner] in
                if let owner, !owner.hasRoute, !seen { seen = true; released.fulfill() }
            }
            NotificationCenter.default.post(name: name, object: nil)
            await fulfillment(of: [released], timeout: 2)
            XCTAssertEqual(session.deactivationCount, 1)
            owner.closeSetup(setup)
            XCTAssertEqual(session.deactivationCount, 1)
            XCTAssertEqual(session.activationCount, 1)
        }
    }

    func testExplicitCallSelectionSupersedesQueuedInitialPreference() async throws {
        let (session, devices, owner, _) = try fixture()
        let setup = try await owner.beginSetup()
        try await owner.select(id(devices, "speaker"), save: true)
        owner.closeSetup(setup)
        owner.prepareCall(); owner.updateCall(UUID(), active: true)
        try await owner.select(id(devices, "receiver"), save: false)
        await Task.yield()
        XCTAssertEqual(session.currentOutputs.first?.type, .builtInReceiver)
        XCTAssertEqual(devices.preference(active: true)["kind"] as? String, "speaker")
    }

}
