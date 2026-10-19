import XCTest
@testable import BJJNotes

final class PhotosTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_792_350_000)

    private func video(_ name: String?, _ taken: Date?, _ seconds: Double?) -> ClipFacts {
        ClipFacts(isVideo: true, filename: name, takenAt: taken, duration: seconds)
    }

    func testMatchesByNameAndTime() {
        let shared = video("IMG_1234.MOV", t0, 42.4)
        let library = [
            video("IMG_1233.MOV", t0.addingTimeInterval(-2), 12),
            video("IMG_1234.MOV", t0.addingTimeInterval(0.4), 42.5),
            ClipFacts(isVideo: false, filename: "IMG_1234.HEIC", takenAt: t0, duration: nil),
        ]
        XCTAssertEqual(PhotosMatch.best(for: shared, among: library), 1)
    }

    func testTimeAloneIsEnoughWhenTheNameDiffers() {
        // An edited video is shared as FullSizeRender.mov, but it was taken at the same moment.
        let shared = video("FullSizeRender.mov", t0, 30)
        XCTAssertEqual(PhotosMatch.best(for: shared, among: [video("IMG_9000.MOV", t0.addingTimeInterval(1), 30)]), 0)
    }

    func testAReusedNameFromAnotherDayIsNotAMatch() {
        let shared = video("IMG_0007.MOV", t0, 10)
        XCTAssertNil(PhotosMatch.best(for: shared, among: [video("IMG_0007.MOV", t0.addingTimeInterval(-86_400 * 400), 10)]))
    }

    func testOneWeakHintIsNotEnough() {
        // Only the length matches.
        XCTAssertNil(PhotosMatch.best(for: video(nil, nil, 15), among: [video("IMG_1.MOV", nil, 15)]))
        // With no date on the copy, the name carries it.
        XCTAssertEqual(PhotosMatch.best(for: video("IMG_5.MOV", nil, nil), among: [video("IMG_4.MOV", t0, 1), video("img_5.mov", t0, 1)]), 1)
    }

    func testExifDates() {
        let chicago = TimeZone(identifier: "America/Chicago")!
        XCTAssertEqual(ClipLoader.exifDate("2026:10:19 14:02:11", offset: "-05:00"), ISO8601DateFormatter().date(from: "2026-10-19T19:02:11Z"))
        XCTAssertEqual(ClipLoader.exifDate("2026:10:19 14:02:11", offset: nil, timeZone: chicago), ISO8601DateFormatter().date(from: "2026-10-19T19:02:11Z"))
        XCTAssertNil(ClipLoader.exifDate("", offset: nil))
        XCTAssertNil(ClipLoader.exifDate("yesterday", offset: nil))
    }

    func testOriginalNames() {
        let file = URL(fileURLWithPath: "/tmp/x/IMG_1234.MOV")
        XCTAssertEqual(ClipLoader.filename("IMG_1234", file), "IMG_1234.MOV")
        XCTAssertEqual(ClipLoader.filename("IMG_1234.MOV", file), "IMG_1234.MOV")
        XCTAssertEqual(ClipLoader.filename(nil, file), "IMG_1234.MOV")
    }

    func testCaptureBodyCarriesClipsAndLinks() throws {
        let clip = PendingAttachment(
            kind: "video", photosLocalId: "L/1", photosCloudId: nil, filename: "IMG_1.MOV",
            takenAt: Date(timeIntervalSince1970: 0), durationS: 4.5, width: 1080, height: 1920, thumb: Data([0xFF, 0xD8])
        )
        let note = PendingNote(text: "", url: "https://www.instagram.com/reel/abc/", attachments: [clip], id: "note-0001")
        let body = API.captureBody(note)
        XCTAssertEqual(body["clientId"] as? String, "note-0001")
        XCTAssertEqual(body["url"] as? String, "https://www.instagram.com/reel/abc/")
        let sent = try XCTUnwrap((body["attachments"] as? [[String: Any]])?.first)
        XCTAssertEqual(sent["thumb"] as? String, "/9g=")
        XCTAssertEqual(sent["takenAt"] as? String, "1970-01-01T00:00:00Z")
        XCTAssertEqual(sent["photosLocalId"] as? String, "L/1")
        XCTAssertNil(sent["photosCloudId"])
        XCTAssertNoThrow(try JSONSerialization.data(withJSONObject: body))
    }

    func testReadsAQueueSavedBeforeClipsExisted() throws {
        let old = #"[{"id":"abc-12345","text":"Frames first.","kind":null,"starred":false,"date":"2026-10-18","createdAt":782000000}]"#
        let notes = try JSONDecoder().decode([PendingNote].self, from: Data(old.utf8))
        XCTAssertEqual(notes.first?.text, "Frames first.")
        XCTAssertNil(notes.first?.attachments)
        XCTAssertNil(notes.first?.url)
    }

    func testClipsSavedWithoutTheirOriginalAreQueuedForLinking() {
        let still = Data([1])
        let found = PendingAttachment(kind: "video", photosLocalId: "L/1", photosCloudId: nil, filename: "A.MOV", takenAt: t0, durationS: 3, width: nil, height: nil, thumb: still)
        let missing = PendingAttachment(kind: "photo", photosLocalId: nil, photosCloudId: nil, filename: "B.HEIC", takenAt: t0, durationS: nil, width: nil, height: nil, thumb: still)
        let note = PendingNote(text: "", attachments: [found, missing], id: "note-0002")
        var result = Outbox.FlushResult()
        result.sentNotes = [note]
        result.sent[note.id] = CaptureResponse(note_id: 7, speech: "Saved.", duplicate: false, attachments: [.init(id: 11, linked: true), .init(id: 12, linked: false)])
        XCTAssertEqual(Sync.unlinked(in: result), [PendingLink(attachmentId: 12, isVideo: false, filename: "B.HEIC", takenAt: t0, duration: nil)])
    }
}
