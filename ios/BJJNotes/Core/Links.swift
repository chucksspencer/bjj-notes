import Foundation

/// A saved photo or video whose original hasn't been found in Photos yet (for example, shared before
/// BJJ Notes was allowed to read the library). The app looks again each time it's opened.
struct PendingLink: Codable, Equatable {
    let attachmentId: Int
    let isVideo: Bool
    let filename: String?
    let takenAt: Date?
    let duration: Double?
    var tries: Int = 0

    var facts: ClipFacts { ClipFacts(isVideo: isVideo, filename: filename, takenAt: takenAt, duration: duration) }
}

/// The photos and videos still to be linked to their originals, in the app group.
actor Links {
    static let shared = Links(fileURL: AppGroup.file("links.json"))
    /// Give up on an item after this many looks (it was probably deleted, or isn't in this library).
    static let maxTries = 6

    private let fileURL: URL

    init(fileURL: URL) {
        self.fileURL = fileURL
    }

    var pending: [PendingLink] { read() }

    func add(_ links: [PendingLink]) {
        guard !links.isEmpty else { return }
        update { items in
            let known = Set(items.map(\.attachmentId))
            items.append(contentsOf: links.filter { !known.contains($0.attachmentId) })
        }
    }

    /// Looks for each original and tells the server where it is. Needs permission to read Photos.
    func resolve(api: API = .shared, find: (ClipFacts) -> (local: String, cloud: String?)? = PhotosLibrary.find) async {
        guard PhotosLibrary.canRead else { return }
        for link in read() {
            if let found = find(link.facts) {
                do {
                    try await api.linkAttachment(id: link.attachmentId, localId: found.local, cloudId: found.cloud)
                    update { $0.removeAll { $0.attachmentId == link.attachmentId } }
                } catch let error as APIError where error.isPermanent {
                    update { $0.removeAll { $0.attachmentId == link.attachmentId } } // the note was deleted
                } catch {
                    return // offline or signed out: try again next time
                }
            } else {
                update { items in
                    guard let i = items.firstIndex(where: { $0.attachmentId == link.attachmentId }) else { return }
                    items[i].tries += 1
                    if items[i].tries >= Links.maxTries { items.remove(at: i) }
                }
            }
        }
    }

    private func read() -> [PendingLink] {
        var items: [PendingLink] = []
        var error: NSError?
        NSFileCoordinator().coordinate(readingItemAt: fileURL, options: [], error: &error) { url in
            items = Links.decode(url)
        }
        return items
    }

    private func update(_ change: (inout [PendingLink]) -> Void) {
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        var error: NSError?
        NSFileCoordinator().coordinate(writingItemAt: fileURL, options: [], error: &error) { url in
            var items = Links.decode(url)
            change(&items)
            if let data = try? JSONEncoder().encode(items) {
                try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            }
        }
    }

    private static func decode(_ url: URL) -> [PendingLink] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([PendingLink].self, from: data)) ?? []
    }
}
