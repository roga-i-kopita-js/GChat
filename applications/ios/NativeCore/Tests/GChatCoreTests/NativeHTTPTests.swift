import XCTest
@testable import GChatCore

private final class HTTPFixture: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        let path = request.url!.path
        if path == "/slow" { return }
        if path == "/timeout" { client?.urlProtocol(self, didFailWithError: URLError(.timedOut)); return }
        if path == "/offline" { client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)); return }
        let statuses = ["/empty": 204, "/not-modified": 304, "/error": 422, "/redirect": 302, "/not-modified-large": 304]
        var headers = ["Content-Type": "application/octet-stream", "Set-Cookie": "secret=1", "Set-Cookie2": "secret=2", "X-Fixture": "yes"]
        if ["/head-large", "/not-modified-large", "/declared-large"].contains(path) { headers["Content-Length"] = String(NativeHTTPRequest.bodyLimit + 1) }
        let response = HTTPURLResponse(url: request.url!, statusCode: statuses[path] ?? 200, httpVersion: "HTTP/1.1",
            headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if ["/head-large", "/not-modified-large", "/declared-large"].contains(path) { client?.urlProtocolDidFinishLoading(self); return }
        if path == "/large" {
            for _ in 0..<129 { client?.urlProtocol(self, didLoad: Data(repeating: 0, count: 65536)) }
        } else if !["/empty", "/not-modified"].contains(path) { client?.urlProtocol(self, didLoad: Data([0, 1, 2, 255])) }
        client?.urlProtocolDidFinishLoading(self)
    }
}

final class NativeHTTPTests: XCTestCase {
    private let cycle = UUID().uuidString.lowercased()
    private var server: ServerOrigin { try! ServerOrigin("https://gchat.test") }
    private func envelope(_ path: String = "/bytes", id: String = UUID().uuidString.lowercased(),
                          headers: [[String]] = [], body: Any = NSNull(), method: String = "GET") -> [String: Any] {
        ["httpVersion": 1, "cycleId": cycle, "requestId": id,
         "request": ["url": path, "method": method, "headers": headers, "bodyBase64": body]]
    }
    private func failure(_ value: [String: Any], _ code: String) {
        XCTAssertThrowsError(try NativeHTTPRequest(value, server: server)) { XCTAssertEqual(($0 as? NativeHTTPFailure)?.code, code) }
    }

    func testOriginEnvelopeHeadersAndAuthBoundary() throws {
        for path in ["http://gchat.test/api", "https://evil.test/api", "//evil.test/api", "https://u:p@gchat.test/api", "/api#fragment"] {
            failure(envelope(path), "INVALID_ARGUMENT")
        }
        failure(envelope("/api/auth/login"), "FORBIDDEN")
        failure(envelope("/api/auth/refresh"), "FORBIDDEN")
        for path in ["/api/auth", "/api/%61uth/login", "/api/x/../auth/login", "/api//auth/login", "/api%2fauth%2flogin"] { failure(envelope(path), "FORBIDDEN") }
        for header in [["Cookie", "x=1"], ["Host", "evil.test"], ["X-Test", "a\r\nb"], ["bad name", "x"], ["Content-Length", "20"]] {
            failure(envelope(headers: [header]), "INVALID_ARGUMENT")
        }
        failure(envelope(headers: [["Authorization", "x"], ["authorization", "y"]]), "INVALID_ARGUMENT")
        var value = envelope(); value["extra"] = true; failure(value, "INVALID_ARGUMENT")
        value = envelope(); value["httpVersion"] = true; failure(value, "INVALID_ARGUMENT")
        value["httpVersion"] = 2; failure(value, "UNSUPPORTED_VERSION")
        failure(envelope(method: "TRACE"), "INVALID_ARGUMENT")
        failure(envelope(body: "AA=="), "INVALID_ARGUMENT")
        failure(envelope(body: "not base64", method: "POST"), "INVALID_ARGUMENT")
    }

