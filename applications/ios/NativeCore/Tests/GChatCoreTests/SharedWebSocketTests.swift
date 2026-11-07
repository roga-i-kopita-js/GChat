import XCTest
@testable import GChatCore

@MainActor private final class TestSocket: NativeSocket {
    var sent: [[String: Any]] = []
    var inbound: [String] = []
    var waiter: CheckedContinuation<String, Error>?
    var closed = false
    var automatic = true
    let device = "85317ef8-8656-4417-b61f-ae20a1be924b"
    var rules: [[String: String]] = [
        ["direction": "send", "message_pattern": "device.*"],
        ["direction": "send", "message_pattern": "call.*"],
        ["direction": "send", "message_pattern": "rtc.*"],
        ["direction": "receive", "message_pattern": "device.*"],
        ["direction": "receive", "message_pattern": "rtc.*"],
        ["direction": "receive", "message_pattern": "call.ice_config"]
    ]

    func send(_ text: String) async throws {
        guard !closed else { throw NativeError.network }
        let message = try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
        sent.append(message)
        guard automatic else { return }
        switch message["type"] as? String {
        case "device.register": reply(message, payload: ["device_id": device])
        case "native.bridge_policy": reply(message, payload: ["restrictions": rules])
        case "call.current": reply(message, payload: ["call": NSNull()])
        default: break
        }
    }

    func receive() async throws -> String {
        if !inbound.isEmpty { return inbound.removeFirst() }
        if closed { throw NativeError.network }
        return try await withCheckedThrowingContinuation { waiter = $0 }
    }

    func push(_ value: [String: Any]) {
        let raw = String(decoding: try! JSONSerialization.data(withJSONObject: value), as: UTF8.self)
        if let waiter { self.waiter = nil; waiter.resume(returning: raw) }
        else { inbound.append(raw) }
    }
    func reply(_ request: [String: Any], payload: [String: Any] = [:], error: String? = nil) {
        var value: [String: Any] = ["type": "response", "request_id": request["request_id"]!]
        if let error { value["error"] = ["code": error, "message": "safe fixture"] }
        else { value["payload"] = payload }
        push(value)
    }
    func close() {
        closed = true
        waiter?.resume(throwing: NativeError.network); waiter = nil
    }
}

@MainActor final class SharedWebSocketTests: XCTestCase {
    let server = try! ServerOrigin("https://chat.example:444")

    private func waitFor(_ predicate: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<5000 {
            if predicate() { return }
            await Task.yield()
        }
        XCTFail("Condition did not become true", file: file, line: line)
    }

    private func start(_ socket: TestSocket) async -> SharedWebSocket {
        let client = SharedWebSocket(server: server, access: { _ in "fixture" }, readDevice: { _ in nil }, saveDevice: { _, _ in }, factory: { request in
            XCTAssertEqual(request.url?.absoluteString, "wss://chat.example:444/ws")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture")
            return socket
        })
        client.attach(cycle: "cycle-1")
        client.start(sessionID: "session-1")
        await waitFor { client.status == "online" }
        return client
    }

    func testPolicySyntaxAndExactPrefixSemantics() throws {
        func policy(_ rules: [[String: String]]) throws -> WebSocketPolicy {
            try WebSocketPolicy(data: JSONSerialization.data(withJSONObject: ["restrictions": rules]))
        }
        let value = try policy([["direction": "send", "message_pattern": "rtc.*"], ["direction": "receive", "message_pattern": "call.ice_config"]])
        XCTAssertFalse(value.allows("send", type: "rtc.offer"))
        XCTAssertTrue(value.allows("send", type: "rtc"))
        XCTAssertTrue(value.allows("receive", type: "rtc.offer"))
        XCTAssertTrue(value.allows("receive", type: "call.updated"))
        XCTAssertFalse(value.allows("receive", type: "call.ice_config"))
        XCTAssertTrue(try policy([]).allows("send", type: "anything.new"))
        for pattern in ["*", "rtc*", "rtc.*.offer", "Rtc.*", "rtc.%", "rtc..offer"] {
            XCTAssertThrowsError(try policy([["direction": "send", "message_pattern": pattern]]))
        }
        XCTAssertThrowsError(try policy([["direction": "unknown", "message_pattern": "rtc.*"]]))
    }

