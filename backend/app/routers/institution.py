"""Getting into an institution, and running it.

The welcome screen (someone who isn't a member anywhere yet) offers: create an institution (its profile filled in from its
website), accept an invitation sent to your email, join with an invite link or code from a colleague, or find your institution
by its website and ask to join (an admin approves). An institution can also let people with its verified email domain join
at once. None of this depends on the email domain alone, and there is no public list of institutions.
"""

import re
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import ROLES, Principal, audit, client_ip, current, is_free_mail, join, signed_in
from ..config import settings
from ..db import get_session
from ..models import Institution, Invitation, JoinRequest, Membership, Notification, Subscription, User
from ..services import images
from ..services import members as ms
from ..services import mailer, orginfo, plans
from .sso import limits

router = APIRouter(tags=["institution"])
ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"  # no 0/O, 1/I/L, U: easy to read aloud and type
JOINABLE_ROLES = ["viewer", "analyst", "data_manager"]  # roles a link or an approved request may give; admins promote further


def new_code() -> str:
    return "-".join("".join(secrets.choice(ALPHABET) for _ in range(4)) for _ in range(3))


def _norm_code(code: str) -> str:
    raw = re.sub(r"[^A-Z0-9]", "", (code or "").upper().rsplit("/", 1)[-1])
    return "-".join(raw[i:i + 4] for i in range(0, len(raw), 4)) if len(raw) == 12 else ""


def email_domain(user: User) -> str | None:
    """The domain of the address the person signed in with. Every sign-in proves that address, so it is verified."""
    d = user.email.rsplit("@", 1)[-1].lower()
    return None if is_free_mail(d) else d


def site(inst: Institution) -> str:
    return settings().frontend_origin.rstrip("/")


async def _members(session: AsyncSession, institution_id: str) -> int:
    return await ms.count(session, institution_id, guests=False)


async def card(session: AsyncSession, inst: Institution) -> dict:
    return {"id": inst.id, "name": inst.name, "logo": inst.logo, "website": inst.website, "kind": inst.kind, "country": inst.country,
            "region": inst.region, "members": await _members(session, inst.id)}


def _logo(data_url: str | None) -> str | None:
    """A logo sent by the browser, re-drawn as a 128px PNG (never stored as sent: no scripts or oversized files)."""
    return images.redraw(data_url, 128, "logo") if data_url else None


async def _admins(session: AsyncSession, institution_id: str) -> list[User]:
    return list(await session.scalars(select(User).join(Membership, Membership.user_id == User.id).where(
        Membership.institution_id == institution_id, Membership.role.in_(["admin", "owner"]), Membership.active.is_(True), User.active.is_(True))))


def _action(inst: Institution, user: User) -> str:
    """What this person can do to get into this institution: join | request | invite_only."""
    if inst.join_policy == "domain" and inst.domain and email_domain(user) == inst.domain:
        return "join"
    return "invite_only" if inst.join_policy == "invite" else "request"


def _can_create(who: Principal) -> None:
    """Anyone can create a workspace, even with one already: people can belong to several and switch between them."""


# ------------------------------------------------------------------------------------------ welcome screen

