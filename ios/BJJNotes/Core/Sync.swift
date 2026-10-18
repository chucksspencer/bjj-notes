import BackgroundTasks
import Foundation
import Network

/// Gets notes saved offline to the server: right away when possible, otherwise when the connection
/// comes back while the app is running, when it's opened, or in a background refresh.
enum Sync {
    @discardableResult
    static func run(first: String? = nil, timeout: TimeInterval = 20, api: API = .shared) async -> Outbox.FlushResult {
        let result = await Outbox.shared.flush(first: first) { note in
            try await api.capture(note, timeout: timeout)
        }
        if await Outbox.shared.count > 0 { scheduleBackgroundRetry() }
        return result
    }

    static func scheduleBackgroundRetry() {
        let request = BGAppRefreshTaskRequest(identifier: Config.syncTaskID)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    private static let monitor = NWPathMonitor()

    /// While the app is running, send what's waiting as soon as the phone is back online.
    static func watchConnection() {
        monitor.pathUpdateHandler = { path in
            guard path.status == .satisfied else { return }
            Task { await run() }
        }
        monitor.start(queue: DispatchQueue(label: "BJJNotes.connection"))
    }
}
