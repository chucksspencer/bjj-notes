import SwiftUI

@main
struct BJJNotesApp: App {
    init() {
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