@router.get("/onboarding")
async def onboarding(who: Principal = Depends(signed_in), session: AsyncSession = Depends(get_session)):
    """Everything waiting for this person: invitations, their institution if its email domain matches, and open requests."""
    u = who.user
    mine = await ms.ids(session, u.id)
    invites = []
    for inv, inst in (await session.execute(select(Invitation, Institution).join(Institution, Institution.id == Invitation.institution_id)
                                            .where(Invitation.email == u.email, Invitation.accepted_at.is_(None), Institution.suspended.is_(False))
                                            .order_by(Invitation.created_at.desc()))).all():
        if inst.id in mine:
            continue
        by = await session.get(User, inv.invited_by)
        invites.append({"id": inv.id, "role": inv.role, "invited_by": (by.name or by.email) if by else None, "created_at": inv.created_at.isoformat(),
                        "institution": await card(session, inst)})
    suggestions = []
    d = email_domain(u)
    if d:
        for inst in (await session.scalars(select(Institution).where(Institution.domain == d, Institution.suspended.is_(False),
                                                                     Institution.discoverable.is_(True)).order_by(Institution.created_at))).all():
            if inst.id not in mine:  # every workspace with this email domain: departments may each have their own
                suggestions.append({**await card(session, inst), "action": _action(inst, u)})
    requests = []
    for r, inst in (await session.execute(select(JoinRequest, Institution).join(Institution, Institution.id == JoinRequest.institution_id)
                                          .where(JoinRequest.user_id == u.id, JoinRequest.status == "pending"))).all():
        requests.append({"id": r.id, "created_at": r.created_at.isoformat(), "institution": await card(session, inst)})
    return {"invitations": invites, "suggestions": suggestions, "requests": requests, "email_domain": d,
            "member_of": None if who.institution is None else {"id": who.institution.id, "name": who.institution.name,
                                                               "personal": "@" in (who.institution.domain or "")}}


class PreviewIn(BaseModel):
    value: str = Field(min_length=3, max_length=300)


@router.post("/onboarding/preview")
async def preview(body: PreviewIn, request: Request, who: Principal = Depends(signed_in), session: AsyncSession = Depends(get_session)):
    """The institution's details from its website or an email address, to check and edit before creating it. If it's
    already on YieldPilot, say so, so colleagues join one workspace instead of making a second."""
    limits.check(f"preview:{who.user.id}", 20, 600)
    info = await run_in_threadpool(orginfo.lookup, body.value)
    if not info.get("domain"):
        raise HTTPException(422, "Enter your institution's website, like csulb.edu, or a work email address.")
    if info.get("free_mail"):
        raise HTTPException(422, f"{info['domain']} is a personal email service. Enter your institution's website instead.")
    existing = await session.scalar(select(Institution).where(
        or_(Institution.domain == info["domain"], Institution.website.ilike(f"%://{info['domain']}"), Institution.website.ilike(f"%://www.{info['domain']}")),
        Institution.discoverable.is_(True), Institution.suspended.is_(False)))
    mine = email_domain(who.user)
    return {**info, "claimable": bool(mine and mine == info["domain"] and not existing),
            "existing": {**await card(session, existing), "action": _action(existing, who.user)} if existing else None}


class CreateIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    website: str | None = Field(None, max_length=300)
    kind: str | None = Field(None, max_length=40)
    country: str | None = Field(None, max_length=80)
    region: str | None = Field(None, max_length=120)
    description: str | None = Field(None, max_length=600)
    logo: str | None = None
    claim_domain: bool = True  # let colleagues with the creator's verified email domain find it


@router.post("/onboarding/institutions")
async def create_institution(body: CreateIn, who: Principal = Depends(signed_in), session: AsyncSession = Depends(get_session)):
    """Create an institution; its creator is the owner and can invite everyone else."""
    _can_create(who)
    limits.check(f"create:{who.user.id}", 5, 3600)
    d = email_domain(who.user)
    domain = d if body.claim_domain and d else None  # several workspaces may share a domain
    web = orginfo.domain_of(body.website or "") if body.website else None
    inst = Institution(name=body.name.strip(), domain=domain, website=f"https://{web}" if web else None, kind=body.kind, country=body.country,
                       region=body.region, description=(body.description or "").strip() or None, logo=_logo(body.logo), join_code=new_code(),
                       join_policy="request", created_by=who.user.id)
    session.add(inst)
    await session.flush()
    session.add(Subscription(institution_id=inst.id, status="free", custom_limits={}))
    await join(session, who.user, inst, "owner", "created")
    await session.commit()
    return {"id": inst.id, "name": inst.name}


