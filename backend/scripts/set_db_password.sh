#!/usr/bin/env bash
# Set the Cloud SQL "app" user's password to one you choose, then update Secret Manager and backend/.env.cloud.
set -euo pipefail
cd "$(dirname "$0")/.."
P=yieldpilot-csulb I=yieldpilot-db
export CLOUDSDK_ACTIVE_CONFIG_NAME=yieldpilot

read -rsp "New database password: " PW; echo
read -rsp "Confirm password: " PW2; echo
[[ "$PW" == "$PW2" ]] || { echo "Passwords don't match."; exit 1; }
[[ ${#PW} -ge 16 ]] || { echo "Use at least 16 characters."; exit 1; }

gcloud sql users set-password app --instance="$I" --project="$P" --password="$PW" --quiet
export PW
ENC=$(python3 -c 'import os,urllib.parse;print(urllib.parse.quote(os.environ["PW"],safe=""))')
printf 'postgresql+asyncpg://app:%s@/yieldpilot?host=/cloudsql/%s:us-central1:%s' "$ENC" "$P" "$I" \
  | gcloud secrets versions add yp-database-url --data-file=- --project="$P"
for v in $(gcloud secrets versions list yp-database-url --project="$P" --filter="state=ENABLED" --format="value(name)" | tail -n +2); do
  gcloud secrets versions disable "$v" --secret=yp-database-url --project="$P" --quiet
done
ENC="$ENC" python3 - <<'PY'
import os, re
p = ".env.cloud"
s = open(p).read()
s = re.sub(r"^DB_PASSWORD=.*$", "DB_PASSWORD=" + os.environ["PW"], s, flags=re.M)
s = re.sub(r"^DATABASE_URL=.*$", "DATABASE_URL=postgresql+asyncpg://app:" + os.environ["ENC"] + "@127.0.0.1:5433/yieldpilot", s, flags=re.M)
open(p, "w").write(s)
PY
unset PW PW2
echo "Password updated. Cloud Run picks it up on the next deploy (push to main)."
