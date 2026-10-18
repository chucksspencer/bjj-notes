import XCTest
@testable import BJJNotes

final class OutboxTests: XCTestCase {
    private func tempURL() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("outbox-\(UUID().uuidString).json")
    }

    private func reply(_ speech: String) -> CaptureResponse {
        CaptureResponse(note_id: 1, speech: speech, duplicate: false)
    }

    func testNotesSurviveARestart() async {
        let url = tempURL()
        let a = PendingNote(text: "Frames first.")
        await Outbox(fileURL: url).add(a)
        let reopened = Outbox(fileURL: url)
        let pending = await reopened.pending
        XCTAssertEqual(pending, [a])
    }

    func testSendsTheNewNoteFirstThenTheRest() async {
        let box = Outbox(fileURL: tempURL())
        let old = PendingNote(text: "Old one.")
        let new = PendingNote(text: "New one.")
        await box.add(old)
        await box.add(new)
        var order: [String] = []
        let result = await box.flush(first: new.id) { note in
            order.append(note.text)
            return self.reply("Saved.")
        }
        XCTAssertEqual(order, ["New one.", "Old one."])
        XCTAssertEqual(result.sent.count, 2)
        let left = await box.count
        XCTAssertEqual(left, 0)
    }

    func testStopsAtAConnectionProblemAndKeepsTheRest() async {
        let box = Outbox(fileURL: tempURL())
        await box.add(PendingNote(text: "One."))
        await box.add(PendingNote(text: "Two."))
        var tries = 0
        let result = await box.flush { _ in
            tries += 1
            throw APIError(kind: .offline, message: "No signal.")
        }
        XCTAssertEqual(tries, 1)
        XCTAssertEqual(result.stoppedBy?.kind, .offline)
        let left = await box.count
        XCTAssertEqual(left, 2)
    }

    func testDropsANoteTheServerRefusesForGood() async {
        let box = Outbox(fileURL: tempURL())
        let bad = PendingNote(text: " ")
        let good = PendingNote(text: "Hips out.")
        await box.add(bad)
        await box.add(good)
        let result = await box.flush { note in
            if note.id == bad.id { throw APIError(kind: .server(400), message: "Nothing to save.") }
            return self.reply("Saved.")
        }
        XCTAssertEqual(result.dropped, [bad])
        XCTAssertNotNil(result.sent[good.id])
        let left = await box.count
        XCTAssertEqual(left, 0)
    }

    func testSignInAndServerTroubleAreRetried() {
        XCTAssertFalse(APIError(kind: .notSignedIn, message: "").isPermanent)
        XCTAssertFalse(APIError(kind: .server(500), message: "").isPermanent)
        XCTAssertFalse(APIError(kind: .server(429), message: "").isPermanent)
        XCTAssertTrue(APIError(kind: .server(400), message: "").isPermanent)
    }

    func testKeepsTheDayItWasCaptured() {
        let lateEvening = Date(timeIntervalSince1970: 1_792_288_800) // 2026-10-18 02:00 UTC, 9pm the day before in Madison
        XCTAssertEqual(PendingNote.day(lateEvening, timeZone: TimeZone(identifier: "America/Chicago")!), "2026-10-17")
        XCTAssertEqual(PendingNote.day(lateEvening, timeZone: TimeZone(identifier: "UTC")!), "2026-10-18")
    }
}
