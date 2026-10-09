#!/usr/bin/env bash
# One-time Azure setup, run in Azure Cloud Shell (works from the Azure mobile app or a phone browser).
#
#   curl -fsSL <raw URL of this file> | bash
#   (or paste it into Cloud Shell)
#
# Creates the resource group and a deployment identity that GitHub Actions can use without
# any stored password (OIDC federated credential), then prints the three values to add as
# GitHub repository secrets. Safe to re-run.
set -euo pipefail

REPO="${REPO:-chucksspencer/bjj-notes}"
RESOURCE_GROUP="${RESOURCE_GROUP:-bjj-notes}"
LOCATION="${LOCATION:-centralus}"
APP_DISPLAY_NAME="${APP_DISPLAY_NAME:-bjj-notes-github-deploy}"

echo "Registering resource providers (first time can take a minute)..."
az provider register --namespace Microsoft.App --wait
az provider register --namespace Microsoft.OperationalInsights --wait

echo "Creating resource group $RESOURCE_GROUP in $LOCATION..."
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --only-show-errors >/dev/null

SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
TENANT_ID="$(az account show --query tenantId -o tsv)"

APP_ID="$(az ad app list --display-name "$APP_DISPLAY_NAME" --query '[0].appId' -o tsv)"
if [ -z "$APP_ID" ]; then
  echo "Creating app registration $APP_DISPLAY_NAME..."
  APP_ID="$(az ad app create --display-name "$APP_DISPLAY_NAME" --query appId -o tsv)"
fi
if ! az ad sp show --id "$APP_ID" >/dev/null 2>&1; then
  az ad sp create --id "$APP_ID" --only-show-errors >/dev/null
  sleep 15 # let the service principal propagate before assigning a role
fi

echo "Granting Contributor on $RESOURCE_GROUP only..."
az role assignment create \
  --assignee "$APP_ID" \
  --role Contributor \
  --scope "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP" \
  --only-show-errors >/dev/null

SUBJECT="repo:${REPO}:ref:refs/heads/main"
if [ -z "$(az ad app federated-credential list --id "$APP_ID" --query "[?subject=='$SUBJECT'].name" -o tsv)" ]; then
  echo "Trusting GitHub Actions runs on $REPO main..."
  az ad app federated-credential create --id "$APP_ID" --parameters "{
    \"name\": \"github-main\",
    \"issuer\": \"https://token.actions.githubusercontent.com\",
    \"subject\": \"$SUBJECT\",
    \"audiences\": [\"api://AzureADTokenExchange\"]
  }" --only-show-errors >/dev/null
fi

cat <<EOF

Done. Add these as GitHub repository secrets (Settings → Secrets and variables → Actions):

  AZURE_CLIENT_ID        $APP_ID
  AZURE_TENANT_ID        $TENANT_ID
  AZURE_SUBSCRIPTION_ID  $SUBSCRIPTION_ID

EOF
