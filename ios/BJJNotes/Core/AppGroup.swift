import Foundation

/// Storage the app and its share extension both see: the offline queue, Photos links, the sign-in.
enum AppGroup {
    static let id = "group.com.chucksspencer.bjjnotes"

    /// The shared folder, or nil when the build has no app group (tests, unsigned builds).
    static var container: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: id)
    }

    /// A file in the shared folder, falling back to this process's own Application Support.
    static func file(_ name: String) -> URL {
        if let container { return container.appendingPathComponent(name) }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent(name)
    }
}
