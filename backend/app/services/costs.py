"""What YieldPilot's work costs.

A Run's cost is Google's actual charge: its share of what the Detailed billing export charged for the forecast server's busy
time in the hours it ran (google_bill.hours). Runs from the last few hours, which Google hasn't billed yet, are worked out from
their measured seconds at Google's list prices until the bill arrives. AI answers are their tokens at Google's per-token prices,
and uploads and files their measured seconds and bytes at Google's prices. The platform's total is Google's bill itself."""

import threading
import time
from datetime import date, datetime, timedelta, timezone

from fastapi.concurrency import run_in_threadpool
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..models import Forecast, Institution, Membership, Payment, Project, RunLog, UsageEvent, User
from ..storage import storage
from . import google_bill
from .fields import GROUPS

CPU = 0.000024  # Cloud Run, per vCPU-second while working
MEMORY = 0.0000025  # Cloud Run, per GiB-second
IDLE = 0.0000025  # Cloud Run, per vCPU-second or GiB-second on a machine kept ready
STORAGE = 0.02  # Cloud Storage Standard, per GB-month
SQL_HOUR = 0.035  # Cloud SQL Postgres, zonal Small instance
SQL_DISK = 0.17  # per GB-month, SSD
SQL_BACKUP = 0.08  # per GB-month
E2_CORE, E2_RAM = 0.02181159, 0.00292353  # Compute Engine, per hour
DISK = 0.10  # balanced persistent disk, per GB-month
GEMINI = {  # dollars per million tokens: (in, out)
    "gemini-3.5-flash-lite": (0.30, 2.50), "gemini-3.5-flash": (1.50, 9.00), "gemini-3.6-flash": (1.50, 7.50),
    "gemini-3.7-flash": (1.50, 7.50), "gemini-3.8-flash": (1.50, 7.50),
}
GEMINI_UNKNOWN = (1.50, 9.00)  # a model not listed above: the highest price of the models the app uses
HOURS_A_MONTH = 730
DAYS_A_MONTH = 30.4167
GIB = 1024 ** 3
MAX_ROWS = 2000

PURPOSE = {
    "column_matching": "Matching columns", "data_review": "Reviewing data", "question": "Answering questions", "summary": "Writing summaries",
    "chart_explanation": "Explaining charts", "scenario_ideas": "Suggesting scenarios", "file_upload": "File upload",
    "table_import": "Import from a connected system", "other": "Other",
}
_RUN_COST = func.coalesce(RunLog.seconds, 0.0) * (RunLog.vcpu * CPU + RunLog.memory_gib * MEMORY)
_lock = threading.Lock()
_stored: tuple[float, dict[str, int]] = (0.0, {})


def stored_bytes(max_age: int = 600) -> dict[str, int]:
    """Bytes in the bucket per institution (every file sits under its institution's folder). Counted at most every ten minutes."""
    global _stored
    with _lock:
        at, sizes = _stored
        if at and time.monotonic() - at < max_age:
            return sizes
        sizes = {}
        for b in storage().bucket.list_blobs():
            owner = b.name.split("/", 1)[0]
            sizes[owner] = sizes.get(owner, 0) + (b.size or 0)
        _stored = (time.monotonic(), sizes)
        return sizes


def ai_cost(model: str | None, tokens_in: int, tokens_out: int) -> float:
    price_in, price_out = GEMINI.get(model or "", GEMINI_UNKNOWN)
    return (tokens_in * price_in + tokens_out * price_out) / 1_000_000


def _machine_second() -> float:
    return settings().run_vcpu * CPU + settings().run_memory_gib * MEMORY


def _blank() -> dict:
    return {"runs": 0, "done": 0, "failed": 0, "cancelled": 0, "seconds": 0.0, "done_seconds": 0.0, "ai_calls": 0, "input_tokens": 0,
            "output_tokens": 0, "imports": 0, "rows_imported": 0, "run_cost": 0.0, "ai_cost": 0.0, "import_cost": 0.0}


def _add_run(t: dict, outcome: str, n: int, seconds: float, cost: float) -> None:
    t["runs"] += n
    t[outcome] = t.get(outcome, 0) + n
    t["seconds"] += seconds
    t["run_cost"] += cost
    if outcome == "done":
        t["done_seconds"] += seconds


