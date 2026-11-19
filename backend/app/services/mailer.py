"""YieldPilot's own email, sent through a real mailbox over SMTP (Gmail or Google Workspace with an app password, Microsoft
365, Amazon SES, SendGrid, Postmark, Mailgun, ...). Mail from a real mailbox passes SPF, DKIM and DMARC, so it reaches
inboxes (iCloud, Outlook, Yahoo) instead of junk. Settings: the Secret Manager secret yp-smtp (scripts/set_email.sh), JSON
{"host", "port", "username", "password", "from_email", "from_name"}.
"""

import json
import logging
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid

from . import secrets

log = logging.getLogger("yieldpilot.mail")


def _config() -> dict | None:
    raw = secrets.get("yp-smtp")
    try:
        c = json.loads(raw) if raw else None
    except ValueError:
        log.warning("yp-smtp isn't valid JSON")
        return None
    return c if c and c.get("host") and c.get("username") and c.get("password") else None


def ready() -> bool:
    return _config() is not None


def send(to: str, subject: str, text: str, html: str) -> None:
    c = _config()
    if c is None:
        raise RuntimeError("no mailbox connected")
    sender = c.get("from_email") or c["username"]
    msg = EmailMessage()
    msg["From"] = formataddr((c.get("from_name") or "YieldPilot", sender))
    msg["To"] = to
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=False)
    msg["Message-ID"] = make_msgid(domain=sender.rsplit("@", 1)[-1])
    msg["Auto-Submitted"] = "auto-generated"  # a transactional message: no auto-replies
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
    port = int(c.get("port") or 465)
    context = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(c["host"], port, context=context, timeout=20) as s:
            s.login(c["username"], c["password"])
            s.send_message(msg)
    else:
        with smtplib.SMTP(c["host"], port, timeout=20) as s:
            s.starttls(context=context)
            s.login(c["username"], c["password"])
            s.send_message(msg)


def sign_in_email(code: str, link: str) -> tuple[str, str, str]:
    """Subject, plain text and HTML. Plain and short, no images or tracking: what spam filters trust."""
    spaced = f"{code[:3]} {code[3:]}"
    subject = f"{spaced} is your YieldPilot sign-in code"
    text = (f"Your YieldPilot sign-in code is {spaced}\n\nOr sign in with this link:\n{link}\n\n"
            "The code and the link work once and expire in 15 minutes.\n"
            "If you didn't try to sign in, you can ignore this email: nobody can sign in without it.\n\nYieldPilot\n")
    html = f"""<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2330">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="440" cellspacing="0" cellpadding="0" style="max-width:440px;background:#ffffff;border:1px solid #e6e6ee;border-radius:14px">
<tr><td style="padding:28px 28px 8px;font-size:18px;font-weight:600">Sign in to YieldPilot</td></tr>
<tr><td style="padding:8px 28px;font-size:14px;color:#5b6070">Your sign-in code:</td></tr>
<tr><td style="padding:4px 28px 16px;font-size:32px;font-weight:700;letter-spacing:6px">{spaced}</td></tr>
<tr><td style="padding:0 28px 20px"><a href="{link}" style="display:inline-block;background:#6b5bc4;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 20px;border-radius:10px">Sign in to YieldPilot</a></td></tr>
<tr><td style="padding:0 28px 26px;font-size:12.5px;color:#6b7080;line-height:1.5">The code and the button work once and expire in 15 minutes. If you didn't try to sign in, ignore this email: nobody can sign in without it.</td></tr>
</table></td></tr></table></body></html>"""
    return subject, text, html


def notify(to: str, subject: str, message: str, action: str, url: str) -> None:
    """A short notice with one button (an invitation, a join request, an approval), sent in the background when a mailbox is
    connected. In-app notifications carry the same news, so a failed email never fails what the person did."""
    import html as h
    import threading

    def run() -> None:
        try:
            if not ready():
                return
            text = f"{message}\n\n{action}: {url}\n\nYieldPilot\n"
            body = f"""<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2330">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="440" cellspacing="0" cellpadding="0" style="max-width:440px;background:#ffffff;border:1px solid #e6e6ee;border-radius:14px">
<tr><td style="padding:28px 28px 10px;font-size:15px;line-height:1.55">{h.escape(message)}</td></tr>
<tr><td style="padding:10px 28px 28px"><a href="{h.escape(url)}" style="display:inline-block;background:#6b5bc4;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 20px;border-radius:10px">{h.escape(action)}</a></td></tr>
</table></td></tr></table></body></html>"""
            send(to, subject, text, body)
        except Exception as e:
            log.warning("notice email failed: %s", type(e).__name__)

    threading.Thread(target=run, daemon=True).start()