@router.get("/onboarding/code/{code}")
async def code_preview(code: str, request: Request, who: Principal = Depends(signed_in), session: AsyncSession = Depends(get_session)):
    """Which institution an invite link or code opens, and the role it gives, before joining."""
    limits.check(f"code:{who.user.id}", 30, 600)
    limits.check(f"code-ip:{client_ip(request)}", 60, 600)
    inst = await session.scalar(select(Institution).where(Institution.join_code == _norm_code(code), Institution.join_code_enabled.is_(True),
                                                          Institution.suspended.is_(False))) if _norm_code(code) else None
    if inst is None:
        raise HTTPException(404, "That invite link or code isn't valid. It may have been replaced; ask for a new one.")
    return {**await card(session, inst), "role": inst.default_role, "member": inst.id in await ms.ids(session, who.user.id)}


class CodeIn(BaseModel):
    code: str = Field(min_length=8, max_length=300)


@router.post("/onboarding/code")
async def join_with_code(body: CodeIn, request: Request, who: Principal = Depends(signed_in), session: AsyncSession = Depends(get_session)):
    limits.check(f"code:{who.user.id}", 30, 600)
    inst = await session.scalar(select(Institution).where(Institution.join_code == _norm_code(body.code), Institution.join_code_enabled.is_(True),
                                                          Institution.suspended.is_(False))) if _norm_code(body.code) else None
    if inst is None:
        raise HTTPException(404, "That invite link or code isn't valid. It may have been replaced; ask for a new one.")
    await plans.check_seat(session, inst.id)
    await join(session, who.user, inst, inst.default_role, "invite link")
    await session.commit()
    return {"id": inst.id, "name": inst.name}


@router.get("/onboarding/find")
async def find(website: str, who: Principal = Depends(signed_in), session: AsyncSession = Depends(get_session)):
    """An institution by its exact website or email domain (no browsing: the customer list stays private)."""
    limits.check(f"find:{who.user.id}", 30, 600)
    d = orginfo.domain_of(website)
    if not d or is_free_mail(d):
        raise HTTPException(422, "Enter your institution's website, like csulb.edu.")
    inst = await session.scalar(select(Institution).where(
        or_(Institution.domain == d, Institution.website.ilike(f"%://{d}"), Institution.website.ilike(f"%://www.{d}")),
        Institution.discoverable.is_(True), Institution.suspended.is_(False)))
    if inst is None:
        return {"found": None}
    return {"found": {**await card(session, inst), "action": _action(inst, who.user), "member": inst.id in await ms.ids(session, who.user.id)}}


class RequestIn(BaseModel):
    institution_id: str
    message: str | None = Field(None, max_length=500)


@router.post("/onboarding/requests")
async def request_to_join(body: RequestIn, who: Principal = Depends(signed_in), session: AsyncSession = Depends(get_session)):
    """Join at once when the institution allows people with this verified email domain, otherwise ask its admins."""
    limits.check(f"request:{who.user.id}", 10, 3600)
    inst = await session.get(Institution, body.institution_id)
    if inst is None or not inst.discoverable or inst.suspended:
        raise HTTPException(404, "That institution isn't available.")
    action = _action(inst, who.user)
    if action == "invite_only":
        raise HTTPException(403, f"{inst.name} is invite only. Ask one of its admins to invite you.")
    if action == "join":
        await plans.check_seat(session, inst.id)
        await join(session, who.user, inst, inst.default_role, "email domain")
        await session.commit()
        return {"joined": True, "id": inst.id, "name": inst.name}
    pending = await session.scalar(select(JoinRequest).where(JoinRequest.user_id == who.user.id, JoinRequest.institution_id == inst.id,
                                                             JoinRequest.status == "pending"))
    if pending is None:
        session.add(JoinRequest(institution_id=inst.id, user_id=who.user.id, message=(body.message or "").strip() or None))
        who_name = who.user.name or who.user.email
        for a in await _admins(session, inst.id):
            session.add(Notification(institution_id=inst.id, recipient_email=a.email, kind="join_request",
                                     title=f"{who_name} asked to join {inst.name}", body=body.message, link="/settings/team"))
            mailer.notify(a.email, f"{who_name} asked to join {inst.name} on YieldPilot",
                          f"{who_name} ({who.user.email}) asked to join {inst.name} on YieldPilot."
                          + (f' Their note: "{body.message.strip()}"' if body.message and body.message.strip() else ""),
                          "Review the request", f"{site(inst)}/settings/team")
        await session.commit()
    return {"joined": False, "requested": True, "name": inst.name}


