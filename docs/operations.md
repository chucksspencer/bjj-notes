# Running BJJ Notes

How the live app is put together, what needs doing now and then, and how to fix the usual problems. Setup from
scratch is in the [README](../README.md); this is for after that. Keep it current when something here changes.

## What's where

| Thing | Where |
| --- | --- |
| The app | https://bjjnotes.chuckspencer.com (the `run.app` address works too) |
| Claude connector | https://bjjnotes.chuckspencer.com/mcp |
| Health check | https://bjjnotes.chuckspencer.com/healthz |
| Code, CI, settings | github.com/chucksspencer/bjj-notes (public). `main` is what's live. |
| Server | Google Cloud Run service `bjj-notes` in `us-central1`: 1 CPU, 512 MiB, at most one instance, scales to zero. The Google Cloud project is labelled `app=bjj-notes` (`gcloud projects list --filter=labels.app=bjj-notes`). |
| Database | Neon Postgres, free plan. Neon itself can rewind only the last 6 hours. |
| Backups | Cloud Storage bucket `<project id>-backups`: one dump a night, each kept 30 days |
| Secrets | GitHub repository secrets; each deploy copies them into Google Secret Manager |
| iPhone app | TestFlight, bundle `com.chucksspencer.bjjnotes`, built on GitHub's Macs. Details in [ios/README.md](../ios/README.md). |
| Domain | DNS at DreamHost: `bjjnotes` CNAME to `ghs.googlehosted.com.`; Google manages the certificate |
| Claude API | An Anthropic Console key, for tidying Siri captures and for search by meaning |

## Settings

**Repository secrets** (Settings → Secrets and variables → Actions). Change one, then run **Actions → CI → Run
workflow** so the deploy copies it to the server.

| Secret | What it is | Changing it |
| --- | --- | --- |
| `DATABASE_URL` | Neon connection string | Reset the role's password in Neon, paste the new string, deploy. |
| `OWNER_PASSWORD` | The owner's password | Deploy; then sign in again with your email and the new one. |
| `API_TOKEN` | The owner's original Siri Shortcut token | Deploy, then update your Shortcuts. Tokens made on Account pages are separate. |
| `ANTHROPIC_API_KEY` | Siri capture tidying and search by meaning | Make a new key in the Anthropic Console, deploy, delete the old key. |
| `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` | TestFlight uploads | A new App Store Connect API key; see ios/README.md. |

**Repository variables** (same page, Variables tab), all optional:

| Variable | Does |
| --- | --- |
| `PUBLIC_URL` | The address the server calls itself: `https://bjjnotes.chuckspencer.com` |
| `SHARE_SHORTCUT_URL` | iCloud link to the shared "Save to BJJ Notes" Shortcut, offered on iPhone Account pages |
| `SEARCH_MODEL` | Claude model for search by meaning (default `claude-haiku-5-5`), or `off` |
| `TIME_ZONE` | The time zone notes are dated in (default `America/Chicago`) |
| `DEPLOY_DISABLED` | `true` pauses deploys (tests still run) |
| `BACKUP_DISABLED` | `true` pauses nightly backups |
| `BACKUP_BUCKET`, `GCP_REGION`, `GCP_SERVICE_ACCOUNT`, `GCP_WORKLOAD_IDENTITY_PROVIDER` | Only for a different Google Cloud project; this repo's defaults are in the workflows |

## What runs by itself

- **CI** (`.github/workflows/ci.yml`): every push to `main` runs the tests (embedded Postgres, real Postgres 16, the
  web app in Chromium), builds the image and deploys it. Pull requests run the tests only. Deploys can only come
  from `main`: Google Cloud trusts nothing else (Workload Identity Federation).
- **iOS** (`ios.yml`): a push that changes `ios/` builds the app and uploads it to TestFlight; also runs by hand.
- **Backup** (`backup.yml`): every night at 08:17 UTC (2:17am in Madison, 3:17 in summer); also runs by hand.
  The run summary shows the counts it backed up.
- **Dependabot**: weekly update PRs for npm packages, GitHub Actions and the Docker base image, a week after
  release (three weeks for major versions). Merge them when CI is green.
- **Database migrations** run when the server starts: each file in `db/migrations` once, in order, each in its
  own transaction.

## Things that expire

| What | When | What to do |
| --- | --- | --- |
| TestFlight builds | 90 days after upload | Actions → iOS → Run workflow (any push under `ios/` also makes one) |
| Apple Developer Program | Yearly ($99) | Renew in the Apple Developer app, or TestFlight stops |
| Backups | 30 days each | Nothing; the bucket deletes them |
| Invite links | 7 days | Make a new one |
| Sign-ins (web, iPhone app) | 90 days after last use | Sign in again |
| Claude connector sign-in | Refreshes itself; resets if the connector URL changes | Remove and re-add the connector |

## How to

**Ship a change.** Merge its pull request into `main` once CI passes, then watch **Actions → CI** go green. The
new version is live a few minutes later.

**Roll back.** Simplest: on GitHub, **Revert** the pull request and merge the revert; CI deploys the code from
before. For an instant switch while you work it out, in Cloud Shell:

```
gcloud run revisions list --service bjj-notes --region us-central1
gcloud run services update-traffic bjj-notes --region us-central1 --to-revisions <revision>=100
# once a fix is deployed:
gcloud run services update-traffic bjj-notes --region us-central1 --to-latest
```

