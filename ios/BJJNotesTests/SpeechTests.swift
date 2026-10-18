import XCTest
@testable import BJJNotes

final class SpeechTests: XCTestCase {
    func testListsReadNaturally() {
        XCTAssertEqual(Speech.list([]), "")
        XCTAssertEqual(Speech.list(["Kimura"]), "Kimura")
        XCTAssertEqual(Speech.list(["Kimura", "Armbar"]), "Kimura and Armbar")
        XCTAssertEqual(Speech.list(["Kimura", "Armbar", "Triangle"]), "Kimura, Armbar and Triangle")
    }

    func testFocusReadsTheTopThreeInRankOrder() {
        let item = { (rank: Int, label: String) in FocusItem(id: rank, label: label, goal: nil, rank: rank, lastNoteOn: nil) }
        XCTAssertEqual(Speech.focus(FocusView(today: "2026-10-18", active: [])), "Your focus list is empty.")
        XCTAssertEqual(Speech.focus(FocusView(today: "2026-10-18", active: [item(1, "Baratoplata")])), "Your focus is Baratoplata.")
        let five = FocusView(today: "2026-10-18", active: [item(2, "Body lock passing"), item(1, "Baratoplata"), item(3, "Ghost escape"), item(4, "Leg elevation"), item(5, "Shoulder crunch")])
        XCTAssertEqual(Speech.focus(five), "Your focus is Baratoplata, then Body lock passing, then Ghost escape. 2 more on the list.")
    }

    /// The Lab as the server sends it (GET /api/v1/lab), extra fields and all.
    func testLabFromServerJSON() throws {
        let json = """
        {"today":"2026-10-18","days":30,"starDays":28,"questionDays":60,
         "starred":{"techniques":[{"id":1,"name":"Ghost escape","type":"escape","role":"bottom","status":"learning","aliases":[],"starred":true,"starredAt":"2026-10-17T12:00:00Z","noteCount":2,"lastNoteOn":null,"firstNoteOn":null,"edges":[]}],
                    "notes":[{"id":9,"body":"Hips before knees.","kind":"instruction","observedOn":"2026-10-17","techniques":[{"id":1,"name":"Ghost escape","type":"escape","role":"bottom","status":"learning"}],"rawText":null,"source":null}]},
         "olderStarred":{"techniques":[],"notes":[]},
         "toTry":{"total":3,"notes":[]},
         "fresh":[{"id":4,"name":"Toreando pass","status":"seen"}],
         "questions":[{"id":12,"body":"Underhook first?","kind":"question","observedOn":"2026-10-16","techniques":[]}],
         "olderQuestions":[]}
        """
        let lab = try JSONDecoder().decode(LabView.self, from: Data(json.utf8))
        XCTAssertEqual(
            Speech.lab(lab),
            "In your lab: 2 starred, 3 to try, 1 new technique and 1 question for coach. Starred: Ghost escape and 1 note."
        )
        let empty = LabView(today: "2026-10-18", days: 30, starred: .init(techniques: [], notes: []), toTry: .init(total: 0, notes: []), fresh: [], questions: [])
        XCTAssertEqual(Speech.lab(empty), "Nothing in your lab right now.")
    }

    func testOfflineReplies() {
        XCTAssertEqual(Speech.savedOffline(APIError(kind: .offline, message: "")), "Saved on your phone. It'll go to BJJ Notes when you're back online.")
        XCTAssertEqual(Speech.savedOffline(APIError(kind: .notSignedIn, message: "")), "Saved on your phone. Open BJJ Notes and sign in, and it'll be sent.")
    }
}
