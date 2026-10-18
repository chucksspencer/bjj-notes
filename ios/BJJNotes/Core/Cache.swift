import Foundation

/// The last focus list and Lab seen, so Siri can still answer (marked as possibly stale) when offline.
enum Cache {
    private static let defaults = UserDefaults.standard

    static var focus: FocusView? {
        get { load("cache.focus") }
        set { store(newValue, "cache.focus") }
    }

    static var lab: LabView? {
        get { load("cache.lab") }
        set { store(newValue, "cache.lab") }
    }

    private static func load<T: Decodable>(_ key: String) -> T? {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
    }

    private static func store<T: Encodable>(_ value: T?, _ key: String) {
        if let value, let data = try? JSONEncoder().encode(value) {
            defaults.set(data, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
}
