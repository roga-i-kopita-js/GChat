import Foundation

public enum NativeError: String, Error {
    case validation = "VALIDATION_ERROR"
    case storage = "SECURE_STORAGE_ERROR"
    case unauthenticated = "UNAUTHENTICATED"
    case invalidSession = "SESSION_INVALID"
    case network = "NETWORK_ERROR"
    case unavailable = "BRIDGE_UNAVAILABLE"
    case forbidden = "FORBIDDEN"
}

/// A configured HTTPS origin, independent of the Web document's query string.
public struct ServerOrigin: Codable, Equatable, Sendable {
    public let url: URL

    public init(_ value: String) throws {
        guard let parts = URLComponents(string: value),
              parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil,
              parts.path.isEmpty || parts.path == "/",
              parts.query == nil, parts.fragment == nil,
              parts.port == nil || (1...65535).contains(parts.port!) else {
            throw NativeError.validation
        }
        var canonical = URLComponents()
        canonical.scheme = "https"
        canonical.host = host.lowercased()
        canonical.port = parts.port == 443 ? nil : parts.port
        guard let url = canonical.url else { throw NativeError.validation }
        self.url = url
    }

    public func contains(_ other: URL) -> Bool {
        other.scheme?.lowercased() == "https" &&
        other.host?.lowercased() == url.host?.lowercased() &&
        (other.port ?? 443) == (url.port ?? 443) &&
        other.user == nil && other.password == nil
    }

    public func allowsDocument(_ other: URL) -> Bool {
        contains(other) && (other.path == "/apps/client" || other.path.hasPrefix("/apps/client/"))
    }

    public var loginRoute: String {
        var parts = URLComponents()
        parts.path = "/login"
        parts.queryItems = [URLQueryItem(name: "serverUrl", value: url.absoluteString)]
        return parts.string!
    }

    public var launchURL: URL {
        URL(string: "/apps/client" + loginRoute, relativeTo: url)!.absoluteURL
    }
}
