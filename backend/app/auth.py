from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, Request
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .db import get_session
from .services import members
from .models import AuditEvent, Institution, Invitation, JoinRequest, LoginCode, LoginSession, Membership, MlAccess, Notification, OperatorAccess, RunAllowance, Share, Subscription, User
from .services import usage

# guest: someone outside the institution who was sent a report; sees only what was shared with them
ROLES = ["guest", "viewer", "analyst", "data_manager", "admin", "owner"]
COOKIE = "yp_session"


@dataclass
class Principal:
    user: User
    institution: Institution | None  # None until they create or join one (the welcome screen)
    granted_operator: bool = False  # a main operator let them into the operator dashboard
    ml_granted: bool = False  # an admin or owner of their institution let them into the ML workspace

    def require(self, minimum: str) -> None:
        if ROLES.index(self.user.role) < ROLES.index(minimum):
            raise HTTPException(403, "You don't have permission to do this.")

    def at_least(self, role: str) -> bool:
        return ROLES.index(self.user.role) >= ROLES.index(role)

    @property
    def member(self) -> bool:
        """Sees the whole institution workspace (everyone but guests)."""
        return self.user.role != "guest"

    def manages(self, owner_id: str | None) -> bool:
        """May change, share or delete something someone made: its creator, or an admin or owner."""
        return owner_id == self.user.id or self.at_least("admin")

    @property
    def main_operator(self) -> bool:
        """Named in OPERATOR_EMAILS: can't be removed from the app, and the only ones who can give or take away operator access."""
        return settings().is_operator(self.user.email)

    @property
    def ml(self) -> bool:
        """Opens the ML workspace: admins and owners always, other members once an admin or owner gives them access."""
        return self.institution is not None and self.member and (self.at_least("admin") or self.ml_granted)

    @property
    def operator(self) -> bool:
        """YieldPilot staff: they see the operator dashboard, never another institution's data."""
        return self.main_operator or self.granted_operator


def client_ip(request: Request) -> str:
    """The visitor's address: Cloud Run appends it to X-Forwarded-For, and the web proxy's own address comes last."""
    parts = [p.strip() for p in request.headers.get("x-forwarded-for", "").split(",") if p.strip()]
    if len(parts) >= 2:
        return parts[-2]
    return parts[0] if parts else (request.client.host if request.client else "")


async def issue_session(session: AsyncSession, user: User, method: str, request: Request) -> str:
    """A server-side session for this browser; the cookie carries only its id, signed."""
    now = datetime.now(timezone.utc)
    hours = settings().session_hours
    s = LoginSession(user_id=user.id, method=method, ip=client_ip(request)[:64], user_agent=request.headers.get("user-agent", "")[:300],
                     expires_at=now + timedelta(hours=hours))
    session.add(s)
    await session.flush()
    claims = {"sub": user.id, "sid": s.id, "iat": now, "exp": now + timedelta(hours=hours)}
    return jwt.encode(claims, settings().jwt_secret, algorithm="HS256")


async def end_sessions(session: AsyncSession, user_id: str) -> None:
    """Sign a person out everywhere (removed, deactivated, or moved to another institution)."""
    await session.execute(update(LoginSession).where(LoginSession.user_id == user_id, LoginSession.revoked_at.is_(None))
                          .values(revoked_at=datetime.now(timezone.utc)))


