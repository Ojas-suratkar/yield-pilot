"""Plans, limits and usage. Every limit is checked before the work starts, against what was really used this month."""

from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..models import Forecast, Invitation, Membership, Plan, RunLog, Subscription, UsageEvent, User
from . import members as ms

LIMIT_KEYS = ["seats", "runs_per_user", "runs_per_institution", "rows_per_dataset", "storage_gb", "ai_questions", "scenarios_per_study",
              "history_months"]
# A workspace without a plan (new, or its plan was cancelled): enough to try the whole product before buying.
FREE_LIMITS = {"seats": 2, "runs_per_user": 3, "runs_per_institution": 3, "rows_per_dataset": 100_000, "storage_gb": 1, "ai_questions": 20,
               "scenarios_per_study": 1, "history_months": 3}
GIB = 1024 ** 3
RUNNERS = ("analyst", "data_manager", "admin", "owner")  # the roles that can press Run
QUESTIONS = ("question", "ml_recommendations")  # the AI use a plan counts: what people ask for. Automatic steps never use one up


def month_start(now: datetime | None = None) -> datetime:
    now = now or datetime.now(timezone.utc)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


async def subscription(session: AsyncSession, institution_id: str) -> Subscription:
    sub = await session.get(Subscription, institution_id)
    if sub is None:  # an institution from before plans existed
        sub = Subscription(institution_id=institution_id, status="free", custom_limits={})
        session.add(sub)
        await session.flush()
    return sub


async def limits(session: AsyncSession, sub: Subscription) -> dict:
    """The limits that apply now (None = unlimited). Only full access, which an operator grants, has none."""
    if sub.status == "full_access":
        return {k: None for k in LIMIT_KEYS}
    plan = await session.get(Plan, sub.plan_key) if sub.plan_key and sub.status != "canceled" else None
    base = dict(plan.limits) if plan else FREE_LIMITS
    return {k: (sub.custom_limits or {}).get(k, base.get(k)) for k in LIMIT_KEYS}


async def _limits_for(session: AsyncSession, institution_id: str) -> dict:
    return await limits(session, await subscription(session, institution_id))


async def stored_gb(institution_id: str, fresh: bool = False) -> float:
    """Gigabytes this institution has in the bucket right now."""
    from .costs import stored_bytes  # costs reads the store, and the store checks plans
    return (await run_in_threadpool(stored_bytes, 0 if fresh else 600)).get(institution_id, 0) / GIB


async def usage(session: AsyncSession, institution_id: str, storage: bool = True) -> dict:
    since = month_start()
    seats = await ms.count(session, institution_id)
    pending = await session.scalar(select(func.count()).select_from(Invitation).where(Invitation.institution_id == institution_id,
                                                                                  Invitation.accepted_at.is_(None)))
    rows = (await session.execute(select(RunLog.user_id, func.count()).where(RunLog.institution_id == institution_id, RunLog.outcome == "done",
                                                                            RunLog.started_at >= since).group_by(RunLog.user_id))).all()
    questions = await session.scalar(select(func.count()).select_from(UsageEvent).where(
        UsageEvent.institution_id == institution_id, UsageEvent.kind == "ai", UsageEvent.purpose.in_(QUESTIONS), UsageEvent.at >= since))
    by_user = {u: n for u, n in rows}
    return {"seats": seats, "pending_invites": pending, "runs_month": sum(by_user.values()), "runs_by_user": by_user, "ai_questions": questions,
            "storage_gb": round(await stored_gb(institution_id), 2) if storage else None, "period_start": since.isoformat()}


