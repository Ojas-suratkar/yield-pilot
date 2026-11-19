#!/usr/bin/env bash
# Turns on "Continue with Google". First create the OAuth client (Google Cloud console, 2 minutes):
#   1. https://console.cloud.google.com/auth/overview?project=yieldpilot-csulb  -> Get started: app name YieldPilot,
#      support email, audience External, then Create. Under Audience, click Publish app.
#   2. https://console.cloud.google.com/auth/clients/create?project=yieldpilot-csulb  -> Web application
#      Authorized redirect URIs:
#        https://yp-frontend-920963501268.us-central1.run.app/api/auth/google/callback
#        http://localhost:5174/api/auth/google/callback
# Then run this script and paste the client ID and secret when asked (the secret is never echoed or saved in a file).
set -euo pipefail
export CLOUDSDK_ACTIVE_CONFIG_NAME=yieldpilot
PROJECT=yieldpilot-csulb
GITLAB=http://136.111.93.134/api/v4/projects/4
TOKEN=$(cat ~/.config/yieldpilot/gitlab-token)

read -rp "Google OAuth client ID: " CLIENT_ID
read -rsp "Google OAuth client secret: " CLIENT_SECRET; echo

if gcloud secrets describe yp-google-client-secret --project "$PROJECT" >/dev/null 2>&1; then
  printf %s "$CLIENT_SECRET" | gcloud secrets versions add yp-google-client-secret --project "$PROJECT" --data-file=- >/dev/null
else
  printf %s "$CLIENT_SECRET" | gcloud secrets create yp-google-client-secret --project "$PROJECT" --replication-policy=automatic --data-file=- >/dev/null
fi
gcloud secrets add-iam-policy-binding yp-google-client-secret --project "$PROJECT" \
  --member="serviceAccount:yp-backend@$PROJECT.iam.gserviceaccount.com" --role=roles/secretmanager.secretAccessor >/dev/null

curl -sf -X PUT -H "PRIVATE-TOKEN: $TOKEN" "$GITLAB/variables/GOOGLE_CLIENT_ID" --data-urlencode "value=$CLIENT_ID" >/dev/null \
  || curl -sf -X POST -H "PRIVATE-TOKEN: $TOKEN" "$GITLAB/variables" --data-urlencode "key=GOOGLE_CLIENT_ID" --data-urlencode "value=$CLIENT_ID" >/dev/null

# local development uses the same client
ENV_FILE="$(dirname "$0")/../.env"
grep -q '^GOOGLE_CLIENT_ID=' "$ENV_FILE" && sed -i '' "s|^GOOGLE_CLIENT_ID=.*|GOOGLE_CLIENT_ID=$CLIENT_ID|" "$ENV_FILE" || echo "GOOGLE_CLIENT_ID=$CLIENT_ID" >> "$ENV_FILE"
grep -q '^GOOGLE_CLIENT_SECRET=' "$ENV_FILE" && sed -i '' "s|^GOOGLE_CLIENT_SECRET=.*|GOOGLE_CLIENT_SECRET=$CLIENT_SECRET|" "$ENV_FILE" || echo "GOOGLE_CLIENT_SECRET=$CLIENT_SECRET" >> "$ENV_FILE"

curl -sf -X POST -H "PRIVATE-TOKEN: $TOKEN" "$GITLAB/pipeline" --data "ref=main" >/dev/null || echo "Start a pipeline in GitLab (Build > Pipelines > Run pipeline) to deploy."
echo "Saved. A deploy has started; Continue with Google works in about 3 minutes."
