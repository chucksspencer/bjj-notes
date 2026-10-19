import Foundation

/// A photo or video shared to the app: where the original is in Photos (once found), a few facts used
/// to find it, and a small still image.
struct PendingAttachment: Codable, Equatable {
    /// "photo" or "video"
    let kind: String
    var photosLocalId: String?
    var photosCloudId: String?
    /// The original's file name, e.g. IMG_1234.MOV.
    let filename: String?
    /// When it was taken, from the file's own metadata.
    let takenAt: Date?
    let durationS: Double?
    let width: Int?
    let height: Int?
    /// JPEG
    let thumb: Data

    var facts: ClipFacts {
        ClipFacts(isVideo: kind == "video", filename: filename, takenAt: takenAt, duration: durationS)
    }
}

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
    /// A shared link (Instagram, YouTube…), which puts the note on the To try list.
    var url: String?
    var attachments: [PendingAttachment]?

    init(
        text: String,
        kind: String? = nil,
        starred: Bool = false,
        url: String? = nil,
        attachments: [PendingAttachment]? = nil,
        now: Date = Date(),
        id: String = UUID().uuidString
    ) {
        self.id = id
        self.text = text
        self.kind = kind
        self.starred = starred
        self.date = PendingNote.day(now)
        self.createdAt = now
        self.url = url
        self.attachments = attachments
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

/// Notes waiting to be sent, kept in a file in the app group so they survive the app being closed and
/// the app and its share extension see the same queue. Every change re-reads the file under a file
/// lock, so the two processes can't overwrite each other.
actor Outbox {
    static let shared = Outbox(fileURL: Outbox.defaultURL)

    struct FlushResult {
        /// Server replies for the notes that went through, by note id.
        var sent: [String: CaptureResponse] = [:]
        /// The notes that went through, as they were sent.
        var sentNotes: [PendingNote] = []
        /// Notes the server refused for good (they won't be retried).
        var dropped: [PendingNote] = []
        /// Why sending stopped early, if it did; what's left stays queued.
        var stoppedBy: APIError?
    }

    private let fileURL: URL
    private var flushing = false

    init(fileURL: URL) {
        self.fileURL = fileURL
    }

    /// In the app group, so notes saved from the share sheet are sent by the app if need be, and back.
    static var defaultURL: URL { AppGroup.file("outbox.json") }

    /// Where versions before the share sheet kept the queue (only the app could see it).
    private static var legacyURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("outbox.json")
    }

    var pending: [PendingNote] { read() }
    var count: Int { read().count }

    func add(_ note: PendingNote) {
        update { $0.append(note) }
    }

    /// Changes a waiting note (e.g. once its photos are found in the library).
    func replace(_ note: PendingNote) {
        update { items in
            if let i = items.firstIndex(where: { $0.id == note.id }) { items[i] = note }
        }
    }

    private func remove(_ id: String) {
        update { $0.removeAll { $0.id == id } }
    }

    /// Moves anything still waiting in the old queue into the shared one.
    func adoptLegacyQueue() {
        let legacy = Outbox.legacyURL
        guard legacy != fileURL, let data = try? Data(contentsOf: legacy) else { return }
        let old = (try? JSONDecoder().decode([PendingNote].self, from: data)) ?? []
        update { items in
            let known = Set(items.map(\.id))
            items.append(contentsOf: old.filter { !known.contains($0.id) })
        }
        try? FileManager.default.removeItem(at: legacy)
    }

    // MARK: The file

    private func read() -> [PendingNote] {
        var items: [PendingNote] = []
        var error: NSError?
        NSFileCoordinator().coordinate(readingItemAt: fileURL, options: [], error: &error) { url in
            items = Outbox.decode(url)
        }
        return items
    }

    private func update(_ change: (inout [PendingNote]) -> Void) {
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        var error: NSError?
        NSFileCoordinator().coordinate(writingItemAt: fileURL, options: [], error: &error) { url in
            var items = Outbox.decode(url)
            change(&items)
            if let data = try? JSONEncoder().encode(items) {
                try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            }
        }
    }

    private static func decode(_ url: URL) -> [PendingNote] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([PendingNote].self, from: data)) ?? []
    }

    // MARK: Sending

    /// Sends waiting notes, `first` (if given) before the rest, oldest first after that.
    /// Stops at the first sign-in or connection problem and leaves the rest queued.
    func flush(first: String? = nil, send: (PendingNote) async throws -> CaptureResponse) async -> FlushResult {
        var result = FlushResult()
        guard !flushing else { return result }
        flushing = true
        defer { flushing = false }
        let items = read()
        let ordered = items.filter { $0.id == first } + items.filter { $0.id != first }
        for note in ordered {
            do {
                let reply = try await send(note)
                remove(note.id)
                result.sent[note.id] = reply
                result.sentNotes.append(note)
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
