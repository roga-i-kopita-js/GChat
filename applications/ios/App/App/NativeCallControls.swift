import UIKit
import GChatCore

/// Foreground call controls; audio and the call itself are owned by the shell.
@MainActor final class NativeCallControls: NSObject, UIAdaptivePresentationControllerDelegate {
    private weak var presenter: UIViewController?
    private let calls: NativeCallsCoordinator
    private let button = UIButton(type: .system)
    private var panel: NativeCallPanel?
    private var autoPresented: UUID?

    init(calls: NativeCallsCoordinator, presenter: UIViewController) {
        self.calls = calls; self.presenter = presenter
        super.init()
        var configuration = UIButton.Configuration.filled()
        configuration.cornerStyle = .capsule
        configuration.image = UIImage(systemName: "phone.fill")
        configuration.imagePadding = 8
        button.configuration = configuration
        button.accessibilityIdentifier = "gchat.native-call-controls"
        button.isHidden = true
        button.addAction(UIAction { [weak self] _ in self?.show() }, for: .touchUpInside)
        button.translatesAutoresizingMaskIntoConstraints = false
        presenter.view.addSubview(button)
        NSLayoutConstraint.activate([
            button.topAnchor.constraint(equalTo: presenter.view.safeAreaLayoutGuide.topAnchor, constant: 8),
            button.trailingAnchor.constraint(equalTo: presenter.view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            button.leadingAnchor.constraint(greaterThanOrEqualTo: presenter.view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44)
        ])
    }

    func update() {
        button.isHidden = !calls.hasLocalCall
        button.configuration?.title = calls.incoming ? "Входящий звонок" : "Управление звонком"
        presenter?.view.bringSubviewToFront(button)
        panel?.refresh()
        guard calls.hasLocalCall else {
            panel?.dismiss(animated: true); panel = nil
            return
        }
        if calls.incoming, autoPresented != calls.call?.call_id,
           UIApplication.shared.applicationState == .active {
            show()
        }
    }

    private func show() {
        guard panel == nil, calls.hasLocalCall, UIApplication.shared.applicationState == .active,
              var host = presenter, host.viewIfLoaded?.window != nil else { return }
        while let next = host.presentedViewController { host = next }
        guard !host.isBeingDismissed, !host.isBeingPresented else { return }
        let panel = NativeCallPanel(calls: calls)
        panel.onClose = { [weak self, weak panel] in panel?.dismiss(animated: true); self?.panel = nil }
        panel.modalPresentationStyle = .pageSheet
        panel.sheetPresentationController?.detents = [.medium()]
        panel.sheetPresentationController?.prefersGrabberVisible = true
        self.panel = panel
        host.present(panel, animated: true)
        panel.presentationController?.delegate = self
        autoPresented = calls.call?.call_id
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { panel = nil }

    func showError(_ message: String) {
        guard UIApplication.shared.applicationState == .active, var host = presenter,
              host.viewIfLoaded?.window != nil else { return }
        while let next = host.presentedViewController { host = next }
        guard !(host is UIAlertController), !host.isBeingDismissed else { return }
        let alert = UIAlertController(title: "Звонок", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "ОК", style: .default))
        host.present(alert, animated: true)
    }
}

@MainActor private final class NativeCallPanel: UIViewController {
    var onClose: (() -> Void)?
    private let calls: NativeCallsCoordinator
    private let titleLabel = UILabel()
    private let statusLabel = UILabel()
    private let answer = UIButton(type: .system)
    private let mute = UIButton(type: .system)
    private let end = UIButton(type: .system)
    private var working = false

    init(calls: NativeCallsCoordinator) { self.calls = calls; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("Use init(calls:)") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        titleLabel.font = .preferredFont(forTextStyle: .title2)
        titleLabel.textAlignment = .center
        statusLabel.font = .preferredFont(forTextStyle: .body)
        statusLabel.textColor = .secondaryLabel
        statusLabel.textAlignment = .center
        for button in [answer, mute, end] {
            button.configuration = .tinted()
            button.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
        }
        end.tintColor = .systemRed
        answer.accessibilityIdentifier = "gchat.native-call-answer"
        end.accessibilityIdentifier = "gchat.native-call-end"
        mute.accessibilityIdentifier = "gchat.native-call-mute"
        answer.addAction(UIAction { [weak self] _ in self?.perform { [calls = self?.calls] in try await calls?.answer() } }, for: .touchUpInside)
        end.addAction(UIAction { [weak self] _ in self?.perform { [calls = self?.calls] in try await calls?.end() } }, for: .touchUpInside)
        mute.addAction(UIAction { [weak self] _ in self?.perform { [calls = self?.calls] in try await calls?.toggleMute() } }, for: .touchUpInside)
        let close = UIButton(type: .system)
        close.setTitle("Свернуть", for: .normal)
        close.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        close.addAction(UIAction { [weak self] _ in self?.onClose?() }, for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [titleLabel, statusLabel, answer, mute, end, close])
        stack.axis = .vertical; stack.spacing = 12; stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16)
        ])
        refresh()
    }

    func refresh() {
        guard isViewLoaded else { return }
        titleLabel.text = calls.incoming ? "Входящий звонок" : "Звонок GChat"
        if calls.call?.recovery_id != nil { statusLabel.text = "Восстанавливаем соединение…" }
        else {
            switch calls.phase {
            case .ringing: statusLabel.text = calls.incoming ? "Ответить на вызов?" : "Вызываем…"
            case .connecting: statusLabel.text = "Соединяем…"
            case .active: statusLabel.text = calls.connected ? "Разговор" : "Подключаем аудио…"
            default: statusLabel.text = "Звонок завершён"
            }
        }
        answer.setTitle("Ответить", for: .normal)
        answer.isHidden = !calls.incoming
        mute.setTitle(calls.muted ? "Включить микрофон" : "Выключить микрофон", for: .normal)
        mute.isHidden = calls.phase != .active && calls.phase != .connecting
        end.setTitle(calls.incoming ? "Отклонить" : "Завершить", for: .normal)
        for button in [answer, mute, end] { button.isEnabled = !working && calls.hasLocalCall }
    }

    private func perform(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !working else { return }
        working = true; refresh()
        Task { @MainActor [weak self] in
            do { try await operation() }
            catch {
                if let self, self.viewIfLoaded?.window != nil {
                    let alert = UIAlertController(title: "Звонок", message: "Не удалось выполнить действие. Проверьте соединение и разрешение микрофона.", preferredStyle: .alert)
                    alert.addAction(UIAlertAction(title: "ОК", style: .default))
                    self.present(alert, animated: true)
                }
            }
            self?.working = false; self?.refresh()
        }
    }
}