    func testRegistersAndLoadsPolicyBeforeEnablingWeb() async throws {
        let socket = TestSocket()
        let client = await start(socket)
        defer { client.stop() }
        XCTAssertEqual(socket.sent.prefix(3).compactMap { $0["type"] as? String }, ["device.register", "native.bridge_policy", "call.current"])
        for type in ["device.register", "call.create", "rtc.offer"] {
            do {
                try await client.sendWeb(cycle: "cycle-1", message: ["type": type, "request_id": "1", "payload": [:]])
                XCTFail("Forbidden command sent")
            } catch { XCTAssertEqual(error as? NativeError, .forbidden) }
        }
        XCTAssertEqual(socket.sent.count, 3)
        try await client.sendWeb(cycle: "cycle-1", message: ["type": "chat.list", "request_id": "web-1", "payload": [:]])
        XCTAssertNotEqual(socket.sent.last?["request_id"] as? String, "web-1")
    }

    func testCorrelationFilteringAndNativeDeliveryAreIndependent() async throws {
        let socket = TestSocket()
        let client = await start(socket)
        defer { client.stop() }
        var web: [[String: Any]] = []
        var native: [[String: Any]] = []
        client.onWebMessage = { _, message in web.append(message) }
        client.onNativeMessage = { native.append($0) }
        try await client.sendWeb(cycle: "cycle-1", message: ["type": "chat.list", "request_id": "same-id", "payload": [:]])
        let webRequest = socket.sent.last!
        let nativeRequest = Task { try await client.request("call.ice_config", payload: [:]) }
        await waitFor { socket.sent.last?["type"] as? String == "call.ice_config" }
        let iceRequest = socket.sent.last!
        XCTAssertNotEqual(iceRequest["request_id"] as? String, webRequest["request_id"] as? String)
        socket.reply(iceRequest, error: "FORBIDDEN")
        do { _ = try await nativeRequest.value; XCTFail("Expected native error") } catch {}
        socket.reply(webRequest, payload: ["items": []])
        socket.push(["type": "rtc.offer", "payload": ["sdp": "fixture"]])
        socket.push(["type": "call.updated", "payload": [:]])
        await waitFor { native.count == 4 }
        XCTAssertEqual(web.count, 2)
        XCTAssertEqual(web.first?["request_id"] as? String, "same-id")
        XCTAssertEqual(web.last?["type"] as? String, "call.updated")
        XCTAssertEqual(native.count, 4)
    }

    func testCyclesDetachWithoutClosingSocketAndOldResponsesAreDropped() async throws {
        let socket = TestSocket()
        let client = await start(socket)
        defer { client.stop() }
        var web: [[String: Any]] = []
        client.onWebMessage = { _, message in web.append(message) }
        try await client.sendWeb(cycle: "cycle-1", message: ["type": "chat.list", "request_id": "1", "payload": [:]])
        let old = socket.sent.last!
        var receivedWhileDetached = false
        client.onNativeMessage = { _ in receivedWhileDetached = true }
        client.attach(cycle: nil)
        socket.push(["type": "chat.updated", "payload": [:]])
        await waitFor { receivedWhileDetached }
        client.attach(cycle: "cycle-2")
        client.start(sessionID: "session-1")
        socket.reply(old)
        socket.push(["type": "chat.updated", "payload": [:]])
        await waitFor { web.count == 1 }
        XCTAssertFalse(socket.closed)
        XCTAssertEqual(web.first?["type"] as? String, "chat.updated")
        do {
            try await client.sendWeb(cycle: "cycle-1", message: ["type": "chat.list", "request_id": "2", "payload": [:]])
            XCTFail("Old cycle sent a command")
        } catch { XCTAssertEqual(error as? NativeError, .unavailable) }
    }

