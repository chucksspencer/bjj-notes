import Foundation
import UniformTypeIdentifiers

/// What was shared, the takeaway typed or dictated with it, and saving it.
@MainActor
final class ShareModel: ObservableObject {
    enum Phase: Equatable {
        case loading
        case ready
        case saving
        case done(String)
    }

    @Published var phase: Phase = .loading
    @Published var text = ""
    @Published private(set) var link: String?
    @Published private(set) var attachments: [PendingAttachment] = []
    @Published private(set) var problem: String?

    private let context: NSExtensionContext?

    init(context: NSExtensionContext?) {
        self.context = context
    }

    var takeaway: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var canSave: Bool {
        phase == .ready && (!attachments.isEmpty || link != nil || !takeaway.isEmpty)
    }

    func load() async {
        let providers = (context?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        var sharedText: [String] = []
        for provider in providers {
            do {
                if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
                    let file = try await ClipLoader.file(from: provider, type: .movie)
                    defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
                    attachments.append(try await ClipLoader.video(at: file, name: provider.suggestedName))
                } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    let file = try await ClipLoader.file(from: provider, type: .image)
                    defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
                    attachments.append(try ClipLoader.photo(at: file, name: provider.suggestedName))
                } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    let item = try await provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil)
                    if let url = item as? URL, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                        link = url.absoluteString
                    }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    let item = try await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil)
                    if let words = item as? String { sharedText.append(words) }
                }
            } catch {
                problem = "One of the shared items couldn't be read."
            }
        }
        // Some apps share a caption with the link inside it.
        if link == nil, let words = sharedText.first {
            link = ShareModel.firstLink(in: words)
            if link == nil, text.isEmpty { text = words }
        }
        phase = .ready
    }

    /// Saves on the phone first, then sends; with no signal it waits and the app sends it later.
    func save() async {
        guard canSave else { return }
        phase = .saving
        let note = PhotosLibrary.link(PendingNote(
            text: takeaway,
            url: link,
            attachments: attachments.isEmpty ? nil : attachments
        ))
        await Outbox.shared.add(note)
        let result = await Sync.run(first: note.id, timeout: 15)
        if let reply = result.sent[note.id] {
            phase = .done(reply.speech)
        } else if result.dropped.contains(where: { $0.id == note.id }) {
            phase = .done("BJJ Notes couldn't save that.")
        } else {
            phase = .done(Speech.savedOffline(result.stoppedBy))
        }
    }

    static func firstLink(in text: String) -> String? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        return detector.firstMatch(in: text, options: [], range: range)?.url.flatMap { url in
            ["http", "https"].contains(url.scheme?.lowercased() ?? "") ? url.absoluteString : nil
        }
    }
}
