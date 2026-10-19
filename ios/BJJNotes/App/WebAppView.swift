import SwiftUI
import UIKit
import WebKit

/**
 The BJJ Notes web app in a web view. Links to other sites (Instagram, YouTube) open in their own apps;
 embedded players still play inline. The web app's sign-in cookie is copied to the Keychain whenever
 it changes, so Siri and background sync are signed in too.
 */
struct WebAppView: UIViewRepresentable {
    /// Bump to load the app again (after it couldn't be reached).
    let reloads: Int
    @Binding var unreachable: Bool

    func makeCoordinator() -> Coordinator { Coordinator(unreachable: $unreachable) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.applicationNameForUserAgent = "BJJNotesApp/1.0"
        // The web app asks the app to open photos and videos from Photos (see web/src/components/Clips.tsx).
        config.userContentController.add(context.coordinator, name: "bjjNative")

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        web.isOpaque = false
        web.backgroundColor = UIColor(named: "Canvas")
        // The web app pads itself for the notch and home indicator (viewport-fit=cover).
        web.scrollView.contentInsetAdjustmentBehavior = .never

        let refresh = UIRefreshControl()
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.pulledToRefresh(_:)), for: .valueChanged)
        web.scrollView.refreshControl = refresh

        config.websiteDataStore.httpCookieStore.add(context.coordinator)
        context.coordinator.copySignIn(from: config.websiteDataStore.httpCookieStore)
        context.coordinator.reloads = reloads
        context.coordinator.web = web
        web.load(URLRequest(url: Config.serverURL))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        if context.coordinator.reloads != reloads {
            context.coordinator.reloads = reloads
            web.load(URLRequest(url: Config.serverURL))
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKHTTPCookieStoreObserver, WKScriptMessageHandler {
        @Binding var unreachable: Bool
        var reloads = 0
        weak var web: WKWebView?

        init(unreachable: Binding<Bool>) {
            _unreachable = unreachable
        }

        // MARK: Sign-in

        func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
            copySignIn(from: cookieStore)
        }

        func copySignIn(from store: WKHTTPCookieStore) {
            let host = Config.serverURL.host ?? ""
            store.getAllCookies { cookies in
                let session = cookies.first { cookie in
                    cookie.name == Config.sessionCookieName && host.hasSuffix(cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")))
                }
                Session.remember(session?.value)
            }
        }

        // MARK: Photos and videos

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            // Only the app's own pages may ask, and only to open a Photos item by its id.
            guard message.frameInfo.isMainFrame,
                  message.frameInfo.securityOrigin.host == Config.serverURL.host,
                  let body = message.body as? [String: Any], body["action"] as? String == "open",
                  let presenter = web?.window?.rootViewController?.topmostPresented
            else { return }
            let id = { (key: String) -> String? in
                guard let value = body[key] as? String, !value.isEmpty, value.count <= 600 else { return nil }
                return value
            }
            let localId = id("photosLocalId")
            let cloudId = id("photosCloudId")
            Task { @MainActor in
                await PhotosViewer.open(localId: localId, cloudId: cloudId, from: presenter)
            }
        }

        // MARK: Loading

        @objc func pulledToRefresh(_ sender: UIRefreshControl) {
            guard let web else {
                sender.endRefreshing()
                return
            }
            if web.url == nil { web.load(URLRequest(url: Config.serverURL)) } else { web.reload() }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.scrollView.refreshControl?.endRefreshing()
            unreachable = false
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            webView.scrollView.refreshControl?.endRefreshing()
            if (error as NSError).code != NSURLErrorCancelled { unreachable = true }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            webView.scrollView.refreshControl?.endRefreshing()
        }

        // MARK: Links

        /// Embedded players the web app may show (it loads them only when tapped).
        static let playerHosts: Set<String> = ["www.youtube-nocookie.com", "www.youtube.com", "www.instagram.com", "instagram.com"]

        /**
         What the web view may load. The page itself only ever comes from the BJJ Notes server; frames
         only from the server or the YouTube and Instagram players. Other web links open outside the app
         (Safari, or Instagram and YouTube through their links). Anything else, such as app-install
         (itms-services:) or other apps' URL schemes, is refused: even a compromised server can't use
         the app to hand the phone something to install.
         */
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url, let scheme = url.scheme?.lowercased() else {
                decisionHandler(.cancel)
                return
            }
            let mainFrame = action.targetFrame?.isMainFrame ?? true
            let host = url.host?.lowercased() ?? ""
            let ours = scheme == Config.serverURL.scheme && host == Config.serverURL.host?.lowercased()
            if ["about", "blob", "data"].contains(scheme) {
                decisionHandler(mainFrame ? .cancel : .allow)
                return
            }
            guard scheme == "https" || (scheme == "http" && ours) else {
                decisionHandler(.cancel)
                return
            }
            if ours || (!mainFrame && Coordinator.playerHosts.contains(host)) {
                decisionHandler(.allow)
                return
            }
            if mainFrame, action.navigationType == .linkActivated || action.navigationType == .other {
                Coordinator.openOutside(url)
            }
            decisionHandler(.cancel)
        }

        /// target="_blank" links: open outside the app rather than in a new web view.
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = navigationAction.request.url { Coordinator.openOutside(url) }
            return nil
        }

        /// Only ordinary web links leave the app; iOS sends Instagram and YouTube ones to their apps.
        static func openOutside(_ url: URL) {
            guard url.scheme?.lowercased() == "https" else { return }
            UIApplication.shared.open(url)
        }

        // The web app asks before deleting several things at once.
        func webView(
            _ webView: WKWebView,
            runJavaScriptConfirmPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping (Bool) -> Void
        ) {
            guard let presenter = webView.window?.rootViewController?.topmostPresented else {
                completionHandler(false)
                return
            }
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
            presenter.present(alert, animated: true)
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptAlertPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping () -> Void
        ) {
            guard let presenter = webView.window?.rootViewController?.topmostPresented else {
                completionHandler()
                return
            }
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            presenter.present(alert, animated: true)
        }
    }
}

private extension UIViewController {
    var topmostPresented: UIViewController {
        presentedViewController?.topmostPresented ?? self
    }
}
