import Foundation

// The parts of the server's JSON the app uses (see src/shared/api.ts). Unknown fields are ignored.

struct TechniqueRef: Codable, Hashable {
    let id: Int
    let name: String
}

struct FocusItem: Codable, Identifiable, Hashable {
    let id: Int
    let label: String
    let goal: String?
    let rank: Int?
    let lastNoteOn: String?
}

struct FocusView: Codable {
    let today: String
    let active: [FocusItem]
}

struct NoteSummary: Codable, Identifiable, Hashable {
    let id: Int
    let body: String
    let kind: String
    let observedOn: String
    let techniques: [TechniqueRef]
}

struct TechniqueSummary: Codable, Identifiable, Hashable {
    let id: Int
    let name: String
    let status: String
}

struct LabView: Codable {
    struct Starred: Codable {
        let techniques: [TechniqueSummary]
        let notes: [NoteSummary]
    }
    struct ToTry: Codable {
        let total: Int
        let notes: [NoteSummary]
    }
    let today: String
    let days: Int
    let starred: Starred
    let toTry: ToTry
    let fresh: [TechniqueSummary]
    let questions: [NoteSummary]
}

/// What the server says after saving a note; `speech` is written to be read aloud.
struct CaptureResponse: Codable, Equatable {
    struct Attachment: Codable, Equatable {
        let id: Int
        /// Whether the server knows where the original is in Photos.
        let linked: Bool
    }
    let note_id: Int?
    let speech: String
    let duplicate: Bool?
    /// The saved photos and videos, in the order they were sent.
    var attachments: [Attachment]? = nil
}
