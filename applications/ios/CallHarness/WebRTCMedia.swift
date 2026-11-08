import AVFoundation
import GChatCore
import WebRTC

@MainActor final class WebRTCMedia: NSObject, DirectCallMedia, RTCPeerConnectionDelegate, RTCAudioSessionDelegate {
    var onCandidate: ((DirectIceCandidate?) -> Void)?
    var onConnection: ((Bool) -> Void)?
    var onRouteChanged: (() -> Void)?
    private static let sslInitialized = RTCInitializeSSL()
    private let factory: RTCPeerConnectionFactory?
    private var peer: RTCPeerConnection?
    private var track: RTCAudioTrack?
    private var audioActive = false
    private var routeChanges = 0
    private var routeReason: UInt = 0
    private var audioEvents: [String] = []
    var connected: Bool { peer?.connectionState == .connected && audioActive }

    // Configure before reporting/starting the CallKit call. CallKit owns activation.
    func prepareAudio() throws {
        guard !audioActive else { throw NativeError.unavailable }
        recordAudioEvent("prepare begin " + Self.sessionDescription())
        let audio = RTCAudioSession.sharedInstance()
        audio.lockForConfiguration()
        defer { audio.unlockForConfiguration() }
        try audio.setConfiguration(RTCAudioSessionConfiguration.webRTC())
        recordAudioEvent("prepare end " + Self.sessionDescription())
    }