Rolling back code doesn't roll back the database: migrations only go forward. If a migration was the problem,
fix it with a new migration or restore a backup.

**Restore a backup.** In Cloud Shell, with the repo cloned there:

```
bash infra/restore-backup.sh                          # list them
bash infra/restore-backup.sh latest 'postgresql://…'  # restore the newest into that database
```

It replaces everything in the target and asks you to type `RESTORE`. Restore into a new Neon branch first
(Neon console → Branches → New branch), check it, then point `DATABASE_URL` at that branch and deploy. Anything
added since the backup is lost, so look at what's newer first.

**Look after people.** All on the web app's Account page, as the owner:
- Invite: People → **Invite**, pick their belt, send them the link (good for 7 days).
- Forgotten password: People → ••• → **Make a password reset link** (no email is ever sent; you send the link).
- Remove: People → ••• → **Remove**. Deletes their account and notebook at once; it can't be undone except by
  restoring a backup, which rewinds everyone.
- iPhone app for them: the public TestFlight link (ios/README.md → Sharing it with other people).

**Read the logs.** `gcloud run services logs read bjj-notes --region us-central1` (add `--limit 200`), or Cloud
Console → Cloud Run → bjj-notes → Logs.

**Turn things off without a code change.** Set a repository variable, then deploy: `SEARCH_MODEL=off` (search by
words only; Siri captures stay tidied), `BACKUP_DISABLED=true`, `DEPLOY_DISABLED=true`.

**Make voice mode snappier.** The first request after a quiet spell waits a couple of seconds for the server to
start. `gcloud run services update bjj-notes --region us-central1 --min-instances 1` keeps one running for about
$10 a month; the next deploy puts it back to 0 unless `infra/gcp-deploy.sh` is changed too.

## When something's wrong

| Symptom | Look at |
| --- | --- |
| Nothing loads | `/healthz`. Then Actions (did a deploy fail?) and the logs. |
| Claude can't use BJJ Notes, or keeps asking to sign in | Remove and re-add the connector with the `/mcp` address above. |
| Siri says it couldn't reach BJJ Notes | `/healthz`; the token still exists on the Account page; the Shortcut's address. In the iPhone app, a note said offline is sent later by itself. |
| A deploy failed | The failed step in the Actions run. Usual causes: a missing secret, a failing test, Google Cloud permissions (re-run `infra/gcp-bootstrap.sh`; safe to repeat). |
| A backup failed | The Backup run's log. A missing bucket or permission: re-run `infra/gcp-bootstrap.sh`. |
| Account page says search by meaning failed | The error it shows: usually the Anthropic key or billing. Search keeps working by words meanwhile. |
| The iPhone app won't open after months | The TestFlight build expired: run the iOS workflow. |
| A Dependabot PR fails CI | Read the failure; close it if it's a bad release, and Dependabot tries again with the next one. |

## Decisions so far

- **One small service, about $0 a month.** Node on Cloud Run with Neon's free Postgres. Fewer services are better:
  don't add a new vendor sign-up without a strong reason.
- **People.** Invite-only, everyone's notebook separate down to the database's foreign keys, email and password.
  No email sending: the owner makes reset links.
- **Belts.** The owner picks a belt when inviting and people change their own; the app wears its colours. Signed
  out, and in the icon, it's a black belt with a red bar.
- **Sharing without the iPhone app.** Android: the installed web app is a share target. iPhone: a shared iCloud
  Shortcut, offered on the Account page. The iPhone app has its own share sheet.
- **Backups.** Nightly `pg_dump` (matching the server's Postgres version) to a private bucket, 30 days. The deploy
  account can add backups and see them, but can't delete or overwrite them.
- **Search by meaning.** Claude Haiku rewrites the search into the person's matching cards and likely words, and
  keyword search runs on those; no embeddings, no extra vendor, about a second per search. If it's worth making
  faster: Google's Gemini embedding model through Vertex AI in the same Google Cloud project (no new sign-up,
  pennies) with pgvector in Neon. A Voyage AI version with pgvector is commit `54a76b3` for reference. Avoid
  anything billed by the hour while idle (a Vertex AI endpoint, a GPU).
- **Supply chain.** Lockfile, no npm install scripts, signature checks, third-party Actions pinned to commits,
  Dependabot's one-week wait, keyless deploys from `main` only.

## Working on the code

Changes are made in Claude Code sessions on the repo (or locally): one branch and pull request per change, CI green
before merging. Things to keep true:

- Every notebook query is scoped to the signed-in person (`forUser`, `uid`); new notebook tables get a `user_id`
  and composite foreign keys.
- Migrations are new numbered files in `db/migrations`, never edits to old ones.
- Changes people make can be undone (`activity_log`, the Undo button, "undo that").
- Names are matched fuzzily, for voice: see `src/resolve.ts`.
- What the app says is short and plain, in the app's own voice.
- New behaviour comes with tests: over HTTP for the server, in Chromium for the web app.
- The README and this file change with the behaviour they describe.
- New GitHub Actions are pinned to a commit; new packages should have been out a while.

## Next

From the README: Siri that searches and answers from your notes, starring by voice, a Lock Screen focus widget, a
position graph view and focus timeline, training sessions and a weekly review screen.