def _add_event(t: dict, kind: str, model: str | None, n: int, tokens_in: int, tokens_out: int, seconds: float, rows: int) -> None:
    if kind == "ai":
        t["ai_calls"] += n
        t["input_tokens"] += tokens_in
        t["output_tokens"] += tokens_out
        t["ai_cost"] += ai_cost(model, tokens_in, tokens_out)
    else:
        t["imports"] += n
        t["rows_imported"] += rows
        t["import_cost"] += seconds * _machine_second()


def _finish(t: dict, storage_gb: float = 0.0, days: int = 30) -> dict:
    t["storage_gb"] = round(storage_gb, 4)
    t["storage_cost"] = storage_gb * STORAGE * days / DAYS_A_MONTH
    t["total_cost"] = t["run_cost"] + t["ai_cost"] + t["import_cost"] + t["storage_cost"]
    t["avg_seconds"] = round(t["done_seconds"] / t["done"], 1) if t["done"] else 0
    t["seconds"] = round(t["seconds"], 1)
    t.pop("done_seconds", None)
    return {k: round(v, 6) if isinstance(v, float) else v for k, v in t.items()}


def _buckets(since: datetime, until: datetime, unit: str) -> list[str]:
    d, out = since.date() if unit == "day" else date(since.year, since.month, 1), []
    while d <= until.date():
        out.append(d.isoformat())
        d = d + timedelta(days=1) if unit == "day" else date(d.year + d.month // 12, d.month % 12 + 1, 1)
    return out


def billed(rows: list[tuple[str, datetime, float | None]], bill: dict) -> dict[str, float]:
    """Each run's actual cost from Google's hourly bill: its share of what Google charged for the forecast server's busy time in
    the hours it ran (runs in the same hour share it by their seconds). `rows` are (id, when it ended, seconds). Runs in hours
    Google hasn't billed yet are left out (their estimate stands)."""
    if not bill.get("connected") or not bill.get("until"):
        return {}
    until = datetime.fromisoformat(bill["until"])
    vcpu = max(1, settings().run_vcpu)
    pieces: dict[str, list[tuple[str, float]]] = {}
    load: dict[str, float] = {}
    for rid, end, secs in rows:
        if end.replace(minute=0, second=0, microsecond=0) > until:
            continue
        t, start = end, end - timedelta(seconds=float(secs or 0))
        while t > start:
            hour = t.replace(minute=0, second=0, microsecond=0)
            if hour == t:
                hour -= timedelta(hours=1)
            part = (t - max(hour, start)).total_seconds()
            pieces.setdefault(rid, []).append((hour.isoformat(), part))
            load[hour.isoformat()] = load.get(hour.isoformat(), 0.0) + part
            t = hour
        pieces.setdefault(rid, [])
    out = {}
    for rid, parts in pieces.items():
        cost = 0.0
        for hour, part in parts:
            h = bill["hours"].get(hour)
            if h and h["cost"] > 0:
                cost += h["cost"] * part / max(h["vcpu_seconds"] / vcpu, load[hour], 1e-9)
        out[rid] = cost
    return out


async def _bill_hours(days: int) -> dict:
    return await run_in_threadpool(google_bill.hours, days)


async def _load(session: AsyncSession, since: datetime, until: datetime, unit: str, institution_id: str | None, user_id: str | None,
                bill: dict | None = None):
    at = func.date_trunc(unit, RunLog.started_at)
    q = (select(RunLog.id, at, RunLog.institution_id, RunLog.user_id, RunLog.project_id, RunLog.outcome, func.coalesce(RunLog.seconds, 0.0),
                func.coalesce(_RUN_COST, 0.0), RunLog.started_at)
         .where(RunLog.started_at >= since, RunLog.started_at < until))
    when = func.date_trunc(unit, UsageEvent.at)
    e = (select(when, UsageEvent.institution_id, UsageEvent.user_id, UsageEvent.kind, UsageEvent.purpose, UsageEvent.model, func.count(),
                func.coalesce(func.sum(UsageEvent.input_tokens), 0), func.coalesce(func.sum(UsageEvent.output_tokens), 0),
                func.coalesce(func.sum(UsageEvent.seconds), 0.0), func.coalesce(func.sum(UsageEvent.rows), 0), func.max(UsageEvent.at))
         .where(UsageEvent.at >= since, UsageEvent.at < until)
         .group_by(when, UsageEvent.institution_id, UsageEvent.user_id, UsageEvent.kind, UsageEvent.purpose, UsageEvent.model))
    if institution_id:
        q, e = q.where(RunLog.institution_id == institution_id), e.where(UsageEvent.institution_id == institution_id)
    if user_id:
        q, e = q.where(RunLog.user_id == user_id), e.where(UsageEvent.user_id == user_id)
    per_run = (await session.execute(q)).all()
    actual = billed([(r[0], r[8], r[6]) for r in per_run], bill or {})
    runs = [(at_, inst, user, project, outcome, 1, seconds, actual.get(rid, cost), last) for rid, at_, inst, user, project, outcome, seconds, cost, last in per_run]
    return runs, (await session.execute(e)).all(), sum(1 for r in per_run if r[0] in actual), len(per_run)


async def _people(session: AsyncSession, ids: set[str]) -> dict[str, str]:
    if not ids:
        return {}
    rows = (await session.execute(select(User.id, User.name, User.email).where(User.id.in_(ids)))).all()
    return {i: name or email for i, name, email in rows}


async def report(session: AsyncSession, days: int, institution_id: str | None = None, user_id: str | None = None) -> dict:
    """Totals, the previous period, a day-by-day (or month-by-month) series, and who and what the work was for."""
    now = datetime.now(timezone.utc)
    since, before = now - timedelta(days=days), now - timedelta(days=2 * days)
    unit = "day" if days <= 90 else "month"
    bill = await _bill_hours(2 * days)
    runs, events, from_bill, n_runs = await _load(session, since, now, unit, institution_id, user_id, bill)
    old_runs, old_events, _, _ = await _load(session, before, since, unit, institution_id, user_id, bill)
    sizes = {} if user_id else await run_in_threadpool(stored_bytes)
    gb = (sum(sizes.values()) if institution_id is None else sizes.get(institution_id, 0)) / GIB

    totals, previous = _blank(), _blank()
    series = {b: {"at": b, "done": 0, "failed": 0, "cancelled": 0, "run_cost": 0.0, "ai_cost": 0.0, "import_cost": 0.0} for b in _buckets(since, now, unit)}
    people: dict[str, dict] = {}
    studies: dict[str, dict] = {}
    purposes: dict[str, dict] = {}
    models: dict[str, dict] = {}
    places: dict[str, dict] = {}

    for at, inst, user, project, outcome, n, seconds, cost, last in runs:
        _add_run(totals, outcome, n, seconds, cost)
        point = series.get(at.astimezone(timezone.utc).date().isoformat())
        if point:
            point[outcome] = point.get(outcome, 0) + n
            point["run_cost"] += cost
        for t in (people.setdefault(user, {**_blank(), "last_at": last}), places.setdefault(inst, _blank())):
            _add_run(t, outcome, n, seconds, cost)
        people[user]["last_at"] = max(people[user]["last_at"], last)
        if project:
            s = studies.setdefault(project, {"runs": 0, "done": 0, "failed": 0, "cancelled": 0, "seconds": 0.0, "cost": 0.0, "last_at": last})
            s["runs"] += n
            s[outcome] = s.get(outcome, 0) + n
            s["seconds"] += seconds
            s["cost"] += cost
            s["last_at"] = max(s["last_at"], last)

    for at, inst, user, kind, purpose, model, n, tokens_in, tokens_out, seconds, rows, last in events:
        _add_event(totals, kind, model, n, tokens_in, tokens_out, seconds, rows)
        cost = ai_cost(model, tokens_in, tokens_out) if kind == "ai" else seconds * _machine_second()
        point = series.get(at.astimezone(timezone.utc).date().isoformat())
        if point:
            point["ai_cost" if kind == "ai" else "import_cost"] += cost
        for t in (people.setdefault(user, {**_blank(), "last_at": last}), places.setdefault(inst, _blank())):
            _add_event(t, kind, model, n, tokens_in, tokens_out, seconds, rows)
        people[user]["last_at"] = max(people[user]["last_at"], last)
        p = purposes.setdefault(purpose, {"purpose": purpose, "label": PURPOSE.get(purpose, purpose), "kind": kind, "count": 0, "tokens": 0, "seconds": 0.0, "rows": 0, "cost": 0.0})
        p["count"] += n
        p["tokens"] += tokens_in + tokens_out
        p["seconds"] += seconds
        p["rows"] += rows
        p["cost"] += cost
        if kind == "ai":
            m = models.setdefault(model or "unknown", {"model": model or "unknown", "calls": 0, "input_tokens": 0, "output_tokens": 0, "cost": 0.0})
            m["calls"] += n
            m["input_tokens"] += tokens_in
            m["output_tokens"] += tokens_out
            m["cost"] += cost

    for _, _, _, _, outcome, n, seconds, cost, _ in old_runs:
        _add_run(previous, outcome, n, seconds, cost)
    for _, _, _, kind, _, model, n, tokens_in, tokens_out, seconds, rows, _ in old_events:
        _add_event(previous, kind, model, n, tokens_in, tokens_out, seconds, rows)

    names = await _people(session, set(people))
    titles = dict((await session.execute(select(Project.id, Project.name).where(Project.id.in_(set(studies))))).all()) if studies else {}
    by_person = []
    for uid, t in people.items():
        last = t.pop("last_at")
        by_person.append({"id": uid, "name": names.get(uid, "Former member"), "last_at": last.isoformat(), **_finish(t, days=days)})
    out = {
        "days": days, "unit": unit, "since": since.isoformat(), "scope": "me" if user_id else "institution",
        "run_costs": {"from_bill": from_bill, "estimated": n_runs - from_bill, "billed_until": bill.get("until")},
        "totals": _finish(totals, gb, days), "previous": _finish(previous, gb, days),
        "series": [{**p, **{k: round(p[k], 6) for k in ("run_cost", "ai_cost", "import_cost")}} for p in series.values()],
        "by_person": sorted(by_person, key=lambda x: -x["total_cost"]),
        "by_study": sorted(({"id": k, "name": titles.get(k, "Deleted prediction"), **v, "cost": round(v["cost"], 6), "seconds": round(v["seconds"], 1),
                             "last_at": v["last_at"].isoformat()} for k, v in studies.items()), key=lambda x: -x["cost"]),
        "by_purpose": sorted(({**v, "cost": round(v["cost"], 6), "seconds": round(v["seconds"], 1)} for v in purposes.values()), key=lambda x: -x["cost"]),
        "by_model": sorted(({**v, "cost": round(v["cost"], 6)} for v in models.values()), key=lambda x: -x["cost"]),
    }
    if institution_id is None:
        out["_places"], out["_sizes"] = places, sizes
    return out


def fixed_items(database_bytes: int) -> list[dict]:
    """What runs all month whatever people do, per month."""
    s = settings()
    seconds = HOURS_A_MONTH * 3600
    db_gb = database_bytes / GIB
    items = [
        ("Main app server", "Stays on so forecasts start right away", (s.run_vcpu + s.run_memory_gib) * IDLE * seconds),
        ("Website server", "Shows the pages people visit", 2 * IDLE * seconds),
        ("Database", "Keeps accounts, predictions and results", SQL_HOUR * HOURS_A_MONTH),
        ("Database storage", "The disk the database lives on", 10 * SQL_DISK),
        ("Database backups", "Copies in case something goes wrong", db_gb * SQL_BACKUP),
        ("Update server", "Publishes new versions of YieldPilot", (E2_CORE + 4 * E2_RAM) * HOURS_A_MONTH + 50 * DISK),
    ]
    return [{"label": a, "detail": b, "monthly": round(c, 4)} for a, b, c in items]


RATES = [
    ("Processing, while working", f"${CPU:.6f} per vCPU-second, ${MEMORY:.7f} per GiB-second"),
    ("Machine kept ready", f"${IDLE:.7f} per vCPU-second or GiB-second"),
    ("Stored files", f"${STORAGE:.2f} per GB-month"),
    ("Database", f"${SQL_HOUR:.3f} per hour, ${SQL_DISK:.2f} per GB-month disk, ${SQL_BACKUP:.2f} per GB-month backups"),
    ("Build server", f"${E2_CORE:.5f} per core-hour, ${E2_RAM:.5f} per GiB-hour, ${DISK:.2f} per GB-month disk"),
    *[(m, f"${i:.2f} in, ${o:.2f} out, per million tokens") for m, (i, o) in GEMINI.items()],
]


async def operator_report(session: AsyncSession, days: int) -> dict:
    """The whole platform: usage from the ledger, the always-on services, money collected, and each institution's share."""
    r = await report(session, days)
    places, sizes = r.pop("_places"), r.pop("_sizes")
    now, since = datetime.now(timezone.utc), datetime.now(timezone.utc) - timedelta(days=days)
    fixed = fixed_items(await session.scalar(text("select pg_database_size(current_database())")))
    months = days / DAYS_A_MONTH
    fixed_period = sum(i["monthly"] for i in fixed) * months
    paid = dict((await session.execute(select(Payment.institution_id, func.sum(Payment.amount_cents))
                                       .where(Payment.test_mode.is_(False), Payment.status == "paid", Payment.created_at >= since, Payment.created_at < now).group_by(Payment.institution_id))).all())
    insts = (await session.execute(select(Institution.id, Institution.name, Institution.logo, Institution.domain, Institution.website))).all()
    people = dict((await session.execute(select(Membership.institution_id, func.count()).join(User, User.id == Membership.user_id).where(
        Membership.active.is_(True), User.active.is_(True), User.deleted_at.is_(None)).group_by(Membership.institution_id))).all())
    by_institution = []
    for iid, name, logo, domain, website in insts:
        t = _finish(places.get(iid, _blank()), sizes.get(iid, 0) / GIB, days)
        by_institution.append({"id": iid, "name": name, "logo": logo, "domain": domain, "website": website, "people": people.get(iid, 0),
                               "collected_cents": int(paid.get(iid) or 0), **t})
    collected = sum(int(v or 0) for v in paid.values())
    t = r["totals"]
    total = fixed_period + t["total_cost"]
    return {
        **r, "fixed": [{**i, "period": round(i["monthly"] * months, 4)} for i in fixed], "fixed_total": round(fixed_period, 4),
        "fixed_monthly": round(sum(i["monthly"] for i in fixed), 4), "usage_total": t["total_cost"], "grand_total": round(total, 4),
        "cost_per_run": round(total / t["done"], 4) if t["done"] else None, "collected_cents": collected, "margin": round(collected / 100 - total, 4),
        "by_institution": sorted(by_institution, key=lambda x: -x["total_cost"]), "rates": [{"item": a, "price": b} for a, b in RATES],
    }


def use_bill(r: dict, bill: dict, days: int) -> None:
    """The platform's totals from Google's bill itself. The forecast server's charge is split into the Runs' busy time (their
    actual costs) and the rest (kept ready, and every page people open). Our own estimate stays alongside for comparison."""
    t = r["totals"]
    by = {x["name"]: x for x in bill.get("by_resource") or []}
    api = by.get("API and forecasts", {}).get("cost", 0.0)
    runs = min(t["run_cost"], api) if api else t["run_cost"]
    items = []
    for x in bill.get("by_resource") or []:
        if x["name"] == "API and forecasts":
            items += [{"label": "Running forecasts", "detail": "The forecast server's busy time while Runs were going", "period": runs},
                      {"label": "API server", "detail": "Kept ready all day, and every page people open", "period": max(0.0, x["cost"] - runs)}]
        else:
            items.append({"label": x["name"], "detail": x["detail"], "period": x["cost"]})
    usage = runs + by.get("AI (Gemini)", {}).get("cost", 0.0) + by.get("Stored files", {}).get("cost", 0.0)
    total = float(bill.get("total") or 0.0)
    now = datetime.now(timezone.utc)
    start = max(now - timedelta(days=days), datetime.fromisoformat(f"{bill['first_day']}T00:00:00+00:00")) if bill.get("first_day") else now - timedelta(days=days)
    months = max((now - start).total_seconds() / 86400, 1) / DAYS_A_MONTH
    r.update(source="google", estimate_total=r["grand_total"], items=[{**i, "period": round(i["period"], 4)} for i in items if round(i["period"], 4)],
             grand_total=round(total, 4), usage_total=round(usage, 4), fixed_total=round(total - usage, 4), fixed_monthly=round((total - usage) / months, 4),
             margin=round(r["collected_cents"] / 100 - total, 4), cost_per_run=round(total / t["done"], 4) if t["done"] else None)


def _page(rows: list[dict]) -> dict:
    return {"rows": rows[:MAX_ROWS], "more": len(rows) > MAX_ROWS}


async def run_rows(session: AsyncSession, days: int, institution_id: str | None = None, user_id: str | None = None) -> dict:
    """Every Run in the period, newest first, with who ran it, on what, how it went, how long it took and what it cost."""
    since = datetime.now(timezone.utc) - timedelta(days=days)
    q = (select(RunLog, _RUN_COST, User.name, User.email, Institution.name, Project.name, Project.setup["term"].as_string(), Project.setup["group"].as_string(),
                Forecast.summary["target_term"].as_string(), Forecast.summary["group"].as_string(), Forecast.summary["admits"].as_float(),
                Forecast.summary["expected"].as_float())
         .outerjoin(User, User.id == RunLog.user_id).outerjoin(Institution, Institution.id == RunLog.institution_id)
         .outerjoin(Project, Project.id == RunLog.project_id).outerjoin(Forecast, Forecast.id == RunLog.forecast_id)
         .where(RunLog.started_at >= since).order_by(RunLog.started_at.desc()).limit(MAX_ROWS + 1))
    if institution_id:
        q = q.where(RunLog.institution_id == institution_id)
    if user_id:
        q = q.where(RunLog.user_id == user_id)
    out = []
    found = (await session.execute(q)).all()
    actual = billed([(x[0].id, x[0].started_at, x[0].seconds) for x in found], await _bill_hours(days + 1))
    for r, cost, name, email, inst, study, term, group, f_term, f_group, admits, expected in found:
        cost = actual.get(r.id, cost)
        out.append({
            "id": r.id, "at": r.started_at.isoformat(), "by": name or email or "Former member", "by_id": r.user_id, "institution": inst or "Deleted institution",
            "study": study or "Deleted prediction", "project_id": r.project_id if study else None, "forecast_id": r.forecast_id if expected is not None else None,
            "outcome": r.outcome, "seconds": r.seconds, "cost": round(cost or 0, 6), "billed": r.id in actual, "kind": r.kind, "cpu_seconds": r.cpu_seconds,
            "peak_memory_mb": r.peak_memory_mb, "vcpu": r.vcpu, "memory_gib": r.memory_gib, "error": r.error, "term": f_term or term,
            "group": GROUPS.get(f_group or group or "", "All admits" if (f_term or term) else None), "admits": admits, "expected": expected,
        })
    return _page(out)


async def event_rows(session: AsyncSession, days: int, institution_id: str | None = None, user_id: str | None = None) -> dict:
    """Every AI call and data import in the period, newest first."""
    since = datetime.now(timezone.utc) - timedelta(days=days)
    q = (select(UsageEvent, User.name, User.email, Institution.name).outerjoin(User, User.id == UsageEvent.user_id)
         .outerjoin(Institution, Institution.id == UsageEvent.institution_id).where(UsageEvent.at >= since).order_by(UsageEvent.at.desc()).limit(MAX_ROWS + 1))
    if institution_id:
        q = q.where(UsageEvent.institution_id == institution_id)
    if user_id:
        q = q.where(UsageEvent.user_id == user_id)
    out = []
    for e, name, email, inst in (await session.execute(q)).all():
        cost = ai_cost(e.model, e.input_tokens, e.output_tokens) if e.kind == "ai" else (e.seconds or 0) * _machine_second()
        out.append({"id": e.id, "at": e.at.isoformat(), "by": name or email or "Former member", "by_id": e.user_id, "institution": inst or "Deleted institution",
                    "kind": e.kind, "what": PURPOSE.get(e.purpose, e.purpose), "model": e.model, "tokens": e.input_tokens + e.output_tokens,
                    "seconds": e.seconds, "rows": e.rows, "cost": round(cost, 6)})
    return _page(out)
