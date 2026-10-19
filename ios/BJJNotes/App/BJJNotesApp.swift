import SwiftUI

@main
struct BJJNotesApp: App {
    init() {
        // Earlier versions kept the sign-in and the offline queue where the share sheet can't see them.
        Session.shareWithExtension()
        Task { await Outbox.shared.adoptLegacyQueue() }
        Sync.watchConnection()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
        .backgroundTask(.appRefresh(Config.syncTaskID)) {
            await Sync.run()
        }
    }
}
