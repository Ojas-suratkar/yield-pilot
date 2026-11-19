"""Sign-in, the way most sites do it: Continue with Google, Continue with Microsoft, or type any email address.

The typed address picks the way in: Gmail and Google Workspace go to Google, Microsoft 365 organizations and Outlook /
Hotmail / Live go to Microsoft (any organization, not one tenant), and every other address (Yahoo, Rediff, iCloud, a
company or school domain) gets a one-time sign-in link by email (Google Identity Platform sends it). Anyone can choose
the email link instead. Google and Microsoft use the authorization-code flow with PKCE, a one-time state and a nonce.
"""

import base64
import hashlib
import hmac
import logging
import re
import secrets
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from urllib.parse import urlencode

import httpx
import jwt
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import COOKIE, client_ip, is_free_mail, issue_session, provision
from ..config import settings
from ..db import get_session
from ..models import AuditEvent, LoginCode, LoginSession
from ..services import mailer

router = APIRouter(prefix="/auth", tags=["auth"])
log = logging.getLogger("yieldpilot.auth")
MS = "https://login.microsoftonline.com"
CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad"
FLOW = "yp_sso"  # signed cookie: state, PKCE verifier, nonce, Microsoft authority (10 minutes)
EMAIL_HINT = "yp_email"  # signed cookie: the address a sign-in link was sent to, so this browser needn't ask again
GOOGLE_MAIL = {"gmail.com", "googlemail.com"}
MS_MAIL = {"outlook.com", "hotmail.com", "live.com", "msn.com", "passport.com"}
MS_MAIL_PREFIXES = ("hotmail.", "outlook.", "live.", "windowslive.")
EMAIL_RE = re.compile(r"^[^@\s<>()\[\],;:\"]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$")


def _secure() -> bool:
    return settings().env != "local"


def _back(path: str) -> RedirectResponse:
    if "error=" in path:
        log.warning("sign-in failed: %s", path.split("error=", 1)[1])
    return RedirectResponse(f"{settings().frontend_origin.rstrip('/')}{path}", status_code=302)


def _valid_email(email: str) -> str:
    email = (email or "").strip().lower()
    if not EMAIL_RE.match(email) or ".." in email:
        raise HTTPException(422, "Enter a valid email address.")
    return email


# ------------------------------------------------------------------------------------------ rate limits

class _Limiter:
    """Sliding-window counts per key (an IP address or an email). Abuse gets a polite 429."""

    def __init__(self) -> None:
        self.hits: dict[str, deque] = defaultdict(deque)
        self.lock = threading.Lock()

    def check(self, key: str, limit: int, window: int) -> None:
        now = time.monotonic()
        with self.lock:
            q = self.hits[key]
            while q and now - q[0] > window:
                q.popleft()
            if len(q) >= limit:
                raise HTTPException(429, "Too many attempts. Please wait a few minutes and try again.")
            q.append(now)
            if len(self.hits) > 50_000:  # keep memory bounded
                self.hits.clear()


limits = _Limiter()


# ------------------------------------------------------------------------------------------ OAuth flow state

def _start(url: str, params: dict, extra: dict | None = None) -> RedirectResponse:
    state, nonce, verifier = secrets.token_urlsafe(24), secrets.token_urlsafe(24), secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    flow = jwt.encode({"state": state, "nonce": nonce, "verifier": verifier, **(extra or {}),
                       "exp": datetime.now(timezone.utc) + timedelta(minutes=10)}, settings().jwt_secret, algorithm="HS256")
    q = {**params, "state": state, "nonce": nonce, "code_challenge": challenge, "code_challenge_method": "S256"}
    res = RedirectResponse(f"{url}?{urlencode({k: v for k, v in q.items() if v})}", status_code=302)
    res.set_cookie(FLOW, flow, max_age=600, httponly=True, secure=_secure(), samesite="lax", path="/api/auth")
    return res


