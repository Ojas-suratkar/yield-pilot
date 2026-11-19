"""A forecast's results: admits, explanations, scenarios, the assistant, the summary, exports and sharing."""

import io

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import ROLES, Principal, audit, current
from ..db import get_session
from ..engine import whatif
from ..engine.terms import parse
from ..models import DatasetVersion, Forecast, Invitation, Membership, Notification, Project, Share, User
from ..services import assistant, plans as plan_limits, registry
from ..services.cache import key as ckey, memo
from ..services.fields import GROUPS
from ..services.store import load_artifact, load_frame, reidentify
from .deps import forecast_for, names, owner_only, shared_with
from .projects import spec_of, assistant_context, drop_forecast

router = APIRouter(prefix="/forecasts", tags=["forecasts"])


async def _students(session: AsyncSession, f: Forecast, who: Principal) -> pd.DataFrame:
    df = (await load_frame(f.predictions_key)).copy()
    if who.member and who.at_least("analyst"):  # viewers and guests see coded IDs only
        dv = await session.get(DatasetVersion, f.dataset_version_id)
        df["student"] = (await reidentify(dv, df["student"])).to_numpy()
    return df


@router.get("")
async def all_forecasts(who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """Every forecast in the institution's workspace with who ran it, newest first (a guest: only reports shared with them)."""
    email = who.user.email.lower()
    shared_ids = {s.forecast_id: s.sender_id for s in (await session.scalars(
        select(Share).where(Share.institution_id == who.institution.id).order_by(Share.created_at.desc()).limit(2000))).all()
        if email in [r.lower() for r in (s.recipients or [])]}
    q = select(Forecast, Project).join(Project, Project.id == Forecast.project_id).where(Forecast.institution_id == who.institution.id)
    cutoff = await plan_limits.history_cutoff(session, who.institution.id)
    if cutoff:
        q = q.where(Forecast.created_at >= cutoff)
    if not who.member:
        q = q.where(Forecast.id.in_(list(shared_ids) or [""]))
    rows = (await session.execute(q.order_by(Forecast.created_at.desc()).limit(300))).all()
    senders = await names(session, list(shared_ids.values()) + [f.created_by for f, _ in rows])
    ids = [f.id for f, _ in rows]
    shares = dict((await session.execute(select(Share.forecast_id, func.count()).where(Share.forecast_id.in_(ids)).group_by(Share.forecast_id))).all()) if ids else {}
    return [{
        "id": f.id, "project_id": p.id, "project": p.name, "created_at": f.created_at.isoformat(), "current": p.forecast_id == f.id,
        "is_production": f.is_production, "term": f.summary.get("target_term"), "group": GROUPS.get(f.summary.get("group") or "", "All admits"),
        "applications": f.summary.get("applications"), "range": f.summary.get("range"), "prior": f.summary.get("prior"),
        "admits": f.summary.get("admits"), "expected": f.summary.get("expected"), "yield": f.summary.get("yield"),
        "prior_yield": (f.summary.get("prior") or {}).get("yield"), "confidence": f.summary.get("confidence"),
        "train_terms": f.summary.get("train_terms"), "features": len(f.summary.get("features", [])), "shares": shares.get(f.id, 0),
        "mine": f.created_by == who.user.id, "run_by": senders.get(f.created_by), "run_by_id": f.created_by,
        "manage": who.member and who.manages(f.created_by), "project_owner_id": p.created_by,
        "shared_by": senders.get(shared_ids[f.id]) if f.id in shared_ids else None,
    } for f, p in rows]


@router.get("/{forecast_id}/ideas")
async def ideas(f: Forecast = Depends(forecast_for), session: AsyncSession = Depends(get_session)):
    """Strategies Gemini proposes from this data's levers, each scored by the forecast's own model (saved with the forecast)."""
    if "ideas" not in f.summary:
        art = await load_artifact(f.model_key)
        levers = await run_in_threadpool(memo, ckey("levers", f.model_key), lambda: whatif.levers(art))
        acts = (await run_in_threadpool(memo, ckey("actions", f.model_key), lambda: whatif.actions(art)))["actions"]
        raw = await run_in_threadpool(assistant.ideas, f.summary, levers, [{k: a[k] for k in ("feature", "label", "step", "lift")} for a in acts]) or {}
        by = {lv["feature"]: lv for lv in levers}
        scenarios = []
        for sc in raw.get("scenarios", [])[:4]:
            values = {}
            for v in sc.get("values", []):
                lv = by.get(v.get("feature"))
                if lv:
                    step = lv.get("step") or 1
                    values[lv["feature"]] = float(min(lv["max"], max(lv["min"], round(float(v["value"]) / step) * step)))
            if values:
                total = float((await run_in_threadpool(whatif.scenario, art, values)).sum())
                scenarios.append({"title": sc["title"], "rationale": sc["rationale"], "values": values,
                                  "expected": round(total, 1), "gain": round(total - f.summary["expected"], 1), "yield": round(total / f.summary["admits"], 4)})
        plans = {p["feature"]: p["plan"] for p in raw.get("plans", []) if p.get("feature") in by}
        if not scenarios:  # never empty: the model's own best levers, alone and together
            scenarios = await run_in_threadpool(_model_scenarios, art, levers, acts, f.summary)
        for a in acts:  # every lever gets a plan, even when the AI is unavailable
            plans.setdefault(a["feature"], f"{a['action'] or a['label']}: about {a['lift']:+.0f} enrolled if {abs(a['step'])}% of admits move this way.")
        f.summary = {**f.summary, "ideas": {"scenarios": sorted(scenarios, key=lambda x: x["gain"]), "plans": plans}}
        await session.commit()
    return f.summary["ideas"]


def _model_scenarios(art: dict, levers: list[dict], acts: list[dict], summary: dict) -> list[dict]:
    """Scenarios straight from the model: the three strongest levers on their own, then the helpful ones together."""
    by = {lv["feature"]: lv for lv in levers}
    picks = [a for a in acts if a["lift"] > 0][:3] or acts[:3]
    combos = [(a["label"], f"The model expects {a['lift']:+.0f} enrolled if {abs(a['step'])}% of admits move this way.", {a["feature"]: float(a["step"])})
              for a in picks]
    if len(picks) > 1:
        combos.append(("Do all of the above", "The strongest levers together, scored as one scenario.", {a["feature"]: float(a["step"]) for a in picks}))
    out = []
    for title, why, values in combos:
        values = {k: float(min(by[k]["max"], max(by[k]["min"], v))) for k, v in values.items() if k in by}
        total = float(whatif.scenario(art, values, levers).sum())
        out.append({"title": title, "rationale": why, "values": values, "expected": round(total, 1), "gain": round(total - summary["expected"], 1),
                    "yield": round(total / summary["admits"], 4)})
    return out


@router.delete("/{forecast_id}")
async def delete_forecast(f: Forecast = Depends(forecast_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """Delete one report for everyone it was shared with. If it was the prediction's current forecast, its most recent
    remaining forecast takes over."""
    who.require("analyst")
    owner_only(f)
    p = await session.get(Project, f.project_id) if f.project_id else None
    fid = f.id
    await drop_forecast(session, f)
    if p and p.forecast_id == fid:
        nxt = await session.scalar(select(Forecast).where(Forecast.project_id == p.id).order_by(Forecast.created_at.desc()).limit(1))
        p.forecast_id = nxt.id if nxt else None
        p.stale = bool(nxt) and nxt.spec != (await spec_of(session, p)).__dict__
    await audit(session, who, "forecast.deleted", fid)
    await session.commit()
    return {"ok": True}


@router.get("/{forecast_id}")
async def get_forecast(f: Forecast = Depends(forecast_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    owner = await session.get(User, f.created_by)
    return {"id": f.id, "project_id": f.project_id if who.member else None, "summary": f.summary, "spec": f.spec, "is_production": f.is_production,
            "registry": f.registry if who.member else None, "created_at": f.created_at.isoformat(), "owned": f.owned, "member": who.member,
            "group": GROUPS.get(f.summary.get("group") or "", "All admits"), "by": (owner.name or owner.email) if owner else None}


@router.get("/{forecast_id}/students")
async def students(
    band: str | None = Query(None, pattern="^(high|medium|low)$"), q: str | None = Query(None, max_length=200),
    college: str | None = Query(None, max_length=200), major: str | None = Query(None, max_length=200),
    sort: str = Query("probability", pattern="^(probability|student|college|major|band|actual)$"), desc: bool = True,
    offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500),
    f: Forecast = Depends(forecast_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session),
):
    """Admits for the infinite-scroll table: filtered (likelihood group, ID search, college, major), sorted by any column."""
    df = await _students(session, f, who)
    facets = {"college": sorted(x for x in df["college"].astype(str).unique() if x), "major": sorted(x for x in df["major"].astype(str).unique() if x)} if offset == 0 else None
    if band:
        df = df[df["band"] == band]
    if q:
        df = df[df["student"].astype(str).str.contains(q.strip(), case=False, regex=False)]
    if college:
        df = df[df["college"].astype(str) == college]
    if major:
        df = df[df["major"].astype(str) == major]
    df = df.sort_values(sort, ascending=not desc, na_position="last", kind="stable")
    page = df.iloc[offset: offset + limit]
    page = page.astype(object).where(pd.notna(page), None)
    return {"total": len(df), "rows": page.to_dict(orient="records"), "facets": facets}


@router.get("/{forecast_id}/students/{row}/factors")
async def factors(row: int, f: Forecast = Depends(forecast_for)):
    art = await load_artifact(f.model_key)
    if not 0 <= row < len(art["raw"]):
        raise HTTPException(404, "Admit not found.")
    return await run_in_threadpool(whatif.factors, art, row)


@router.get("/{forecast_id}/levers")
async def levers(f: Forecast = Depends(forecast_for)):
    art = await load_artifact(f.model_key)
    return await run_in_threadpool(memo, ckey("levers", f.model_key), lambda: whatif.levers(art))


class Scenario(BaseModel):
    values: dict[str, float] = {}


@router.post("/{forecast_id}/scenario")
async def scenario(body: Scenario, f: Forecast = Depends(forecast_for), session: AsyncSession = Depends(get_session)):
    await plan_limits.check_scenario(session, f, body.values)
    art = await load_artifact(f.model_key)
    p = await run_in_threadpool(whatif.scenario, art, body.values)
    base, admits = f.summary["expected"], f.summary["admits"]
    total = float(p.sum())
    return {"baseline_expected": base, "baseline_yield": f.summary["yield"], "expected": round(total, 1), "yield": round(total / admits, 4), "gain": round(total - base, 1)}


@router.get("/{forecast_id}/actions")
async def actions(f: Forecast = Depends(forecast_for)):
    art = await load_artifact(f.model_key)
    return await run_in_threadpool(memo, ckey("actions", f.model_key), lambda: whatif.actions(art))


@router.get("/{forecast_id}/summary")
async def get_summary(fresh: bool = False, f: Forecast = Depends(forecast_for), session: AsyncSession = Depends(get_session)):
    if fresh and not getattr(f, "owned", False):
        raise HTTPException(403, "Only the person who ran this forecast, or an admin, can rewrite its summary.")
    if fresh or not f.summary.get("executive_summary"):
        p = await session.get(Project, f.project_id)
        ctx = await assistant_context(session, p) if p and p.forecast_id == f.id else None
        text = await run_in_threadpool(assistant.summarize, f.summary, ctx)
        f.summary = {**f.summary, "executive_summary": text}
        await session.commit()
    return {"text": f.summary["executive_summary"]}


class SummaryIn(BaseModel):
    text: str = Field(max_length=20000)


@router.put("/{forecast_id}/summary")
async def put_summary(body: SummaryIn, f: Forecast = Depends(forecast_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    who.require("analyst")
    owner_only(f)
    f.summary = {**f.summary, "executive_summary": body.text}
    await session.commit()
    return {"text": body.text}


@router.get("/{forecast_id}/export")
async def export(
    format: str = Query("csv", pattern="^(csv|txt)$"),
    f: Forecast = Depends(forecast_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session),
):
    who.require("analyst")
    df = (await _students(session, f, who)).sort_values("probability", ascending=False)
    t = parse(f.summary["target_term"])
    flag = {"fall": "F", "spring": "S", "summer": "U", "winter": "W"}.get(t.season if t else "", "F")
    if format == "txt":
        body = "\n".join(f"{s}|{flag}|{p:.3f}" for s, p in zip(df["student"], df["probability"])) + "\n"
        name, media = f"yields_{f.summary['target_term']}.txt", "text/plain"
    else:
        out = df.rename(columns={"student": "student_id", "probability": "enrollment_probability", "band": "segment"}).drop(columns=["row", "actual"])
        buf = io.StringIO()
        out.to_csv(buf, index=False)
        body, name, media = buf.getvalue(), f"admit_predictions_{f.summary['target_term']}.csv", "text/csv"
    await audit(session, who, "forecast.exported", f.id, format=format, rows=len(df))
    await session.commit()
    return StreamingResponse(iter([body]), media_type=media, headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.post("/{forecast_id}/promote")
async def promote(f: Forecast = Depends(forecast_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """Mark a forecast as the institution's official one (any data manager or above, whoever ran it)."""
    who.require("data_manager")
    for other in await session.scalars(select(Forecast).where(Forecast.project_id == f.project_id, Forecast.is_production.is_(True))):
        other.is_production = False
    f.is_production = True
    error = None
    if not f.registry:
        dv = await session.get(DatasetVersion, f.dataset_version_id)
        try:
            f.registry = await run_in_threadpool(
                registry.register, institution_id=who.institution.id, institution=who.institution.name, group=f.summary.get("group"),
                forecast_id=f.id, model_key=f.model_key, summary=f.summary, data_version=f"{dv.dataset_id}-v{dv.version}")
        except Exception as e:  # the forecast is still official; registration can be retried
            error = f"Marked official, but the Vertex AI registration failed: {e}"
    await audit(session, who, "forecast.promoted", f.id, registry=(f.registry or {}).get("model"))
    await session.commit()
    return {"id": f.id, "is_production": True, "registry": f.registry, "error": error}


@router.get("/{forecast_id}/registry")
async def registry_status(f: Forecast = Depends(forecast_for), session: AsyncSession = Depends(get_session)):
    if f.registry and f.registry.get("pending"):
        f.registry = await run_in_threadpool(registry.refresh, f.registry)
        await session.commit()
    return f.registry


class ShareIn(BaseModel):
    recipients: list[str] = Field(min_length=1, max_length=50)
    files: list[str] = ["pdf"]
    message: str | None = Field(None, max_length=2000)


@router.post("/{forecast_id}/share")
async def share(body: ShareIn, f: Forecast = Depends(forecast_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    who.require("analyst")
    if not who.member:
        raise HTTPException(403, "Guests can't share reports.")
    recipients = sorted({r.strip().lower() for r in body.recipients})
    if "@" in (who.institution.domain or ""):
        raise HTTPException(422, "Personal workspaces can't share reports. Create or join your institution's workspace to share.")
    members = set(await session.scalars(select(User.email).join(Membership, Membership.user_id == User.id).where(
        Membership.institution_id == who.institution.id, Membership.active.is_(True))))
    outside = [r for r in recipients if r not in members]
    if outside:
        # people outside the institution join as guests who see only what is shared with them; only admins may invite them
        if not who.at_least("admin"):
            raise HTTPException(403, f"Only admins can share with people outside {who.institution.name}: {', '.join(outside)}")
        pending = set(await session.scalars(select(Invitation.email).where(Invitation.institution_id == who.institution.id, Invitation.accepted_at.is_(None))))
        for r in outside:
            if r not in pending:
                session.add(Invitation(institution_id=who.institution.id, email=r, role="guest", invited_by=who.user.id))
    session.add(Share(institution_id=who.institution.id, forecast_id=f.id, sender_id=who.user.id, recipients=recipients, files=body.files, message=body.message))
    term = assistant.term_name(f.summary["target_term"])
    for r in recipients:
        session.add(Notification(institution_id=who.institution.id, recipient_email=r, kind="share",
                                 title=f"{who.user.name or who.user.email} shared the {term} yield report", body=body.message,
                                 link=f"/shared/{f.id}"))
    await audit(session, who, "forecast.shared", f.id, recipients=recipients, files=body.files, invited=outside)
    await session.commit()
    return {"ok": True, "recipients": recipients, "invited": outside}


@router.get("/{forecast_id}/shares")
async def shares(f: Forecast = Depends(forecast_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    if not who.member:
        raise HTTPException(404, "Forecast not found.")
    rows = await session.scalars(select(Share).where(Share.forecast_id == f.id).order_by(Share.created_at.desc()))
    return [{"recipients": s.recipients, "files": s.files, "created_at": s.created_at.isoformat()} for s in rows]


__all__ = ["router", "Project"]