@router.delete("/onboarding/requests/{request_id}")
async def cancel_request(request_id: str, who: Principal = Depends(signed_in), session: AsyncSession = Depends(get_session)):
    r = await session.scalar(select(JoinRequest).where(JoinRequest.id == request_id, JoinRequest.user_id == who.user.id, JoinRequest.status == "pending"))
    if r is None:
        raise HTTPException(404, "Request not found.")
    r.status, r.decided_at = "cancelled", datetime.now(timezone.utc)
    await session.commit()
    return {"ok": True}


class InviteAnswer(BaseModel):
    accept: bool


@router.post("/onboarding/invitations/{invitation_id}")
async def answer_invitation(invitation_id: str, body: InviteAnswer, who: Principal = Depends(signed_in), session: AsyncSession = Depends(get_session)):
    inv = await session.scalar(select(Invitation).where(Invitation.id == invitation_id, Invitation.email == who.user.email,
                                                        Invitation.accepted_at.is_(None)))
    if inv is None:
        raise HTTPException(404, "That invitation is no longer open.")
    inst = await session.get(Institution, inv.institution_id)
    if inst is None or inst.suspended:
        raise HTTPException(404, "That institution isn't available.")
    if body.accept:
        await join(session, who.user, inst, inv.role, "invitation", by=inv.invited_by)
        inv.accepted_at = datetime.now(timezone.utc)
    else:
        await session.delete(inv)
    await session.commit()
    return {"ok": True, "id": inst.id, "name": inst.name}


# ------------------------------------------------------------------------------------------ institution settings

def _profile(inst: Institution, who: Principal, members: int) -> dict:
    admin = who.at_least("admin")
    return {"id": inst.id, "name": inst.name, "logo": inst.logo, "website": inst.website, "description": inst.description, "kind": inst.kind,
            "country": inst.country, "region": inst.region, "domain": inst.domain, "members": members, "join_policy": inst.join_policy,
            "default_role": inst.default_role, "discoverable": inst.discoverable,
            "join_code": inst.join_code if admin else None, "join_code_enabled": inst.join_code_enabled if admin else None,
            "invite_url": f"{site(inst)}/join/{inst.join_code}" if admin and inst.join_code else None,
            "claimable_domain": email_domain(who.user) if admin and not inst.domain else None,
            "created_at": inst.created_at.isoformat()}


