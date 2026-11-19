"""Secrets read at run time from Secret Manager (cached 5 minutes), so connecting Stripe or a mailbox needs no deploy."""

import base64
import logging
import threading
import time

import httpx

from ..config import settings

log = logging.getLogger("yieldpilot.secrets")
_cache: dict[str, tuple[float, str]] = {}
_lock = threading.Lock()


def get(name: str, override: str = "") -> str:
    if override:
        return override
    with _lock:
        hit = _cache.get(name)
        if hit and time.monotonic() - hit[0] < 300:
            return hit[1]
    value = ""
    try:
        import google.auth
        from google.auth.transport.requests import Request

        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        creds.refresh(Request())
        p = settings().gcp_project
        r = httpx.get(f"https://secretmanager.googleapis.com/v1/projects/{p}/secrets/{name}/versions/latest:access",
                      headers={"Authorization": f"Bearer {creds.token}", "x-goog-user-project": p}, timeout=10)
        if r.status_code == 200:
            value = base64.b64decode(r.json()["payload"]["data"]).decode().strip()
    except Exception:
        log.info("secret %s not readable", name)
    with _lock:
        _cache[name] = (time.monotonic(), value)
    return value
