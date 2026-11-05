import Foundation
import Security

public struct KeychainSessionStorage: SessionStorage {
    private let service: String

    public init(service: String) { self.service = service }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: "session.v1"]
    }

    public func read() throws -> NativeSession? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let session = try? JSONDecoder().decode(NativeSession.self, from: data) else {
            throw NativeError.storage
        }
        // Revalidate persisted configuration rather than trusting Codable's synthesized initializer.
        guard (try? ServerOrigin(session.server.url.absoluteString)) == session.server else {
            throw NativeError.storage
        }
        return session
    }

    public func write(_ session: NativeSession?) throws {
        guard let session else {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw NativeError.storage }
            return
        }
        let data = try JSONEncoder().encode(session)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let insert = query.merging(attributes) { _, new in new }
            guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else { throw NativeError.storage }
        } else if status != errSecSuccess { throw NativeError.storage }
    }
}
