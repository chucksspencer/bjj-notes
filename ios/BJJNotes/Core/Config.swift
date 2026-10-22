import Foundation

enum Config {
    /// The BJJ Notes server, set at build time (BJJ_SERVER_URL in project.yml).
    static let serverURL: URL = {
        if let value = Bundle.main.object(forInfoDictionaryKey: "BJJServerURL") as? String,
           let url = URL(string: value), url.scheme == "https" || url.scheme == "http" {
            return url
        }
        return URL(string: "https://bjjnotes.chuckspencer.com")!
    }()

    /// The web app's sign-in cookie. The app reuses it for its own requests.
    static let sessionCookieName = "bjj_session"
    /// Writes signed in with the cookie must carry this header (the server's CSRF check).
    static let appHeader = "x-bjj-app"
    /// Background refresh that sends notes saved while offline.
    static let syncTaskID = "com.chucksspencer.bjjnotes.sync"
}
