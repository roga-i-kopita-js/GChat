import UIKit
import AVKit
import AVFoundation
import GChatCore

/// Route selection stays in the system UI; no audio category or mode is changed here.
@MainActor final class NativeAudioRoutePicker: UIViewController, @preconcurrency AVRoutePickerViewDelegate, UIAdaptivePresentationControllerDelegate {
    var completed: ((Result<Bool,Error>) -> Void)?
    var allowsBuiltIn: (() -> Bool)?
    private var requested: AVAudioSession.Port?
    private let initial = AVAudioSession.sharedInstance().currentRoute.outputs.map(\.uid)
    private var changed = false
    private var presentingRoutes = false
    private var observer: NSObjectProtocol?
    private var timeout: Task<Void, Never>?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let title = UILabel(); title.text = "Аудиовыход"; title.font = .preferredFont(forTextStyle: .headline)
        let note = UILabel(); note.text = "Выберите выход в системном меню."; note.numberOfLines = 0
        let routes = AVRoutePickerView(); routes.delegate = self; routes.prioritizesVideoDevices = false
        routes.heightAnchor.constraint(equalToConstant: 60).isActive = true
        let cancel = UIButton(type:.system); cancel.setTitle("Отмена",for:.normal); cancel.addTarget(self,action:#selector(cancelled),for:.touchUpInside)
        let stack = UIStackView(arrangedSubviews:[title,note,routes,cancel]); stack.axis = .vertical; stack.spacing = 20; stack.translatesAutoresizingMaskIntoConstraints = false
        if allowsBuiltIn?() == true {
            for (label,action) in [("Динамик",#selector(speaker)),("Телефон",#selector(receiver))] {
                let button = UIButton(type:.system); button.setTitle(label,for:.normal); button.addTarget(self,action:action,for:.touchUpInside)
                stack.insertArrangedSubview(button,at:2)
            }
        }
        view.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo:view.safeAreaLayoutGuide.leadingAnchor,constant:24),stack.trailingAnchor.constraint(equalTo:view.safeAreaLayoutGuide.trailingAnchor,constant:-24),stack.topAnchor.constraint(equalTo:view.safeAreaLayoutGuide.topAnchor,constant:24)])
        observer = NotificationCenter.default.addObserver(forName:AVAudioSession.routeChangeNotification,object:nil,queue:.main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.changed = AVAudioSession.sharedInstance().currentRoute.outputs.map(\.uid) != self.initial
                if let requested = self.requested {
                    if AVAudioSession.sharedInstance().currentRoute.outputs.contains(where:{$0.portType == requested}) { self.finish(.success(true)) }
                } else if self.changed && !self.presentingRoutes { self.finish(.success(true)) }
            }
        }
    }

    deinit { if let observer { NotificationCenter.default.removeObserver(observer) }; timeout?.cancel() }
    @objc private func cancelled() { finish(.success(false)) }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish(.success(false)) }
    func routePickerViewWillBeginPresentingRoutes(_ routePickerView: AVRoutePickerView) { presentingRoutes = true }
    func routePickerViewDidEndPresentingRoutes(_ routePickerView: AVRoutePickerView) {
        presentingRoutes = false
        if changed { finish(.success(true)); return }
        // A route-change notification can follow dismissal. Waiting starts after the chooser closes.
        timeout?.cancel()
        timeout = Task { @MainActor in
            do { try await Task.sleep(nanoseconds:5_000_000_000); self.finish(.success(false)) } catch {}
        }
    }
    @objc private func speaker() { selectBuiltIn(.builtInSpeaker) }
    @objc private func receiver() { selectBuiltIn(.builtInReceiver) }
    private func selectBuiltIn(_ port:AVAudioSession.Port) {
        guard allowsBuiltIn?() == true, AVAudioSession.sharedInstance().category == .playAndRecord else { finish(.failure(DeviceCommandError("INVALID_STATE"))); return }
        requested = port; timeout?.cancel()
        do { try AVAudioSession.sharedInstance().overrideOutputAudioPort(port == .builtInSpeaker ? .speaker : .none) }
        catch { finish(.failure(DeviceCommandError("DEVICE_UNAVAILABLE"))); return }
        if AVAudioSession.sharedInstance().currentRoute.outputs.contains(where:{$0.portType == port}) { finish(.success(true)); return }
        timeout = Task { @MainActor in
            do { try await Task.sleep(nanoseconds:5_000_000_000); self.finish(.failure(DeviceCommandError("DEVICE_UNAVAILABLE"))) } catch {}
        }
    }
    func finish(_ selected: Result<Bool,Error>) {
        guard let callback = completed else { return }
        completed = nil; timeout?.cancel(); timeout = nil
        if let observer { NotificationCenter.default.removeObserver(observer); self.observer = nil }
        dismiss(animated:true); callback(selected)
    }
}
