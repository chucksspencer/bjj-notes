import AppIntents
import Foundation

/// A spoken reply made from text the app or server composed.
func spoken(_ text: String) -> IntentDialog {
    IntentDialog(LocalizedStringResource(stringLiteral: text))
}

/// Saves a note on the phone first, then sends it. If it can't go now, it waits and syncs later.
func saveNote(_ text: String, kind: String? = nil) async -> String {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "Nothing to save." }
    let note = PendingNote(text: trimmed, kind: kind)
    await Outbox.shared.add(note)
    // Short timeout: Siri is waiting. A slow save stays queued and is recognised if it did arrive.
    let result = await Sync.run(first: note.id, timeout: 12)
    if let reply = result.sent[note.id] { return reply.speech }
    if result.dropped.contains(note) { return "BJJ Notes couldn't save that note." }
    return Speech.savedOffline(result.stoppedBy)
}

struct AddNoteIntent: AppIntent {
    static var title: LocalizedStringResource = "Add a BJJ note"
    static var description = IntentDescription(
        "Saves a training note. BJJ Notes tidies it up and files it under the techniques it mentions. Works offline: the note waits on your phone and syncs later."
    )

    @Parameter(title: "Note", requestValueDialog: IntentDialog("What's the note?"))
    var text: String

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$text) to BJJ Notes")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        .result(dialog: spoken(await saveNote(text)))
    }
}

struct AskCoachIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask coach"
    static var description = IntentDescription("Adds a question for your coach to the Lab's Ask coach list.")

    @Parameter(title: "Question", requestValueDialog: IntentDialog("What's the question for coach?"))
    var text: String

    static var parameterSummary: some ParameterSummary {
        Summary("Ask coach \(\.$text)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        .result(dialog: spoken(await saveNote(text, kind: "question")))
    }
}
