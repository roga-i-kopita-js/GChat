import UIKit
import Capacitor
import GChatCore
import WebKit

/// Remote loading is a spike implementation; Simulator/device acceptance remains mandatory.
final class MainViewController: CAPBridgeViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    let server: ServerOrigin
    let sessions: SessionManager
    let transport: SharedWebSocket
    let calls: NativeCallsCoordinator
    var onChangeServer: (() -> Void)?
    private var capacitorDelegate: WebViewDelegationHandler?
    private var plugin: GChatPlugin?
    private var retryView: UIView?
    private lazy var callControls = NativeCallControls(calls: calls, presenter: self)

    init(server: ServerOrigin, sessions: SessionManager, transport: SharedWebSocket, calls: NativeCallsCoordinator) {
        self.server = server
        self.sessions = sessions
        self.transport = transport
        self.calls = calls
        super.init(nibName: nil, bundle: nil)
        calls.onChange = { [weak self] in self?.callsChanged() }
        calls.onError = { [weak self] message in
            guard let self, self.isViewLoaded else { return }
            self.callControls.showError(message)
        }
    }

    required init?(coder: NSCoder) { fatalError("Use init(server:sessions:)") }

    override func willMove(toParent parent: UIViewController?) {
        if parent == nil { plugin?.invalidateCycle() }
        super.willMove(toParent: parent)
    }

    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = InstanceDescriptor(
            at: Bundle.main.bundleURL.appendingPathComponent("public"),
            configuration: Bundle.main.url(forResource: "capacitor.config", withExtension: "json"),
            cordovaConfiguration: nil
        )
        descriptor.serverURL = server.launchURL.absoluteString
        descriptor.loggingBehavior = .none
        descriptor.allowLinkPreviews = false
        descriptor.isWebDebuggable = false
        return descriptor
    }

    override func capacitorDidLoad() {
        guard let bridge, let webView else { return }
        capacitorDelegate = webView.navigationDelegate as? WebViewDelegationHandler
        webView.navigationDelegate = self
        webView.uiDelegate = self
        let content = webView.configuration.userContentController
        content.removeScriptMessageHandler(forName: "bridge")
        content.add(WeakMessageHandler(self), name: "bridge")
        content.addUserScript(WKUserScript(source: "window.GChatRuntime = 'native';",
                                           injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let plugin = GChatPlugin(server: server, sessions: sessions, transport: transport, calls: calls)
        self.plugin = plugin
        bridge.registerPluginInstance(plugin)
        callsChanged()
    }

    func callsChanged() {
        guard isViewLoaded else { return }
        plugin?.publishCalls()
        callControls.update()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        calls.foreground()
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // Gate before Capacitor dispatch: CAPPluginCall does not expose the originating frame.
        guard message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url, server.allowsDocument(url),
              let current = webView?.url, server.allowsDocument(current),
              let body = message.body as? [String: Any],
              body["type"] as? String == "message", body["pluginId"] as? String == "GChat" else { return }
        capacitorDelegate?.userContentController(controller, didReceive: message)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard action.targetFrame?.isMainFrame == true, let url = action.request.url,
              server.allowsDocument(url) else { decisionHandler(.cancel); return }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard response.isForMainFrame, let url = response.response.url,
              server.allowsDocument(url), response.canShowMIMEType,
              response.response.mimeType == "text/html",
              (response.response as? HTTPURLResponse)?.statusCode == 200 else {
            decisionHandler(.cancel)
            showRetry()
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        plugin?.invalidateCycle()
        capacitorDelegate?.webView(webView, didStartProvisionalNavigation: navigation)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        retryView?.removeFromSuperview()
        retryView = nil
        capacitorDelegate?.webView(webView, didFinish: navigation)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { showRetry() }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { showRetry() }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        plugin?.invalidateCycle()
        webView.load(URLRequest(url: server.launchURL))
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) { decisionHandler(.deny) }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        // Capacitor probes its optional HTTP/cookie interceptors synchronously.
        // Web uses ordinary same-origin fetch; neither interceptor is exposed.
        guard frame.isMainFrame, let url = frame.request.url, server.allowsDocument(url),
              let data = prompt.data(using: .utf8),
              let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = body["type"] as? String,
              ["CapacitorCookies.isEnabled", "CapacitorHttp.isEnabled"].contains(type) else {
            completionHandler(nil)
            return
        }
        completionHandler("false")
    }

    private func showRetry() {
        guard retryView == nil else { return }
        plugin?.invalidateCycle()
        let label = UILabel()
        label.text = "Не удалось загрузить GChat. Проверьте подключение и адрес сервера."
        label.numberOfLines = 0
        label.textAlignment = .center
        let button = UIButton(type: .system)
        button.setTitle("Повторить", for: .normal)
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        button.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.retryView?.removeFromSuperview()
            self.retryView = nil
            self.webView?.load(URLRequest(url: self.server.launchURL))
        }, for: .touchUpInside)
        let change = UIButton(type: .system)
        change.setTitle("Изменить адрес сервера", for: .normal)
        change.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        change.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in
                do {
                    try await self.sessions.prepareServerChange()
                    self.onChangeServer?()
                } catch {
                    label.text = "Для смены сервера сначала выйдите из аккаунта. Если сессия недоступна, повторите загрузку."
                }
            }
        }, for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [label, button, change])
        stack.axis = .vertical
        stack.spacing = 16
        stack.backgroundColor = .systemBackground
        stack.isLayoutMarginsRelativeArrangement = true
        stack.layoutMargins = UIEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let overlay = UIView()
        overlay.backgroundColor = .systemBackground
        overlay.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(overlay)
        overlay.addSubview(stack)
        NSLayoutConstraint.activate([
            overlay.topAnchor.constraint(equalTo: view.topAnchor),
            overlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            overlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: overlay.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: overlay.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: overlay.trailingAnchor)
        ])
        retryView = overlay
    }
}