def _flow(request: Request, state: str | None) -> dict | None:
    """The flow this browser started, if the returning state matches it (stops forged and replayed callbacks)."""
    try:
        f = jwt.decode(request.cookies.get(FLOW, ""), settings().jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    return f if state and secrets.compare_digest(state, f.get("state", "")) else None


async def _finish(session: AsyncSession, request: Request, email: str, name: str | None, oid: str | None, org: str | None,
                  method: str, profile: dict | None = None, json: bool = False):
    try:
        user = await provision(session, email, name, oid, org, profile)
    except HTTPException as e:
        if json:
            raise
        code = "invite_only" if "invite only" in e.detail else "account_disabled" if "disabled" in e.detail else \
            "account_linked" if "different Microsoft" in e.detail else "domain_not_allowed"
        return _back(f"/login?error={code}")
    session.add(AuditEvent(institution_id=user.institution_id or "", user_id=user.id, action="user.signed_in", target=email, meta={"provider": method}))
    token = await issue_session(session, user, method, request)
    await session.commit()
    res = JSONResponse({"ok": True}) if json else _back("/sso/callback")
    res.set_cookie(COOKIE, token, max_age=settings().session_hours * 3600, httponly=True, secure=_secure(), samesite="lax", path="/")
    res.delete_cookie(FLOW, path="/api/auth")
    return res


# ------------------------------------------------------------------------------------------ discovery

@lru_cache(maxsize=4096)
def _dns(name: str, kind: str) -> tuple[str, ...] | None:
    """Google's public DNS: the answers, () when there are none, None when the lookup itself failed."""
    try:
        d = httpx.get("https://dns.google/resolve", params={"name": name, "type": kind}, timeout=5).json()
        return tuple(a.get("data", "").rstrip(".").lower() for a in d.get("Answer") or [] if a.get("type") in (1, 5, 15, 28))
    except (httpx.HTTPError, ValueError):
        return None


def _mail_hosts(domain: str) -> tuple[str, ...] | None:
    mx = _dns(domain, "MX")
    return None if mx is None else tuple(m.split(" ", 1)[-1] for m in mx)


@lru_cache(maxsize=4096)
def _microsoft_realm(domain: str) -> bool:
    """Whether people at this domain sign in with Microsoft 365 / Entra ID (Microsoft's public realm lookup). A federated
    domain counts only when its sign-in server exists: some test and parked domains point at servers that don't."""
    try:
        r = httpx.get(f"{MS}/getuserrealm.srf", params={"login": f"someone@{domain}", "json": "1"}, timeout=5).json()
    except (httpx.HTTPError, ValueError):
        return False
    if r.get("IsViral") or r.get("NameSpaceType") not in ("Managed", "Federated"):
        return False
    if r.get("NameSpaceType") == "Federated":
        host = (r.get("AuthURL") or "").split("/")[2] if "//" in (r.get("AuthURL") or "") else ""
        return bool(host and _dns(host, "A"))
    return True


def _google_workspace(domain: str) -> bool:
    """Whether the domain's mail is hosted by Google Workspace (its MX records)."""
    return any(h.endswith(("google.com", "googlemail.com")) for h in _mail_hosts(domain) or ())


def _receives_mail(domain: str) -> bool:
    """False only when DNS says so for sure: no mail records and no address, or the 'null MX' that refuses all mail."""
    mx = _mail_hosts(domain)
    if mx is None:
        return True  # couldn't check: don't block anyone
    if mx:
        return mx != ("",) and mx != (".",)
    return bool(_dns(domain, "A"))


@lru_cache(maxsize=4096)
def _ms_tenant(domain: str) -> str | None:
    """The Microsoft directory (tenant ID) a domain belongs to, from Microsoft's public sign-in metadata."""
    try:
        r = httpx.get(f"{MS}/{domain}/v2.0/.well-known/openid-configuration", timeout=5)
        parts = r.json().get("issuer", "").split("/") if r.status_code == 200 else []
        return parts[3] if len(parts) > 3 else None
    except (httpx.HTTPError, ValueError):
        return None


def _ms_personal(domain: str) -> bool:
    return domain in MS_MAIL or domain.startswith(MS_MAIL_PREFIXES)


@router.get("/providers")
async def providers():
    s = settings()
    return {"microsoft": bool(s.microsoft_client_id), "google": bool(s.google_client_id), "email": True, "dev": s.auth_mode == "dev",
            "microsoft_personal": s.microsoft_personal_accounts, "microsoft_any": not s.microsoft_tenants.strip()}


@router.get("/discover")
async def discover(email: str, request: Request):
    """How this address signs in: google | microsoft | email. Every address can also use an email link."""
    limits.check(f"discover:{client_ip(request)}", 60, 60)
    email = _valid_email(email)
    domain = email.rsplit("@", 1)[1]
    s = settings()
    if not s.domain_allowed(domain):
        raise HTTPException(403, "Your institution isn't set up on YieldPilot yet.")
    if not is_free_mail(domain) and not await run_in_threadpool(_receives_mail, domain):
        raise HTTPException(422, f"{domain} doesn't receive email. Check the address.")
    method = "email"
    if domain in GOOGLE_MAIL:
        method = "google"
    elif _ms_personal(domain):
        method = "microsoft" if s.microsoft_personal_accounts else "email"
    elif not is_free_mail(domain):
        # where the domain's mailboxes live decides first (an organization can have a Microsoft directory and Google mail)
        if await run_in_threadpool(_google_workspace, domain):
            method = "google"
        elif await run_in_threadpool(_microsoft_realm, domain):
            method = "microsoft"
    note = None
    if method == "microsoft" and not _ms_personal(domain) and not s.microsoft_tenant_ok(await run_in_threadpool(_ms_tenant, domain)):
        # the app registration doesn't accept this organization's directory yet: Microsoft would only show an error
        method, note = "email", "microsoft_unavailable"
    if method == "google" and not s.google_client_id or method == "microsoft" and not s.microsoft_client_id:
        method = "email"
    return {"method": method, "provider": method, "note": note}  # "provider" kept for older pages


# ------------------------------------------------------------------------------------------ Microsoft

@router.get("/microsoft/login")
async def microsoft_login(request: Request, login_hint: str | None = None):
    s = settings()
    if not s.microsoft_client_id:
        return _back("/login?error=sso_not_configured")
    limits.check(f"oauth:{client_ip(request)}", 30, 60)
    hint = (login_hint or "").strip().lower()
    domain = hint.rsplit("@", 1)[1] if "@" in hint else ""
    if domain and _ms_personal(domain) and not s.microsoft_personal_accounts:
        return _back("/login?error=microsoft_personal")
    if domain and not _ms_personal(domain) and not s.microsoft_tenant_ok(await run_in_threadpool(_ms_tenant, domain)):
        return _back("/login?error=microsoft_unavailable")
    # a typed address goes straight to the right kind of Microsoft account; the plain button lets people choose
    authority = ("consumers" if _ms_personal(domain) else "organizations") if domain else \
        ("common" if s.microsoft_personal_accounts else s.microsoft_tenant_id)
    return _start(f"{MS}/{authority}/oauth2/v2.0/authorize", {
        "client_id": s.microsoft_client_id, "response_type": "code", "redirect_uri": s.microsoft_redirect_uri, "response_mode": "query",
        "scope": "openid email profile User.Read", "prompt": None if hint else "select_account", "login_hint": hint or None,
        "domain_hint": ("consumers" if _ms_personal(domain) else domain) if domain else None}, {"authority": authority})


def _microsoft_email(profile: dict, tenant: str) -> str | None:
    """The address to trust. Organizations can type any 'mail' value, so it counts only when it shares the domain of the
    sign-in name (which Microsoft requires the organization to own); otherwise the sign-in name is used. Guests are refused."""
    upn = (profile.get("userPrincipalName") or "").strip().lower()
    mail = (profile.get("mail") or "").strip().lower()
    if tenant == CONSUMER_TENANT:
        return mail or upn or None  # a personal Microsoft account: its address is verified by Microsoft
    if not upn or "#ext#" in upn or "@" not in upn:
        return None
    if mail and "@" in mail and mail.rsplit("@", 1)[1] == upn.rsplit("@", 1)[1]:
        return mail
    return upn


@router.get("/microsoft/callback")
async def microsoft_callback(request: Request, code: str | None = None, state: str | None = None, error: str | None = None,
                             session: AsyncSession = Depends(get_session)):
    s = settings()
    if error:
        log.warning("microsoft sign-in error %s", error[:60])
        return _back(f"/login?error={'access_denied' if error == 'access_denied' else 'microsoft_failed'}")
    flow = _flow(request, state)
    if not code or flow is None:
        return _back("/login?error=invalid_state")
    async with httpx.AsyncClient(timeout=15) as client:
        tok = await client.post(f"{MS}/{flow.get('authority', 'common')}/oauth2/v2.0/token", data={
            "client_id": s.microsoft_client_id, "client_secret": s.microsoft_client_secret, "code": code, "code_verifier": flow["verifier"],
            "redirect_uri": s.microsoft_redirect_uri, "grant_type": "authorization_code"})
        body = tok.json()
        if tok.status_code != 200 or "access_token" not in body or "id_token" not in body:
            log.warning("microsoft token exchange %s: %s", tok.status_code, body.get("error"))
            return _back("/login?error=token_exchange_failed")
        # straight from Microsoft's token endpoint over TLS, so its claims are trusted; the nonce ties it to this browser
        claims = jwt.decode(body["id_token"], options={"verify_signature": False})
        if not secrets.compare_digest(claims.get("nonce", ""), flow["nonce"]) or claims.get("aud") != s.microsoft_client_id:
            return _back("/login?error=invalid_state")
        tenant = claims.get("tid", "")
        auth = {"Authorization": f"Bearer {body['access_token']}"}
        me = await client.get("https://graph.microsoft.com/v1.0/me", headers=auth,
                              params={"$select": "id,displayName,mail,userPrincipalName,jobTitle,department"})
        if me.status_code != 200:
            return _back("/login?error=profile_failed")
        profile = me.json()
        email = _microsoft_email(profile, tenant)
        if not email:
            return _back("/login?error=guest_account")
        photo = None
        pic = await client.get("https://graph.microsoft.com/v1.0/me/photos/96x96/$value", headers=auth)
        if pic.status_code == 200 and len(pic.content) < 60_000:
            photo = f"data:{pic.headers.get('content-type', 'image/jpeg')};base64,{base64.b64encode(pic.content).decode()}"
        org = None
        if tenant != CONSUMER_TENANT:
            org_res = await client.get("https://graph.microsoft.com/v1.0/organization", headers=auth, params={"$select": "id,displayName"})
            if org_res.status_code == 200 and (v := org_res.json().get("value")):
                org = v[0].get("displayName")
    return await _finish(session, request, email, profile.get("displayName"), profile.get("id"), org, "microsoft",
                         {"title": profile.get("jobTitle"), "department": profile.get("department"), "photo": photo})


# ------------------------------------------------------------------------------------------ Google

@router.get("/google/login")
async def google_login(request: Request, login_hint: str | None = None):
    s = settings()
    if not s.google_client_id:
        return _back("/login?error=sso_not_configured")
    limits.check(f"oauth:{client_ip(request)}", 30, 60)
    hint = (login_hint or "").strip().lower()
    domain = hint.rsplit("@", 1)[1] if "@" in hint else ""
    return _start("https://accounts.google.com/o/oauth2/v2/auth", {
        "client_id": s.google_client_id, "response_type": "code", "redirect_uri": s.google_redirect_uri, "scope": "openid email profile",
        "prompt": None if hint else "select_account", "login_hint": hint or None,
        "hd": domain if domain and domain not in GOOGLE_MAIL else None})


@router.get("/google/callback")
async def google_callback(request: Request, code: str | None = None, state: str | None = None, error: str | None = None,
                          session: AsyncSession = Depends(get_session)):
    from google.auth.transport import requests as grequests
    from google.oauth2 import id_token

    s = settings()
    if error:
        return _back(f"/login?error={'access_denied' if error == 'access_denied' else 'google_' + error[:40]}")
    flow = _flow(request, state)
    if not code or flow is None:
        return _back("/login?error=invalid_state")
    async with httpx.AsyncClient(timeout=15) as client:
        tok = await client.post("https://oauth2.googleapis.com/token", data={
            "client_id": s.google_client_id, "client_secret": s.google_client_secret, "code": code, "code_verifier": flow["verifier"],
            "redirect_uri": s.google_redirect_uri, "grant_type": "authorization_code"})
    if tok.status_code != 200 or "id_token" not in tok.json():
        log.warning("google token exchange %s: %s", tok.status_code, tok.json().get("error"))
        return _back("/login?error=token_exchange_failed")
    try:
        claims = id_token.verify_oauth2_token(tok.json()["id_token"], grequests.Request(), s.google_client_id)
    except ValueError as e:
        log.warning("google id token rejected: %s", e)
        return _back("/login?error=token_exchange_failed")
    if not secrets.compare_digest(claims.get("nonce", ""), flow["nonce"]):
        return _back("/login?error=invalid_state")
    if not claims.get("email_verified"):
        return _back("/login?error=email_not_verified")
    org = claims.get("hd")  # Google Workspace domain
    return await _finish(session, request, claims["email"], claims.get("name"), None, org.split(".")[0].upper() if org else None, "google",
                         {"photo": claims.get("picture")})


# ------------------------------------------------------------------------------------------ email link (any address)

_creds = None
_creds_lock = threading.Lock()


def _identity(path: str, body: dict) -> dict:
    """Google Identity Platform REST: with the web key when configured, otherwise as this service's Google account."""
    global _creds
    s = settings()
    url = f"https://identitytoolkit.googleapis.com/v1/{path}"
    if s.identity_api_key:
        r = httpx.post(url, params={"key": s.identity_api_key}, json=body, timeout=15)
    else:
        import google.auth
        from google.auth.transport.requests import Request as GRequest

        with _creds_lock:
            if _creds is None:
                _creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
            if not _creds.valid:
                _creds.refresh(GRequest())
            token = _creds.token
        admin = path in ("accounts:sendOobCode", "accounts:delete")  # these name the project; sign-in takes it from the header
        r = httpx.post(url, json={**body, "targetProjectId": s.gcp_project} if admin else body, timeout=15,
                       headers={"Authorization": f"Bearer {token}", "x-goog-user-project": s.gcp_project})
    data = r.json()
    if r.status_code != 200:
        msg = (data.get("error") or {}).get("message", "")
        log.warning("identity platform %s: %s %s", path, r.status_code, msg)
        raise HTTPException(400 if "OOB_CODE" in msg or "EMAIL" in msg else 502, msg or "unavailable")
    return data


class EmailStart(BaseModel):
    email: str = Field(max_length=320)


CODE_MINUTES, CODE_TRIES = 15, 5


def _digest(kind: str, value: str) -> str:
    """Codes and link tokens are stored only as keyed hashes: a database copy can't be used to sign in."""
    return hmac.new(settings().jwt_secret.encode(), f"{kind}:{value}".encode(), hashlib.sha256).hexdigest()


@router.post("/email/start")
async def email_start(body: EmailStart, request: Request, session: AsyncSession = Depends(get_session)):
    """Email a one-time code and link. The answer is the same whatever the address, so nobody can probe who has an account."""
    email = _valid_email(body.email)
    domain = email.rsplit("@", 1)[1]
    if not settings().domain_allowed(domain):
        raise HTTPException(403, "Your institution isn't set up on YieldPilot yet.")
    limits.check(f"email-ip:{client_ip(request)}", 10, 600)
    limits.check(f"email:{email}", 3, 600)
    if not is_free_mail(domain) and not await run_in_threadpool(_receives_mail, domain):
        raise HTTPException(422, f"{domain} doesn't receive email. Check the address.")
    own = await run_in_threadpool(mailer.ready)
    if own:  # YieldPilot's own email from a real mailbox: a code to type and a link
        now = datetime.now(timezone.utc)
        await session.execute(delete(LoginCode).where(LoginCode.expires_at < now - timedelta(days=1)))
        await session.execute(update(LoginCode).where(LoginCode.email == email, LoginCode.used_at.is_(None)).values(used_at=now))
        code, token = f"{secrets.randbelow(10**6):06d}", secrets.token_urlsafe(32)
        session.add(LoginCode(email=email, code_hash=_digest("code", code), token_hash=_digest("token", token), ip=client_ip(request)[:64],
                              expires_at=now + timedelta(minutes=CODE_MINUTES)))
        await session.commit()
        subject, text, html = mailer.sign_in_email(code, f"{settings().frontend_origin.rstrip('/')}/login/email?token={token}")
        try:
            await run_in_threadpool(mailer.send, email, subject, text, html)
        except Exception as e:
            log.warning("sign-in email to a %s address failed: %s", domain, type(e).__name__)
            raise HTTPException(502, "We couldn't send the sign-in email just now. Please try again in a minute.")
    else:  # no mailbox connected yet: Google Identity Platform's sender (often filtered as junk)
        try:
            await run_in_threadpool(_identity, "accounts:sendOobCode", {
                "requestType": "EMAIL_SIGNIN", "email": email, "canHandleCodeInApp": True,
                # the link says, signed, which address it was sent to: it then works in any browser or mail app, nothing to retype.
                # It proves nothing by itself; Identity Platform still checks the one-time code belongs to that address.
                "continueUrl": f"{settings().frontend_origin.rstrip('/')}/login/email?h={_link_hint(email)}"})
        except HTTPException:
            raise HTTPException(502, "We couldn't send the sign-in email just now. Please try again in a minute.")
    res = JSONResponse({"sent": True, "code": own})
    hint = jwt.encode({"email": email, "exp": datetime.now(timezone.utc) + timedelta(hours=1)}, settings().jwt_secret, algorithm="HS256")
    res.set_cookie(EMAIL_HINT, hint, max_age=3600, httponly=True, secure=_secure(), samesite="lax", path="/api/auth")
    return res


class EmailFinish(BaseModel):
    token: str | None = Field(None, min_length=20, max_length=200)  # the link in YieldPilot's email
    code: str | None = Field(None, max_length=12)  # the 6 digits typed from it
    oob_code: str | None = Field(None, min_length=10, max_length=2000)  # a link from Identity Platform's email
    hint: str | None = Field(None, max_length=1000)  # that link's signed note of the address it was sent to
    email: str | None = Field(None, max_length=320)


def _link_hint(email: str) -> str:
    return jwt.encode({"email": email, "use": "email-link", "exp": datetime.now(timezone.utc) + timedelta(hours=6)},
                      settings().jwt_secret, algorithm="HS256")


def _hinted(request: Request, email: str | None, hint: str | None = None) -> str:
    """The address a link was sent to: typed, from the link's signed note, or from this browser's cookie."""
    if not email and hint:
        try:
            claims = jwt.decode(hint, settings().jwt_secret, algorithms=["HS256"])
            email = claims["email"] if claims.get("use") == "email-link" else None
        except jwt.PyJWTError:
            email = None
    if not email:
        try:
            email = jwt.decode(request.cookies.get(EMAIL_HINT, ""), settings().jwt_secret, algorithms=["HS256"])["email"]
        except jwt.PyJWTError:
            raise HTTPException(409, "email_required")  # nothing says which address: the page asks for it
    return _valid_email(email)


@router.post("/email/finish")
async def email_finish(body: EmailFinish, request: Request, session: AsyncSession = Depends(get_session)):
    """A code typed or a link opened: checked as genuine, unused, unexpired and for this address, then the session starts."""
    limits.check(f"email-finish:{client_ip(request)}", 20, 600)
    now = datetime.now(timezone.utc)
    expired = "This code or link has expired or was already used. Request a new one."
    if body.token:
        row = await session.scalar(select(LoginCode).where(LoginCode.token_hash == _digest("token", body.token)))
        if row is None or row.used_at is not None or row.expires_at < now:
            raise HTTPException(400, expired)
        email = row.email
    elif body.code:
        email = _hinted(request, body.email, body.hint)
        limits.check(f"email-code:{email}", 10, 600)
        row = await session.scalar(select(LoginCode).where(LoginCode.email == email, LoginCode.used_at.is_(None))
                                   .order_by(LoginCode.created_at.desc()).limit(1))
        if row is None or row.expires_at < now:
            raise HTTPException(400, expired)
        row.attempts += 1
        digits = "".join(ch for ch in body.code if ch.isdigit())
        if not hmac.compare_digest(row.code_hash, _digest("code", digits)):
            if row.attempts >= CODE_TRIES:
                row.used_at = now  # too many wrong guesses: this code is finished
            await session.commit()
            raise HTTPException(400, "That code isn't right." if row.used_at is None else "Too many wrong codes. Request a new one.")
    elif body.oob_code:
        email = _hinted(request, body.email, body.hint)
        try:
            data = await run_in_threadpool(_identity, "accounts:signInWithEmailLink", {"email": email, "oobCode": body.oob_code})
        except HTTPException as e:
            if e.status_code == 400:
                raise HTTPException(400, "This sign-in link has expired, was already used, or was sent to a different address. Request a new one.")
            raise HTTPException(502, "Sign-in couldn't be completed just now. Please try again.")
        if (data.get("email") or "").lower() != email:
            raise HTTPException(400, "This sign-in link was sent to a different address.")
        # YieldPilot keeps the account; Identity Platform's copy isn't needed once the address is proven
        threading.Thread(target=_forget_identity, args=(data.get("idToken"),), daemon=True).start()
        row = None
    else:
        raise HTTPException(422, "Enter the code from the email.")
    if row is not None:
        row.used_at = now
    res = await _finish(session, request, email, None, None, None, "email", json=True)
    res.delete_cookie(EMAIL_HINT, path="/api/auth")
    return res


def _forget_identity(id_token: str | None) -> None:
    if id_token:
        try:
            _identity("accounts:delete", {"idToken": id_token})
        except Exception:
            log.info("identity platform copy of an email sign-in was not removed")


# ------------------------------------------------------------------------------------------ sign out

@router.post("/logout")
async def logout(request: Request, session: AsyncSession = Depends(get_session)):
    """Ends this browser's session on the server too, so a copied cookie stops working."""
    try:
        claims = jwt.decode(request.cookies.get(COOKIE, ""), settings().jwt_secret, algorithms=["HS256"], options={"verify_exp": False})
        if claims.get("sid"):
            await session.execute(update(LoginSession).where(LoginSession.id == claims["sid"], LoginSession.revoked_at.is_(None))
                                  .values(revoked_at=datetime.now(timezone.utc)))
            await session.commit()
    except jwt.PyJWTError:
        pass
    res = RedirectResponse("/login", status_code=303)
    res.delete_cookie(COOKIE, path="/")
    return res
