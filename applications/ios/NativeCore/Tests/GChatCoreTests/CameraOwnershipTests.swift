import XCTest
@testable import GChatCore

final class CameraOwnershipTests: XCTestCase {
    func testCallRequiresActualSelectionAndHasAnIndependentLease() throws {
        var owner = CameraOwnership()
        XCTAssertThrowsError(try owner.acquire(call:true)) { XCTAssertEqual(($0 as? DeviceCommandError)?.code,"INVALID_STATE") }
        let call = UUID(); XCTAssertFalse(owner.selectCall(call))
        let session = try owner.acquire(call:true)
        owner.release(session)
        XCTAssertTrue(owner.retained); XCTAssertTrue(owner.hasCall)
        owner.releaseViews(); XCTAssertTrue(owner.retained)
        XCTAssertTrue(owner.selectCall(nil)); XCTAssertFalse(owner.retained)
    }
    func testViewReleaseAndExplicitCloseAreIdempotent() throws {
        var owner = CameraOwnership()
        let one = try owner.acquire(call:false); let two = try owner.acquire(call:false)
        owner.release(one); owner.release(one); XCTAssertTrue(owner.retained)
        owner.release(two); XCTAssertFalse(owner.retained)
        _ = owner.selectCall(UUID()); _ = try owner.acquire(call:true)
        owner.close(); owner.close(); XCTAssertFalse(owner.retained); XCTAssertNotNil(owner.selectedCall)
    }
    func testResyncKeepsCallButMakesOldViewSessionsInvalidAndCallReplacementClosesThem() throws {
        var owner = CameraOwnership(); let call = UUID(); _ = owner.selectCall(call)
        let view = try owner.acquire(call:true)
        owner.releaseViews(); XCTAssertFalse(owner.contains(view)); XCTAssertTrue(owner.hasCall)
        XCTAssertFalse(owner.selectCall(call)); XCTAssertTrue(owner.hasCall)
        let nextView = try owner.acquire(call:false)
        XCTAssertTrue(owner.selectCall(UUID())); XCTAssertFalse(owner.contains(nextView)); XCTAssertFalse(owner.retained)
    }
}