# Free email services: their people never share an institution, each gets a personal workspace.
FREE_MAIL = {
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "passport.com", "yahoo.com", "ymail.com",
    "rocketmail.com", "aol.com", "aim.com", "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "pm.me", "tutanota.com",
    "tuta.io", "fastmail.com", "zoho.com", "zohomail.com", "gmx.com", "gmx.net", "gmx.de", "mail.com", "yandex.com", "yandex.ru", "ya.ru",
    "mail.ru", "bk.ru", "list.ru", "inbox.ru", "rambler.ru", "rediffmail.com", "rediff.com", "sify.com", "indiatimes.com", "qq.com",
    "163.com", "126.com", "yeah.net", "sina.com", "sohu.com", "naver.com", "daum.net", "hanmail.net", "web.de", "t-online.de",
    "freenet.de", "orange.fr", "free.fr", "laposte.net", "sfr.fr", "libero.it", "virgilio.it", "tiscali.it", "btinternet.com",
    "sky.com", "virginmedia.com", "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "cox.net", "charter.net", "earthlink.net",
    "juno.com", "optonline.net", "rogers.com", "shaw.ca", "sympatico.ca", "bigpond.com", "optusnet.com.au", "xtra.co.nz", "seznam.cz",
    "wp.pl", "o2.pl", "interia.pl", "onet.pl", "hushmail.com", "lycos.com", "inbox.com", "mailinator.com", "duck.com",
}
FREE_MAIL_PREFIXES = ("yahoo.", "hotmail.", "outlook.", "live.", "windowslive.", "aol.", "gmx.", "yandex.")
PERSONAL = FREE_MAIL  # kept for older imports


def is_free_mail(domain: str) -> bool:
    domain = domain.lower()
    return domain in FREE_MAIL or domain.startswith(FREE_MAIL_PREFIXES)


async def delete_account(session: AsyncSession, user: User) -> None:
    """Remove a person from YieldPilot. Who they are goes (name, email, photo, sign-in links, sessions, requests, invitations and
    notifications); the institution's shared studies and runs stay, shown as made by a "Former member". The next time they sign
    in they are a new person, and create or join a workspace from the welcome screen."""
    email, institution_id, gone = user.email, user.institution_id, "Former member"
    await session.execute(delete(LoginSession).where(LoginSession.user_id == user.id))
    await session.execute(delete(LoginCode).where(LoginCode.email == email))
    await session.execute(delete(JoinRequest).where(JoinRequest.user_id == user.id))
    await session.execute(delete(OperatorAccess).where(OperatorAccess.email == email))
    await session.execute(delete(MlAccess).where(MlAccess.user_id == user.id))
    await session.execute(delete(Membership).where(Membership.user_id == user.id))
    await session.execute(delete(RunAllowance).where(RunAllowance.user_id == user.id))
    await session.execute(delete(Invitation).where(Invitation.email == email, Invitation.institution_id == institution_id))
    await session.execute(delete(Notification).where(Notification.recipient_email == email, Notification.institution_id == institution_id))
    await session.execute(update(AuditEvent).where(AuditEvent.target == email).values(target=gone))
    for share in (await session.scalars(select(Share).where(Share.institution_id == institution_id))).all():
        if email in (share.recipients or []):
            share.recipients = [r for r in share.recipients if r != email]
    user.email, user.name, user.title, user.department, user.photo = f"deleted-{user.id}@deleted.invalid", gone, None, None, None
    user.microsoft_oid, user.last_login_at, user.institution_id, user.role = None, None, None, "viewer"
    user.active, user.deleted_at = False, datetime.now(timezone.utc)


def _domain_name(domain: str) -> str:
    """"csulb.edu" -> "CSULB" until the identity provider tells us the organization's real name."""
    return domain.split(".")[0].upper()


async def provision(session: AsyncSession, email: str, name: str | None = None, oid: str | None = None, org: str | None = None,
                    profile: dict | None = None) -> User:
    """Find or create the person. A new person belongs to no institution yet: the welcome screen lets them create one or join
    theirs (an invitation, an invite link, or a request an admin approves), so membership never rests on an email domain alone."""
    email = email.strip().lower()
    domain = email.rsplit("@", 1)[-1]
    if "@" not in email or "." not in domain or not settings().domain_allowed(domain):
        raise HTTPException(403, "Your institution isn't set up on YieldPilot yet.")
    user = await session.scalar(select(User).where(User.email == email))
    if user is not None and oid and user.microsoft_oid and user.microsoft_oid != oid:
        # this address already belongs to a different Microsoft account: never let another account take it over
        raise HTTPException(403, "This email is linked to a different Microsoft account.")
    if user is None:
        user = User(email=email, name=name, microsoft_oid=oid, institution_id=None, role="viewer")
        session.add(user)
        await session.flush()
        session.add(AuditEvent(institution_id="", user_id=user.id, action="user.created", target=email))
    if name and not user.name:
        user.name = name
    if oid and not user.microsoft_oid:
        user.microsoft_oid = oid
    profile = profile or {}
    for k in ("title", "department"):  # from the directory, unless the person has set their own
        if profile.get(k) and not getattr(user, k):
            setattr(user, k, profile[k][:200])
    if profile.get("photo") and not user.photo_custom:  # a picture the person chose stays
        user.photo = profile["photo"]
    if not user.active:
        raise HTTPException(403, "Your account is disabled. Ask an owner of your workspace.")
    user.last_login_at = datetime.now(timezone.utc)
    return user


