"""The operator dashboard for YieldPilot staff (OPERATOR_EMAILS): institutions, people, runs, plans and payments.
Counts and money only: it never reads student records. Every change is recorded in the activity log."""

import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import ROLES, Principal, delete_account, end_sessions, is_free_mail, operator
from ..config import settings
from ..db import get_session
from ..storage import storage
from ..models import AuditEvent, Connection, Dataset, DatasetVersion, Forecast, Institution, Invitation, JoinRequest, Notification, OperatorAccess, Membership, Payment, Plan, Project, RunLog, Subscription, UsageEvent, User
from ..services import costs, google_bill, mailer, orginfo, plans
from ..services import members as ms
from .institution import new_code

router = APIRouter(prefix="/admin", tags=["admin"])


def _log(session: AsyncSession, who: Principal, institution_id: str | None, action: str, target: str, /, **meta) -> None:
    session.add(AuditEvent(institution_id=institution_id, user_id=who.user.id, action=f"admin.{action}", target=target, meta=meta))


def _monthly_cents(sub: Subscription, catalog: dict[str, Plan]) -> int:
    """What an active subscription brings in per month (yearly prices spread over 12 months)."""
    p = catalog.get(sub.plan_key or "")
    if p is None or sub.test_mode or sub.status not in ("active", "past_due"):
        return 0
    if sub.interval == "month" and p.price_month_cents:
        return p.price_month_cents
    return round((p.price_year_cents or 0) / 12)


@router.get("/overview")
async def overview(who: Principal = Depends(operator), session: AsyncSession = Depends(get_session)):
    now = datetime.now(timezone.utc)
    month = plans.month_start(now)
    catalog = {p.key: p for p in (await session.scalars(select(Plan))).all()}
    subs = (await session.scalars(select(Subscription))).all()
    count = lambda q: session.scalar(select(func.count()).select_from(q))  # noqa: E731
    day, week, mon = (func.date_trunc("day", RunLog.started_at), func.date_trunc("week", User.created_at),
                      func.date_trunc("month", Payment.created_at))
    runs_day = (await session.execute(
        select(day, func.count()).where(RunLog.outcome == "done", RunLog.started_at >= now - timedelta(days=30)).group_by(day).order_by(day))).all()
    signups = (await session.execute(
        select(week, func.count()).where(User.created_at >= now - timedelta(weeks=12), User.deleted_at.is_(None)).group_by(week).order_by(week))).all()
    revenue = (await session.execute(
        select(mon, func.sum(Payment.amount_cents)).where(Payment.test_mode.is_(False), Payment.status == "paid", Payment.created_at >= now - timedelta(days=365))
        .group_by(mon).order_by(mon))).all()
    mix: dict[str, int] = {}
    for s in subs:
        label = "Full access" if s.status == "full_access" else f"{catalog[s.plan_key].name if s.plan_key in catalog else 'No plan'} ({s.status.replace('_', ' ')})"
        mix[label] = mix.get(label, 0) + 1
    return {
        "institutions": await count(Institution),
        "users": await session.scalar(select(func.count()).select_from(User).where(User.deleted_at.is_(None))),
        "active_users": await session.scalar(select(func.count()).select_from(User).where(User.last_login_at >= now - timedelta(days=30))),
        "runs_month": await session.scalar(select(func.count()).select_from(RunLog).where(RunLog.outcome == "done", RunLog.started_at >= month)),
        "runs_failed_month": await session.scalar(select(func.count()).select_from(RunLog).where(RunLog.outcome == "failed", RunLog.started_at >= month)),
        "avg_run_seconds": round(await session.scalar(select(func.avg(RunLog.seconds)).where(RunLog.outcome == "done", RunLog.started_at >= month)) or 0, 1),
        "mrr_cents": sum(_monthly_cents(s, catalog) for s in subs),
        "revenue_month_cents": await session.scalar(select(func.coalesce(func.sum(Payment.amount_cents), 0)).where(Payment.test_mode.is_(False), Payment.status == "paid", Payment.created_at >= month)),
        "failed_payments": await session.scalar(select(func.count()).select_from(Payment).where(Payment.test_mode.is_(False), Payment.status == "failed", Payment.created_at >= now - timedelta(days=30))),
        "plan_mix": [{"label": k, "value": v} for k, v in sorted(mix.items(), key=lambda x: -x[1])],
        "runs_per_day": [{"day": d.date().isoformat(), "runs": n} for d, n in runs_day],
        "signups_per_week": [{"week": d.date().isoformat(), "users": n} for d, n in signups],
        "revenue_per_month": [{"month": d.date().isoformat()[:7], "cents": int(c or 0)} for d, c in revenue],
    }