    override init() {
        factory = Self.sslInitialized ? RTCPeerConnectionFactory() : nil
        super.init()
        let audio = RTCAudioSession.sharedInstance()
        audio.useManualAudio = true
        audio.isAudioEnabled = false
        audio.add(self)
        NotificationCenter.default.addObserver(self, selector: #selector(routeChanged),
            name: AVAudioSession.routeChangeNotification, object: nil)
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    var speakerEnabled: Bool {
        AVAudioSession.sharedInstance().currentRoute.outputs.contains { $0.portType == .builtInSpeaker }
    }

    var outputRoute: String {
        AVAudioSession.sharedInstance().currentRoute.outputs.map { port in
            switch port.portType {
            case .builtInReceiver: return "разговорный динамик"
            case .builtInSpeaker: return "громкий динамик"
            case .headphones: return "наушники"
            case .bluetoothHFP, .bluetoothA2DP, .bluetoothLE: return "Bluetooth"
            default: return "другой выход"
            }
        }.joined(separator: ", ")
    }

    var routeDiagnostics: String {
        let session = AVAudioSession.sharedInstance()
        return "выход: \(outputRoute); category: \(session.category.rawValue); mode: \(session.mode.rawValue); options: \(session.categoryOptions.rawValue); volume: \(session.outputVolume); изменений: \(routeChanges); причина: \(routeReason)"
    }

    // Accessory names are for the local UI only; diagnostics use outputRoute.
    var outputDevice: String {
        AVAudioSession.sharedInstance().currentRoute.outputs.map { port in
            switch port.portType {
            case .builtInReceiver: return "iPhone — разговорный динамик"
            case .builtInSpeaker: return "Громкая связь"
            default: return port.portName
            }
        }.joined(separator: ", ")
    }

    var audioEventDiagnostics: String { audioEvents.joined(separator: "\n") }

    private nonisolated static func ports(_ route: AVAudioSessionRouteDescription) -> String {
        // Port types only: never accessory names, UIDs or network addresses.
        route.outputs.map { $0.portType.rawValue }.joined(separator: ",")
    }

    private nonisolated static func sessionDescription() -> String {
        let audio = AVAudioSession.sharedInstance()
        return "out=\(ports(audio.currentRoute)) category=\(audio.category.rawValue) mode=\(audio.mode.rawValue) options=\(audio.categoryOptions.rawValue) rate=\(audio.sampleRate) buffer=\(audio.ioBufferDuration)"
    }

    private func recordAudioEvent(_ event: String, at time: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        audioEvents.append(String(format: "%.3f", time) + " " + event)
        if audioEvents.count > 32 { audioEvents.removeFirst(audioEvents.count - 32) }
        onRouteChanged?()
    }

    private nonisolated func audioEvent(_ event: String) {
        let time = ProcessInfo.processInfo.systemUptime
        let snapshot = Self.sessionDescription()
        Task { @MainActor [weak self] in self?.recordAudioEvent(event + " " + snapshot, at: time) }
    }

    nonisolated func audioSession(_ session: RTCAudioSession, willSetActive active: Bool) {
        audioEvent("WebRTC willSetActive=\(active)")
    }

    nonisolated func audioSession(_ session: RTCAudioSession, didSetActive active: Bool) {
        audioEvent("WebRTC didSetActive=\(active)")
    }

    nonisolated func audioSessionDidStartPlayOrRecord(_ session: RTCAudioSession) {
        audioEvent("WebRTC startPlayOrRecord")
    }

    nonisolated func audioSessionDidStopPlayOrRecord(_ session: RTCAudioSession) {
        audioEvent("WebRTC stopPlayOrRecord")
    }

    @objc private nonisolated func routeChanged(_ notification: Notification) {
        let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
        let previous = notification.userInfo?[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription
        let event = "route reason=\(reason) previous=\(previous.map(Self.ports) ?? "none") " + Self.sessionDescription()
        let time = ProcessInfo.processInfo.systemUptime
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.routeChanges += 1
            self.routeReason = reason
            self.recordAudioEvent(event, at: time)
        }
    }

    func configure(servers: [DirectIceServer]) async throws {
        guard let factory else { throw NativeError.unavailable }
        let config = RTCConfiguration()
        config.iceTransportPolicy = .relay
        config.sdpSemantics = .unifiedPlan
        config.continualGatheringPolicy = .gatherContinually
        config.iceServers = servers.map { RTCIceServer(urlStrings: $0.urls, username: $0.username, credential: $0.credential) }
        if let peer {
            guard peer.setConfiguration(config) else { throw NativeError.unavailable }
            return
        }
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let connection = factory.peerConnection(with: config, constraints: constraints, delegate: self) else { throw NativeError.unavailable }
        peer = connection
        let source = factory.audioSource(with: constraints)
        let audioTrack = factory.audioTrack(with: source, trackId: "gchat-audio")
        track = audioTrack
        connection.add(audioTrack, streamIds: ["gchat"])
    }

    func offer(restart: Bool) async throws -> String {
        guard let peer, peer.signalingState == .stable else { throw NativeError.unavailable }
        let constraints = RTCMediaConstraints(mandatoryConstraints: ["IceRestart": restart ? "true" : "false"], optionalConstraints: nil)
        let sdp: RTCSessionDescription = try await withCheckedThrowingContinuation { continuation in
            peer.offer(for: constraints) { value, error in
                if let error { continuation.resume(throwing: error) }
                else if let value { continuation.resume(returning: value) }
                else { continuation.resume(throwing: NativeError.unavailable) }
            }
        }
        try await local(sdp, peer: peer)
        return sdp.sdp
    }

    func answer(offer: String) async throws -> String {
        guard let peer else { throw NativeError.unavailable }
        try await remote(RTCSessionDescription(type: .offer, sdp: offer), peer: peer)
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        let sdp: RTCSessionDescription = try await withCheckedThrowingContinuation { continuation in
            peer.answer(for: constraints) { value, error in
                if let error { continuation.resume(throwing: error) }
                else if let value { continuation.resume(returning: value) }
                else { continuation.resume(throwing: NativeError.unavailable) }
            }
        }
        try await local(sdp, peer: peer)
        return sdp.sdp
    }

    func applyAnswer(_ sdp: String) async throws {
        guard let peer else { throw NativeError.unavailable }
        try await remote(RTCSessionDescription(type: .answer, sdp: sdp), peer: peer)
    }

    private func local(_ sdp: RTCSessionDescription, peer: RTCPeerConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setLocalDescription(sdp) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    private func remote(_ sdp: RTCSessionDescription, peer: RTCPeerConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setRemoteDescription(sdp) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    func addCandidate(_ candidate: DirectIceCandidate) async throws {
        guard let peer else { throw NativeError.unavailable }
        // The harness negotiates one audio m-line; a mid-only candidate therefore has index zero.
        let value = RTCIceCandidate(sdp: candidate.candidate, sdpMLineIndex: candidate.sdp_mline_index ?? 0, sdpMid: candidate.sdp_mid)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.add(value) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    func setMuted(_ value: Bool) { track?.isEnabled = !value }

    func close() {
        let previous = peer
        peer = nil; track = nil
        previous?.close()
    }

    func audioActivated(_ active: Bool, session: AVAudioSession) {
        recordAudioEvent("CallKit active=\(active) " + Self.sessionDescription())
        let audio = RTCAudioSession.sharedInstance()
        if active { audio.audioSessionDidActivate(session) }
        else { audio.audioSessionDidDeactivate(session) }
        audio.isAudioEnabled = active
        audioActive = active
        onConnection?(connected)
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        Task { @MainActor [weak self] in
            guard let self, self.peer === peerConnection else { return }
            self.onCandidate?(DirectIceCandidate(candidate: candidate.sdp, mid: candidate.sdpMid, line: candidate.sdpMLineIndex))
        }
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        Task { @MainActor [weak self] in
            guard let self, self.peer === peerConnection else { return }
            self.onConnection?(self.connected)
        }
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
