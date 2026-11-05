import UIKit
import GChatCore

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = ShellViewController()
        self.window = window
        window.makeKeyAndVisible()
    }
}

/// Owns native configuration and session independently of either WebView.
final class ShellViewController: UIViewController {
    private var child: UIViewController?
    private let serverKey = "gchat.server.v1"

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
            transport: HTTPAuthTransport()
        )
        let main = MainViewController(server: server, sessions: manager)
        main.onChangeServer = { [weak self] in
            guard let self else { return }
            UserDefaults.standard.removeObject(forKey: self.serverKey)
            self.selectServer()
        }
        show(main)
    }

    private func selectServer() {
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