@router.get("/institutions")
async def institutions(who: Principal = Depends(operator), session: AsyncSession = Depends(get_session)):
    month = plans.month_start()
    insts = (await session.scalars(select(Institution).order_by(Institution.created_at.desc()))).all()
    subs = {s.institution_id: s for s in (await session.scalars(select(Subscription))).all()}
    catalog = {p.key: p for p in (await session.scalars(select(Plan))).all()}
    members = dict((await session.execute(select(Membership.institution_id, func.count()).join(User, User.id == Membership.user_id).where(
        Membership.active.is_(True), User.active.is_(True), User.deleted_at.is_(None)).group_by(Membership.institution_id))).all())
    last = dict((await session.execute(select(Membership.institution_id, func.max(User.last_login_at)).join(User, User.id == Membership.user_id)
                                       .group_by(Membership.institution_id))).all())
    invites = dict((await session.execute(select(Invitation.institution_id, func.count()).where(Invitation.accepted_at.is_(None))
                                          .group_by(Invitation.institution_id))).all())
    runs = dict((await session.execute(select(RunLog.institution_id, func.count()).where(RunLog.outcome == "done", RunLog.started_at >= month)
                                       .group_by(RunLog.institution_id))).all())
    studies = dict((await session.execute(select(Project.institution_id, func.count()).group_by(Project.institution_id))).all())
    paid = dict((await session.execute(select(Payment.institution_id, func.sum(Payment.amount_cents)).where(Payment.test_mode.is_(False), Payment.status == "paid")
                                       .group_by(Payment.institution_id))).all())
    out = []
    for i in insts:
        s = subs.get(i.id)
        out.append({
            "id": i.id, "name": i.name, "domain": i.domain, "personal": "@" in (i.domain or ""), "created_at": i.created_at.isoformat(),
            "logo": i.logo, "website": i.website,
            "plan": s.plan_key if s else None, "plan_name": catalog[s.plan_key].name if s and s.plan_key in catalog else None,
            "status": s.status if s else "full_access", "interval": s.interval if s else None,
            "custom_limits": (s.custom_limits if s else {}) or {}, "seats_used": members.get(i.id, 0), "pending_invites": invites.get(i.id, 0),
            "runs_month": runs.get(i.id, 0), "studies": studies.get(i.id, 0), "paid_cents": int(paid.get(i.id) or 0),
            "mrr_cents": _monthly_cents(s, catalog) if s else 0, "last_active": last[i.id].isoformat() if last.get(i.id) else None,
            "suspended": i.suspended, "join_policy": i.join_policy,
        })
    return out


class InstitutionIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    domain: str = Field(min_length=3, max_length=200, pattern=r"^[a-z0-9.-]+\.[a-z]{2,}$")  # its email domain (staff verify it with the customer)
    plan: str | None = None
    owner_email: str | None = Field(None, max_length=320, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    join_policy: str = "request"


@router.post("/institutions")
async def create_institution(body: InstitutionIn, who: Principal = Depends(operator), session: AsyncSession = Depends(get_session)):
    """Set up a customer before anyone there signs in: people with this email domain join it, the owner gets an invitation."""
    domain = body.domain.lower()
    if is_free_mail(domain):
        raise HTTPException(422, "That's a free email service. Institutions use their own domain.")
    if await session.scalar(select(Institution).where(Institution.domain == domain)):
        raise HTTPException(409, "An institution with that domain already exists.")
    if body.plan and not await session.get(Plan, body.plan):
        raise HTTPException(422, "Unknown plan.")
    info = await run_in_threadpool(orginfo.lookup, domain)  # logo, website and location, as when a customer creates it
    inst = Institution(name=body.name.strip(), domain=domain, join_policy=body.join_policy if body.join_policy in ("domain", "request", "invite") else "request",
                       website=info.get("website"), logo=info.get("logo"), description=info.get("description"), kind=info.get("kind"),
                       country=info.get("country"), region=info.get("region"), join_code=new_code(), created_by=who.user.id)
    session.add(inst)
    await session.flush()
    session.add(Subscription(institution_id=inst.id, plan_key=body.plan, status="full_access" if not body.plan else "active", custom_limits={}))
    if body.owner_email:
        _invite(session, who, inst, body.owner_email.strip().lower(), "owner")
    _log(session, who, inst.id, "institution_created", inst.id, name=inst.name, plan=body.plan)
    await session.commit()
    return {"id": inst.id}


class InstitutionPatch(BaseModel):
    name: str | None = Field(None, min_length=2, max_length=200)
    plan: str | None = None
    status: str | None = None
    custom_limits: dict | None = None
    suspended: bool | None = None
    join_policy: str | None = None


@router.patch("/institutions/{institution_id}")
async def update_institution(institution_id: str, body: InstitutionPatch, who: Principal = Depends(operator),
                             session: AsyncSession = Depends(get_session)):
    inst = await session.get(Institution, institution_id)
    if inst is None:
        raise HTTPException(404, "Institution not found.")
    sub = await plans.subscription(session, institution_id)
    data = body.model_dump(exclude_unset=True)
    if "plan" in data:
        if data["plan"] and not await session.get(Plan, data["plan"]):
            raise HTTPException(422, "Unknown plan.")
        sub.plan_key = data["plan"] or None
        if "status" not in data and not sub.stripe_subscription_id:  # chosen here, not bought: the plan applies at once
            sub.status = "active" if sub.plan_key else "full_access"
    if "status" in data:
        if data["status"] not in ("full_access", "free", "trialing", "active", "past_due", "canceled"):
            raise HTTPException(422, "Unknown status.")
        sub.status = data["status"]
    if "custom_limits" in data:
        sub.custom_limits = {k: (None if v in (None, "") else int(v)) for k, v in (data["custom_limits"] or {}).items() if k in plans.LIMIT_KEYS}
    if "suspended" in data:
        inst.suspended = bool(data["suspended"])
    if "join_policy" in data:
        inst.join_policy = data["join_policy"] if data["join_policy"] in ("domain", "request", "invite") else "request"
    if data.get("name"):
        inst.name = data["name"].strip()
    _log(session, who, inst.id, "institution_updated", inst.id, **{k: v for k, v in data.items() if k != "custom_limits"})
    await session.commit()
    return {"ok": True}


def _invite(session: AsyncSession, who: Principal, inst: Institution, email: str, role: str) -> None:
    session.add(Invitation(institution_id=inst.id, email=email, role=role, invited_by=who.user.id))
    session.add(Notification(institution_id=inst.id, recipient_email=email, kind="invite",
                             title=f"You're invited to {inst.name} on YieldPilot", link="/welcome"))
    mailer.notify(email, f"You're invited to {inst.name} on YieldPilot",
                  f"You've been invited to join {inst.name} on YieldPilot, the admission yield forecasting workspace, as {role.replace('_', ' ')}.",
                  f"Sign in with {email} to accept", f"{settings().frontend_origin.rstrip('/')}/login?email={email}")


class MemberIn(BaseModel):
    email: str = Field(max_length=320, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    role: str = "analyst"


@router.post("/institutions/{institution_id}/members")
async def add_member(institution_id: str, body: MemberIn, who: Principal = Depends(operator), session: AsyncSession = Depends(get_session)):
    """Add someone to an institution: they're invited by email and join it when they next sign in and accept."""
    inst = await session.get(Institution, institution_id)
    if inst is None:
        raise HTTPException(404, "Institution not found.")
    if body.role not in ROLES:
        raise HTTPException(422, "Unknown role.")
    email = body.email.strip().lower()
    member = await session.scalar(select(User).where(User.email == email))
    if member is not None and member.institution_id == inst.id:
        raise HTTPException(409, f"{email} is already a member.")
    old = await session.scalar(select(Invitation).where(Invitation.institution_id == inst.id, Invitation.email == email, Invitation.accepted_at.is_(None)))
    if old is not None:
        old.role = body.role
    else:
        _invite(session, who, inst, email, body.role)
    _log(session, who, inst.id, "member_invited", email, role=body.role)
    await session.commit()
    return {"ok": True}


@router.get("/institutions/{institution_id}")
async def institution_detail(institution_id: str, who: Principal = Depends(operator), session: AsyncSession = Depends(get_session)):
    """One institution for the operator's side panel: profile, plan, people, invitations, requests and activity."""
    i = await session.get(Institution, institution_id)
    if i is None:
        raise HTTPException(404, "Institution not found.")
    month = plans.month_start()
    sub = await plans.subscription(session, i.id)
    catalog = {p.key: p for p in (await session.scalars(select(Plan))).all()}
    runs = dict((await session.execute(select(RunLog.user_id, func.count()).where(RunLog.institution_id == i.id, RunLog.outcome == "done",
                                                                                 RunLog.started_at >= month).group_by(RunLog.user_id))).all())
    people = [u for u, _ in (await session.execute(ms.people(i.id).where(Membership.active.is_(True)).order_by(Membership.role.desc(), User.created_at))).all()]
    roles = {u: r for u, r in (await session.execute(select(Membership.user_id, Membership.role).where(Membership.institution_id == i.id))).all()}
    for u in people:  # this workspace's role, which may differ from the one they're working in now
        session.expunge(u)
        u.role = roles.get(u.id, u.role)
    invites = (await session.scalars(select(Invitation).where(Invitation.institution_id == i.id, Invitation.accepted_at.is_(None))
                                     .order_by(Invitation.created_at.desc()))).all()
    requests = await session.scalar(select(func.count()).select_from(JoinRequest).where(JoinRequest.institution_id == i.id, JoinRequest.status == "pending"))
    studies = await session.scalar(select(func.count()).select_from(Project).where(Project.institution_id == i.id))
    paid = await session.scalar(select(func.coalesce(func.sum(Payment.amount_cents), 0)).where(Payment.test_mode.is_(False), Payment.institution_id == i.id, Payment.status == "paid"))
    await session.commit()
    return {
        "id": i.id, "name": i.name, "logo": i.logo, "website": i.website, "domain": i.domain, "personal": "@" in (i.domain or ""),
        "description": i.description, "kind": i.kind, "country": i.country, "region": i.region, "created_at": i.created_at.isoformat(),
        "join_policy": i.join_policy, "default_role": i.default_role, "discoverable": i.discoverable, "suspended": i.suspended,
        "invite_url": f"{settings().frontend_origin.rstrip('/')}/join/{i.join_code}" if i.join_code and i.join_code_enabled else None,
        "plan": sub.plan_key, "plan_name": catalog[sub.plan_key].name if sub.plan_key in catalog else None, "status": sub.status,
        "interval": sub.interval, "custom_limits": sub.custom_limits or {}, "mrr_cents": _monthly_cents(sub, catalog), "paid_cents": int(paid or 0),
        "studies": studies, "runs_month": sum(runs.values()), "pending_requests": requests,
        "members": [{"id": u.id, "name": u.name, "email": u.email, "photo": u.photo, "role": u.role, "active": u.active,
                     "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None, "runs_month": runs.get(u.id, 0)} for u in people],
        "invitations": [{"id": v.id, "email": v.email, "role": v.role, "created_at": v.created_at.isoformat()} for v in invites],
    }


@router.delete("/institutions/{institution_id}/invitations/{invitation_id}")
async def cancel_invitation(institution_id: str, invitation_id: str, who: Principal = Depends(operator), session: AsyncSession = Depends(get_session)):
    inv = await session.scalar(select(Invitation).where(Invitation.id == invitation_id, Invitation.institution_id == institution_id,
                                                        Invitation.accepted_at.is_(None)))
    if inv is None:
        raise HTTPException(404, "Invitation not found.")
    await session.delete(inv)
    _log(session, who, institution_id, "invite_cancelled", inv.email)
    await session.commit()
    return {"ok": True}


@router.get("/users")
async def users(q: str = "", who: Principal = Depends(operator), session: AsyncSession = Depends(get_session)):
    month = plans.month_start()
    stmt = select(User, Institution.name).outerjoin(Institution, Institution.id == User.institution_id).where(User.deleted_at.is_(None)).order_by(User.created_at.desc()).limit(500)
    if q.strip():
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(or_(func.lower(User.email).like(like), func.lower(func.coalesce(User.name, "")).like(like),
                              func.lower(Institution.name).like(like)))
    rows = (await session.execute(stmt)).all()
    runs = dict((await session.execute(select(RunLog.user_id, func.count()).where(RunLog.outcome == "done", RunLog.started_at >= month)
                                       .group_by(RunLog.user_id))).all())
    use = await _usage_by_person(session, datetime.now(timezone.utc) - timedelta(days=30))
    spaces: dict[str, list[dict]] = {}
    for m, iname in (await session.execute(select(Membership, Institution.name).join(Institution, Institution.id == Membership.institution_id)
                                           .order_by(Institution.name))).all():
        spaces.setdefault(m.user_id, []).append({"id": m.institution_id, "name": iname, "role": m.role, "active": m.active, "ml": m.ml_access})
    return [{"id": u.id, "email": u.email, "name": u.name, "institution_id": u.institution_id, "institution": name or "Not in an institution yet",
             "role": u.role,
             "active": u.active, "created_at": u.created_at.isoformat(), "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None,
             "runs_month": runs.get(u.id, 0),
             "workspaces": [{**w, "current": w["id"] == u.institution_id} for w in spaces.get(u.id, [])],
             "ml": u.role in ("admin", "owner") or any(w["ml"] for w in spaces.get(u.id, []) if w["id"] == u.institution_id),
             **use.get(u.id, _NO_USE)} for u, name in rows]


_NO_USE = {"runs_30": 0, "run_seconds_30": 0.0, "cpu_seconds_30": 0.0, "ai_calls_30": 0, "tokens_30": 0, "imports_30": 0, "cost_30": 0.0,
           "last_active_at": None}


async def _usage_by_person(session: AsyncSession, since: datetime) -> dict[str, dict]:
    """Each person's measured use since `since`: runs (time, CPU), AI calls (tokens), imports, and what it cost at Google's prices."""
    out: dict[str, dict] = {}

    def row(uid: str) -> dict:
        return out.setdefault(uid, dict(_NO_USE))

    for uid, n, secs, cpu, cost, last in (await session.execute(
            select(RunLog.user_id, func.count(), func.sum(RunLog.seconds), func.sum(RunLog.cpu_seconds), func.sum(costs._RUN_COST),
                   func.max(RunLog.started_at)).where(RunLog.started_at >= since).group_by(RunLog.user_id))).all():
        r = row(uid)
        r.update(runs_30=n, run_seconds_30=round(secs or 0, 1), cpu_seconds_30=round(cpu or 0, 1), cost_30=r["cost_30"] + (cost or 0),
                 last_active_at=last)
    for uid, kind, model, n, tin, tout, secs, last in (await session.execute(
            select(UsageEvent.user_id, UsageEvent.kind, UsageEvent.model, func.count(), func.sum(UsageEvent.input_tokens),
                   func.sum(UsageEvent.output_tokens), func.sum(UsageEvent.seconds), func.max(UsageEvent.at))
            .where(UsageEvent.at >= since).group_by(UsageEvent.user_id, UsageEvent.kind, UsageEvent.model))).all():
        r = row(uid)
        if kind == "ai":
            r["ai_calls_30"] += n
            r["tokens_30"] += int((tin or 0) + (tout or 0))
            r["cost_30"] += costs.ai_cost(model, tin or 0, tout or 0)
        else:
            r["imports_30"] += n
            r["cost_30"] += (secs or 0) * costs._machine_second()
        r["last_active_at"] = max(x for x in (r["last_active_at"], last) if x)
    for r in out.values():
        r["cost_30"] = round(r["cost_30"], 4)
        r["last_active_at"] = r["last_active_at"].isoformat() if r["last_active_at"] else None
    return out


class WorkspaceRoleIn(BaseModel):
    role: str


@router.put("/users/{user_id}/workspaces/{institution_id}")
async def set_workspace(user_id: str, institution_id: str, body: WorkspaceRoleIn, who: Principal = Depends(operator),
                        session: AsyncSession = Depends(get_session)):
    """Add someone to a workspace with a role, or change their role there. Their other workspaces stay."""
    u, inst = await session.get(User, user_id), await session.get(Institution, institution_id)
    if u is None or u.deleted_at is not None or inst is None:
        raise HTTPException(404, "Not found.")
    if body.role not in ROLES:
        raise HTTPException(422, "Unknown role.")
    if settings().is_operator(u.email) and u.id != who.user.id:
        raise HTTPException(403, "This person is a main operator: their role and access can't be changed by anyone else.")
    m = await ms.get(session, u.id, inst.id)
    if m is not None and m.role == "owner" and body.role != "owner" and await ms.owners(session, inst.id) <= 1:
        raise HTTPException(422, f"Every workspace needs an owner. Make someone else an owner of {inst.name} first.")
    if m is None:
        await ms.add(session, u, inst.id, body.role, switch=False)
    else:
        m.role, m.active = body.role, True
        if u.institution_id == inst.id:
            u.role = body.role
    _log(session, who, inst.id, "workspace_role_set", u.id, role=body.role)
    await session.commit()
    return {"ok": True}


@router.delete("/users/{user_id}/workspaces/{institution_id}")
async def remove_workspace(user_id: str, institution_id: str, who: Principal = Depends(operator), session: AsyncSession = Depends(get_session)):
    """Take someone out of one workspace. Their account and other workspaces stay."""
    u = await session.get(User, user_id)
    m = await ms.get(session, user_id, institution_id) if u else None
    if u is None or m is None:
        raise HTTPException(404, "Not found.")
    if settings().is_operator(u.email) and u.id != who.user.id:
        raise HTTPException(403, "This person is a main operator: their role and access can't be changed by anyone else.")
    if m.role == "owner" and await ms.owners(session, institution_id) <= 1 and await ms.count(session, institution_id) > 1:
        raise HTTPException(422, "They're this workspace's only owner. Make someone else an owner there first.")
    await ms.leave(session, u, institution_id)
    _log(session, who, institution_id, "workspace_removed", u.id)
    await session.commit()
    return {"ok": True}


@router.post("/users/{user_id}/signout")
async def sign_out_user(user_id: str, who: Principal = Depends(operator), session: AsyncSession = Depends(get_session)):
    """Ends every session the person has, on every device."""
    u = await session.get(User, user_id)
    if u is None or u.deleted_at is not None:
        raise HTTPException(404, "User not found.")
    await end_sessions(session, u.id)
    _log(session, who, u.institution_id, "user_signed_out", u.id)
    await session.commit()
    return {"ok": True}


class MlIn(BaseModel):
    granted: bool


@router.put("/users/{user_id}/ml")
async def set_ml(user_id: str, body: MlIn, who: Principal = Depends(operator), session: AsyncSession = Depends(get_session)):
    """Give or remove the ML workspace (admins and owners always have it)."""
    u = await session.get(User, user_id)
    if u is None or u.deleted_at is not None:
        raise HTTPException(404, "User not found.")
    m = await ms.get(session, u.id, u.institution_id)
    if m is None or m.role == "guest":
        raise HTTPException(422, "Only a member of an institution can use the ML workspace.")
    m.ml_access, m.ml_granted_by = body.granted, who.user.id if body.granted else None  # in the workspace they're working in now
    _log(session, who, u.institution_id, "ml_access_given" if body.granted else "ml_access_removed", u.id)
    await session.commit()
    return {"ok": True}


class UserPatch(BaseModel):
    role: str | None = None
    active: bool | None = None
    institution_id: str | None = None


@router.patch("/users/{user_id}")
async def update_user(user_id: str, body: UserPatch, who: Principal = Depends(operator), session: AsyncSession = Depends(get_session)):
    u = await session.get(User, user_id)
    if u is None:
        raise HTTPException(404, "User not found.")
    data = body.model_dump(exclude_unset=True)
    if settings().is_operator(u.email) and u.id != who.user.id:
        raise HTTPException(403, "This person is a main operator: their role and access can't be changed by anyone else.")
    if data.get("role"):
        if data["role"] not in ROLES:
            raise HTTPException(422, "Unknown role.")
        u.role = data["role"]
        m = await ms.get(session, u.id, u.institution_id)
        if m is not None:
            m.role = data["role"]
    if "active" in data and data["active"] is not None:
        u.active = data["active"]
        if not u.active:
            await end_sessions(session, u.id)
    if data.get("institution_id") and data["institution_id"] != u.institution_id:
        if await session.get(Institution, data["institution_id"]) is None:
            raise HTTPException(404, "Institution not found.")
        await ms.add(session, u, data["institution_id"], data.get("role") or u.role or "viewer")  # added and opened; their other workspaces stay
    _log(session, who, u.institution_id, "user_updated", u.email, **data)
    await session.commit()
    return {"ok": True}


@router.delete("/users/{user_id}")
async def delete_user(user_id: str, who: Principal = Depends(operator), session: AsyncSession = Depends(get_session)):
    """Delete someone's account. They're signed out at once and sign up again as a new person; their institution keeps its shared work."""
    u = await session.get(User, user_id)
    if u is None or u.deleted_at is not None:
        raise HTTPException(404, "User not found.")
    if u.id == who.user.id:
        raise HTTPException(422, "You can't delete your own account here.")
    if settings().is_operator(u.email):
        raise HTTPException(403, "A main operator can't be deleted here.")
    for m in (await session.scalars(select(Membership).where(Membership.user_id == u.id, Membership.role == "owner", Membership.active.is_(True)))).all():
        if await ms.owners(session, m.institution_id) <= 1 and await ms.count(session, m.institution_id) > 1:
            name = (await session.get(Institution, m.institution_id)).name
            raise HTTPException(422, f"This is {name}'s only owner. Make someone else an owner there first.")
    institution_id = u.institution_id
    await delete_account(session, u)
    _log(session, who, institution_id, "user_deleted", u.id)
    await session.commit()
    return {"ok": True}


class AllowanceIn(BaseModel):
    runs: int | None = Field(None, ge=0, le=100_000)


class DeleteIn(BaseModel):
    confirm: str = Field(max_length=300)  # the institution's name, typed by the operator


@router.post("/institutions/{institution_id}/delete")
async def delete_institution(institution_id: str, body: DeleteIn, who: Principal = Depends(operator), session: AsyncSession = Depends(get_session)):
    """Delete a workspace and everything in it, for good: predictions, data, forecasts, files, invitations, usage and billing records.
    People keep their accounts and their other workspaces; anyone working in this one moves to another of theirs."""
    _main_only(who)
    inst = await session.get(Institution, institution_id)
    if inst is None:
        raise HTTPException(404, "Institution not found.")
    if body.confirm.strip().lower() != inst.name.strip().lower():
        raise HTTPException(422, "Type the institution's name exactly to confirm.")
    sub = await session.get(Subscription, inst.id)
    if sub and sub.stripe_subscription_id and not sub.test_mode and sub.status in ("active", "trialing", "past_due"):
        raise HTTPException(409, f"{inst.name} has a paid subscription. Cancel it in Stripe first, then delete the institution.")
    for u in (await session.scalars(select(User).where(User.institution_id == inst.id))).all():
        nxt = await ms.fallback(session, u, exclude=inst.id)
        if nxt is not None:
            ms.use(u, nxt)
        else:
            u.institution_id = None  # the welcome screen
    from ..models import MlAccess, RunAllowance, Share, Upload
    # children first, so no row is left pointing at a deleted one
    from ..models import TuningRun
    await session.execute(delete(TuningRun).where(TuningRun.institution_id == inst.id))
    for table in (Share, Forecast, Project, DatasetVersion, Dataset, Upload, Connection, Invitation, JoinRequest, Notification, Payment, RunLog,
                  UsageEvent, MlAccess, RunAllowance, Membership, Subscription, AuditEvent):
        await session.execute(delete(table).where(table.institution_id == inst.id))
    name = inst.name
    await session.delete(inst)
    _log(session, who, None, "institution_deleted", institution_id, name=name)
    await session.commit()
    try:
        await run_in_threadpool(storage().delete_prefix, f"{institution_id}/")  # its uploaded files, data versions and models
    except Exception:
        logging.getLogger(__name__).exception("couldn't delete the files of deleted institution %s", institution_id)
    return {"ok": True}


@router.get("/institutions/{institution_id}/runs")
async def institution_runs(institution_id: str, who: Principal = Depends(operator), session: AsyncSession = Depends(get_session)):
    """Each member's runs this month, their allowance and what's left."""
    if await session.get(Institution, institution_id) is None:
        raise HTTPException(404, "Institution not found.")
    out = await plans.member_runs(session, institution_id)
    await session.commit()
    return {**out, "can_edit": True}


@router.put("/institutions/{institution_id}/runs/{user_id}")
async def set_institution_runs(institution_id: str, user_id: str, body: AllowanceIn, who: Principal = Depends(operator),
                               session: AsyncSession = Depends(get_session)):
    await plans.set_allowance(session, institution_id, user_id, body.runs, who.user.id)
    _log(session, who, institution_id, "runs_allowance_set", user_id, runs=body.runs)
    await session.commit()
    return {**(await plans.member_runs(session, institution_id)), "can_edit": True}


@router.get("/operators")
async def operator_list(who: Principal = Depends(operator), session: AsyncSession = Depends(get_session)):
    """Who can open this dashboard. Main operators come from OPERATOR_EMAILS; the others were added here."""
    main = settings().operators()
    grants = [g for g in (await session.scalars(select(OperatorAccess).order_by(OperatorAccess.created_at))).all() if g.email not in main]
    people = {u.email: u for u in (await session.scalars(select(User).where(User.email.in_([*main, *[g.email for g in grants]])))).all()}
    adders = {u.id: u.name or u.email for u in (await session.scalars(select(User).where(User.id.in_({g.added_by for g in grants})))).all()} if grants else {}

    def row(email: str, grant: OperatorAccess | None) -> dict:
        u = people.get(email)
        return {"email": email, "name": u.name if u else None, "photo": u.photo if u else None, "main": grant is None, "signed_up": u is not None,
                "last_login_at": u.last_login_at.isoformat() if u and u.last_login_at else None, "added_at": grant.created_at.isoformat() if grant else None,
                "added_by": adders.get(grant.added_by, "Former member") if grant else None}

    return {"can_manage": who.main_operator, "operators": [*[row(e, None) for e in main], *[row(g.email, g) for g in grants]]}


class OperatorIn(BaseModel):
    email: str = Field(max_length=320, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _main_only(who: Principal) -> None:
    if not who.main_operator:
        raise HTTPException(403, "Only the main operator can change who has operator access.")


@router.post("/operators")
async def add_operator(body: OperatorIn, who: Principal = Depends(operator), session: AsyncSession = Depends(get_session)):
    _main_only(who)
    email = body.email.strip().lower()
    if settings().is_operator(email) or await session.get(OperatorAccess, email) is not None:
        raise HTTPException(409, f"{email} already has operator access.")
    session.add(OperatorAccess(email=email, added_by=who.user.id))
    _log(session, who, who.institution.id if who.institution else "", "operator_added", email)
    await session.commit()
    mailer.notify(email, "You have operator access to YieldPilot", f"{who.user.name or who.user.email} gave you access to the YieldPilot operator dashboard.",
                  f"Sign in with {email}", f"{settings().frontend_origin.rstrip('/')}/login?email={email}")
    return {"ok": True}


@router.delete("/operators/{email:path}")
async def remove_operator(email: str, who: Principal = Depends(operator), session: AsyncSession = Depends(get_session)):
    """Takes effect on the person's very next request."""
    _main_only(who)
    email = email.strip().lower()
    if settings().is_operator(email):
        raise HTTPException(422, "A main operator can't be removed here.")
    grant = await session.get(OperatorAccess, email)
    if grant is None:
        raise HTTPException(404, "That person doesn't have operator access.")
    await session.delete(grant)
    _log(session, who, who.institution.id if who.institution else "", "operator_removed", email)
    await session.commit()
    return {"ok": True}


@router.get("/costs")
async def cost_report(days: int = Query(30, ge=1, le=730), who: Principal = Depends(operator), session: AsyncSession = Depends(get_session)):
    """What the platform costs to run, from Google's bill (the billing export in BigQuery), against the money collected."""
    r = await costs.operator_report(session, days)
    await session.commit()
    actual = await run_in_threadpool(google_bill.actual, days)
    if actual.get("connected"):
        costs.use_bill(r, actual, days)
    return {**r, "actual": actual, "meters": await run_in_threadpool(google_bill.meters, days)}


@router.get("/usage")
async def usage_report(days: int = Query(30, ge=1, le=730), institution_id: str | None = None, user_id: str | None = None,
                       who: Principal = Depends(operator), session: AsyncSession = Depends(get_session)):
    """The usage report for the whole platform, one institution, or one person."""
    r = await costs.report(session, days, institution_id, user_id)
    await session.commit()
    return r


@router.get("/runs")
async def run_list(days: int = Query(30, ge=1, le=730), institution_id: str | None = None, user_id: str | None = None,
                   who: Principal = Depends(operator), session: AsyncSession = Depends(get_session)):
    return await costs.run_rows(session, days, institution_id, user_id)


@router.get("/events")
async def event_list(days: int = Query(30, ge=1, le=730), institution_id: str | None = None, user_id: str | None = None,
                     who: Principal = Depends(operator), session: AsyncSession = Depends(get_session)):
    return await costs.event_rows(session, days, institution_id, user_id)


@router.get("/payments")
async def payment_list(who: Principal = Depends(operator), session: AsyncSession = Depends(get_session)):
    rows = (await session.execute(select(Payment, Institution.name).join(Institution, Institution.id == Payment.institution_id)
                                  .order_by(Payment.created_at.desc()).limit(500))).all()
    return [{"id": p.id, "institution": name, "institution_id": p.institution_id, "amount": p.amount_cents, "currency": p.currency,
             "status": p.status, "description": p.description, "url": p.hosted_url, "created_at": p.created_at.isoformat(), "test_mode": p.test_mode} for p, name in rows]


@router.get("/plans")
async def plan_list(who: Principal = Depends(operator), session: AsyncSession = Depends(get_session)):
    return [plans.plan_out(p) for p in (await session.scalars(select(Plan).order_by(Plan.sort))).all()]
