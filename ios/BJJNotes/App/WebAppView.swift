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

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKHTTPCookieStoreObserver {
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

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url, let scheme = url.scheme?.lowercased() else {
                decisionHandler(.allow)
                return
            }
            if ["about", "blob", "data"].contains(scheme) {
                decisionHandler(.allow)
                return
            }
            let mainFrame = action.targetFrame?.isMainFrame ?? true
            let ours = url.host == Config.serverURL.host
            if !["http", "https"].contains(scheme) || (mainFrame && !ours) {
                // Instagram, YouTube and the like open in their own apps.
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        /// target="_blank" links: open outside the app rather than in a new web view.
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = navigationAction.request.url { UIApplication.shared.open(url) }
            return nil
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
