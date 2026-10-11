#!/usr/bin/env bash
# One-time Google Cloud setup. Paste into Cloud Shell (console.cloud.google.com → the >_ icon).
# Safe to re-run: every step checks before it creates.
#
# Creates a "BJJ Notes" project, links your billing account, turns on the APIs, and sets up
# keyless deploys: GitHub Actions on this repo's main branch can deploy, nothing else can.
# Prints the two values to add as GitHub repository variables.
set -euo pipefail

REGION="${REGION:-us-central1}"
REPO="${REPO:-chucksspencer/bjj-notes}"
REPO_ID="${REPO_ID:-1411991872}" # numeric GitHub id of $REPO; survives renames and can't be squatted

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
retry() { # IAM changes on brand-new service accounts can take a few seconds to propagate
  local n
  for n in 1 2 3 4 5 6; do "$@" >/dev/null 2>&1 && return 0; sleep $((n * 5)); done
  "$@" >/dev/null
}

if [ -z "$(gcloud config get-value account 2>/dev/null)" ]; then
  echo "Cloud Shell isn't signed in to gcloud. Run:  gcloud auth login   then run this script again." >&2
  exit 1
fi

say "Project"
PROJECT_ID="${PROJECT_ID:-$(gcloud projects list --filter='labels.app=bjj-notes' --format='value(projectId)' --limit=1)}"
if [ -z "$PROJECT_ID" ]; then
  PROJECT_ID="bjj-notes-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
  gcloud projects create "$PROJECT_ID" --name="BJJ Notes" --labels=app=bjj-notes
fi
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
gcloud config set project "$PROJECT_ID" >/dev/null 2>&1
echo "$PROJECT_ID ($PROJECT_NUMBER)"

say "Billing"
if [ "$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)')" != "True" ]; then
  mapfile -t ACCOUNTS < <(gcloud billing accounts list --filter='open=true' --format='value(name.basename())')
  if [ "${#ACCOUNTS[@]}" -ne 1 ]; then
    echo "Found ${#ACCOUNTS[@]} open billing accounts, so I can't pick one for you."
    echo "Link one at https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT_ID"
    echo "(no billing account yet? start the free trial at https://console.cloud.google.com/freetrial), then re-run."
    exit 1
  fi
  gcloud billing projects link "$PROJECT_ID" --billing-account="${ACCOUNTS[0]}" >/dev/null
fi
echo "linked"

say "APIs (a minute or two the first time)"
gcloud services enable --project="$PROJECT_ID" \
  run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com cloudresourcemanager.googleapis.com
echo "enabled"

say "Container registry"
if ! gcloud artifacts repositories describe bjj-notes --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud artifacts repositories create bjj-notes --repository-format=docker --location="$REGION" \
    --project="$PROJECT_ID" --description="BJJ Notes images"
fi
# Keep the three newest images so storage stays inside the 0.5 GB free allowance.
POLICY="$(mktemp)"
cat >"$POLICY" <<'JSON'
[
  {"name": "keep-newest", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": 3}},
  {"name": "delete-older", "action": {"type": "Delete"}, "condition": {"tagState": "any", "olderThan": "1d"}}
]
JSON
gcloud artifacts repositories set-cleanup-policies bjj-notes --location="$REGION" --project="$PROJECT_ID" \
  --policy="$POLICY" >/dev/null 2>&1 || echo "(couldn't set the cleanup policy; not required)"
rm -f "$POLICY"
echo "$REGION-docker.pkg.dev/$PROJECT_ID/bjj-notes"

say "Service accounts"
RUN_SA="bjj-notes-run@$PROJECT_ID.iam.gserviceaccount.com"
DEPLOY_SA="bjj-notes-deploy@$PROJECT_ID.iam.gserviceaccount.com"
gcloud iam service-accounts describe "$RUN_SA" --project="$PROJECT_ID" >/dev/null 2>&1 ||
  gcloud iam service-accounts create bjj-notes-run --project="$PROJECT_ID" --display-name="BJJ Notes app"
gcloud iam service-accounts describe "$DEPLOY_SA" --project="$PROJECT_ID" >/dev/null 2>&1 ||
  gcloud iam service-accounts create bjj-notes-deploy --project="$PROJECT_ID" --display-name="BJJ Notes deploys from GitHub"

# The app may read its secrets; the deployer may push images, manage secrets and Cloud Run,
# and launch the service as the app account. All scoped to this project.
retry gcloud projects add-iam-policy-binding "$PROJECT_ID" --condition=None \
  --member="serviceAccount:$RUN_SA" --role=roles/secretmanager.secretAccessor
for role in roles/run.admin roles/artifactregistry.writer roles/secretmanager.admin; do
  retry gcloud projects add-iam-policy-binding "$PROJECT_ID" --condition=None --member="serviceAccount:$DEPLOY_SA" --role="$role"
done
retry gcloud iam service-accounts add-iam-policy-binding "$RUN_SA" --project="$PROJECT_ID" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/iam.serviceAccountUser
echo "ready"

say "GitHub Actions trust (Workload Identity Federation)"
gcloud iam workload-identity-pools describe github --location=global --project="$PROJECT_ID" >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create github --location=global --project="$PROJECT_ID" --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers describe github --workload-identity-pool=github --location=global \
  --project="$PROJECT_ID" >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools providers create-oidc github --workload-identity-pool=github --location=global \
    --project="$PROJECT_ID" --display-name="GitHub" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository_id == '$REPO_ID' && assertion.ref == 'refs/heads/main'"
retry gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --project="$PROJECT_ID" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository_id/$REPO_ID"
echo "only $REPO main can deploy"

say "Done. In GitHub: $REPO → Settings → Secrets and variables → Actions → Variables tab → New repository variable"
echo
echo "  GCP_WORKLOAD_IDENTITY_PROVIDER"
echo "  projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github"
echo
echo "  GCP_SERVICE_ACCOUNT"
echo "  $DEPLOY_SA"
if [ "$REGION" != "us-central1" ]; then
  echo
  echo "  GCP_REGION"
  echo "  $REGION"
fi
echo
echo "Your app's address will be https://bjj-notes-$PROJECT_NUMBER.$REGION.run.app"
