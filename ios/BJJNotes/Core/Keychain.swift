import Foundation
import Security

/// Small strings kept in the Keychain, shared with the share extension through the app group, and
/// readable after the phone's first unlock so background sync works.
enum Keychain {
    private static let service = "BJJNotes"

    private static func base(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    /// Reads from any group this process can see (the shared one, or the app's own from older versions).
    static func read(_ account: String, sharedOnly: Bool = false) -> String? {
        var query = base(account)
        if sharedOnly { query[kSecAttrAccessGroup as String] = AppGroup.id }
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Replaces the value, in the shared group when this build has one.
    static func write(_ value: String, for account: String) {
        delete(account)
        var item = base(account)
        item[kSecValueData as String] = Data(value.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        var shared = item
        shared[kSecAttrAccessGroup as String] = AppGroup.id
        if SecItemAdd(shared as CFDictionary, nil) != errSecSuccess {
            SecItemAdd(item as CFDictionary, nil)
        }
    }

    static func delete(_ account: String) {
        SecItemDelete(base(account) as CFDictionary)
    }
}
