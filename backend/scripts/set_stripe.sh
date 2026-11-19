#!/usr/bin/env bash
# Connect Stripe: checks the key, stores it in Secret Manager, registers YieldPilot's webhook with Stripe and stores its signing
# secret too. No key is printed and no deploy is needed: the API reads both within 5 minutes. Safe to run again.
# Use a test key (sk_test_...) first; run again with the live key (sk_live_...) when ready.
set -euo pipefail
cd "$(dirname "$0")/.."
export CLOUDSDK_ACTIVE_CONFIG_NAME=yieldpilot
P=yieldpilot-csulb
export SITE=${SITE:-https://yp-frontend-920963501268.us-central1.run.app}

echo "Nothing appears on screen while you paste. Paste the key once, then press Enter."
read -rsp "Stripe secret key (sk_test_... first, sk_live_... when ready): " STRIPE_KEY; echo
export STRIPE_KEY

store() {  # name, value on stdin
  gcloud secrets describe "$1" --project "$P" >/dev/null 2>&1 || gcloud secrets create "$1" --project "$P" --replication-policy=automatic --quiet >/dev/null
  gcloud secrets versions add "$1" --project "$P" --data-file=- --quiet >/dev/null
}

# Prints only the new signing secret, which is captured here and never shown. The old webhook at this address goes first:
# Stripe gives out a signing secret only when a webhook is created, and two webhooks would deliver every event twice.
SIGNING=$(.venv/bin/python - <<'PY'
import os, sys
import httpx

key, url = os.environ["STRIPE_KEY"].strip(), os.environ["SITE"].rstrip("/") + "/api/v1/billing/webhook"
if not key.startswith(("sk_", "rk_")):
    sys.exit("That doesn't look like a Stripe secret key. It starts with sk_test_ or sk_live_.")
if key.count("_test_") + key.count("_live_") > 1:
    sys.exit("The key went in more than once. Run this again, paste it once and press Enter.")
stripe = httpx.Client(base_url="https://api.stripe.com/v1", auth=(key, ""), timeout=30)
me = stripe.get("/account")
if me.status_code != 200:
    sys.exit("Stripe refused that key: " + str((me.json().get("error") or {}).get("message")))
account = me.json()
print("Stripe account:", ((account.get("settings") or {}).get("dashboard") or {}).get("display_name") or account.get("id"), "(test mode)" if "_test_" in key else "(LIVE: real money)", file=sys.stderr)
for hook in stripe.get("/webhook_endpoints", params={"limit": 100}).json().get("data", []):
    if hook.get("url") == url:
        stripe.delete(f"/webhook_endpoints/{hook['id']}")
events = ["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
          "invoice.paid", "invoice.finalized", "invoice.payment_failed", "invoice.voided", "invoice.marked_uncollectible"]
made = stripe.post("/webhook_endpoints", data={"url": url, "description": "YieldPilot", **{f"enabled_events[{i}]": e for i, e in enumerate(events)}}).json()
if not made.get("secret"):
    sys.exit("Stripe refused the webhook: " + str((made.get("error") or {}).get("message")))
sys.stdout.write(made["secret"])
PY
)

printf '%s' "$STRIPE_KEY" | store yp-stripe-secret-key
printf '%s' "$SIGNING" | store yp-stripe-webhook-secret
unset STRIPE_KEY SIGNING
echo "Stripe is connected. The key and webhook secret are in Secret Manager, and plan checkout turns on within 5 minutes."
