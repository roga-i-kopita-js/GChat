import UIKit
import GChatCore

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        if let response = connectionOptions.notificationResponse { ChatNotifications.shared.intent(response.notification.request.content.userInfo) }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = ShellViewController()
        self.window = window
        window.makeKeyAndVisible()
        #if DEBUG
        for context in connectionOptions.urlContexts {
            showLaunchSpikeReceipt(context.url, cold: true)
        }
        #endif
    }

    func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
        #if DEBUG
        for context in contexts { showLaunchSpikeReceipt(context.url, cold: false) }
        #endif
    }

    #if DEBUG
    private func showLaunchSpikeReceipt(_ url: URL, cold: Bool) {
        guard url.absoluteString == "gchat-launch-spike://open", let window else { return }
        window.viewWithTag(71403)?.removeFromSuperview()
        let receipt = UIButton(type: .system)
        receipt.tag = 71403
        receipt.accessibilityIdentifier = "gchat.launch-spike.received"
        receipt.setTitle(cold ? "Ссылка получена: холодный запуск. Закрыть" : "Ссылка получена: повторный запуск. Закрыть", for: .normal)
        receipt.titleLabel?.numberOfLines = 0
        receipt.titleLabel?.textAlignment = .center
        receipt.backgroundColor = .systemGreen
        receipt.setTitleColor(.black, for: .normal)
        receipt.layer.cornerRadius = 12
        receipt.addAction(UIAction { [weak receipt] _ in receipt?.removeFromSuperview() }, for: .touchUpInside)
        receipt.translatesAutoresizingMaskIntoConstraints = false
        window.addSubview(receipt)
        NSLayoutConstraint.activate([
            receipt.topAnchor.constraint(equalTo: window.safeAreaLayoutGuide.topAnchor, constant: 12),
            receipt.leadingAnchor.constraint(equalTo: window.leadingAnchor, constant: 16),
            receipt.trailingAnchor.constraint(equalTo: window.trailingAnchor, constant: -16),
            receipt.heightAnchor.constraint(greaterThanOrEqualToConstant: 64)
        ])
    }
    #endif
}

/// Owns native configuration and session independently of either WebView.
final class ShellViewController: UIViewController {
    private var child: UIViewController?
    private let serverKey = "gchat.server.v1"
    private var transport: SharedWebSocket?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        if let saved = UserDefaults.standard.string(forKey: serverKey),
           let server = try? ServerOrigin(saved) {
            open(server)
        } else {
            selectServer()
        }
    }

    private func open(_ server: ServerOrigin) {
        UserDefaults.standard.set(server.url.absoluteString, forKey: serverKey)
        let manager = SessionManager(
            server: server,
            storage: KeychainSessionStorage(service: Bundle.main.bundleIdentifier! + ".auth"),
            transport: HTTPAuthTransport(),
            onClear: { session in
                guard let account = session.accountID else { return }
                try await MainActor.run { try ChatLocalStorage.forServer(session.server).purge(account: account) }
            }
        )
        let deviceKey = "gchat.device.v1." + server.url.absoluteString
        let transport = SharedWebSocket(
            server: server,
            access: { force in try await manager.restore(force: force)?.tokens.access_token },
            readDevice: { UserDefaults.standard.string(forKey: deviceKey + "." + $0) },
            saveDevice: { sessionID, deviceID in UserDefaults.standard.set(deviceID, forKey: deviceKey + "." + sessionID) }
        )
        self.transport?.stop()
        self.transport = transport
        // Restore native connectivity even when the remote Web cannot load.
        Task { @MainActor in
            transport.onInvalidSession = {
                Task { try? await manager.invalidate() }
            }
            if let session = try? await manager.restore(), let id = session.sessionID {
                transport.start(sessionID: id)
            }
        }
        let main = MainViewController(server: server, sessions: manager, transport: transport)
        main.onChangeServer = { [weak self] in
            guard let self else { return }
            UserDefaults.standard.removeObject(forKey: self.serverKey)
            self.selectServer()
        }
        show(main)
    }

    private func selectServer() {
        transport?.stop()
        transport = nil
        let startup = ServerViewController()
        startup.onSelect = { [weak self] server in self?.open(server) }
        show(startup)
    }

    private func show(_ controller: UIViewController) {
        child?.willMove(toParent: nil)
        child?.view.removeFromSuperview()
        child?.removeFromParent()
        addChild(controller)
        controller.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(controller.view)
        NSLayoutConstraint.activate([
            controller.view.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            controller.view.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            controller.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            controller.view.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        controller.didMove(toParent: self)
        child = controller
    }
}
