#!/usr/bin/env bash
# Backs up the database: a compressed pg_dump, checked, then copied to a private Cloud Storage bucket that
# keeps each copy for 30 days (Neon's free plan can only rewind 6 hours). Run nightly by GitHub Actions
# (.github/workflows/backup.yml) once it has authenticated to Google Cloud; also works by hand in Cloud Shell.
#
# Required: DATABASE_URL, and GCP_SERVICE_ACCOUNT (gives the project id), PROJECT_ID or BACKUP_BUCKET.
# Optional: BACKUP_BUCKET (default <project id>-backups, made by infra/gcp-bootstrap.sh).
set -Eeuo pipefail

annotate() { # title, then message on stdin: an error annotation on the GitHub Actions run
  [ -n "${GITHUB_ACTIONS:-}" ] || return 0
  printf '::error title=%s::%s\n' "$1" "$(head -c 3500 | sed -e 's/%/%25/g' -e 's/\r//g' | awk 'BEGIN{ORS="%0A"} {print}')"
}
fail() {
  echo "$*" >&2
  echo "$*" | annotate "Backup failed"
  exit 1
}
trap 'echo "Backup failed at line $LINENO" | annotate "Backup failed"' ERR

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  printf '%s' "${s%"${s##*[![:space:]]}"}"
}

DATABASE_URL="$(trim "${DATABASE_URL:-}")"
[ -n "$DATABASE_URL" ] || fail "DATABASE_URL isn't set (the Neon connection string; a GitHub secret)."
PROJECT_ID="${PROJECT_ID:-$(sed -nE 's/^[^@]+@([^.]+)\.iam\.gserviceaccount\.com$/\1/p' <<<"${GCP_SERVICE_ACCOUNT:-}")}"
BUCKET="${BACKUP_BUCKET:-${PROJECT_ID:+$PROJECT_ID-backups}}"
[ -n "$BUCKET" ] || fail "Can't work out the backup bucket: set BACKUP_BUCKET, PROJECT_ID or GCP_SERVICE_ACCOUNT."

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"
# The PostgreSQL project's own apt repository (signed), for a client of any version.
install_client() {
  echo "Installing the PostgreSQL ${1:-} client"
  if [ ! -x /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh ]; then
    $SUDO apt-get update -qq >/dev/null
    $SUDO apt-get install -y -qq postgresql-common >/dev/null
  fi
  $SUDO /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y >/dev/null
  $SUDO apt-get install -y -qq "postgresql-client${1:+-$1}" >/dev/null
}

# 1. A pg_dump of the server's own major version: an older one refuses to dump a newer server, and a newer
#    one writes things an older server can't restore.
command -v psql >/dev/null || install_client
MAJOR="$(psql "$DATABASE_URL" -XAtc "select current_setting('server_version_num')::int / 10000")"
[[ "$MAJOR" =~ ^[0-9]+$ ]] || fail "Couldn't read the server's version (is DATABASE_URL right?)."
BIN="/usr/lib/postgresql/$MAJOR/bin"
[ -x "$BIN/pg_dump" ] || install_client "$MAJOR"
[ -x "$BIN/pg_dump" ] || fail "No pg_dump for PostgreSQL $MAJOR."

# 2. Dump, then check the archive reads back and has the tables that matter.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
NAME="bjj-notes-$(date -u +%Y-%m-%dT%H%MZ)-pg$MAJOR.dump"
"$BIN/pg_dump" --format=custom --compress=9 --no-owner --no-privileges --file="$WORK/$NAME" "$DATABASE_URL"
LIST="$("$BIN/pg_restore" --list "$WORK/$NAME")"
for table in schema_migrations users notes techniques focus_items sessions; do
  grep -qE "TABLE DATA public $table( |$)" <<<"$LIST" || fail "The backup has no data section for the $table table; not uploading it."
done
read -r PEOPLE NOTES TECHNIQUES < <(psql "$DATABASE_URL" -XAt -F ' ' -c \
  "select (select count(*) from users), (select count(*) from notes), (select count(*) from techniques)")
SIZE="$(du -h "$WORK/$NAME" | cut -f1)"
echo "Dumped $NOTES notes, $TECHNIQUES techniques, $PEOPLE people: $NAME ($SIZE)"

# 3. Upload. The bucket deletes copies after 30 days by itself.
gcloud storage cp --quiet "$WORK/$NAME" "gs://$BUCKET/$NAME" >/dev/null 2>"$WORK/upload.log" || {
  cat "$WORK/upload.log" >&2
  fail "Couldn't upload to gs://$BUCKET. If that bucket doesn't exist yet, run infra/gcp-bootstrap.sh again in Cloud Shell: it creates the bucket and lets the backups write to it."
}
echo "Saved to gs://$BUCKET/$NAME"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Backed up"
    echo "- \`gs://$BUCKET/$NAME\` ($SIZE)"
    echo "- $NOTES notes, $TECHNIQUES techniques, $PEOPLE people (PostgreSQL $MAJOR)"
    echo "- Restore: \`bash infra/restore-backup.sh\` in Cloud Shell (see the README)"
  } >>"$GITHUB_STEP_SUMMARY"
fi
