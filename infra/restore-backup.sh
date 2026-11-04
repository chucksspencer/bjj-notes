#!/usr/bin/env bash
# Restores a nightly backup (see infra/backup.sh). Run in Cloud Shell, where you're already signed in:
#
#   bash infra/restore-backup.sh                          # list the backups, newest last
#   bash infra/restore-backup.sh latest  'postgresql://…' # restore the newest into that database
#   bash infra/restore-backup.sh bjj-notes-2026-11-04T0817Z-pg17.dump 'postgresql://…'
#
# Restoring replaces everything in the target database with the backup. Safest is a new, empty Neon branch
# (Neon console → Branches → New branch → copy its connection string): check the result there, then either
# point DATABASE_URL at it or restore into the main branch the same way.
#
# Optional: BACKUP_BUCKET (default <current gcloud project>-backups).
set -Eeuo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
BUCKET="${BACKUP_BUCKET:-$PROJECT_ID-backups}"
[ -n "${BACKUP_BUCKET:-}${PROJECT_ID}" ] || { echo "Set the project first: gcloud config set project <your BJJ Notes project id>" >&2; exit 1; }

BACKUPS="$(gcloud storage ls "gs://$BUCKET/" 2>/dev/null | sed -n 's#^gs://[^/]*/##p' | grep -E '\.dump$' | sort || true)"
if [ $# -eq 0 ]; then
  [ -n "$BACKUPS" ] || { echo "No backups in gs://$BUCKET yet." >&2; exit 1; }
  echo "Backups in gs://$BUCKET (newest last):"
  sed 's/^/  /' <<<"$BACKUPS"
  echo
  echo "Restore one:  bash infra/restore-backup.sh <name or latest> '<target database connection string>'"
  exit 0
fi
[ $# -eq 2 ] || { echo "Usage: bash infra/restore-backup.sh [<name or latest> '<target database connection string>']" >&2; exit 1; }

NAME="$1"
TARGET="$2"
[ "$NAME" != "latest" ] || NAME="$(tail -n 1 <<<"$BACKUPS")"
[ -n "$NAME" ] && grep -qxF "$NAME" <<<"$BACKUPS" || { echo "No backup called '$1' in gs://$BUCKET. Run with no arguments to list them." >&2; exit 1; }
[[ "$TARGET" =~ ^postgres(ql)?:// ]] || { echo "The target should be a connection string (postgresql://…)." >&2; exit 1; }

# The backup's PostgreSQL major version is in its name (…-pg17.dump); restore with the same client.
MAJOR="$(sed -nE 's/.*-pg([0-9]+)\.dump$/\1/p' <<<"$NAME")"
[ -n "$MAJOR" ] || { echo "Can't tell which PostgreSQL version made $NAME." >&2; exit 1; }
BIN="/usr/lib/postgresql/$MAJOR/bin"
if [ ! -x "$BIN/pg_restore" ]; then
  SUDO=""
  [ "$(id -u)" -eq 0 ] || SUDO="sudo"
  echo "Installing the PostgreSQL $MAJOR client"
  if [ ! -x /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh ]; then
    $SUDO apt-get update -qq >/dev/null
    $SUDO apt-get install -y -qq postgresql-common >/dev/null
  fi
  $SUDO /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y >/dev/null
  $SUDO apt-get install -y -qq "postgresql-client-$MAJOR" >/dev/null
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
gcloud storage cp --quiet "gs://$BUCKET/$NAME" "$WORK/$NAME" >/dev/null

# Say where it's going (without the password) and make sure that's meant.
WHERE="$(sed -E 's#^postgres(ql)?://([^:@/]+)(:[^@/]*)?@#postgresql://\2@#; s#\?.*$##' <<<"$TARGET")"
NOW="$("$BIN/psql" "$TARGET" -XAtc "select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'notes'" 2>/dev/null || echo "?")"
echo
echo "Backup:  $NAME"
echo "Target:  $WHERE"
if [ "$NOW" = "1" ]; then
  echo "         It has a BJJ Notes database ($("$BIN/psql" "$TARGET" -XAtc 'select count(*) from notes') notes). Everything in it is replaced."
fi
if [ -z "${RESTORE_CONFIRM:-}" ]; then
  read -r -p "Type RESTORE to go ahead: " RESTORE_CONFIRM
fi
[ "$RESTORE_CONFIRM" = "RESTORE" ] || { echo "Nothing changed."; exit 1; }

# One transaction: it all goes in, or nothing changes.
"$BIN/pg_restore" --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error \
  --dbname="$TARGET" "$WORK/$NAME"
echo "Restored: $("$BIN/psql" "$TARGET" -XAtc 'select count(*) from notes') notes, $("$BIN/psql" "$TARGET" -XAtc 'select count(*) from users') people."
