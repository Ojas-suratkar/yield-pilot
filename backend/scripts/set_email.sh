#!/usr/bin/env bash
# Connect the mailbox YieldPilot sends sign-in emails from. It sends you a test email first and saves the settings to
# Secret Manager (yp-smtp) only if that works. Nothing is printed and no deploy is needed (picked up within 5 minutes).
#
#   Gmail / Google Workspace: host smtp.gmail.com, port 465, the full address, and an app password
#     (myaccount.google.com/apppasswords; needs 2-Step Verification).
#   Microsoft 365: host smtp.office365.com, port 587 (SMTP AUTH must be allowed for the mailbox).
#   Amazon SES, SendGrid, Postmark, Mailgun, Brevo: their SMTP host, port 587 and SMTP credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
export CLOUDSDK_ACTIVE_CONFIG_NAME=yieldpilot
P=yieldpilot-csulb

read -rp "SMTP host [smtp.gmail.com]: " HOST; HOST=${HOST:-smtp.gmail.com}
read -rp "Port [465]: " PORT; PORT=${PORT:-465}
read -rp "Username (usually the full email address): " USERNAME
read -rsp "Password or app password: " PASSWORD; echo
read -rp "Send from [$USERNAME]: " FROM; FROM=${FROM:-$USERNAME}
read -rp "Sender name [YieldPilot]: " NAME; NAME=${NAME:-YieldPilot}
read -rp "Send a test email to: " TO

export HOST PORT USERNAME PASSWORD FROM NAME TO
CONFIG=$(.venv/bin/python - <<'PY'
import json, os, smtplib, ssl, sys
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid
e = os.environ
msg = EmailMessage()
msg["From"], msg["To"], msg["Subject"] = formataddr((e["NAME"], e["FROM"])), e["TO"], "YieldPilot email is connected"
msg["Date"], msg["Message-ID"] = formatdate(), make_msgid(domain=e["FROM"].rsplit("@", 1)[-1])
msg.set_content("This is a test from YieldPilot. Sign-in codes will come from this address.\n")
try:
    port = int(e["PORT"])
    if port == 465:
        s = smtplib.SMTP_SSL(e["HOST"], port, context=ssl.create_default_context(), timeout=20)
    else:
        s = smtplib.SMTP(e["HOST"], port, timeout=20); s.starttls(context=ssl.create_default_context())
    s.login(e["USERNAME"], e["PASSWORD"]); s.send_message(msg); s.quit()
except Exception as err:
    print(f"The test email couldn't be sent ({type(err).__name__}). Nothing was saved.", file=sys.stderr)
    sys.exit(1)
print(json.dumps({"host": e["HOST"], "port": port, "username": e["USERNAME"], "password": e["PASSWORD"],
                  "from_email": e["FROM"], "from_name": e["NAME"]}))
PY
)
unset PASSWORD
gcloud secrets describe yp-smtp --project "$P" >/dev/null 2>&1 || gcloud secrets create yp-smtp --project "$P" --replication-policy=automatic --quiet >/dev/null
printf '%s' "$CONFIG" | gcloud secrets versions add yp-smtp --project "$P" --data-file=- --quiet >/dev/null
unset CONFIG
echo "Connected. A test email went to $TO; sign-in codes come from $FROM within 5 minutes."