async def join(session: AsyncSession, user: User, inst: Institution, role: str, how: str, by: str | None = None, switch: bool = True) -> None:
    """Add someone to a workspace. They keep every other workspace they're in and switch between them from the workspace menu;
    `switch` opens this one for them now (someone else adding them only opens it if they have none)."""
    existing = await members.get(session, user.id, inst.id)
    if existing is not None and existing.active:
        if switch:
            members.use(user, existing)
        return
    m = await members.add(session, user, inst.id, role if role in ROLES else "viewer", switch=switch)
    session.add(AuditEvent(institution_id=inst.id, user_id=by or user.id, action="member.joined", target=user.email, meta={"how": how, "role": m.role}))


async def signed_in(request: Request, session: AsyncSession = Depends(get_session)) -> Principal:
    """The signed-in person, with or without an institution yet."""
    if settings().auth_mode == "dev":
        email = request.headers.get("x-dev-user", "").strip().lower()
        if not email:
            raise HTTPException(401, "Sign in required.")
        # the API on a laptop works on the production database: it signs in existing people only, never creates one
        user = await session.scalar(select(User).where(User.email == email))
        if user is None:
            raise HTTPException(401, "No YieldPilot account uses that email. Sign in once on the live site first.")
    else:
        token = request.cookies.get(COOKIE) or request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        if not token:
            raise HTTPException(401, "Sign in required.")
        try:
            claims = jwt.decode(token, settings().jwt_secret, algorithms=["HS256"], options={"require": ["exp", "sub", "sid"]})
        except jwt.PyJWTError:
            raise HTTPException(401, "Your session has expired. Please sign in again.")
        s = await session.get(LoginSession, claims["sid"])
        if s is None or s.user_id != claims["sub"] or s.revoked_at is not None or s.expires_at < datetime.now(timezone.utc):
            raise HTTPException(401, "Your session has ended. Please sign in again.")
        user = await session.get(User, claims["sub"])
        if user is None:
            raise HTTPException(401, "Sign in required.")
        request.state.sid = s.id
    if not user.active:
        raise HTTPException(403, "Your account is disabled.")
    m = await members.get(session, user.id, user.institution_id)
    if m is None or not m.active:  # removed from the workspace they were in: open another of theirs, or the welcome screen
        m = await members.fallback(session, user, exclude=user.institution_id)
        if m is not None:
            members.use(user, m)
        else:
            user.institution_id = None
    elif user.role != m.role:
        user.role = m.role  # the role in this workspace
    inst = await session.get(Institution, user.institution_id) if user.institution_id else None
    who = Principal(user, inst, await session.get(OperatorAccess, user.email) is not None, bool(m is not None and inst is not None and m.ml_access))
    if inst is not None:
        usage.acting(inst.id, user.id)
    if inst is not None and inst.suspended and not who.operator:
        raise HTTPException(403, f"{inst.name} is suspended on YieldPilot. Contact YieldPilot support.")
    return who


async def current(who: Principal = Depends(signed_in)) -> Principal:
    """The signed-in member of an institution. Someone who hasn't created or joined one yet is sent to the welcome screen."""
    if who.institution is None:
        raise HTTPException(409, "onboarding_required")
    return who


async def operator(who: Principal = Depends(signed_in)) -> Principal:
    if not who.operator:
        raise HTTPException(404)
    return who


async def audit(session: AsyncSession, who: Principal, action: str, target: str, **meta) -> None:
    session.add(AuditEvent(institution_id=who.institution.id, user_id=who.user.id, action=action, target=target, meta=meta))
