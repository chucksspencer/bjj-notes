import SwiftUI

/// The web app, full screen. If the server can't be reached, a native screen says so and how many
/// notes are waiting on the phone.
struct RootView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var unreachable = false
    @State private var reloads = 0
    @State private var waiting = 0

    var body: some View {
        ZStack {
            Color("Canvas").ignoresSafeArea()
            WebAppView(reloads: reloads, unreachable: $unreachable)
                .ignoresSafeArea()
            if unreachable {
                OfflineView(waiting: waiting) { reloads += 1 }
            }
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await Sync.run()
            waiting = await Outbox.shared.count
        }
    }
}

struct OfflineView: View {
    let waiting: Int
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Can't reach BJJ Notes")
                .font(.system(size: 34, weight: .heavy).width(.condensed))
            Text(waiting > 0
                 ? "\(Speech.count(waiting, "note")) saved on this phone will be sent when you're back online."
                 : "Notes you add with Siri while you're offline are kept on this phone and sent when you're back online.")
                .foregroundStyle(.secondary)
            Button("Try again", action: retry)
                .buttonStyle(.borderedProminent)
                .padding(.top, 6)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(Color("Canvas"))
    }
}
