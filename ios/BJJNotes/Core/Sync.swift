import Foundation
import Network
#if !SHARE_EXTENSION
import BackgroundTasks
#endif

/// Gets notes saved offline to the server: right away when possible, otherwise when the connection
/// comes back while the app is running, when it's opened, or in a background refresh. Photos and
/// videos are linked to their originals in Photos before they're sent, or as soon as they can be.
enum Sync {
    @discardableResult
    static func run(first: String? = nil, timeout: TimeInterval = 20, api: API = .shared) async -> Outbox.FlushResult {
        // Anything shared before Photos could be read: find the originals now, if we can.
        if PhotosLibrary.canRead {
            for note in await Outbox.shared.pending where note.attachments?.contains(where: { $0.photosLocalId == nil }) == true {
                await Outbox.shared.replace(PhotosLibrary.link(note))
            }
        }
        let result = await Outbox.shared.flush(first: first) { note in
            try await api.capture(note, timeout: timeout)
        }
        await Links.shared.add(unlinked(in: result))
        await Links.shared.resolve(api: api)
        if await Outbox.shared.count > 0 { scheduleBackgroundRetry() }
        return result
    }

    /// Photos and videos the server saved without knowing where the original is.
    static func unlinked(in result: Outbox.FlushResult) -> [PendingLink] {
        result.sentNotes.flatMap { note -> [PendingLink] in
            guard let sent = note.attachments, let saved = result.sent[note.id]?.attachments, saved.count == sent.count else { return [] }
            return zip(sent, saved).compactMap { local, server in
                server.linked ? nil : PendingLink(
                    attachmentId: server.id,
                    isVideo: local.kind == "video",
                    filename: local.filename,
                    takenAt: local.takenAt,
                    duration: local.durationS
                )
            }
        }
    }

    static func scheduleBackgroundRetry() {
        #if !SHARE_EXTENSION
        let request = BGAppRefreshTaskRequest(identifier: Config.syncTaskID)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
        #endif
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
