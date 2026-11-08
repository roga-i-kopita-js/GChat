import Foundation

/// A native call lease is independent of Web sessions and preview surfaces.
public struct CameraOwnership: Sendable {
    public private(set) var selectedCall: UUID?
    public private(set) var retainedCall: UUID?
    private var views = Set<UUID>()
    public init() {}
    public var hasCall: Bool { retainedCall != nil && retainedCall == selectedCall }
    public var retained: Bool { hasCall || !views.isEmpty }
    public func contains(_ session: UUID) -> Bool { views.contains(session) }
    /// Returns true when a source tied to the old selected call must be closed.
    public mutating func selectCall(_ id: UUID?) -> Bool {
        let ended = retainedCall != nil && retainedCall != id
        selectedCall = id
        if ended { close() }
        return ended
    }
    public mutating func acquire(call: Bool) throws -> UUID {
        if call {
            guard let selectedCall else { throw DeviceCommandError("INVALID_STATE") }
            retainedCall = selectedCall
        }
        let id = UUID(); views.insert(id); return id
    }
    public mutating func release(_ session: UUID) { views.remove(session) }
    public mutating func releaseViews() { views.removeAll() }
    public mutating func close() { views.removeAll(); retainedCall = nil }
}
