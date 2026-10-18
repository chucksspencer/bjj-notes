import Foundation

/// A note saved on the phone that hasn't reached the server yet.
struct PendingNote: Codable, Identifiable, Equatable {
    /// Sent as the note's client id: a retry of the same note is recognised, never saved twice.
    let id: String
    let text: String
    /// "question" for Ask coach; nil lets the server decide.
    let kind: String?
    let starred: Bool
    /// The day it was captured (YYYY-MM-DD, local), so a note that waited overnight keeps its day.
    let date: String
    let createdAt: Date

    init(text: String, kind: String? = nil, starred: Bool = false, now: Date = Date(), id: String = UUID().uuidString) {
        self.id = id
        self.text = text
        self.kind = kind
        self.starred = starred
        self.date = PendingNote.day(now)
        self.createdAt = now
    }

    static func day(_ date: Date, timeZone: TimeZone = .current) -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = timeZone
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: date)
    }
}

/// Notes waiting to be sent, kept in a file so they survive the app being closed.
actor Outbox {
    static let shared = Outbox(fileURL: Outbox.defaultURL)

    struct FlushResult {
        /// Server replies for the notes that went through, by note id.
        var sent: [String: CaptureResponse] = [:]
        /// Notes the server refused for good (they won't be retried).
        var dropped: [PendingNote] = []
        /// Why sending stopped early, if it did; what's left stays queued.
        var stoppedBy: APIError?
    }

    private let fileURL: URL
    private var items: [PendingNote]
    private var flushing = false

    init(fileURL: URL) {
        self.fileURL = fileURL
        if let data = try? Data(contentsOf: fileURL), let saved = try? JSONDecoder().decode([PendingNote].self, from: data) {
            items = saved
        } else {
            items = []
        }
    }

    static var defaultURL: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return dir.appendingPathComponent("outbox.json")
    }

    var pending: [PendingNote] { items }
    var count: Int { items.count }

    func add(_ note: PendingNote) {
        items.append(note)
        persist()
    }

    private func remove(_ id: String) {
        items.removeAll { $0.id == id }
        persist()
    }

    private func persist() {
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(items).write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            // Keep going with what's in memory; the next change tries to write again.
        }
    }

    /// Sends waiting notes, `first` (if given) before the rest, oldest first after that.
    /// Stops at the first sign-in or connection problem and leaves the rest queued.
    func flush(first: String? = nil, send: (PendingNote) async throws -> CaptureResponse) async -> FlushResult {
        var result = FlushResult()
        guard !flushing else { return result }
        flushing = true
        defer { flushing = false }
        let ordered = items.filter { $0.id == first } + items.filter { $0.id != first }
        for note in ordered {
            do {
                let reply = try await send(note)
                remove(note.id)
                result.sent[note.id] = reply
            } catch let error as APIError where error.isPermanent {
                remove(note.id)
                result.dropped.append(note)
            } catch let error as APIError {
                result.stoppedBy = error
                return result
            } catch {
                result.stoppedBy = APIError(kind: .offline, message: error.localizedDescription)
                return result
            }
        }
        return result
    }
}
