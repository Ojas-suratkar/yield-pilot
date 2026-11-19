#!/usr/bin/env bash
# Point the API on this laptop at production: Cloud SQL (through the proxy on 127.0.0.1:5433), the Cloud Storage
# bucket, Vertex AI, and the production keys from Secret Manager. Writes backend/.env (gitignored); prints no secret.
set -euo pipefail
cd "$(dirname "$0")/.."
export CLOUDSDK_ACTIVE_CONFIG_NAME=yieldpilot
P=yieldpilot-csulb

[[ -f .env.cloud ]] || { echo "backend/.env.cloud is missing (scripts/set_db_password.sh creates it)."; exit 1; }
secret() { gcloud secrets versions access latest --secret="$1" --project="$P"; }

PSEUDONYM_KEY=$(secret yp-pseudonym-key) JWT_SECRET=$(secret yp-jwt-secret) CONNECTION_KEY=$(secret yp-connection-key) \
MICROSOFT_CLIENT_SECRET=$(secret yp-ms-client-secret) GOOGLE_CLIENT_SECRET=$(secret yp-google-client-secret) \
python3 - <<'PY'
import os, re

def read(path):
    out = {}
    if os.path.exists(path):
        for line in open(path):
            m = re.match(r"^([A-Z_]+)=(.*)$", line.rstrip("\n"))
            if m:
                out[m.group(1)] = re.sub(r"\s+#.*$", "", m.group(2)).strip()
    return out

old, cloud = read(".env"), read(".env.cloud")
env = {
    "ENV": "local",  # only turns on the API docs and the dev sign-in; every service below is production
    "DATABASE_URL": cloud["DATABASE_URL"],
    "GCS_BUCKET": "yieldpilot-csulb-data",
    "GCP_PROJECT": "yieldpilot-csulb",
    "ALLOWED_DOMAINS": "*",
    "MAX_UPLOAD_MB": "500",
    "AUTH_MODE": "dev",
    "FRONTEND_ORIGIN": "http://localhost:5174",
    "SESSION_HOURS": "8",
    "OPERATOR_EMAILS": "mahmoud.albawaneh@csulb.edu;ojasprashant.suratkar-sa@csulb.edu",
    "MICROSOFT_PERSONAL_ACCOUNTS": "true",  # the app registration accepts any organization and personal Microsoft accounts
    "MICROSOFT_CLIENT_ID": old.get("MICROSOFT_CLIENT_ID", ""),
    "GOOGLE_CLIENT_ID": old.get("GOOGLE_CLIENT_ID", ""),
}
for k in ("PSEUDONYM_KEY", "JWT_SECRET", "CONNECTION_KEY", "MICROSOFT_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET"):
    env[k] = os.environ[k]
fd = os.open(".env", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write("# Production services from this laptop. Written by scripts/use_cloud.sh; keys come from Secret Manager.\n")
    f.writelines(f"{k}={v}\n" for k, v in env.items())
PY
echo "backend/.env now points at production (Cloud SQL, Cloud Storage, Vertex AI). Start the API with scripts/dev.sh."