@router.get("/institution")
async def get_institution(who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    return _profile(who.institution, who, await _members(session, who.institution.id))


class InstitutionPatch(BaseModel):
    name: str | None = Field(None, min_length=2, max_length=200)
    website: str | None = Field(None, max_length=300)
    description: str | None = Field(None, max_length=600)
    kind: str | None = Field(None, max_length=40)
    country: str | None = Field(None, max_length=80)
    region: str | None = Field(None, max_length=120)
    logo: str | None = None
    join_policy: str | None = None
    default_role: str | None = None
    discoverable: bool | None = None
    claim_domain: bool | None = None
    join_code_enabled: bool | None = None
    rotate_code: bool | None = None


@router.patch("/institution")
async def update_institution(body: InstitutionPatch, who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    who.require("admin")
    inst = await session.get(Institution, who.institution.id)
    data = body.model_dump(exclude_unset=True)
    for k in ("name", "description", "kind", "country", "region"):
        if k in data:
            setattr(inst, k, (data[k] or "").strip() or (inst.name if k == "name" else None))
    if "website" in data:
        d = orginfo.domain_of(data["website"] or "") if data["website"] else None
        inst.website = f"https://{d}" if d else None
    if "logo" in data:
        inst.logo = _logo(data["logo"])
    if data.get("join_policy"):
        if data["join_policy"] not in ("domain", "request", "invite"):
            raise HTTPException(422, "Unknown joining option.")
        if data["join_policy"] == "domain" and not inst.domain:
            raise HTTPException(422, "Verify your email domain first, so YieldPilot knows who your colleagues are.")
        inst.join_policy = data["join_policy"]
    if data.get("default_role"):
        if data["default_role"] not in JOINABLE_ROLES:
            raise HTTPException(422, "New members can start as viewer, analyst or data manager.")
        inst.default_role = data["default_role"]
    if data.get("discoverable") is not None:
        inst.discoverable = bool(data["discoverable"])
    if data.get("claim_domain"):
        d = email_domain(who.user)
        if not d:
            raise HTTPException(422, "Sign in with your institution email (not a personal address) to verify its domain.")
        inst.domain = d
    if data.get("join_code_enabled") is not None:
        inst.join_code_enabled = bool(data["join_code_enabled"])
    if data.get("rotate_code") or (inst.join_code is None and data.get("join_code_enabled")):
        inst.join_code = new_code()  # the old link stops working at once
    await audit(session, who, "institution.updated", inst.id, fields=sorted(k for k in data if k != "logo"))
    await session.commit()
    who.institution = inst
    return _profile(inst, who, await _members(session, inst.id))


@router.post("/institution/refresh")
async def refresh_details(who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """Fetch the logo and any missing details again from the institution's website."""
    who.require("admin")
    inst = await session.get(Institution, who.institution.id)
    source = inst.website or inst.domain
    if not source:
        raise HTTPException(422, "Add your institution's website first.")
    info = await run_in_threadpool(orginfo.lookup, source)
    if info.get("logo"):
        inst.logo = info["logo"]
    for k in ("description", "kind", "country", "region"):
        if not getattr(inst, k) and info.get(k):
            setattr(inst, k, info[k])
    await session.commit()
    return _profile(inst, who, await _members(session, inst.id))


@router.get("/institution/requests")
async def join_requests(who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    who.require("admin")
    rows = (await session.execute(select(JoinRequest, User).join(User, User.id == JoinRequest.user_id)
                                  .where(JoinRequest.institution_id == who.institution.id, JoinRequest.status == "pending")
                                  .order_by(JoinRequest.created_at))).all()
    return [{"id": r.id, "name": u.name, "email": u.email, "photo": u.photo, "message": r.message, "created_at": r.created_at.isoformat()}
            for r, u in rows]


class Decision(BaseModel):
    approve: bool
    role: str | None = None


@router.post("/institution/requests/{request_id}")
async def decide(request_id: str, body: Decision, who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    who.require("admin")
    r = await session.scalar(select(JoinRequest).where(JoinRequest.id == request_id, JoinRequest.institution_id == who.institution.id,
                                                       JoinRequest.status == "pending"))
    if r is None:
        raise HTTPException(404, "That request was already answered.")
    u = await session.get(User, r.user_id)
    inst = who.institution
    role = body.role or inst.default_role
    if role not in ROLES or not who.at_least(role) or role == "guest":
        raise HTTPException(403, "You can't give that role.")
    if body.approve:
        await plans.check_seat(session, inst.id)
        await join(session, u, inst, role, "request approved", by=who.user.id, switch=False)
    r.status, r.decided_by, r.decided_at = ("approved" if body.approve else "declined"), who.user.id, datetime.now(timezone.utc)
    title = f"You're now a member of {inst.name}" if body.approve else f"Your request to join {inst.name} wasn't approved"
    session.add(Notification(institution_id=inst.id, recipient_email=u.email, kind="join_decision", title=title, link="/"))
    mailer.notify(u.email, f"{title} on YieldPilot",
                  f"{who.user.name or who.user.email} approved your request to join {inst.name} on YieldPilot."
                  if body.approve else f"Your request to join {inst.name} on YieldPilot wasn't approved. Ask a colleague for an invitation.",
                  "Open YieldPilot", site(inst))
    await audit(session, who, "member.request_" + ("approved" if body.approve else "declined"), u.email, role=role)
    await session.commit()
    return {"ok": True}
