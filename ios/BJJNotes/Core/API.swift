import Foundation

struct APIError: Error, LocalizedError, Equatable {
    enum Kind: Equatable {
        /// No sign-in on this phone yet, or it ran out: open the app and sign in.
        case notSignedIn
        /// No connection, or the server didn't answer in time.
        case offline
        /// The server answered with an error status.
        case server(Int)
    }

    let kind: Kind
    let message: String
    var errorDescription: String? { message }

    /// Retrying won't help (the note itself was refused), as opposed to a sign-in or connection problem.
    var isPermanent: Bool {
        if case .server(let code) = kind { return (400..<500).contains(code) && ![401, 403, 408, 429].contains(code) }
        return false
    }
}

/// The BJJ Notes JSON API, signed in with the web app's session.
final class API {
    static let shared = API()

    private let urlSession: URLSession
    private let token: () -> String?

    init(urlSession: URLSession = API.makeSession(), token: @escaping () -> String? = { Session.token }) {
        self.urlSession = urlSession
        self.token = token
    }

    static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        config.httpShouldSetCookies = false // the session cookie is added by hand below
        config.httpCookieStorage = nil
        return URLSession(configuration: config)
    }

    func capture(_ note: PendingNote, timeout: TimeInterval = 20) async throws -> CaptureResponse {
        let data = try JSONSerialization.data(withJSONObject: API.captureBody(note))
        // Stills make the request bigger; give slow connections longer.
        let limit = note.attachments?.isEmpty == false ? max(timeout, 30) : timeout
        return try await send(request("POST", "/api/v1/capture", body: data, timeout: limit), as: CaptureResponse.self)
    }

    /// The JSON for POST /api/v1/capture.
    static func captureBody(_ note: PendingNote) -> [String: Any] {
        var body: [String: Any] = ["text": note.text, "clientId": note.id, "date": note.date]
        if let kind = note.kind { body["kind"] = kind }
        if note.starred { body["starred"] = true }
        if let url = note.url { body["url"] = url }
        if let attachments = note.attachments, !attachments.isEmpty {
            let iso = ISO8601DateFormatter()
            body["attachments"] = attachments.map { a -> [String: Any] in
                var item: [String: Any] = ["kind": a.kind, "thumb": a.thumb.base64EncodedString()]
                if let v = a.photosLocalId { item["photosLocalId"] = v }
                if let v = a.photosCloudId { item["photosCloudId"] = v }
                if let v = a.filename { item["filename"] = v }
                if let v = a.takenAt { item["takenAt"] = iso.string(from: v) }
                if let v = a.durationS { item["durationS"] = v }
                if let v = a.width { item["width"] = v }
                if let v = a.height { item["height"] = v }
                return item
            }
        }
        return body
    }

    /// Records where a saved photo or video's original is in Photos.
    func linkAttachment(id: Int, localId: String, cloudId: String?) async throws {
        var body: [String: Any] = ["photosLocalId": localId]
        if let cloudId { body["photosCloudId"] = cloudId }
        let data = try JSONSerialization.data(withJSONObject: body)
        _ = try await send(request("PATCH", "/api/v1/attachments/\(id)", body: data, timeout: 15), as: LinkedAttachment.self)
    }

    private struct LinkedAttachment: Decodable {
        let id: Int
    }

    func focus(timeout: TimeInterval = 15) async throws -> FocusView {
        try await send(request("GET", "/api/v1/focus", timeout: timeout), as: FocusView.self)
    }

    func lab(timeout: TimeInterval = 15) async throws -> LabView {
        try await send(request("GET", "/api/v1/lab", timeout: timeout), as: LabView.self)
    }

    private func request(_ method: String, _ path: String, body: Data? = nil, timeout: TimeInterval) throws -> URLRequest {
        guard let token = token(), !token.isEmpty else {
            throw APIError(kind: .notSignedIn, message: "Open BJJ Notes and sign in first.")
        }
        guard let url = URL(string: path, relativeTo: Config.serverURL) else {
            throw APIError(kind: .server(0), message: "Bad address for BJJ Notes.")
        }
        var r = URLRequest(url: url, timeoutInterval: timeout)
        r.httpMethod = method
        r.setValue("\(Config.sessionCookieName)=\(token)", forHTTPHeaderField: "Cookie")
        r.setValue("1", forHTTPHeaderField: Config.appHeader)
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            r.httpBody = body
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return r
    }

    private struct ServerMessage: Decodable {
        let speech: String?
        let message: String?
    }

    private func send<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await urlSession.data(for: request)
        } catch {
            throw APIError(kind: .offline, message: "BJJ Notes can't be reached right now.")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 {
            throw APIError(kind: .notSignedIn, message: "Open BJJ Notes and sign in again.")
        }
        guard (200..<300).contains(status) else {
            let said = try? JSONDecoder().decode(ServerMessage.self, from: data)
            throw APIError(kind: .server(status), message: said?.speech ?? said?.message ?? "BJJ Notes had a problem (\(status)).")
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError(kind: .server(status), message: "BJJ Notes sent something unexpected.")
        }
    }
}
