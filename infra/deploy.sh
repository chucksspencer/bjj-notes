#!/usr/bin/env bash
# Creates or updates the Container App. Run by GitHub Actions (see .github/workflows/ci.yml),
# or by hand from Cloud Shell with the same environment variables set.
#
# Required: IMAGE, DATABASE_URL, OWNER_PASSWORD, API_TOKEN
# Optional: ANTHROPIC_API_KEY, PUBLIC_URL (e.g. https://bjj.yourdomain.com; defaults to the
#           Azure-assigned address), TIME_ZONE, GHCR_USERNAME + GHCR_PULL_TOKEN (for a private image),
#           RESOURCE_GROUP, LOCATION, ENV_NAME, APP_NAME
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-bjj-notes}"
LOCATION="${LOCATION:-centralus}"
ENV_NAME="${ENV_NAME:-bjj-notes-env}"
APP_NAME="${APP_NAME:-bjj-notes}"
TIME_ZONE="${TIME_ZONE:-America/Chicago}"
: "${IMAGE:?IMAGE is required}"
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${OWNER_PASSWORD:?OWNER_PASSWORD is required}"
: "${API_TOKEN:?API_TOKEN is required}"

az extension add --name containerapp --upgrade --only-show-errors >/dev/null

if ! az containerapp env show --name "$ENV_NAME" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  echo "Creating Container Apps environment $ENV_NAME (a few minutes the first time)..."
  # No Log Analytics workspace: keeps the bill at zero. Stream logs with `az containerapp logs show`.
  az containerapp env create --name "$ENV_NAME" --resource-group "$RESOURCE_GROUP" --location "$LOCATION" \
    --logs-destination none --only-show-errors >/dev/null
fi

secrets=("database-url=$DATABASE_URL" "owner-password=$OWNER_PASSWORD" "api-token=$API_TOKEN")
env_vars=(
  "DATABASE_URL=secretref:database-url"
  "OWNER_PASSWORD=secretref:owner-password"
  "API_TOKEN=secretref:api-token"
  "TIME_ZONE=$TIME_ZONE"
)
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  secrets+=("anthropic-api-key=$ANTHROPIC_API_KEY")
  env_vars+=("ANTHROPIC_API_KEY=secretref:anthropic-api-key")
fi
registry=()
if [ -n "${GHCR_PULL_TOKEN:-}" ]; then
  registry=(--registry-server ghcr.io --registry-username "${GHCR_USERNAME:?GHCR_USERNAME is required with GHCR_PULL_TOKEN}" --registry-password "$GHCR_PULL_TOKEN")
fi

if az containerapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  echo "Updating $APP_NAME to $IMAGE..."
  az containerapp secret set --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --secrets "${secrets[@]}" \
    --only-show-errors >/dev/null
  if [ ${#registry[@]} -gt 0 ]; then
    az containerapp registry set --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" \
      --server ghcr.io --username "$GHCR_USERNAME" --password "$GHCR_PULL_TOKEN" --only-show-errors >/dev/null
  fi
  az containerapp update --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --image "$IMAGE" \
    --set-env-vars "${env_vars[@]}" --only-show-errors >/dev/null
else
  echo "Creating $APP_NAME from $IMAGE..."
  az containerapp create --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --environment "$ENV_NAME" \
    --image "$IMAGE" "${registry[@]}" \
    --target-port 8080 --ingress external \
    --min-replicas 0 --max-replicas 1 --cpu 0.25 --memory 0.5Gi \
    --secrets "${secrets[@]}" --env-vars "${env_vars[@]}" --only-show-errors >/dev/null
fi

FQDN="$(az containerapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --query properties.configuration.ingress.fqdn -o tsv)"
URL="${PUBLIC_URL:-https://$FQDN}"
CURRENT="$(az containerapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" \
  --query "properties.template.containers[0].env[?name=='PUBLIC_URL'].value | [0]" -o tsv)"
if [ "$CURRENT" != "$URL" ]; then
  az containerapp update --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --set-env-vars "PUBLIC_URL=$URL" \
    --only-show-errors >/dev/null
fi

echo "Azure address: https://$FQDN"
echo "MCP endpoint for the Claude connector: $URL/mcp"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Deployed"
    echo "- Image: \`$IMAGE\`"
    echo "- Claude connector URL: \`$URL/mcp\`"
    echo "- Siri capture URL: \`$URL/api/capture\`"
  } >>"$GITHUB_STEP_SUMMARY"
fi
