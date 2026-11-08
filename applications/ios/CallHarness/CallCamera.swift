import GChatCore
import SwiftUI
import UIKit

/// Uses the same native staging/commit implementation as the application, without a WebView.
@MainActor final class HarnessCameraFiles: NativeMediaFiles {
    private let files = DeviceFiles()
    private let queue = DispatchQueue(label:"gchat.harness.camera.files",qos:.userInitiated)
    private func work<T>(_ operation:@escaping (DeviceFiles)throws->T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in queue.async { [files] in continuation.resume(with:Result { try operation(files) }) } }
    }
    func createCapture(extension suffix:String) async throws -> URL { try await work { try $0.createCapture(extension:suffix) } }
    func commitCapture(_ url:URL) async throws -> [String:Any] { try await work { try $0.commitCapture(url) } }
    func abortCapture(_ url:URL) async { _ = try? await work { $0.abortCapture(url) } }
    func disposeDocument() async { _ = try? await work { $0.reset() } }
}

struct CallCameraPreview: UIViewRepresentable {
    let camera: NativeMediaController
    func makeUIView(context:Context) -> UIView { UIView() }
    func updateUIView(_ view:UIView,context:Context) { camera.bindNativePreview(view) }
}
