import Foundation

/// What Siri says. Short, because it's read aloud.
enum Speech {
    /// "A", "A and B", "A, B and C".
    static func list(_ items: [String]) -> String {
        switch items.count {
        case 0: return ""
        case 1: return items[0]
        default: return items.dropLast().joined(separator: ", ") + " and " + items[items.count - 1]
        }
    }

    static func count(_ n: Int, _ noun: String) -> String {
        "\(n) \(noun)\(n == 1 ? "" : "s")"
    }

    /// "Your focus is Baratoplata, then body lock passing, then ghost escape. 4 more on the list."
    static func focus(_ view: FocusView) -> String {
        let items = view.active.sorted { ($0.rank ?? .max) < ($1.rank ?? .max) }
        guard let first = items.first else { return "Your focus list is empty." }
        let top = items.prefix(3).dropFirst().map { $0.label }
        var said = "Your focus is \(first.label)"
        if !top.isEmpty { said += ", then " + top.joined(separator: ", then ") }
        said += "."
        if items.count > 3 { said += " \(items.count - 3) more on the list." }
        return said
    }

    /// "2 starred, 3 to try, 1 new technique and 1 question for coach. Starred: Ghost escape and 1 note."
    static func lab(_ view: LabView) -> String {
        let starredCount = view.starred.techniques.count + view.starred.notes.count
        var parts: [String] = []
        if starredCount > 0 { parts.append("\(starredCount) starred") }
        if view.toTry.total > 0 { parts.append("\(view.toTry.total) to try") }
        if !view.fresh.isEmpty { parts.append(count(view.fresh.count, "new technique")) }
        if !view.questions.isEmpty { parts.append(count(view.questions.count, "question") + " for coach") }
        guard !parts.isEmpty else { return "Nothing in your lab right now." }
        var said = "In your lab: " + list(parts) + "."
        if starredCount > 0 {
            var starred = view.starred.techniques.prefix(3).map { $0.name }
            if !view.starred.notes.isEmpty { starred.append(count(view.starred.notes.count, "note")) }
            said += " Starred: " + list(starred) + "."
        }
        return said
    }

    /// What to say when a note couldn't be sent yet; it's safe on the phone either way.
    static func savedOffline(_ problem: APIError?) -> String {
        if problem?.kind == .notSignedIn {
            return "Saved on your phone. Open BJJ Notes and sign in, and it'll be sent."
        }
        return "Saved on your phone. It'll go to BJJ Notes when you're back online."
    }
}
