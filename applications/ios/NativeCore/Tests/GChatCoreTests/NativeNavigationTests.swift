import XCTest
@testable import GChatCore

@MainActor final class NativeNavigationTests: XCTestCase {
    private let server = try! ServerOrigin("https://gchat.test")
    private let cycle = UUID().uuidString.lowercased()
    private func ready(_ navigation: NativeNavigation, path: String = "/calls") throws {
        try navigation.webReady(["navigationVersion": 1, "cycleId": cycle, "phase": "ready", "location": ["pathname": path, "search": "", "hash": ""]])
    }
    private func response(_ id: String, outcome: String = "committed", path: String = "/calls") -> [String: Any] {
        ["navigationVersion": 1, "cycleId": cycle, "requestId": id,
         "result": ["id": id, "outcome": outcome, "location": ["pathname": path, "search": "", "hash": ""]]]
    }
    private func expectCode(_ code: String, _ operation: () throws -> Void) {
        XCTAssertThrowsError(try operation()) { XCTAssertEqual(($0 as? DeviceCommandError)?.code, code) }
    }
    func testRouteAndQueryBoundary() throws {
        for path in ["https://evil.test/calls", "//evil.test/calls", "/calls#token", "/settings/../calls", "/settings/%2e%2e/calls", "/settings%2fgeneral/audio", "/calls?token=secret", "/calls?group=bad", "/calls?group=all&group=all", "/unknown", "/login?serverUrl=https://evil.test", "/login?returnTo=%2Flogin", "/admin/users?offset=24", "/admin/users?status=other"] {
            expectCode("INVALID_ARGUMENT") { _ = try NativeNavigationTarget(path, server: server) }
        }
        XCTAssertEqual(try NativeNavigationTarget("/admin/users?q=%20anna%20&status=all&offset=0", server: server).value, "/admin/users?q=anna")
        XCTAssertEqual(try NativeNavigationTarget("/admin/users?offset=0025", server: server).value, "/admin/users?offset=25")
        XCTAssertNoThrow(try NativeNavigationTarget("/dialogs/" + UUID().uuidString, server: server))
        XCTAssertNoThrow(try NativeNavigationTarget("/login?returnTo=%2Fcalls", server: server))
    }
    func testReadinessAndEnvelopeValidation() throws {
        let navigation = NativeNavigation(server: server)
        try navigation.activate(cycle: cycle)
        expectCode("INVALID_ARGUMENT") { try navigation.webReady(["navigationVersion": true, "cycleId": cycle, "phase": "failed"]) }
        expectCode("UNSUPPORTED_VERSION") { try navigation.webReady(["navigationVersion": 2, "cycleId": cycle, "phase": "failed"]) }
        expectCode("INVALID_STATE") { try navigation.webReady(["navigationVersion": 1, "cycleId": UUID().uuidString, "phase": "failed"]) }
        expectCode("INVALID_ARGUMENT") { try navigation.webReady(["navigationVersion": 1, "cycleId": cycle, "phase": "ready", "location": ["pathname": "/calls", "search": "?token=secret", "hash": ""]]) }
        XCTAssertFalse(navigation.isReady)
        try ready(navigation)
        XCTAssertTrue(navigation.isReady)
    }
    func testOnlyLatestQueuedCommandIsDeliveredWhenWebBecomesReady() async throws {
        let navigation = NativeNavigation(server: server)
        try navigation.activate(cycle: cycle)
        var delivered: [[String: Any]] = []
        navigation.onCommand = { value in
            delivered.append(value)
            try! navigation.complete(self.response(value["requestId"] as! String, path: "/settings/general/audio"))
        }
        let first = Task { try await navigation.navigate(to: "/calls") }
        try await Task.sleep(for: .milliseconds(5))
        let second = Task { try await navigation.navigate(to: "/settings/general/audio") }
        try await Task.sleep(for: .milliseconds(5))
        XCTAssertTrue(delivered.isEmpty)
        try ready(navigation)
        let a = try await first.value, b = try await second.value
        XCTAssertEqual(a["outcome"] as? String, "superseded")
        XCTAssertEqual(b["outcome"] as? String, "committed")
        XCTAssertEqual(delivered.count, 1)
        XCTAssertEqual(Set(delivered[0].keys), ["navigationVersion", "cycleId", "requestId", "command", "args"])
    }
    func testActiveAndCompletedDuplicatesNeverDeliverTwice() async throws {
        let navigation = NativeNavigation(server: server); try navigation.activate(cycle: cycle); try ready(navigation)
        let id = UUID().uuidString.lowercased()
        var deliveries = 0
        navigation.onCommand = { _ in deliveries += 1 }
        let first = Task { try await navigation.navigate(to: "/calls", requestID: id) }
        try await Task.sleep(for: .milliseconds(5))
        let duplicate = Task { try await navigation.navigate(to: "/calls", requestID: id) }
        try await Task.sleep(for: .milliseconds(5))
        XCTAssertEqual(deliveries, 1)
        try navigation.complete(response(id))
        let a = try await first.value, b = try await duplicate.value
        XCTAssertEqual(a["id"] as? String, id)
        XCTAssertEqual(b["id"] as? String, id)
        let replay = try await navigation.navigate(to: "/calls", requestID: id)
        XCTAssertEqual(replay["outcome"] as? String, "committed")
        XCTAssertEqual(deliveries, 1)
        do { _ = try await navigation.navigate(to: "/settings/general/audio", requestID: id); XCTFail("Same ID cannot mean another command") }
        catch { XCTAssertEqual((error as? DeviceCommandError)?.code, "INVALID_ARGUMENT") }
    }
    func testSupersededCompletionCannotReplaceCurrentLocation() async throws {
        let navigation = NativeNavigation(server: server); try navigation.activate(cycle: cycle); try ready(navigation)
        let oldID = UUID().uuidString.lowercased(), newID = UUID().uuidString.lowercased()
        let old = Task { try await navigation.navigate(to: "/settings/general/audio", requestID: oldID) }
        try await Task.sleep(for: .milliseconds(5))
        let next = Task { try await navigation.navigate(to: "/calls", requestID: newID) }
        try await Task.sleep(for: .milliseconds(5))
        try navigation.complete(response(oldID, path: "/settings/general/audio"))
        try navigation.complete(response(newID))
        let oldResult = try await old.value, result = try await next.value
        XCTAssertEqual(oldResult["outcome"] as? String, "superseded")
        XCTAssertEqual((result["location"] as? [String: Any])?["pathname"] as? String, "/calls")
    }
    func testOldCycleCancelsPendingAndRejectsLateCompletion() async throws {
        let navigation = NativeNavigation(server: server); try navigation.activate(cycle: cycle); try ready(navigation)
        let id = UUID().uuidString.lowercased()
        let pending = Task { try await navigation.navigate(to: "/calls", requestID: id) }
        try await Task.sleep(for: .milliseconds(5))
        try navigation.activate(cycle: UUID().uuidString)
        expectCode("INVALID_STATE") { try navigation.complete(response(id)) }
        do { _ = try await pending.value; XCTFail("Expected invalid context") }
        catch { XCTAssertEqual((error as? DeviceCommandError)?.code, "INVALID_STATE") }
    }
    func testFailedStartupCompletesQueuedCommandAsFailed() async throws {
        let navigation = NativeNavigation(server: server); try navigation.activate(cycle: cycle)
        let pending = Task { try await navigation.navigate(to: "/calls") }
        try await Task.sleep(for: .milliseconds(5))
        try navigation.webReady(["navigationVersion": 1, "cycleId": cycle, "phase": "failed"])
        let result = try await pending.value
        XCTAssertEqual(result["outcome"] as? String, "failed")
    }
    func testReplayWindowEvictionNeverResendsRetiredCommand() async throws {
        let navigation = NativeNavigation(server: server); try navigation.activate(cycle: cycle); try ready(navigation)
        var deliveries = 0
        navigation.onCommand = { value in deliveries += 1; try! navigation.complete(self.response(value["requestId"] as! String)) }
        let first = UUID().uuidString.lowercased()
        _ = try await navigation.navigate(to: "/calls", requestID: first)
        for _ in 0..<128 { _ = try await navigation.navigate(to: "/calls") }
        do { _ = try await navigation.navigate(to: "/calls", requestID: first); XCTFail("Retired command") }
        catch { XCTAssertEqual((error as? DeviceCommandError)?.code, "INVALID_STATE") }
        XCTAssertEqual(deliveries, 129)
    }
    func testCompletionRejectsExtraFieldsAndNormalizesFailureText() async throws {
        let navigation = NativeNavigation(server: server); try navigation.activate(cycle: cycle); try ready(navigation)
        let id = UUID().uuidString.lowercased()
        let pending = Task { try await navigation.navigate(to: "/calls", requestID: id) }
        try await Task.sleep(for: .milliseconds(5))
        var bad = response(id); bad["token"] = "must-not-appear"
        expectCode("INVALID_ARGUMENT") { try navigation.complete(bad) }
        var failure = response(id, outcome: "failed")
        var result = failure["result"] as! [String: Any]
        result["error"] = ["code": "INTEGRATION_ERROR", "service": "navigation", "operation": "navigate", "message": "raw private error"]
        failure["result"] = result
        try navigation.complete(failure)
        let completed = try await pending.value
        XCTAssertFalse(String(describing: completed).contains("raw private error"))
    }
}