    func testNativeTokenReplacesWebTokenWithoutCookies() throws {
        let value = try NativeHTTPRequest(envelope(headers: [["Authorization", "Bearer untrusted"], ["X-Test", "ok"]]), server: server)
        let request = try value.urlRequest(accessToken: "native-token")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer native-token")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Test"), "ok")
        XCTAssertFalse(request.httpShouldHandleCookies)
        XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalCacheData)
        XCTAssertThrowsError(try value.urlRequest(accessToken: nil)) { XCTAssertEqual(($0 as? NativeHTTPFailure)?.code, "UNAUTHENTICATED") }
        let publicRequest = try NativeHTTPRequest(envelope(), server: server).urlRequest(accessToken: "unused")
        XCTAssertNil(publicRequest.value(forHTTPHeaderField: "Authorization"))
    }

    func testRequestBodyLimitAndEmptyPost() throws {
        let bytes = Data(repeating: 0, count: NativeHTTPRequest.bodyLimit)
        XCTAssertEqual(try NativeHTTPRequest(envelope(body: bytes.base64EncodedString(), method: "POST"), server: server).body?.count, bytes.count)
        failure(envelope(body: (bytes + Data([0])).base64EncodedString(), method: "POST"), "UNSUPPORTED")
        XCTAssertEqual(try NativeHTTPRequest(envelope(body: "", method: "POST"), server: server).body, Data())
    }

    @MainActor func testHTTPStatusesBinaryAndCookieFiltering() async throws {
        let bridge = NativeHTTPBridge(server: server, protocolClasses: [HTTPFixture.self])
        bridge.activate(cycle: cycle)
        for (path, status) in [("/bytes", 200), ("/empty", 204), ("/not-modified", 304), ("/error", 422)] {
            let value = envelope(path)
            let response = try await bridge.execute(value) { XCTFail("Public request must not read session"); return nil }
            XCTAssertEqual(response["requestId"] as? String, value["requestId"] as? String)
            let result = try XCTUnwrap(response["result"] as? [String: Any])
            XCTAssertEqual(result["status"] as? Int, status)
            XCTAssertEqual(result["statusText"] as? String, "")
            XCTAssertEqual(result["bodyBase64"] as? String, [204, 304].contains(status) ? "" : "AAEC/w==")
            let headers = try XCTUnwrap(result["headers"] as? [[String]])
            XCTAssertFalse(headers.contains { $0[0].lowercased().hasPrefix("set-cookie") })
        }
    }

    @MainActor func testBodylessResponsesDoNotApplyRepresentationSizeLimit() async throws {
        let bridge = NativeHTTPBridge(server: server, protocolClasses: [HTTPFixture.self]); bridge.activate(cycle: cycle)
        for (path, method, status) in [("/head-large", "HEAD", 200), ("/not-modified-large", "GET", 304)] {
            let response = try await bridge.execute(envelope(path, method: method)) { nil }
            let result = try XCTUnwrap(response["result"] as? [String: Any])
            XCTAssertEqual(result["status"] as? Int, status)
            XCTAssertEqual(result["bodyBase64"] as? String, "")
        }
        do { _ = try await bridge.execute(envelope("/declared-large")) { nil }; XCTFail("GET must enforce declared body size") }
        catch { XCTAssertEqual((error as? NativeHTTPFailure)?.code, "UNSUPPORTED") }
    }

    @MainActor func testResetDuringTokenReadCannotSendOrRemoveNewRequest() async throws {
        let bridge = NativeHTTPBridge(server: server, protocolClasses: [HTTPFixture.self]); bridge.activate(cycle: cycle)
        let id = UUID().uuidString
        let started = expectation(description: "Token lookup started")
        var release: CheckedContinuation<String?, Never>?
        let old = Task {
            try await bridge.execute(envelope("/slow", id: id, headers: [["Authorization", "marker"]])) {
                await withCheckedContinuation { release = $0; started.fulfill() }
            }
        }
        await fulfillment(of: [started], timeout: 2)
        bridge.reset(); bridge.activate(cycle: cycle)
        let next = try await bridge.execute(envelope(id: id)) { nil }
        XCTAssertNotNil(next["result"])
        release?.resume(returning: "native-token")
        do { _ = try await old.value; XCTFail("Old context must be cancelled") }
        catch { XCTAssertEqual((error as? NativeHTTPFailure)?.code, "CANCELLED") }
        let after = try await bridge.execute(envelope()) { nil }
        XCTAssertNotNil(after["result"])
    }

    @MainActor func testWireIdentifiersPreserveCaseAndActiveDuplicateIsRejected() async throws {
        let bridge = NativeHTTPBridge(server: server, protocolClasses: [HTTPFixture.self]); bridge.activate(cycle: cycle)
        var upper = envelope()
        upper["cycleId"] = cycle.uppercased()
        upper["requestId"] = UUID().uuidString.uppercased()
        let result = try await bridge.execute(upper) { nil }
        XCTAssertEqual(result["cycleId"] as? String, upper["cycleId"] as? String)
        XCTAssertEqual(result["requestId"] as? String, upper["requestId"] as? String)
        let request = envelope("/slow")
        let pending = Task { try await bridge.execute(request) { nil } }
        try await Task.sleep(for: .milliseconds(30))
        do { _ = try await bridge.execute(request) { nil }; XCTFail("Duplicate must not start") }
        catch { XCTAssertEqual((error as? NativeHTTPFailure)?.code, "INVALID_ARGUMENT") }
        try bridge.cancel(["httpVersion": 1, "cycleId": cycle, "requestId": request["requestId"]!])
        do { _ = try await pending.value; XCTFail("Expected cancellation") }
        catch { XCTAssertEqual((error as? NativeHTTPFailure)?.kind, "aborted") }
    }

    @MainActor func testLimitRedirectTimeoutAndNetworkFailure() async throws {
        let bridge = NativeHTTPBridge(server: server, protocolClasses: [HTTPFixture.self]); bridge.activate(cycle: cycle)
        for (path, kind, code) in [("/large", "unsupported", "UNSUPPORTED"), ("/redirect", "network", "NETWORK_ERROR"), ("/timeout", "timeout", "TIMEOUT"), ("/offline", "network", "NETWORK_ERROR")] {
            do { _ = try await bridge.execute(envelope(path)) { nil }; XCTFail("Expected rejection") }
            catch {
                let failure = try XCTUnwrap(error as? NativeHTTPFailure)
                XCTAssertEqual(failure.kind, kind); XCTAssertEqual(failure.code, code)
                XCTAssertEqual(Set(failure.json.keys), ["kind", "code"])
                if path == "/offline" { XCTAssertEqual(failure.diagnosticTransportCode, NSURLErrorNotConnectedToInternet) }
            }
        }
    }

    @MainActor func testCancellationBeforeRegistrationAndCycleReset() async throws {
        let bridge = NativeHTTPBridge(server: server, protocolClasses: [HTTPFixture.self]); bridge.activate(cycle: cycle)
        let request = envelope()
        let cancel: [String: Any] = ["httpVersion": 1, "cycleId": cycle, "requestId": request["requestId"]!]
        try bridge.cancel(cancel); try bridge.cancel(cancel)
        do { _ = try await bridge.execute(request) { nil }; XCTFail("Expected cancellation") }
        catch { XCTAssertEqual((error as? NativeHTTPFailure)?.kind, "aborted") }
        let next = try await bridge.execute(envelope()) { nil }
        XCTAssertNotNil(next["result"])
        bridge.activate(cycle: UUID().uuidString)
        do { _ = try await bridge.execute(envelope()) { nil }; XCTFail("Old cycle") }
        catch { XCTAssertEqual((error as? NativeHTTPFailure)?.kind, "aborted") }
    }

    @MainActor func testActiveCancellationAndResetDoNotBlockNextCycle() async throws {
        for reset in [false, true] {
            let bridge = NativeHTTPBridge(server: server, protocolClasses: [HTTPFixture.self]); bridge.activate(cycle: cycle)
            let request = envelope("/slow")
            let pending = Task { try await bridge.execute(request) { nil } }
            try await Task.sleep(for: .milliseconds(30))
            if reset { bridge.reset() }
            else { try bridge.cancel(["httpVersion": 1, "cycleId": cycle, "requestId": request["requestId"]!]) }
            do { _ = try await pending.value; XCTFail("Expected cancellation") }
            catch { XCTAssertEqual((error as? NativeHTTPFailure)?.kind, "aborted") }
            bridge.activate(cycle: cycle)
            let next = try await bridge.execute(envelope()) { nil }
            XCTAssertNotNil(next["result"])
        }
    }
}
