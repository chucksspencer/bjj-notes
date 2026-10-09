# BJJ Notes

A personal jiu-jitsu notebook you can talk to. Techniques are organised as a **position graph** (a sweep takes you from the bottom of a guard to the top; a pass from a guard to a pin; an escape from the bottom of a pin), with dated notes from class, videos and rolling, training sessions, and a ranked **focus list** whose history is kept.

It is one small Node service with three front doors:

| Door | For | Auth |
| --- | --- | --- |
| `/mcp` | Claude (chat or voice) as a custom connector | OAuth 2.1, your password |
| `/api/capture`, `/api/focus` | Siri Shortcuts ("Hey Siri, BJJ note") | Bearer token |
| *(web UI)* | Browsing, editing, the graph view | Next milestone |

The database starts with ~30 positions and your working list from 2026-10-09 (Baratoplata through ankle lock adjustments) as the active focus list, each linked to a technique card.

## Set it up from your phone

Everything below works in a phone browser. Expect about 30–40 minutes the first time.

### 1. Database (Neon, free)

1. Sign up at [neon.com](https://neon.com) and create a project. Pick a US region close to Azure Central US (e.g. US East).
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
| `GHCR_PULL_TOKEN` | A [classic personal access token](https://github.com/settings/tokens) with only `read:packages`, so Azure can pull the private image |
| `ANTHROPIC_API_KEY` | *Optional.* Lets Siri captures be tidied and filed by Claude (Haiku). Without it, captures link techniques named word-for-word and the rest goes to the inbox. |

### 4. Azure (Cloud Shell, once)

1. Open Cloud Shell (Azure mobile app or [shell.azure.com](https://shell.azure.com)), Bash.
2. Open [`infra/azure-bootstrap.sh`](infra/azure-bootstrap.sh) on GitHub, use **Copy raw file**, paste into Cloud Shell and press return.
3. It creates the `bjj-notes` resource group and a deploy identity that only GitHub Actions on this repo's `main` branch can use (no stored password), then prints three values. Add them as repository secrets: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.

### 5. Deploy

1. **Settings → Secrets and variables → Actions → Variables**: add `DEPLOY_ENABLED` = `true`.
2. **Actions → CI → Run workflow** on `main`.
3. When it finishes, the run summary shows the **Claude connector URL** (`https://bjj-notes.<random>.centralus.azurecontainerapps.io/mcp`).

From then on, every push to `main` tests, builds and deploys.

### 6. Connect Claude

On claude.ai in a browser, add a **custom connector** in settings with the connector URL. Claude opens a sign-in page from this server; enter `OWNER_PASSWORD`. Connectors added on the web also show up in the iOS app. Try it in voice mode first: that's the main thing this first version needs to prove.

Try: *"What's on my BJJ focus list?"*, *"Add a note to ghost escape: turn to the knees before the hips"*, *"Move body lock passing to the top of my focus"*, *"What do I have from deep half bottom?"*, *"Undo that."*

### 7. Siri Shortcuts

Create these in the Shortcuts app. Replace `HOST` with your server address and `TOKEN` with `API_TOKEN`.

**BJJ note** (say "Hey Siri, BJJ note")
1. *Dictate Text*
2. *Get Contents of URL* `https://HOST/api/capture`: Method **POST**; Headers `Authorization` = `Bearer TOKEN`; Request Body **JSON** with `text` = *Dictated Text*
3. *Get Dictionary Value* `speech` from *Contents of URL*
4. *Speak Text*

**BJJ focus**: *Get Contents of URL* `https://HOST/api/focus` (GET, same header) → *Get Dictionary Value* `speech` → *Speak Text*.

**Save to BJJ** (share sheet, for YouTube and Instagram links): enable *Show in Share Sheet* for URLs → *Dictate Text* (your takeaway) → POST to `/api/capture` with JSON `text` = *Dictated Text* and `url` = *Shortcut Input*.

Shortcuts also run on Apple Watch.

## Your own domain on DreamHost (optional)

If your domain's DNS is at DreamHost:

1. In Cloud Shell, get the verification ID:
   `az containerapp show -n bjj-notes -g bjj-notes --query properties.customDomainVerificationId -o tsv`
2. In the DreamHost panel's DNS settings for the domain, add a **CNAME** `bjj` → the Azure address (without `https://`), and a **TXT** `asuid.bjj` → the verification ID.
3. Back in Cloud Shell (free managed certificate):
   ```
   az containerapp hostname add -n bjj-notes -g bjj-notes --hostname bjj.example.com
   az containerapp hostname bind -n bjj-notes -g bjj-notes --environment bjj-notes-env --hostname bjj.example.com --validation-method CNAME
   ```
4. Add a repository variable `PUBLIC_URL` = `https://bjj.example.com`, re-run the workflow, then remove and re-add the Claude connector with the new URL (tokens are bound to the URL they were issued for).

## Costs

Container Apps scales to zero and one person's use fits in its monthly free grant; Neon's free plan covers the database; the image is in GitHub's registry; logs go nowhere by default (stream them with `az containerapp logs show -n bjj-notes -g bjj-notes --follow`). The only running cost is Anthropic API usage for parsed Siri captures, if enabled. The first request after a quiet spell takes a few seconds while the container starts; if that bothers you in voice mode, run `az containerapp update -n bjj-notes -g bjj-notes --min-replicas 1` (a small idle charge).

The image is also built for Arm, so it runs as-is on a cheap VM with Docker Compose if you go that way later; without `DATABASE_URL` it uses an embedded database in `PGLITE_DIR`.

## How it's organised

```
src/
  server.ts          entry point: config, database, migrations, HTTP
  app.ts             routes: OAuth, /mcp (stateless Streamable HTTP), /api, /healthz
  mcp/server.ts      the 12 MCP tools and the instructions Claude sees
  services/          notes, techniques, focus list, search/positions/review, undo log
  resolve.ts         fuzzy name matching tuned for voice transcription
  auth/              single-user OAuth server (dynamic registration, PKCE, rotating refresh tokens)
  capture.ts         Siri endpoints and the optional Claude parser
db/migrations/       schema, starter positions, your working list
infra/               Azure bootstrap and deploy scripts
test/                end-to-end tests over HTTP: OAuth flow, every MCP tool, capture API
```

**Data model.** `positions` (with aliases like "100 kilos") · `techniques` (type, role, status, details, mistakes, aliases) · `technique_edges` (from position/role → to position/role) · `technique_links` (chain, counter, variation, setup) · `notes` (dated, kind, optional source and video timestamp, inbox flag) · `sources` · `sessions` · `focus_items` + `focus_events` (every add, move, pause and completion, for focus over time) · `activity_log` (powers `undo_last`).

**Name matching.** Voice transcription mangles names, so lookups combine trigram similarity, edit distance and word matching: "barra toe plata" finds Baratoplata, "ghost" finds Ghost escape, but "omoplata" is not mistaken for Baratoplata. Exact names and aliases always win; uncertain matches are reported back rather than guessed.

### MCP tools

| Tool | Does |
| --- | --- |
| `search` | Techniques by fuzzy name / type / role / position / status; notes by full text |
| `get_technique` | A card: positions, details, mistakes, related techniques, focus status, recent notes |
| `save_technique` | Create or update a card; add positions, aliases, details, links |
| `add_note` | Save a dated note linked to techniques; unknown techniques go to the inbox |
| `get_inbox`, `file_note` | Triage notes that couldn't be placed |
| `log_session` | Record a class/open mat/private; attaches that day's notes |
| `get_focus` | Ranked focus list with time since each item's last note, or its history |
| `update_focus` | add / move / resume / pause / backlog / complete / drop |
| `get_position` | What you have from a position, what leads into it, and the gaps |
| `review` | Last N days: sessions, notes, most-noted techniques, quiet focus items |
| `undo_last` | Reverse the most recent change |

## Local development

```
npm install
cp .env.example .env
npm run dev          # embedded database, http://localhost:8080
npm test             # embedded database
TEST_PG_ADMIN_URL=postgres://postgres@localhost:5432/postgres npm test   # against real Postgres
```

## Next

1. Web UI: library, technique pages with embedded videos at timestamps, focus board, inbox triage.
2. Position graph view and focus timeline.
3. Semantic search with pgvector embeddings.
4. Native iOS app with App Intents, a Lock Screen focus widget and offline capture.
