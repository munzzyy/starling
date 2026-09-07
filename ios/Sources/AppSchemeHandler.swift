import WebKit

// Serves the bundled web app on starling://localhost the way the Android
// wrapper's WebViewAssetLoader serves it on appassets.androidplatform.net:
// every byte of the app itself comes out of the bundle. Relay traffic is the
// page's own fetch() to the canonical origin, governed by the page's CSP;
// this handler never proxies anything.
//
// The host string is load-bearing twice over. WebKit's secure-context check
// trusts any origin whose host is literally "localhost" regardless of
// scheme, and that trust is what turns on crypto.subtle for this page. And
// scheme+host is the storage origin: change either and every circle secret
// on every phone is silently orphaned. starling://localhost is permanent.
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "starling"
    static let host = "localhost"
    static let start = URL(string: "\(scheme)://\(host)/index.html")!

    private static let mime: [String: String] = [
        "html": "text/html; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "json": "application/json",
        "webmanifest": "application/manifest+json",
        "svg": "image/svg+xml",
        "png": "image/png",
        "ico": "image/x-icon",
        "txt": "text/plain; charset=utf-8",
        "xml": "application/xml",
        "map": "application/json",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "md": "text/markdown; charset=utf-8",
        "woff2": "font/woff2",
        "wasm": "application/wasm",
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.host == Self.host, url.port == nil,
              let base = Bundle.main.resourceURL?
                  .appendingPathComponent("app", isDirectory: true)
                  .standardizedFileURL
        else {
            task.didFailWithError(URLError(.unsupportedURL))
            return
        }
        var rel = url.path
        if rel.isEmpty || rel == "/" { rel = "/index.html" }
        let file = base.appendingPathComponent(String(rel.dropFirst())).standardizedFileURL
        // Resolve inside the bundled app directory only, on RESOLVED paths:
        // standardizedFileURL is lexical, and a symlink that slipped into the
        // bundle would otherwise walk the read outside it.
        guard file.resolvingSymlinksInPath().path
                  .hasPrefix(base.resolvingSymlinksInPath().path + "/"),
              let data = try? Data(contentsOf: file)
        else {
            respond(task, url: url, status: 404, mime: "text/plain; charset=utf-8", data: Data("not found".utf8))
            return
        }
        let ext = file.pathExtension.lowercased()
        respond(task, url: url, status: 200, mime: Self.mime[ext] ?? "application/octet-stream", data: data)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func respond(_ task: WKURLSchemeTask, url: URL, status: Int, mime: String, data: Data) {
        let headers = [
            "Content-Type": mime,
            "Content-Length": String(data.count),
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
        ]
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
            task.didFailWithError(URLError(.badServerResponse))
            return
        }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }
}
