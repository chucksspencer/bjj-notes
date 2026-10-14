# BJJ Notes

A personal jiu-jitsu notebook you can talk to. Techniques are organised as a **position graph** (a sweep takes you from the bottom of a guard to the top; a pass from a guard to a pin; an escape from the bottom of a pin), with dated notes from class, videos and rolling, training sessions, and a ranked **focus list** whose history is kept.

It is one small Node service with three front doors:

| Door | For | Auth |
| --- | --- | --- |
| `/mcp` | Claude (chat or voice) as a custom connector | OAuth 2.1, your password |
| `/api/capture`, `/api/focus` | Siri Shortcuts ("Hey Siri, BJJ note") | Bearer token |
| `/` | The web app: Lab and focus list, technique library, notes, positions, inbox | Your password (stays signed in 90 days) |

The database starts with ~30 positions and your working list from 2026-10-09 (Baratoplata through ankle lock adjustments) as the active focus list, each linked to a technique card.

## Set it up from your phone

Everything below works in a phone browser. Expect about 30 minutes the first time.

### 1. Database (Neon, free)

1. Sign up at [neon.com](https://neon.com) and create a project in a US region (Ohio or N. Virginia are both close to Google's Iowa region).
2. Copy the connection string (`postgresql://…?sslmode=require`).

### 2. Two secrets you make up

- **OWNER_PASSWORD**: 12+ characters. You'll type it once when connecting Claude.
- **API_TOKEN**: 32+ random characters, used by your Siri Shortcuts. A password manager's generator works.

### 3. GitHub secrets

In this repo: **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
| --- | --- |
| `DATABASE_URL` | Neon connection string |
| `OWNER_PASSWORD` | from step 2 |
| `API_TOKEN` | from step 2 |
| `ANTHROPIC_API_KEY` | *Optional.* Lets Siri captures be tidied and filed by Claude (Haiku). Without it, captures link techniques named word-for-word and the rest goes to the inbox. |

### 4. Google Cloud (Cloud Shell, once)

1. Sign in at [console.cloud.google.com](https://console.cloud.google.com). If you've never used Google Cloud, start the free trial first: it asks for a card, gives $300 of credit, and this app stays inside the always-free allowances anyway.
2. Open Cloud Shell (the `>_` icon at the top; also in the Google Cloud iOS app).
3. Run [`infra/gcp-bootstrap.sh`](infra/gcp-bootstrap.sh) by pasting this one line into Cloud Shell (while the repo is public; otherwise copy the raw file in):
   ```
   curl -fsSL https://raw.githubusercontent.com/chucksspencer/bjj-notes/main/infra/gcp-bootstrap.sh | bash
   ```
4. It creates a **BJJ Notes** project, links your billing account, turns on the APIs, and sets up keyless deploys that only GitHub Actions on this repo's `main` branch can use. Re-running it is safe if anything stops halfway.
5. At the end it prints two values, `GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_SERVICE_ACCOUNT`. This repo's are already in `.github/workflows/ci.yml`; for a different project or a fork, replace them there or set repository variables with those names.

### 5. Deploy

1. **Actions → CI → Run workflow** on `main`.
2. When it finishes, the run summary shows the **Claude connector URL**: `https://bjj-notes-<project number>.us-central1.run.app/mcp`.

From then on, every push to `main` tests, builds and deploys. The deploy copies your GitHub secrets into Google Secret Manager (only when they change), so GitHub stays the one place you edit them.

### 6. Connect Claude

On claude.ai in a browser, add a **custom connector** in settings with the connector URL. Claude opens a sign-in page from this server; enter `OWNER_PASSWORD`. Connectors added on the web also show up in the iOS app. Try it in voice mode first: that's the main thing this first version needs to prove.

Try: *"What's on my BJJ focus list?"*, *"Add a note to ghost escape: turn to the knees before the hips"*, *"Move body lock passing to the top of my focus"*, *"What do I have from deep half bottom?"*, *"Undo that."*

### 7. The web app on your phone

Open the server's address in Safari and sign in with `OWNER_PASSWORD`. Then **Share → Add to Home Screen** for an app icon that opens full screen.

- **Focus**: your ranked list. Tap an item to open its technique card; the ••• button moves, pauses, completes, renames or removes it.
- **Library**: every technique, searchable by name, alias or detail (typos are fine), filterable by type and top/bottom. The black bar on each row is its rank bar: one stripe for learning, two for drilling, three for hitting it live, four for reliable.
- **Technique card**: tap the belt's stripes to change status; positions, key details, common mistakes, related techniques and notes, with YouTube videos that play from the saved timestamp.
- **+**: a new note from anywhere. Notes without a technique land in the **Inbox** to file later.
- **Positions**: what you have from each position, top or bottom, the ways in, and the gaps.

Every change shows an **Undo** button, the same undo Claude uses when you say "undo that".

### 8. Siri Shortcuts

Create these in the Shortcuts app. Replace `HOST` with your server address and `TOKEN` with `API_TOKEN`.

**BJJ note** (say "Hey Siri, BJJ note")
1. *Dictate Text*
2. *Get Contents of URL* `https://HOST/api/capture`: Method **POST**; Headers `Authorization` = `Bearer TOKEN`; Request Body **JSON** with `text` = *Dictated Text*
3. *Get Dictionary Value* `speech` from *Contents of URL*
4. *Speak Text*

**BJJ focus**: *Get Contents of URL* `https://HOST/api/focus` (GET, same header) → *Get Dictionary Value* `speech` → *Speak Text*.

**Save to BJJ Notes** (from the share sheet in Instagram, YouTube or Safari)
1. In the shortcut's settings, turn on *Show in Share Sheet*; receive **URLs** and **Text**; if there's no input, **Continue**.
2. *Ask for Input* (Text): "What's the takeaway?" Dictate with the keyboard's mic, or tap Done with nothing to save the link to review later.
3. *Get Contents of URL* `https://HOST/api/capture`: Method **POST**; Request Body **JSON** with `text` = *Provided Input*, `url` = *Shortcut Input* and `token` = your `API_TOKEN` (or send it as the header `Authorization` = `Bearer TOKEN` instead of the `token` field)
4. *Get Dictionary Value* `speech` from *Contents of URL* → *Show Notification*

The server tidies what it's given: share-tracking is stripped (`?igsh=…`, `?si=…`) so the same reel saved twice is one source; a link inside shared text or a dictated note is picked out. Anything shared with a link goes on the **To try** list (in the Lab, under the Focus tab), out of the way until you've tried it: **Keep** files it under a technique, **Toss** deletes it. Reels play in the note when tapped, with *Open in Instagram* beside them.

Shortcuts also run on Apple Watch.

## Your own domain on DreamHost (optional)

The `run.app` address works fine. To use something like `bjj.example.com` with DNS at DreamHost (Cloud Run domain mapping, free certificate; Google labels it preview):

1. In Cloud Shell: `gcloud domains verify example.com`, and follow the link. It asks you to add a **TXT** record; add it in the DreamHost panel's DNS settings and finish verification.
2. `gcloud beta run domain-mappings create --service bjj-notes --domain bjj.example.com --region us-central1`
3. Add the **CNAME** it prints (`bjj` → `ghs.googlehosted.com.`) at DreamHost. The certificate can take up to an hour.
4. Add a repository variable `PUBLIC_URL` = `https://bjj.example.com`, re-run the workflow, then remove and re-add the Claude connector with the new URL (tokens are bound to the URL they were issued for), and update the Siri Shortcuts.

## Costs

Expected bill: $0 apart from optional Anthropic API usage for parsed Siri captures (cents a month).

- **Cloud Run** scales to zero; one person's use is a small fraction of the monthly free allowance (2 million requests, 180,000 vCPU-seconds). It's capped at one instance.
- **Neon** free plan for the database.
- **Artifact Registry** keeps the three newest images, about 0.1 GB, inside the 0.5 GB free allowance.
- **Secret Manager**: 3–4 secrets, inside the free 6 active versions; old versions are destroyed on change.
- **Logging** stays inside the free allowance. Read logs with `gcloud run services logs read bjj-notes --region us-central1`.

The first request after a quiet spell takes a couple of seconds while the container starts. If that bothers you in voice mode, `gcloud run services update bjj-notes --region us-central1 --min-instances 1` keeps one warm for roughly $10 a month.

The image is also built for Arm, so it runs as-is on a cheap VM with Docker Compose if you go that way later; without `DATABASE_URL` it uses an embedded database in `PGLITE_DIR`.

## How it's organised

```
src/
  server.ts          entry point: config, database, migrations, HTTP
  app.ts             routes: OAuth, /mcp (stateless Streamable HTTP), /api, the web app, /healthz
  http/              the web app's sign-in (cookie sessions), JSON API (/api/v1) and static hosting
  shared/api.ts      types shared by the JSON API and the web app
  mcp/server.ts      the 12 MCP tools and the instructions Claude sees
  services/          notes, techniques, focus list, search/positions/review, undo log; views.ts is the read side
  resolve.ts         fuzzy name matching tuned for voice transcription
  auth/              single-user OAuth server (dynamic registration, PKCE, rotating refresh tokens)
  capture.ts         Siri endpoints and the optional Claude parser
web/                 the web app (React, Vite); built into dist/public
db/migrations/       schema, starter positions, your working list
infra/               Google Cloud bootstrap (run once) and deploy (run by CI) scripts
test/                end-to-end tests over HTTP (OAuth, every MCP tool, capture, JSON API) and the web app in Chromium
```

**Data model.** `positions` (with aliases like "100 kilos") · `techniques` (type, role, status, details, mistakes, aliases) · `technique_edges` (from position/role → to position/role) · `technique_links` (chain, counter, variation, setup) · `notes` (dated, kind, where it came from, optional source and video timestamp, inbox flag) · `sources` · `sessions` (a class, seminar, open mat… with optional event name, instructor and location: where notes came from) · `focus_items` + `focus_events` (every add, move, pause and completion, for focus over time) · `activity_log` (powers `undo_last`).

**Name matching.** Voice transcription mangles names, so lookups combine trigram similarity, edit distance and word matching: "barra toe plata" finds Baratoplata, "ghost" finds Ghost escape, but "omoplata" is not mistaken for Baratoplata. Exact names and aliases always win; uncertain matches are reported back rather than guessed.

### MCP tools

| Tool | Does |
| --- | --- |
| `search` | Techniques by fuzzy name / type / role / position / status; notes by full text or where they came from |
| `get_technique` | A card: positions, details, mistakes, related techniques, focus status, recent notes |
| `save_technique` | Create or update a card; add positions, aliases, details, links; star or unstar it |
| `add_note` | Save a dated note linked to techniques and where it came from ("Zen camp seminar by Josh Jones"); unknown techniques go to the inbox |
| `update_note` | Change a note's text, kind, date or where it came from; star or unstar it; mark a question answered |
| `get_inbox`, `file_note` | Triage notes that couldn't be placed; with `to_try`, the To try list ("silly Instagram bullshit") of videos to try before keeping |
| `log_session` | Record a class/seminar/open mat/private; attaches that day's notes; saying the same session twice updates it |
| `get_lab` | The Lab, the short-term working set: starred techniques and notes (stars over 4 weeks old fold away), the To try list, techniques new in the last N days, open questions for coach |
| `clear_stars` | Unstar everything, or only stars older than N days, in one undoable step |
| `get_focus` | Ranked focus list with time since each item's last note, or its history |
| `update_focus` | add / move / resume / pause / backlog / complete / drop |
| `get_position` | What you have from a position, what leads into it, and the gaps |
| `review` | Last N days: sessions, notes, most-noted techniques, quiet focus items |
| `undo_last` | Reverse the most recent change |

## Local development

```
npm install
cp .env.example .env
npm run dev          # server with an embedded database, http://localhost:8080
npm run dev:web      # web app with live reload, http://localhost:5173 (talks to the server above)
npm test             # embedded database
npm run build && E2E=1 npx vitest run test/ui.e2e.test.ts   # the web app in Chromium
TEST_PG_ADMIN_URL=postgres://postgres@localhost:5432/postgres npm test   # against real Postgres
```

## Next

1. Position graph view and focus timeline.
2. Training sessions and a weekly review screen.
3. Offline capture in the web app, and semantic search with pgvector embeddings.
4. Native iOS app with App Intents and a Lock Screen focus widget.
