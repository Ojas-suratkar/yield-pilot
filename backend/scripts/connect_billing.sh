#!/usr/bin/env bash
# Run once. Prepares what the operator dashboard needs to show what Google actually charged:
#   1. a BigQuery dataset for Google's billing export
#   2. read access to only that dataset for the API, plus permission to run queries
#   3. read access to Google's usage meters (Cloud Monitoring), for each service's billed instance time
# Then it opens the billing page for the one step Google only allows by hand. Safe to run again.
set -euo pipefail
export CLOUDSDK_ACTIVE_CONFIG_NAME=yieldpilot
P=yieldpilot-csulb
SA="yp-backend@$P.iam.gserviceaccount.com"
URL="https://console.cloud.google.com/billing/012AD0-B00ABC-55B7C3/export"

bq --project_id="$P" show billing_export >/dev/null 2>&1 || bq --project_id="$P" --location=US mk --dataset billing_export
bq --project_id="$P" query --quiet --use_legacy_sql=false "GRANT \`roles/bigquery.dataViewer\` ON SCHEMA \`$P.billing_export\` TO \"serviceAccount:$SA\""
for ROLE in roles/bigquery.jobUser roles/monitoring.viewer; do
  gcloud projects add-iam-policy-binding "$P" --member="serviceAccount:$SA" --role=$ROLE --condition=None --quiet >/dev/null
done

echo
echo "Ready. On the page that opens:"
echo "  BigQuery export > Standard usage cost > Edit settings"
echo "  Project: $P    Dataset: billing_export    Save"
echo
echo "$URL"
open "$URL" 2>/dev/null || true