async def check_run(session: AsyncSession, institution_id: str, user_id: str, running: int = 0) -> None:
    """Before a Run: refuse when this person's or the institution's monthly runs are used up. Runs still going count too."""
    if not settings().enforce_plans:
        return
    lim = await _limits_for(session, institution_id)
    use = await usage(session, institution_id, storage=False)
    mine, my_limit = use["runs_by_user"].get(user_id, 0), (await allowances(session, institution_id)).get(user_id, lim["runs_per_user"])
    if my_limit is not None and mine >= my_limit:
        raise HTTPException(429, f"You've used all {my_limit} of your runs this month. Runs reset on the 1st, or ask your institution's owner for more.")
    if lim["runs_per_institution"] is not None and use["runs_month"] + running >= lim["runs_per_institution"]:
        raise HTTPException(429, f"Your institution has used all {lim['runs_per_institution']} runs this month. Runs reset on the 1st, "
                                 "or an owner can upgrade in Billing.")


async def check_seat(session: AsyncSession, institution_id: str) -> None:
    """Before someone is invited or joins: refuse when every seat is taken."""
    if not settings().enforce_plans:
        return
    lim = await _limits_for(session, institution_id)
    use = await usage(session, institution_id, storage=False)
    if lim["seats"] is not None and use["seats"] + use["pending_invites"] >= lim["seats"]:
        raise HTTPException(402, f"All {lim['seats']} seats on this plan are in use. Remove someone, or an owner can upgrade in Billing.")


async def check_data(session: AsyncSession, institution_id: str, rows: int) -> None:
    """Before a data version is saved: refuse a dataset over the plan's size, or any new file once storage is full."""
    if not settings().enforce_plans:
        return
    lim = await _limits_for(session, institution_id)
    if lim["rows_per_dataset"] is not None and rows > lim["rows_per_dataset"]:
        raise HTTPException(402, f"This data has {rows:,} rows and your plan allows {lim['rows_per_dataset']:,} per dataset. "
                                 "Use a smaller file, or an owner can upgrade in Billing.")
    if lim["storage_gb"] is not None and await stored_gb(institution_id, fresh=True) >= lim["storage_gb"]:
        raise HTTPException(402, f"Your institution has used all {lim['storage_gb']} GB of storage on this plan. "
                                 "Delete older data, or an owner can upgrade in Billing.")


async def rows_limit(session: AsyncSession, institution_id: str) -> int | None:
    """Rows a dataset may have on this plan (None: no limit)."""
    if not settings().enforce_plans:
        return None
    return (await _limits_for(session, institution_id))["rows_per_dataset"]


async def check_ai(session: AsyncSession, institution_id: str) -> None:
    """Before an AI question: refuse once the month's questions are used up."""
    if not settings().enforce_plans:
        return
    limit = (await _limits_for(session, institution_id))["ai_questions"]
    if limit is not None and (await usage(session, institution_id, storage=False))["ai_questions"] >= limit:
        raise HTTPException(429, f"Your institution has used all {limit} AI questions this month. They reset on the 1st, or an owner can upgrade in Billing.")


async def check_scenario(session: AsyncSession, f: Forecast, values: dict[str, float]) -> None:
    """A what-if counts once per set of levers moved, so adjusting the same lever further never uses up another."""
    levers = sorted(k for k, v in values.items() if v)
    if not levers or not settings().enforce_plans:
        return
    limit = (await _limits_for(session, f.institution_id))["scenarios_per_study"]
    used, key = f.summary.get("whatifs") or [], "|".join(levers)
    if limit is None or key in used:
        return
    if len(used) >= limit:
        raise HTTPException(402, f"Your plan includes {limit} what-if {'scenario' if limit == 1 else 'scenarios'} per prediction. "
                                 "Go back to one you've tried, or an owner can upgrade in Billing.")
    f.summary = {**f.summary, "whatifs": [*used, key]}
    await session.commit()


async def history_cutoff(session: AsyncSession, institution_id: str) -> datetime | None:
    """The oldest forecast this plan still shows (None: all of them)."""
    if not settings().enforce_plans:
        return None
    months = (await _limits_for(session, institution_id))["history_months"]
    return None if months is None else datetime.now(timezone.utc) - timedelta(days=round(months * 30.4375))


