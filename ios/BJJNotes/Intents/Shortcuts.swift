import AppIntents

/// The phrases Siri knows without any setup. Each must name the app; Siri's newer models also match
/// looser wording to these actions.
struct BJJShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AddNoteIntent(),
            phrases: [
                "Add a note to \(.applicationName)",
                "New \(.applicationName) note",
                "Save a note in \(.applicationName)",
                "Take a note in \(.applicationName)",
            ],
            shortTitle: "New note",
            systemImageName: "square.and.pencil"
        )
        AppShortcut(
            intent: AskCoachIntent(),
            phrases: [
                "Ask coach in \(.applicationName)",
                "Add a question for coach in \(.applicationName)",
                "Add a question to \(.applicationName)",
            ],
            shortTitle: "Ask coach",
            systemImageName: "questionmark.bubble"
        )
        AppShortcut(
            intent: FocusIntent(),
            phrases: [
                "What's my focus in \(.applicationName)",
                "What am I working on in \(.applicationName)",
                "Read my \(.applicationName) focus",
            ],
            shortTitle: "Focus",
            systemImageName: "scope"
        )
        AppShortcut(
            intent: LabIntent(),
            phrases: [
                "What's in my \(.applicationName) lab",
                "What's in the lab in \(.applicationName)",
                "Check my lab in \(.applicationName)",
            ],
            shortTitle: "Lab",
            systemImageName: "flask"
        )
    }
}
