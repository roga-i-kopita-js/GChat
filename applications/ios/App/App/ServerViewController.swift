import UIKit
import WebKit
import GChatCore

/// Bundled, offline bootstrap. It has no Capacitor bridge or auth capabilities.
final class ServerViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    var onSelect: ((ServerOrigin) -> Void)?
    private var webView: WKWebView!
    private let document = URL(string: "gchat-bootstrap://localhost/server")!

    override func viewDidLoad() {
        super.viewDidLoad()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(BootstrapAssets(), forURLScheme: "gchat-bootstrap")
        // A weak forwarding handler prevents a WebView/controller retain cycle.
        configuration.userContentController.add(WeakMessageHandler(self), name: "selectServer")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        view = webView
        webView.load(URLRequest(url: document))
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.request.url == document,
              let body = message.body as? [String: String], body.count == 1,
              let value = body["serverUrl"], let server = try? ServerOrigin(value) else {
            webView.evaluateJavaScript("window.serverSelectionFailed()", completionHandler: nil)
            return
        }
        onSelect?(server)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(action.targetFrame?.isMainFrame == true &&
                        action.request.url == document ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
}

private final class BootstrapAssets: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let files = ["/server": ("index", "html", "text/html"),
                     "/server.css": ("server", "css", "text/css"),
                     "/server.js": ("server", "js", "text/javascript")]
        guard let url = task.request.url, url.scheme == "gchat-bootstrap", url.host == "localhost",
              let file = files[url.path],
              let asset = Bundle.main.url(forResource: file.0, withExtension: file.1, subdirectory: "public"),
              let data = try? Data(contentsOf: asset) else {
            task.didFailWithError(NativeError.validation)
            return
        }
        task.didReceive(URLResponse(url: url, mimeType: file.2, expectedContentLength: data.count,
                                   textEncodingName: "utf-8"))
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
