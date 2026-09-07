import UIKit
import SafariServices
import WebKit

// One screen: the bundled web app in a WKWebView on the fixed custom-scheme
// origin. Full bleed on purpose: the page lays itself out with
// env(safe-area-inset-*) everywhere, so the map runs under the notch and
// the home indicator the way it does on Android.
final class ViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private var webView: WKWebView!

    // The app's own dark background, behind launch and overscroll alike.
    private static let appBackground = UIColor(
        red: 0x0A / 255.0, green: 0x0D / 255.0, blue: 0x14 / 255.0, alpha: 1)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.appBackground

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(AppSchemeHandler(), forURLScheme: AppSchemeHandler.scheme)
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = Self.appBackground
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // A long-press preview renders the linked page in-process, skipping
        // decidePolicyFor entirely; with previews off, the policy below is
        // the only way out of the bundle.
        webView.allowsLinkPreview = false
        applyPageZoom()
        // The system text-size setting reaches web content the way Android's
        // textZoom does, and it follows live changes, not just launch.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(applyPageZoom),
            name: UIContentSizeCategory.didChangeNotification,
            object: nil)

        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        webView.load(URLRequest(url: AppSchemeHandler.start))
    }

    @objc private func applyPageZoom() {
        webView.pageZoom = UIFontMetrics(forTextStyle: .body).scaledValue(for: 17) / 17
    }

    // Mirrors the Android wrapper's rule. The web view only ever navigates
    // inside the bundled app. A starlingmap.app link CARRYING A FRAGMENT is
    // a deep link (an invite, a help beacon) and stays internal, handed to
    // the live page as a hash change; a bare site link is a trip to the
    // website, which is a different thing from the app and belongs in the
    // system browser view. Everything else goes there too, gesture-gated.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if url.scheme == AppSchemeHandler.scheme {
            decisionHandler(.allow)
            return
        }
        if url.scheme == "https", url.host == "starlingmap.app",
           let fragment = url.fragment, !fragment.isEmpty {
            // JSON-quote the fragment so it lands in the page as data, not
            // as script, exactly like the Android wrapper's JSONObject.quote.
            if let data = try? JSONSerialization.data(
                   withJSONObject: "#" + fragment, options: .fragmentsAllowed),
               let quoted = String(data: data, encoding: .utf8) {
                webView.evaluateJavaScript("location.hash = \(quoted)")
            }
            decisionHandler(.cancel)
            return
        }
        if url.scheme == "https",
           navigationAction.targetFrame?.isMainFrame != false,
           navigationAction.navigationType == .linkActivated {
            present(SFSafariViewController(url: url), animated: true)
        }
        // mailto: and tel: have no in-app rendering; the system apps take
        // them, still only from a real link tap.
        if let scheme = url.scheme, ["mailto", "tel"].contains(scheme),
           navigationAction.navigationType == .linkActivated {
            UIApplication.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    // window.open / target=_blank from the page: same rule as main-frame
    // navigations, including the link-tap gate, and no new web view.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url, url.scheme == "https",
           navigationAction.navigationType == .linkActivated {
            present(SFSafariViewController(url: url), animated: true)
        }
        return nil
    }
}
