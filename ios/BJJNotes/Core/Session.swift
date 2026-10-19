import Foundation

/**
 The web app's sign-in, shared with the app's own requests. You sign in once in the web app inside
 BJJ Notes; its session cookie is copied here, and Siri, sync and the share sheet send it with their
 requests. The server keeps a session alive for 90 days from its last use, so regular use keeps it
 signed in.
 */
enum Session {
    private static let account = "session"

    static var token: String? { Keychain.read(account) }

    /// Keeps the newest sign-in. An empty or missing cookie is ignored rather than clearing the saved
    /// one: a signed-out session simply stops working, and the next sign-in replaces it.
    static func remember(_ token: String?) {
        guard let token, !token.isEmpty, token != Keychain.read(account, sharedOnly: true) else { return }
        Keychain.write(token, for: account)
    }

    /// Versions before the share sheet kept the sign-in where only the app could see it; move it.
    static func shareWithExtension() {
        if Keychain.read(account, sharedOnly: true) == nil, let token = Keychain.read(account) {
            Keychain.write(token, for: account)
        }
    }
}
