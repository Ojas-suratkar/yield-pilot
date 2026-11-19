"""The ML workspace: each prediction's model settings (hyperparameters), kept in the database with the prediction. Every run
records the exact values it trained with, so the latest run's settings are always shown next to the defaults. Admins and owners
always have it; they can give it to others in their institution."""

import asyncio
import json
import logging
import secrets
import time
from dataclasses import replace
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import Principal, audit, current
from ..config import settings
from ..db import Session, get_session
from ..engine import recipe
from ..models import Forecast, Institution, Membership, Notification, Project, RunLog, TuningRun, User
from ..services import members as ms
from ..services import ml_advisor, plans, runs, usage
from ..services.progress import Progress, stream
from .deps import names, project_for
from .projects import _frame, _touch, ensure_setup, guard_rows, spec_of

MAX_CANDIDATES = 6
MAX_TRIALS = 8  # Expert search: settings tried across the ranges (plus your settings and the defaults)
log = logging.getLogger("yieldpilot.ml")
SCORES = ("roc_auc", "pr_auc", "brier", "log_loss", "accuracy", "precision", "recall", "f1", "error_pct")

router = APIRouter(prefix="/ml", tags=["ml"])

INFO = {  # key: (group, label, what it does)
    "n_estimators": ("Trees", "Number of trees", "How many trees the model builds. More can learn finer patterns, but take longer and can overfit."),
    "learning_rate": ("Trees", "Learning rate", "How much each new tree corrects the ones before it. Lower is more careful and usually needs more trees."),
    "max_depth": ("Trees", "Maximum tree depth", "How many questions in a row each tree can ask. Deeper trees capture more detail and overfit more easily."),
    "min_child_weight": ("Trees", "Minimum child weight", "How much evidence a branch needs before it splits. Higher is more conservative."),
    "gamma": ("Trees", "Minimum split gain (gamma)", "How much a split must improve the model to be kept. Higher prunes more."),
    "max_delta_step": ("Trees", "Maximum step", "Caps how far one tree can move a prediction. Helps when one outcome is rare."),
    "subsample": ("Sampling", "Rows per tree", "Share of admits each tree learns from. Below 1 adds variety between trees."),
    "colsample_bytree": ("Sampling", "Columns per tree", "Share of columns each tree may use."),
    "colsample_bylevel": ("Sampling", "Columns per level", "Share of those columns each level of a tree may use."),
    "colsample_bynode": ("Sampling", "Columns per split", "Share of those columns each split may use."),
    "reg_lambda": ("Regularization", "L2 regularization (lambda)", "Shrinks large leaf values. Higher makes the model smoother."),
    "reg_alpha": ("Regularization", "L1 regularization (alpha)", "Pushes small leaf values to zero. Higher makes the model simpler."),
    "max_leaves": ("Trees", "Maximum leaves", "Caps how many leaves each tree can have. 0 means no limit beyond the maximum depth."),
    "grow_policy": ("Trees", "Growth policy", "depthwise grows each tree level by level; lossguide grows the most useful branch first, where maximum leaves matters most."),
    "scale_pos_weight": ("Regularization", "Enrolled weight", "How much enrolled students count compared with those who didn't enroll."),
    "recency_decay": ("Training", "Recency decay", "How quickly older terms count less: each year back weighs e^(−decay × years). 0 counts every term the same."),
    "folds": ("Training", "Calibration folds", "How many parts the training data is split into to calibrate the probabilities."),
    "random_state": ("Training", "Random seed", "Fixes the randomness, so the same data and settings give the same forecast. Blank picks a new one each run."),
}
assert set(INFO) == set(recipe.TUNABLE), "every tunable setting needs a label"


def _require(who: Principal) -> None:
    if not who.ml:
        raise HTTPException(403, "Ask an admin or owner of your institution for access to the ML workspace.")


def _can_edit(who: Principal, p: Project) -> bool:
    """Changes what the prediction's next Run does: someone who can run it, on their own prediction (admins: any)."""
    return who.ml and who.at_least("analyst") and who.manages(p.created_by)


