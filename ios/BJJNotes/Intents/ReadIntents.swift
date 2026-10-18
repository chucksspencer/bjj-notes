import AppIntents
import SwiftUI

struct FocusIntent: AppIntent {
    static var title: LocalizedStringResource = "What's my focus"
    static var description = IntentDescription("Reads out the top of your focus list: what you're working on over the coming weeks and months.")

    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        do {
            let focus = try await API.shared.focus()
            Cache.focus = focus
            return .result(dialog: spoken(Speech.focus(focus)), view: FocusSnippet(items: Array(focus.active.prefix(5))))
        } catch let error as APIError {
            if let cached = Cache.focus {
                return .result(
                    dialog: spoken("I can't reach BJJ Notes, so this is from last time. " + Speech.focus(cached)),
                    view: FocusSnippet(items: Array(cached.active.prefix(5)))
                )
            }
            return .result(dialog: spoken(error.message), view: FocusSnippet(items: []))
        }
    }
}

struct LabIntent: AppIntent {
    static var title: LocalizedStringResource = "What's in my lab"
    static var description = IntentDescription("Sums up the Lab: what's starred, videos to try, new techniques and questions for coach.")

    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        do {
            let lab = try await API.shared.lab()
            Cache.lab = lab
            return .result(dialog: spoken(Speech.lab(lab)), view: LabSnippet(lab: lab))
        } catch let error as APIError {
            if let cached = Cache.lab {
                return .result(dialog: spoken("I can't reach BJJ Notes, so this is from last time. " + Speech.lab(cached)), view: LabSnippet(lab: cached))
            }
            return .result(dialog: spoken(error.message), view: LabSnippet(lab: nil))
        }
    }
}

// MARK: - What Siri shows

struct FocusSnippet: View {
    let items: [FocusItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text("\(item.rank ?? index + 1)")
                        .font(.system(.title3, design: .default).weight(.heavy).width(.condensed))
                        .foregroundStyle(.secondary)
                        .frame(minWidth: 22, alignment: .leading)
                    Text(item.label)
                        .font(.system(.body).weight(.semibold))
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct LabSnippet: View {
    let lab: LabView?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let lab {
                if !lab.starred.techniques.isEmpty || !lab.starred.notes.isEmpty {
                    Label {
                        Text(Speech.list(lab.starred.techniques.prefix(4).map { $0.name } + lab.starred.notes.prefix(2).map { $0.body }))
                            .lineLimit(3)
                    } icon: {
                        Image(systemName: "star.fill").foregroundStyle(.yellow)
                    }
                }
                if lab.toTry.total > 0 {
                    Label(Speech.count(lab.toTry.total, "video") + " to try", systemImage: "play.rectangle")
                }
                if !lab.fresh.isEmpty {
                    Label("New: " + Speech.list(lab.fresh.prefix(4).map { $0.name }), systemImage: "sparkles")
                }
                if let question = lab.questions.first {
                    Label(question.body, systemImage: "questionmark.bubble").lineLimit(2)
                }
            }
        }
        .font(.subheadline)
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