async def allowances(session: AsyncSession, institution_id: str) -> dict[str, int]:
    """Monthly runs the owner set for particular people (everyone else has the plan's per-person number)."""
    return dict((await session.execute(select(Membership.user_id, Membership.runs_allowance).where(
        Membership.institution_id == institution_id, Membership.runs_allowance.is_not(None)))).all())


async def member_runs(session: AsyncSession, institution_id: str) -> dict:
    """Each member's runs this month against their allowance, and how much of the institution's monthly runs is allotted."""
    lim = await _limits_for(session, institution_id)
    use = await usage(session, institution_id, storage=False)
    since = month_start()
    rows = (await session.execute(ms.people(institution_id).where(Membership.role != "guest").order_by(User.name, User.email))).all()
    last = dict((await session.execute(select(RunLog.user_id, func.max(RunLog.started_at)).where(
        RunLog.institution_id == institution_id, RunLog.started_at >= since).group_by(RunLog.user_id))).all())
    asked = dict((await session.execute(select(UsageEvent.user_id, func.count()).where(
        UsageEvent.institution_id == institution_id, UsageEvent.kind == "ai", UsageEvent.purpose.in_(QUESTIONS), UsageEvent.at >= since)
        .group_by(UsageEvent.user_id))).all())
    out, allotted = [], 0
    for u, m in rows:
        can_run = m.role in RUNNERS and m.active and u.active
        custom = m.runs_allowance is not None
        limit, used = m.runs_allowance if custom else lim["runs_per_user"], use["runs_by_user"].get(u.id, 0)
        if can_run and limit is not None:
            allotted += limit
        out.append({"id": u.id, "name": u.name, "email": u.email, "role": m.role, "active": m.active and u.active, "can_run": can_run, "used": used,
                    "limit": limit, "custom": custom, "left": None if limit is None else max(0, limit - used), "ai_questions": asked.get(u.id, 0),
                    "last_run_at": last[u.id].isoformat() if last.get(u.id) else None})
    total = lim["runs_per_institution"]
    return {"enforced": settings().enforce_plans, "period_start": since.isoformat(), "per_user_default": lim["runs_per_user"], "total": total,
            "used": use["runs_month"], "left": None if total is None else max(0, total - use["runs_month"]), "allotted": allotted,
            "unallotted": None if total is None else total - allotted, "members": out}


async def set_allowance(session: AsyncSession, institution_id: str, user_id: str, runs: int | None, by: str) -> None:
    """Give one person their own monthly runs (None: back to the plan's number). Everyone's together can't go past the institution's
    monthly total; lowering someone is always allowed."""
    row = (await session.execute(ms.people(institution_id).where(User.id == user_id))).first()
    if row is None:
        raise HTTPException(404, "Member not found.")
    u, m = row
    if runs is None:
        m.runs_allowance, m.runs_set_by = None, by
        return
    if m.role not in RUNNERS:
        raise HTTPException(422, f"{u.name or u.email} can't run forecasts as a {m.role.replace('_', ' ')}. Change their role first.")
    total = (await _limits_for(session, institution_id))["runs_per_institution"]
    if total is not None:
        view = await member_runs(session, institution_id)
        before = next((x["limit"] for x in view["members"] if x["id"] == u.id and x["can_run"]), None) or 0
        others = view["allotted"] - before
        if runs > total or (others + runs > total and others + runs > view["allotted"]):
            raise HTTPException(422, f"{u.name or u.email} can have at most {max(0, total - others)} runs this month: the institution has "
                                     f"{total} a month and {others} are allotted to others. Lower someone else's first, or upgrade in Billing.")
    m.runs_allowance, m.runs_set_by = runs, by


def plan_out(p: Plan) -> dict:
    return {"key": p.key, "name": p.name, "price_month": p.price_month_cents, "price_year": p.price_year_cents, "limits": p.limits,
            "features": p.features, "self_serve": bool(p.price_month_cents or p.key != "enterprise")}