    func testUnavailablePolicyNeverOpensWebAndLogoutCancelsPendingRequests() async throws {
        let socket = TestSocket()
        socket.automatic = false
        let client = SharedWebSocket(server: server, access: { _ in "fixture" }, readDevice: { _ in nil }, saveDevice: { _, _ in }, factory: { _ in socket })
        client.attach(cycle: "cycle-1")
        client.start(sessionID: "session-1")
        await waitFor { socket.sent.count == 1 }
        socket.reply(socket.sent[0], payload: ["device_id": socket.device])
        await waitFor { socket.sent.count == 2 }
        do {
            try await client.sendWeb(cycle: "cycle-1", message: ["type": "chat.list", "request_id": "1", "payload": [:]])
            XCTFail("Web sent before policy")
        } catch { XCTAssertEqual(error as? NativeError, .unavailable) }
        client.stop()
        XCTAssertTrue(socket.closed)
        XCTAssertEqual(client.status, "offline")
        XCTAssertEqual(socket.sent.count, 2)
    }

    func testSizeAndPendingRequestLimits() async throws {
        let socket = TestSocket()
        let client = await start(socket)
        defer { client.stop() }
        do {
            try await client.sendWeb(cycle: "cycle-1", message: ["type": "chat.send", "request_id": "large", "payload": ["text": String(repeating: "я", count: 70000)]])
            XCTFail("Oversized message sent")
        } catch { XCTAssertEqual(error as? NativeError, .validation) }
        XCTAssertEqual(socket.sent.count, 3)
        try await client.sendWeb(cycle: "cycle-1", message: ["type": "chat.list", "request_id": "1", "payload": [:]])
        do {
            try await client.sendWeb(cycle: "cycle-1", message: ["type": "chat.list", "request_id": "1", "payload": [:]])
            XCTFail("Duplicate in-flight ID accepted")
        } catch { XCTAssertEqual(error as? NativeError, .validation) }
        socket.automatic = false // Keep the request pending until logout; automatic replies race this assertion.
        let task = Task { try await client.request("call.current", payload: [:]) }
        await waitFor { socket.sent.last?["type"] as? String == "call.current" }
        client.stop()
        do { _ = try await task.value; XCTFail("Pending request survived logout") }
        catch { XCTAssertEqual(error as? NativeError, .unavailable) }
    }

    func testRateAndPendingCapacityLimits() async throws {
        let socket = TestSocket()
        let client = await start(socket)
        for index in 0..<32 {
            try await client.sendWeb(cycle: "cycle-1", message: ["type": "chat.list", "request_id": String(index), "payload": [:]])
        }
        do {
            try await client.sendWeb(cycle: "cycle-1", message: ["type": "chat.list", "request_id": "over-limit", "payload": [:]])
            XCTFail("Rate limit bypassed")
        } catch { XCTAssertEqual((error as? AuthFailure)?.code, "RATE_LIMITED") }
        XCTAssertEqual(socket.sent.count, 35)
        client.stop()

        let second = TestSocket()
        let next = await start(second)
        let requests = (0..<129).map { _ in Task { try await next.request("fixture.pending", payload: [:]) } }
        await waitFor { second.sent.count == 131 } // registration + policy + current + 128 pending
        next.stop()
        for task in requests {
            do { _ = try await task.value; XCTFail("Pending request survived stop") }
            catch { XCTAssertEqual(error as? NativeError, .unavailable) }
        }
    }

    func testReconnectRestoresDeviceAndPolicyWithoutRepeatingWebCommand() async throws {
        let first = TestSocket(), second = TestSocket()
        var connections = 0
        var device: String?
        var refreshes: [Bool] = []
        let client = SharedWebSocket(server: server, access: { force in
            refreshes.append(force)
            return "fixture"
        }, readDevice: { _ in device }, saveDevice: { _, value in device = value }, factory: { _ in
            connections += 1
            return connections == 1 ? first : second
        })
        defer { client.stop() }
        client.attach(cycle: "cycle-1")
        client.start(sessionID: "session-1")
        await waitFor { client.status == "online" }
        try await client.sendWeb(cycle: "cycle-1", message: ["type": "chat.send", "request_id": "unknown", "payload": [:]])
        first.close()
        // Production backoff is one second for the first retry.
        try await Task.sleep(nanoseconds: 1_100_000_000)
        await waitFor { connections == 2 && client.status == "online" }
        XCTAssertEqual(refreshes, [false, true])
        XCTAssertEqual((second.sent.first?["payload"] as? [String: Any])?["device_id"] as? String, first.device)
        XCTAssertEqual(second.sent.compactMap { $0["type"] as? String }, ["device.register", "native.bridge_policy", "call.current"])
    }

}