async def _workspace_defaults(session: AsyncSession, institution_id: str) -> tuple[Institution | None, dict]:
    inst = await session.get(Institution, institution_id)
    return inst, dict(inst.model_defaults or {}) if inst else {}


def _used(f: Forecast | None) -> tuple[dict | None, bool]:
    hp = (f.summary.get("hyperparameters") or {}) if f else {}
    used, recorded = hp.get("values"), "values" in hp
    if used is None and f is not None and (f.summary.get("model_info") or {}).get("recipe") == recipe.RECIPE_VERSION:
        used = dict(recipe.DEFAULTS)  # run before settings were recorded: the recipe's own values (its seed wasn't kept)
    elif used is not None:
        used = {**recipe.DEFAULTS, **used}  # settings added since that run had their defaults then
    return used, recorded


async def _view(session: AsyncSession, who: Principal, p: Project) -> dict:
    f = await session.get(Forecast, p.forecast_id) if p.forecast_id else None
    inst, ws = await _workspace_defaults(session, p.institution_id)
    base = recipe.base_of(ws)
    used, recorded = _used(f)
    hp = (f.summary.get("hyperparameters") or {}) if f else {}
    saved = p.model_params or {}
    people = await names(session, [x for x in (p.model_params_by, f.created_by if f else None, inst.model_defaults_by if inst else None) if x])
    return {
        "project": {"id": p.id, "name": p.name}, "can_edit": _can_edit(who, p), "can_default": who.ml and who.at_least("admin"), "stale": p.stale,
        "params": [{"key": k, "group": g, "label": label, "help": text, "kind": recipe.TUNABLE[k][0], "min": recipe.TUNABLE[k][1],
                    "max": recipe.TUNABLE[k][2], "options": recipe.CHOICES.get(k), "default": base[k], "lab": recipe.DEFAULTS[k],
                    "used": (used or {}).get(k), "saved": saved.get(k)}
                   for k, (g, label, text) in INFO.items()],
        "workspace_default": None if not ws else {
            "params": ws, "by": people.get(inst.model_defaults_by), "at": inst.model_defaults_at.isoformat() if inst.model_defaults_at else None},
        "objectives": [{"key": k, "label": label, "higher": higher} for k, (label, higher) in recipe.OBJECTIVES.items()],
        "searchable": [{"key": k, "scale": sc, "from": lo, "to": hi} for k, (sc, lo, hi) in recipe.SEARCHABLE.items()],
        "last_run": None if f is None else {
            "id": f.id, "at": f.created_at.isoformat(), "by": people.get(f.created_by), "recorded": recorded, "changed": hp.get("changed", []),
            "family": hp.get("family") or (f.summary.get("model_info") or {}).get("family")},
        "saved_by": people.get(p.model_params_by) if saved else None,
        "saved_at": p.model_params_at.isoformat() if saved and p.model_params_at else None,
        **await _lab(session, who, p, f),
    }


def _job(j: TuningRun) -> dict:
    return {"id": j.id, "mode": j.mode, "status": j.status, "candidates": j.candidates, "results": j.results, "best": j.best_index,
            "holdout": j.holdout, "error": j.error, "seconds": j.seconds, "at": j.created_at.isoformat(), "progress": j.progress,
            "config": j.config or {"objective": "roc_auc"}}


def _log(j: TuningRun) -> dict:
    """One experiment with every number: each candidate's settings (the values the run really used) and every score."""
    res = j.results or []
    out = []
    for i, c in enumerate(j.candidates or []):
        r = res[i] if i < len(res) and res[i] else None
        out.append({"name": c.get("name"), "why": c.get("why"), "source": c.get("source"), "params": c.get("params") or {},
                    "values": (r or {}).get("values") or c.get("values"), "metrics": (r or {}).get("metrics"),
                    "predicted": (r or {}).get("predicted"), "actual": (r or {}).get("actual"), "seconds": (r or {}).get("seconds")})
    return {"id": j.id, "at": j.created_at.isoformat(), "mode": j.mode, "status": j.status, "objective": (j.config or {}).get("objective", "roc_auc"),
            "seconds": j.seconds, "best": j.best_index, "holdout": j.holdout, "error": j.error, "candidates": out}


