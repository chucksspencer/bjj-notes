import SwiftUI
import UIKit

struct ShareView: View {
    @ObservedObject var model: ShareModel
    let cancel: () -> Void
    let finish: () -> Void
    @FocusState private var typing: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if model.phase == .loading {
                        ProgressView("Getting it ready…")
                            .frame(maxWidth: .infinity, minHeight: 120)
                    } else {
                        content
                    }
                }
                .padding()
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("BJJ Notes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: cancel).disabled(model.phase == .saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model.phase == .saving {
                        ProgressView()
                    } else if case .done = model.phase {
                        Button("Done", action: finish)
                    } else {
                        Button("Save") {
                            typing = false
                            Task {
                                await model.save()
                                try? await Task.sleep(nanoseconds: 1_400_000_000)
                                finish()
                            }
                        }
                        .bold()
                        .disabled(!model.canSave)
                    }
                }
            }
        }
    }

    @ViewBuilder private var content: some View {
        if !model.attachments.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(Array(model.attachments.enumerated()), id: \.offset) { _, clip in
                        Still(clip: clip)
                    }
                }
            }
        }
        if let link = model.link {
            Label(link, systemImage: "link")
                .font(.subheadline)
                .lineLimit(2)
                .foregroundStyle(.secondary)
        }
        if case .done(let message) = model.phase {
            Label(message, systemImage: "checkmark.circle.fill")
                .font(.headline)
                .foregroundStyle(Color.accentColor)
        } else {
            TextField(model.link == nil ? "What's the takeaway? (optional)" : "Why save it? (optional)", text: $model.text, axis: .vertical)
                .lineLimit(3...8)
                .padding(12)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
                .focused($typing)
                .disabled(model.phase == .saving)
            Text(hint)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        if let problem = model.problem {
            Text(problem).font(.footnote).foregroundStyle(.red)
        }
    }

    private var hint: String {
        if model.link != nil { return "It goes on your To try list." }
        return "Name the technique and it's filed there; otherwise it waits in your Inbox. The original stays in Photos."
    }
}

/// A shared photo or video's still, with the video's length.
private struct Still: View {
    let clip: PendingAttachment

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if let image = UIImage(data: clip.thumb) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Color.black
            }
            if clip.kind == "video" {
                Label(clip.durationS.map(Self.duration) ?? "Video", systemImage: "play.fill")
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.black.opacity(0.6), in: Capsule())
                    .foregroundStyle(.white)
                    .padding(6)
            }
        }
        .frame(width: 112, height: 112)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    static func duration(_ seconds: Double) -> String {
        let s = Int(seconds.rounded())
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}
