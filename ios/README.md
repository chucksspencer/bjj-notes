# BJJ Notes for iPhone

A small native app around the web app, there for what a web page can't do:

- **Siri.** "Add a note to BJJ Notes", "Ask coach in BJJ Notes", "What's my focus in BJJ Notes",
  "What's in my BJJ Notes lab". They work without building a Shortcut and show up in the Shortcuts
  app, Spotlight and on the Action button.
- **Offline.** A note added with no signal is kept on the phone and sent when you're back online:
  as soon as the connection returns while the app is running, when you open it, or in a background
  refresh. It keeps the day you said it, and a retry can never save it twice.
- **Everything else** is the web app, full screen inside the app. Links to Instagram and YouTube open
  in their own apps.

You sign in once, in the app, with your email and password. Siri and background sync reuse that sign-in,
which stays valid for 90 days after it was last used.

## Getting it onto your phone

New versions are built on GitHub's Macs and delivered through TestFlight; no Xcode needed.

### 1. Join the Apple Developer Program

In the **Apple Developer** app on your iPhone: Account → Enroll ($99/yr). Approval can take up to two
days. Note your **Team ID** (developer.apple.com → Account → Membership details).

### 2. Register the app (developer.apple.com and App Store Connect, in a browser)

1. **Certificates, Identifiers & Profiles → Identifiers → +** → App IDs → App. Description
   `BJJ Notes`, Bundle ID **Explicit** `com.chucksspencer.bjjnotes`. No extra capabilities needed.
2. **App Store Connect → Apps → + → New App.** Platform iOS, name `BJJ Notes` (any name works if
   that's taken; it isn't shown on your phone), language English (U.S.), bundle ID
   `com.chucksspencer.bjjnotes`, SKU `bjjnotes`, access Full.
3. **App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → +.**
   Name `GitHub`, access **Admin** (needed to sign with Apple-managed certificates). Download the
   `.p8` key (it can only be downloaded once) and note the **Key ID** and the **Issuer ID** above
   the list.
4. **TestFlight → Internal Testing → +** a group (say `Me`) and add yourself.

### 3. Give GitHub the keys

GitHub → the repository → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
| --- | --- |
| `APPLE_TEAM_ID` | Team ID from step 1 |
| `ASC_KEY_ID` | Key ID from step 2.3 |
| `ASC_ISSUER_ID` | Issuer ID from step 2.3 |
| `ASC_KEY_P8` | The whole `.p8` file, `-----BEGIN PRIVATE KEY-----` to `-----END PRIVATE KEY-----` |

Then Actions → **iOS** → Run workflow (or push any change under `ios/`). The build uploads to
TestFlight; it shows up in the **TestFlight** app on your phone 10–20 minutes later. Install it,
open it, and sign in.

### 4. Try Siri

"Hey Siri, add a note to BJJ Notes" → it asks "What's the note?" → say it. Turn on airplane mode and
do it again: it says the note is saved on the phone, and it's sent when you're back online.

Every later change pushed to `main` under `ios/` becomes a new TestFlight build automatically.
TestFlight builds expire after 90 days; any new build resets that.

## Working on it

The Xcode project is generated from `project.yml` with [XcodeGen](https://github.com/yonaskolb/XcodeGen):
`brew install xcodegen && xcodegen generate && open BJJNotes.xcodeproj`. The server address is
`BJJ_SERVER_URL` in `project.yml`.

| Folder | What's there |
| --- | --- |
| `BJJNotes/App` | The app: the web app in a web view, the offline screen |
| `BJJNotes/Core` | Server API, sign-in (Keychain), the offline queue (`Outbox`) and sync, what Siri says |
| `BJJNotes/Intents` | Siri actions (App Intents) and their phrases |
| `BJJNotesTests` | Unit tests, run on every build |

The server side is `POST /api/v1/capture` (the same tidy-and-file as the Siri Shortcut, signed in like
the web app, with `clientId`, `date`, `kind` and `starred`), `GET /api/v1/focus` and `GET /api/v1/lab`.