async def _lab(session: AsyncSession, who: Principal, p: Project, f: Forecast | None) -> dict:
    """What the workspace shows beside the settings: AI suggestions, the latest test, every experiment's log, the forecast's own scores."""
    await _running(session, p.id)  # a test whose server stopped shows as interrupted, not running for ever
    jobs = (await session.scalars(select(TuningRun).where(TuningRun.project_id == p.id).order_by(TuningRun.created_at.desc()).limit(30))).all()
    sug = next((j for j in jobs if j.status == "suggested"), None)
    tests = [j for j in jobs if j.status != "suggested"]
    s = f.summary if f else {}
    ev = s.get("evaluation")
    return {
        "can_tune": _can_edit(who, p),
        "suggestions": None if sug is None else {"id": sug.id, "at": sug.created_at.isoformat(), "candidates": sug.candidates},
        "test": _job(tests[0]) if tests else None,
        "history": [_log(j) for j in tests],
        "forecast": None if f is None else {
            "term": s.get("target_term"), "expected": s.get("expected"), "drivers": (s.get("drivers") or [])[:10],
            "seconds": (s.get("model_info") or {}).get("seconds"), "evaluation": {k: ev.get(k) for k in SCORES} if ev else None},
    }


@router.get("/projects/{project_id}")
async def get_settings(p: Project = Depends(project_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    _require(who)
    return await _view(session, who, p)


class ParamsIn(BaseModel):
    params: dict[str, float | str | None]
    note: str | None = Field(None, max_length=120)  # where the values came from (an experiment's candidate), for the activity log


async def _store(session: AsyncSession, who: Principal, p: Project, clean: dict, action: str, **extra) -> dict:
    if clean != (p.model_params or {}):
        p.model_params = clean or None
        p.model_params_by, p.model_params_at, p.updated_by = who.user.id, datetime.now(timezone.utc), who.user.id
        _touch(p)  # the current forecast was made with other settings
        await audit(session, who, action, p.id, changed=sorted(clean), **extra)
        await session.commit()
    return await _view(session, who, p)


def _clean(values: dict, base: dict) -> dict:
    try:
        return recipe.clean_params(values, base)
    except ValueError as e:
        raise HTTPException(422, str(e))


@router.put("/projects/{project_id}")
async def save_settings(body: ParamsIn, p: Project = Depends(project_for), who: Principal = Depends(current),
                        session: AsyncSession = Depends(get_session)):
    """The settings this prediction's forecast runs use (only the ones that differ from the defaults are kept)."""
    _require(who)
    if not _can_edit(who, p):
        raise HTTPException(403, "Only the person who made this prediction, or an admin, can change its model settings.")
    _, ws = await _workspace_defaults(session, p.institution_id)
    extra = {"source": body.note} if body.note else {}
    return await _store(session, who, p, _clean(body.params, recipe.base_of(ws)), "ml.settings_saved", **extra)


@router.delete("/projects/{project_id}")
async def reset_settings(p: Project = Depends(project_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """Back to the defaults (the workspace's own, if it has them)."""
    _require(who)
    if not _can_edit(who, p):
        raise HTTPException(403, "Only the person who made this prediction, or an admin, can change its model settings.")
    return await _store(session, who, p, {}, "ml.settings_reset")


def _require_default(who: Principal) -> None:
    _require(who)
    if not who.at_least("admin"):
        raise HTTPException(403, "Only an admin or owner can change the workspace's default model settings.")


@router.put("/projects/{project_id}/default")
async def make_default(body: ParamsIn, p: Project = Depends(project_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """Make these the workspace's default model settings: every prediction without its own changes runs with them, and Reset to
    Defaults comes back to them. Kept as changes from the lab's settings."""
    _require_default(who)
    changes = _clean(body.params, recipe.DEFAULTS)
    inst = await session.get(Institution, p.institution_id)
    inst.model_defaults, inst.model_defaults_by, inst.model_defaults_at = changes or None, who.user.id, datetime.now(timezone.utc)
    base = recipe.base_of(changes)
    own = {k: v for k, v in (p.model_params or {}).items() if v != base.get(k)}  # this prediction's changes that are now the default go
    if own != (p.model_params or {}):
        p.model_params = own or None
    _touch(p)
    await audit(session, who, "ml.default_set", inst.id, changed=sorted(changes), **({"source": body.note} if body.note else {}))
    await session.commit()
    return await _view(session, who, p)


@router.delete("/projects/{project_id}/default")
async def clear_default(p: Project = Depends(project_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """The workspace goes back to the research lab's default settings."""
    _require_default(who)
    inst = await session.get(Institution, p.institution_id)
    if inst.model_defaults:
        inst.model_defaults, inst.model_defaults_by, inst.model_defaults_at = None, who.user.id, datetime.now(timezone.utc)
        _touch(p)
        await audit(session, who, "ml.default_cleared", inst.id)
        await session.commit()
    return await _view(session, who, p)


# ------------------------------------------------------------------------------------------------ recommendations and tests


def _require_edit(who: Principal, p: Project) -> None:
    _require(who)
    if not _can_edit(who, p):
        raise HTTPException(403, "Only the person who made this prediction, or an admin, can test its settings.")


async def _context(session: AsyncSession, p: Project) -> tuple[dict, dict, dict]:
    """(the defaults, every setting the prediction uses now, what the AI should know about the data and the latest results)."""
    _, ws = await _workspace_defaults(session, p.institution_id)
    base = recipe.base_of(ws)
    current = {**base, **(p.model_params or {})}
    f = await session.get(Forecast, p.forecast_id) if p.forecast_id else None
    s = f.summary if f else {}
    mi = s.get("model_info") or {}
    last = await session.scalar(select(TuningRun).where(TuningRun.project_id == p.id, TuningRun.status == "done")
                                .order_by(TuningRun.created_at.desc()).limit(1))
    facts = {
        "admits_learned_from": mi.get("train_rows"), "enrolled_among_them": mi.get("train_enrolled"), "columns_used": len(mi.get("columns") or []),
        "terms_learned_from": mi.get("train_terms"), "model": mi.get("family"),
        "latest_forecast_scores": {k: s["evaluation"].get(k) for k in SCORES} if s.get("evaluation") else None,
        "latest_test": [{"name": c["name"], "changes": c.get("params"), "scores": (last.results[i] or {}).get("metrics")}
                        for i, c in enumerate(last.candidates) if i < len(last.results or [])] if last and last.results else None,
    }
    return base, current, facts


@router.post("/projects/{project_id}/recommend")
async def recommend(p: Project = Depends(project_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """AI recommendations: complete sets of settings (a value and a reason for every setting), from this data, its latest results and
    the settings' ranges. Counts as one AI question."""
    _require_edit(who, p)
    await plans.check_ai(session, who.institution.id)
    base, current, facts = await _context(session, p)
    sets = await run_in_threadpool(ml_advisor.recommend, facts, current, base)
    session.add(TuningRun(institution_id=who.institution.id, project_id=p.id, user_id=who.user.id, mode="recommended", status="suggested",
                          candidates=sets))
    await audit(session, who, "ml.recommended", p.id, sets=len(sets))
    await session.commit()
    return await _view(session, who, p)


Objective = Literal["roc_auc", "pr_auc", "f1", "brier", "error_pct"]


class TuneIn(BaseModel):
    mode: Literal["recommended", "default", "custom", "expert"]  # Smart (AI), defaults only, your values, a search across ranges
    params: dict[str, float | str | None] = Field(default_factory=dict)  # custom and expert: your values (blank: the default)
    trials: int = Field(0, ge=0, le=MAX_TRIALS)  # expert: how many settings the search tries
    space: dict[str, list[float]] = Field(default_factory=dict)  # expert: {setting: [from, to]} to search
    objective: Objective = "roc_auc"  # what "best" means


def _candidate(name: str, why: str, values: dict, source: str, base: dict, reasons: dict | None = None) -> dict:
    vals = {**base, **{k: v for k, v in (values or {}).items() if v is not None and v != "" and k in recipe.TUNABLE}}
    out = {"name": name, "why": why, "values": vals, "params": _clean(vals, base), "source": source}
    return {**out, "reasons": reasons} if reasons else out


async def _candidates(session: AsyncSession, p: Project, body: TuneIn, base: dict, current: dict) -> list[dict]:
    """What a test compares, by mode. Every candidate is checked against the allowed ranges here, whatever the screen sent."""
    saved = p.model_params or {}
    defaults = ("Defaults", "The workspace's default settings." if base != recipe.DEFAULTS else "The research lab's tuned defaults.")
    if body.mode == "default":
        out = [_candidate(*defaults, {}, "default", base)] + ([_candidate("Current settings", "What this prediction uses now.", current, "saved", base)] if saved else [])
        cap = MAX_CANDIDATES
    elif body.mode == "custom":
        mine = _candidate("Your settings", "The values you set.", body.params, "custom", base)
        out = ([mine] if mine["params"] else []) + [_candidate(*defaults, {}, "default", base)]
        cap = MAX_CANDIDATES
    elif body.mode == "expert":
        if not body.space:
            raise HTTPException(422, "Choose at least one setting to search, with a range.")
        if not 2 <= body.trials <= MAX_TRIALS:
            raise HTTPException(422, f"Choose between 2 and {MAX_TRIALS} trials.")
        space = {}
        for k, rng in body.space.items():
            if k not in recipe.SEARCHABLE or len(rng) != 2:
                raise HTTPException(422, f"{k} can't be searched.")
            lo, hi = sorted(float(x) for x in rng)
            kind, mn, mx = recipe.TUNABLE[k]
            if lo < mn or hi > mx or lo == hi:
                raise HTTPException(422, f"{INFO[k][1]}: choose a range between {mn:g} and {mx:g}, with From below To.")
            space[k] = [lo, hi]
        mine = _candidate("Your settings", "The values the search starts from.", body.params, "custom", base)
        out = ([mine] if mine["params"] else []) + [_candidate(*defaults, {}, "default", base)]
        out += [_candidate(f"Trial {i + 1}", "A point the search tried across your ranges.", x, "search", base)
                for i, x in enumerate(recipe.search(space, body.trials, secrets.randbelow(2**31), mine["values"]))]
        cap = 2 + MAX_TRIALS
    else:
        sug = await session.scalar(select(TuningRun).where(TuningRun.project_id == p.id, TuningRun.status == "suggested")
                                   .order_by(TuningRun.created_at.desc()).limit(1))
        if sug is None:
            raise HTTPException(422, "Get AI recommendations first.")
        out = ([_candidate("Current settings", "What this prediction uses now.", current, "saved", base)] if saved else [])
        out += [_candidate(*defaults, {}, "default", base)]
        out += [_candidate(x["name"], x["why"], x.get("values") or {**current, **x.get("params", {})}, x.get("source", "ai"), base, x.get("reasons"))
                for x in sug.candidates]
        cap = MAX_CANDIDATES
    unique, seen = [], set()
    for x in out:
        key = json.dumps(x["params"], sort_keys=True)
        if key not in seen:
            seen.add(key)
            unique.append(x)
    return unique[:cap]


STALE = 120  # seconds without word from a running test: the server it ran on stopped (a new version went live), so it's over
WATCH = 780  # a watch ends before Cloud Run's request limit; the page simply watches again
_jobs: set[asyncio.Task] = set()  # tests running on this server (kept so they aren't garbage-collected)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _running(session: AsyncSession, project_id: str) -> TuningRun | None:
    """This prediction's test that is still going. One whose server stopped is marked interrupted (it never counts against the plan)."""
    j = await session.scalar(select(TuningRun).where(TuningRun.project_id == project_id, TuningRun.status.in_(("running", "stopping")))
                             .order_by(TuningRun.created_at.desc()).limit(1))
    if j is None:
        return None
    at = (j.progress or {}).get("at")
    if (datetime.now(timezone.utc) - (datetime.fromisoformat(at) if at else j.created_at)).total_seconds() > STALE:
        j.status, j.finished_at = "failed", datetime.now(timezone.utc)
        j.error = "The test was interrupted while YieldPilot was being updated. It didn't use a run of your plan; start it again."
        await session.commit()
        return None
    return j


async def _start(session: AsyncSession, p: Project, who: Principal, body: TuneIn) -> None:
    """Checks everything, then starts the test on the server. It keeps going whatever page anyone is on, until it finishes or Stop
    is pressed."""
    if await _running(session, p.id):
        raise HTTPException(409, "A test is already running for this prediction. Wait for it to finish, or stop it.")
    v, df = await _frame(session, p)
    await guard_rows(session, who.institution.id, len(df))
    await ensure_setup(session, p, v, df)
    await session.commit()
    hold = recipe.holdout(df, await spec_of(session, p))
    if hold is None:
        raise HTTPException(422, "Testing settings needs a year of history before the terms the model learns from, so each setting can be scored "
                                 "on a term whose outcomes are known. Add an earlier term to the data.")
    base, current, facts = await _context(session, p)
    cands = await _candidates(session, p, body, base, current)
    await plans.check_run(session, who.institution.id, who.user.id, runs.active(who.institution.id))  # a test uses one run of the plan
    rounds = 1
    if body.mode == "recommended":  # Smart: the AI studies round 1's scores and proposes a refined round (one more AI question)
        try:
            await plans.check_ai(session, who.institution.id)
            rounds = 2
        except HTTPException:
            rounds = 1
    config = {"objective": body.objective, "rounds": rounds, **({"trials": body.trials, "space": body.space} if body.mode == "expert" else {})}
    job = TuningRun(institution_id=who.institution.id, project_id=p.id, user_id=who.user.id, mode=body.mode, status="running", candidates=cands,
                    holdout={"target": hold.target_term, "train": hold.train_terms}, config=config,
                    progress={"pct": 0, "label": "Starting", "detail": "", "at": _now()})
    session.add(job)
    await audit(session, who, "ml.test_started", p.id, mode=body.mode, candidates=len(cands), objective=body.objective)
    await session.commit()
    r = runs.start(who.institution.id, p.id, v.data_key, v.idmap_key, [replace(hold, params=x["values"]) for x in cands])
    ctx = {"hold": hold, "data_key": v.data_key, "idmap_key": v.idmap_key, "base": base, "current": current, "facts": facts,
           "objective": body.objective, "rounds": rounds}
    task = asyncio.create_task(_drive(job.id, r, who, p.id, p.name, body.mode, ctx))
    _jobs.add(task)
    task.add_done_callback(_jobs.discard)


async def _follow(job_id: str, r: runs.Run, lo: float, hi: float, prefix: str = "") -> None:
    """Writes the run's progress (mapped into lo-hi) every two seconds, and stops it when someone pressed Stop on any server."""
    beat = 0.0
    while not r.done.is_set():
        await asyncio.sleep(0.5)
        if time.monotonic() - beat < 2:
            continue
        beat = time.monotonic()
        try:
            async with Session() as s:
                j = await s.get(TuningRun, job_id)
                if j is None or j.status == "stopping":
                    r.cancelled = True  # stops within a second
                if j is not None:
                    j.progress = {"pct": round(lo + (hi - lo) * r.pct / 100, 1), "label": prefix + r.label, "detail": r.detail, "at": _now()}
                    await s.commit()
        except Exception:
            log.warning("couldn't record a test's progress", exc_info=True)


async def _say(job_id: str, pct: float, label: str) -> bool:
    """Progress between runs; False when Stop was pressed meanwhile."""
    async with Session() as s:
        j = await s.get(TuningRun, job_id)
        if j is None or j.status == "stopping":
            return False
        j.progress = {"pct": pct, "label": label, "detail": "", "at": _now()}
        await s.commit()
        return True


async def _drive(job_id: str, r: runs.Run, who: Principal, project_id: str, project_name: str, mode: str, ctx: dict) -> None:
    """Follows the test on this server and records the outcome. Smart tuning has a second round: the AI studies the first round's
    scores for the goal and proposes refined settings, which are tested too."""
    usage.acting(who.institution.id, who.user.id)  # the second round's AI question counts for the person who started the test
    began, two = time.monotonic(), ctx["rounds"] == 2
    await _follow(job_id, r, 0, 60 if two else 100, "Round 1 · " if two else "")
    results = r.result["tuning"] if not r.error else None
    stopped = bool(r.error) and (r.cancelled or "stopped" in (r.error or "").lower())
    failed = r.error if r.error and not stopped else None
    note = None
    if two and results is not None:
        try:
            if not await _say(job_id, 62, "The AI is studying round 1's scores"):
                stopped = True
            else:
                async with Session() as s:
                    cands = list((await s.get(TuningRun, job_id)).candidates or [])
                tested = [{"name": c["name"], "values": c.get("values"), "scores": res.get("metrics")} for c, res in zip(cands, results)]
                new = await run_in_threadpool(ml_advisor.refine, ctx["facts"], ctx["current"], ctx["base"], tested, ctx["objective"])
                seen = {json.dumps(c["params"], sort_keys=True) for c in cands}
                new = [{**n, "name": f"Refined: {n['name']}"[:60], "source": "ai_refined"} for n in new if json.dumps(n["params"], sort_keys=True) not in seen][:2]
                if new:
                    async with Session() as s:
                        j = await s.get(TuningRun, job_id)
                        if j.status == "stopping":
                            stopped = True
                        else:
                            j.candidates = cands + new
                            await s.commit()
                    if not stopped:
                        r2 = runs.start(who.institution.id, project_id, ctx["data_key"], ctx["idmap_key"], [replace(ctx["hold"], params=n["values"]) for n in new])
                        await _follow(job_id, r2, 66, 100, "Round 2 · ")
                        if r2.error:
                            if r2.cancelled or "stopped" in r2.error.lower():
                                stopped = True
                            else:
                                note = "Round 2 couldn't finish; round 1's results stand."
                        else:
                            results = results + r2.result["tuning"]
                else:
                    note = "The AI had no new settings to try; round 1's results stand."
        except Exception:
            log.exception("Smart tuning's second round failed")
            note = "Round 2 couldn't run; round 1's results stand."
    try:
        async with Session() as s:
            j = await s.get(TuningRun, job_id)
            if j is None:  # the prediction was deleted meanwhile
                return
            outcome = "failed" if failed else "cancelled" if stopped else "done"
            j.seconds, j.finished_at = round(time.monotonic() - began, 1), datetime.now(timezone.utc)
            if results is not None:  # every number is kept, even when round 2 was stopped
                j.results = results
                j.best_index = recipe.best(results, ctx["objective"])
            j.status = outcome
            j.error = (failed or "")[:300] or None
            if note:
                j.config = {**(j.config or {}), "note": note}
            j.progress = {"pct": 100 if outcome == "done" else (j.progress or {}).get("pct", 0), "label": "Done" if outcome == "done" else outcome.title(),
                          "detail": "", "at": _now()}
            s.add(RunLog(institution_id=who.institution.id, user_id=who.user.id, project_id=project_id, kind="tuning", outcome=outcome,
                         seconds=j.seconds, vcpu=settings().run_vcpu, memory_gib=settings().run_memory_gib, error=(failed or "")[:300] or None))
            if outcome == "done":
                await audit(s, who, "ml.tested", project_id, mode=mode, candidates=len(j.candidates or []), objective=ctx["objective"])
                best = j.candidates[j.best_index] if j.best_index is not None else None
                score = (j.results[j.best_index] or {}).get("metrics", {}).get(ctx["objective"]) if best else None
                label = recipe.OBJECTIVES[ctx["objective"]][0].split("(")[-1].rstrip(")")
                s.add(Notification(institution_id=who.institution.id, recipient_email=who.user.email, kind="ml",
                                   title=f"Your tuning run on {project_name} finished",
                                   body=(f"Best: {best['name']}" + (f", {label} {score:.3f}" if isinstance(score, (int, float)) else "")) if best else "No result",
                                   link="/ml"))
            elif outcome == "failed":
                s.add(Notification(institution_id=who.institution.id, recipient_email=who.user.email, kind="ml",
                                   title=f"Your tuning run on {project_name} couldn't finish", body=(failed or "")[:200], link="/ml"))
            await s.commit()
    except Exception:
        log.exception("couldn't record a test's outcome")


@router.post("/projects/{project_id}/tune")
async def tune(body: TuneIn, p: Project = Depends(project_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """Test settings: each candidate learns from the terms before last year and forecasts last year, whose outcomes are known.
    Starts the test and answers at once; it keeps running on the server until it finishes or Stop is pressed, whatever page anyone
    is on. Follow it with /tune/watch. Every number is saved with the prediction. Uses one run of the plan."""
    _require_edit(who, p)
    await _start(session, p, who, body)
    return await _view(session, who, p)


@router.get("/projects/{project_id}/tune/watch")
async def watch_tune(p: Project = Depends(project_for), who: Principal = Depends(current)):
    """Streams the running test's progress, then the workspace with its results. Leaving the page only ends this watch, never the test."""
    _require(who)
    project_id = p.id

    async def work(prog: Progress):
        began = time.monotonic()
        while not prog.cancelled and time.monotonic() - began < WATCH:
            async with Session() as s:
                j = await _running(s, project_id)
                if j is None:
                    return await _view(s, who, await s.get(Project, project_id))
                at = j.progress or {}
                prog(at.get("pct", 0), "Stopping the test" if j.status == "stopping" else at.get("label"), at.get("detail", ""))
            await asyncio.sleep(1)
        return {"again": True}

    return stream(work)


@router.post("/projects/{project_id}/tune/cancel")
async def cancel_tune(p: Project = Depends(project_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """The Stop button: the only thing that ends a test before it finishes."""
    _require_edit(who, p)
    j = await _running(session, p.id)
    if j is not None and j.status == "running":
        j.status = "stopping"  # the server running it stops it at its next check, within a few seconds
        await audit(session, who, "ml.test_stopped", p.id)
        await session.commit()
        runs.cancel(p.id, "tuning")  # and right away when it runs on this server
    return await _view(session, who, p)


# ------------------------------------------------------------------------------------------------ access


@router.get("/access")
async def access(who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    who.require("admin")
    rows = (await session.execute(ms.people(who.institution.id).where(Membership.role != "guest").order_by(User.name, User.email))).all()
    by = await names(session, list({m.ml_granted_by for _, m in rows if m.ml_granted_by}))
    return [{"id": u.id, "name": u.name, "email": u.email, "role": m.role, "active": m.active and u.active, "always": m.role in ("admin", "owner"),
             "granted": m.ml_access, "granted_by": by.get(m.ml_granted_by) if m.ml_access else None, "granted_at": None} for u, m in rows]


class AccessIn(BaseModel):
    granted: bool


@router.put("/access/{user_id}")
async def set_access(user_id: str, body: AccessIn, who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    who.require("admin")
    row = (await session.execute(ms.people(who.institution.id).where(User.id == user_id))).first()
    if row is None:
        raise HTTPException(404, "Member not found.")
    u, m = row
    if m.role == "guest":
        raise HTTPException(422, "Guests can't use the ML workspace.")
    if body.granted and not m.ml_access and u.id != who.user.id:
        session.add(Notification(institution_id=who.institution.id, recipient_email=u.email, kind="access",
                                 title=f"{who.user.name or who.user.email} gave you access to the ML workspace",
                                 body="Change the model settings behind your predictions.", link="/ml"))
    m.ml_access, m.ml_granted_by = body.granted, who.user.id if body.granted else None
    await audit(session, who, "ml.access_given" if body.granted else "ml.access_removed", u.id)
    await session.commit()
    return {"ok": True}
