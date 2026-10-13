#!/usr/bin/env bash
# Deploys an image to Cloud Run. Run by GitHub Actions after it has authenticated to Google Cloud
# (see .github/workflows/ci.yml); can also be run by hand in Cloud Shell with the same variables.
#
# Required: IMAGE (built image, e.g. ghcr.io/owner/bjj-notes:sha-abc), DATABASE_URL, OWNER_PASSWORD, API_TOKEN,
#           GCP_SERVICE_ACCOUNT (deploy account; gives the project id) or PROJECT_ID,
#           GCP_WORKLOAD_IDENTITY_PROVIDER (gives the project number) or PROJECT_NUMBER
# Optional: ANTHROPIC_API_KEY, PUBLIC_URL (custom domain), TIME_ZONE, GCP_REGION, SERVICE
set -Eeuo pipefail

# In GitHub Actions, failures are also reported as an annotation on the run (readable without the logs).
LOG="$(mktemp)"
exec > >(tee -a "$LOG") 2>&1
annotate() { # title, then message on stdin
  [ -n "${GITHUB_ACTIONS:-}" ] || return 0
  printf '::error title=%s::%s\n' "$1" "$(head -c 3500 | sed -e 's/%/%25/g' -e 's/\r//g' | awk 'BEGIN{ORS="%0A"} {print}')"
}
fail() {
  echo "$*" >&2
  echo "$*" | annotate "Deploy stopped"
  exit 1
}
on_err() {
  local code=$?
  tail -n 30 "$LOG" | annotate "Deploy failed at line $1 (exit $code)"
}
trap 'on_err $LINENO' ERR

trim() { # pasted secrets often carry a stray newline or space, which would break logins
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  printf '%s' "${s%"${s##*[![:space:]]}"}"
}

missing=()
for v in IMAGE DATABASE_URL OWNER_PASSWORD API_TOKEN; do
  [ -n "$(trim "${!v:-}")" ] || missing+=("$v")
done
[ ${#missing[@]} -eq 0 ] || fail "Missing GitHub secrets: ${missing[*]} (Settings → Secrets and variables → Actions)"
[[ "$(trim "$DATABASE_URL")" =~ ^postgres(ql)?:// ]] || fail "DATABASE_URL should start with postgresql:// (the Neon connection string)"
[ "$(trim "$OWNER_PASSWORD" | wc -c)" -ge 12 ] || fail "OWNER_PASSWORD must be at least 12 characters"
[ "$(trim "$API_TOKEN" | wc -c)" -ge 32 ] || fail "API_TOKEN must be at least 32 characters"

PROJECT_ID="${PROJECT_ID:-$(sed -E 's/^[^@]+@([^.]+)\.iam\.gserviceaccount\.com$/\1/' <<<"${GCP_SERVICE_ACCOUNT:-}")}"
PROJECT_NUMBER="${PROJECT_NUMBER:-$(sed -nE 's#^projects/([0-9]+)/.*#\1#p' <<<"${GCP_WORKLOAD_IDENTITY_PROVIDER:-}")}"
REGION="${GCP_REGION:-us-central1}"
SERVICE="${SERVICE:-bjj-notes}"
TIME_ZONE="${TIME_ZONE:-America/Chicago}"
RUN_SA="bjj-notes-run@$PROJECT_ID.iam.gserviceaccount.com"
[[ "$PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || fail "Can't work out the project id from GCP_SERVICE_ACCOUNT"
[[ "$PROJECT_NUMBER" =~ ^[0-9]+$ ]] || fail "Can't work out the project number from GCP_WORKLOAD_IDENTITY_PROVIDER"

# 1. Copy the image into Artifact Registry (Cloud Run can't pull from GitHub's registry).
AR_HOST="$REGION-docker.pkg.dev"
TARGET="$AR_HOST/$PROJECT_ID/bjj-notes/app:${IMAGE##*:}"
gcloud auth configure-docker "$AR_HOST" --quiet >/dev/null 2>&1
docker pull --quiet --platform linux/amd64 "$IMAGE" >/dev/null
docker tag "$IMAGE" "$TARGET"
docker push --quiet "$TARGET" >/dev/null
echo "Image: $TARGET"

# 2. Mirror the GitHub secrets into Secret Manager. A new version is added only when a value
#    changes, and older versions are destroyed, so this stays inside the free tier.
sync_secret() {
  local name="$1" value current
  value="$(trim "$2")"
  if ! gcloud secrets describe "$name" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud secrets create "$name" --project="$PROJECT_ID" --replication-policy=automatic --quiet >/dev/null
  fi
  current="$(gcloud secrets versions access latest --secret="$name" --project="$PROJECT_ID" 2>/dev/null || true)"
  if [ "$current" != "$value" ]; then
    printf '%s' "$value" | gcloud secrets versions add "$name" --project="$PROJECT_ID" --data-file=- --quiet >/dev/null
    echo "Secret $name updated"
  fi
  gcloud secrets versions list "$name" --project="$PROJECT_ID" --filter='state=ENABLED' --sort-by='~createTime' \
    --format='value(name.basename())' | tail -n +2 | while read -r old; do
    gcloud secrets versions destroy "$old" --secret="$name" --project="$PROJECT_ID" --quiet >/dev/null
  done
}
sync_secret database-url "$DATABASE_URL"
sync_secret owner-password "$OWNER_PASSWORD"
sync_secret api-token "$API_TOKEN"
SECRETS="DATABASE_URL=database-url:latest,OWNER_PASSWORD=owner-password:latest,API_TOKEN=api-token:latest"
if [ -n "$(trim "${ANTHROPIC_API_KEY:-}")" ]; then
  sync_secret anthropic-api-key "$ANTHROPIC_API_KEY"
  SECRETS="$SECRETS,ANTHROPIC_API_KEY=anthropic-api-key:latest"
fi

# 3. Deploy. The run.app address is predictable, so PUBLIC_URL (the OAuth issuer) is set in the same revision.
URL="${PUBLIC_URL:-https://$SERVICE-$PROJECT_NUMBER.$REGION.run.app}"
URL="${URL%/}"
gcloud run deploy "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --image="$TARGET" \
  --service-account="$RUN_SA" --allow-unauthenticated \
  --port=8080 --cpu=1 --memory=512Mi --concurrency=80 --min-instances=0 --max-instances=1 --cpu-boost --timeout=300 \
  --set-env-vars="PUBLIC_URL=$URL,TIME_ZONE=$TIME_ZONE" --set-secrets="$SECRETS" --quiet

# If the predictable address isn't one of the service's addresses, fall back to the one it reports.
DESCRIBE="$(gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format=json)"
KNOWN="$(jq -r '[.status.url] + ((.metadata.annotations["run.googleapis.com/urls"] // "[]") | fromjson) | .[]' <<<"$DESCRIBE")"
if [ -z "${PUBLIC_URL:-}" ] && ! grep -qxF "$URL" <<<"$KNOWN"; then
  URL="$(jq -r '.status.url' <<<"$DESCRIBE")"
  gcloud run services update "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
    --update-env-vars="PUBLIC_URL=$URL" --quiet
fi

echo "Claude connector URL: $URL/mcp"
echo "Siri capture URL:     $URL/api/capture"
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  echo "::notice title=Deployed::Claude connector URL: $URL/mcp%0ASiri capture URL: $URL/api/capture"
fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Deployed to Cloud Run ($REGION)"
    echo "- Claude connector URL: \`$URL/mcp\`"
    echo "- Siri capture URL: \`$URL/api/capture\`"
    echo "- Image: \`$TARGET\`"
  } >>"$GITHUB_STEP_SUMMARY"
fi
