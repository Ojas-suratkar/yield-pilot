"""Projects: one forecast workspace per term and population. Every step of the app reads and writes here."""

import hashlib
import json
import logging
import threading
import time
from collections import OrderedDict

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import engine
from ..auth import Principal, audit, current
from ..config import settings
from ..db import Session, get_session
from ..ingest import ingest_frame
from ..models import AuditEvent, Connection, Dataset, DatasetVersion, Forecast, Institution, Notification, Project, RunLog, Share, Upload, User
from ..services import audit as auditor
from ..services import trim
from ..services import ai_audit, assistant, plans, registry, runs
from ..services.cache import key as ckey, memo
from ..services.fields import FIELDS, GROUPS, admitted, ai_map, vmap
from ..services.profiling import REC_VERSION, profile_features, recommend
from ..services.progress import Progress, respond, stream
from ..services.store import forget, latest_version, load_artifact, load_frame, new_version, reidentify
from ..storage import storage
from ..services.terms_info import default_target, make_term, prior_like, recommended_train_terms, term_info
from .deps import manage_only, names, project_for

log = logging.getLogger("yieldpilot.forecasts")
router = APIRouter(prefix="/projects", tags=["projects"])


def project_out(p: Project, v: DatasetVersion | None = None, f: Forecast | None = None, people: dict | None = None) -> dict:
    people = people or {}
    return {
        "id": p.id, "name": p.name, "owner": {"id": p.created_by, "name": people.get(p.created_by)},
        "updated_by": people.get(p.updated_by) if p.updated_by else None, "source": p.source, "mapping": p.mapping, "mapping_confirmed": p.mapping_confirmed,
        "audit": {"score": p.audit_score, "status": p.audit_status, "reviewed": p.audit_reviewed} if p.audit_score is not None else None,
        "fixes_applied": p.fixes_applied, "setup": p.setup, "features": p.features, "forecast_id": p.forecast_id,
        # a forecast from an older recipe counts as out of date, so it re-runs on the current one
        "stale": p.stale or (f is not None and f.summary.get("recipe") != engine.RECIPE_VERSION),
        "results_seen": p.results_seen, "scenarios_seen": p.scenarios_seen, "updated_at": p.updated_at.isoformat() if p.updated_at else None,
        "dataset": None if v is None else {
            "id": v.dataset_id, "version": v.version, "filename": v.source_filename, "rows": v.rows, "columns": v.columns,
            "id_column": v.id_column, "dropped": v.dropped, "warnings": v.warnings, "profile": v.profile, "parent_version": v.parent_version,
        },
        "forecast": None if f is None else {"id": f.id, "summary": f.summary, "created_at": f.created_at.isoformat(), "is_production": f.is_production,
                                            "registry": f.registry, "run_by": {"id": f.created_by, "name": people.get(f.created_by)}},
    }


async def _version(session: AsyncSession, p: Project) -> DatasetVersion | None:
    if not p.dataset_id:
        return None
    return await latest_version(session, p.dataset_id, p.institution_id, p.dataset_version)


async def _frame(session: AsyncSession, p: Project) -> tuple[DatasetVersion, pd.DataFrame]:
    v = await _version(session, p)
    if v is None:
        raise HTTPException(409, "Add your data first.")
    return v, await load_frame(v.data_key)


async def full(session: AsyncSession, p: Project) -> dict:
    v = await _version(session, p)
    f = await session.get(Forecast, p.forecast_id) if p.forecast_id else None
    return project_out(p, v, f, await names(session, [p.created_by, p.updated_by, f.created_by if f else None]))


async def attach(session: AsyncSession, p: Project, v: DatasetVersion, df: pd.DataFrame, source: dict, progress=None,
                 known: dict | None = None) -> None:
    """Point a project at a new dataset: match its columns and reset every later step. `known` is an earlier matching
    for the same source ({"mapping", "used_ai", "fit"}); it is reused, skipping the AI, when its columns are all still there."""
    p.dataset_id, p.dataset_version = v.dataset_id, v.version
    if known and known.get("mapping") and all(c in df.columns for c in known["mapping"].values()):
        p.mapping, used_ai, fit = dict(known["mapping"]), known.get("used_ai", True), known.get("fit") or {}
    else:
        p.mapping, used_ai, fit = await run_in_threadpool(ai_map, df, v.id_column, progress)
    p.source = {**source, "ai_mapped": used_ai, "fit": fit}
    p.audit_plan = None
    p.mapping_confirmed, p.audit_score, p.audit_status, p.audit_reviewed = False, None, None, False
    p.fixes_applied, p.setup, p.features, p.forecast_id, p.stale = [], {}, {}, None, False
    p.results_seen = p.scenarios_seen = False
    p.name = source.get("label") or p.name


def _touch(p: Project) -> None:
    """Settings changed since the last forecast: keep showing it, flagged, until it is re-run."""
    if p.forecast_id:
        p.stale = True


# --------------------------------------------------------------------------------------------- CRUD


@router.get("")
async def list_projects(who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """Every study in the institution's shared workspace, most recently changed first, with who made it and who last ran it."""
    if not who.member:
        return []
    rows = (await session.execute(select(Project, Forecast).outerjoin(Forecast, Forecast.id == Project.forecast_id)
                                  .where(Project.institution_id == who.institution.id).order_by(Project.updated_at.desc()))).all()
    people = await names(session, [x for p, f in rows for x in (p.created_by, p.updated_by, f.created_by if f else None)])
    return [{"id": p.id, "name": p.name, "updated_at": p.updated_at.isoformat(), "forecast_id": p.forecast_id, "setup": p.setup,
             "owner": {"id": p.created_by, "name": people.get(p.created_by)}, "mine": p.created_by == who.user.id,
             "updated_by": people.get(p.updated_by) if p.updated_by else None,
             "last_run": {"by": people.get(f.created_by), "at": f.created_at.isoformat(), "expected": f.summary.get("expected")} if f else None}
            for p, f in rows]


class NewProject(BaseModel):
    name: str = "New yield prediction"
    from_project: str | None = None  # start from that prediction's data, fields and fixes (a new term or population)


@router.post("")
async def create_project(body: NewProject, who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    who.require("analyst")
    p = Project(institution_id=who.institution.id, name=body.name[:200], created_by=who.user.id, mapping={}, setup={}, features={}, source={}, fixes_applied=[])
    src = await session.scalar(select(Project).where(Project.id == body.from_project, Project.institution_id == who.institution.id)) \
        if body.from_project else None
    if src and src.dataset_id:
        p.dataset_id, p.dataset_version, p.source, p.mapping = src.dataset_id, src.dataset_version, dict(src.source), dict(src.mapping)
        p.mapping_confirmed, p.audit_score, p.audit_status, p.audit_reviewed = src.mapping_confirmed, src.audit_score, src.audit_status, src.audit_reviewed
        p.fixes_applied, p.audit_plan, p.name = list(src.fixes_applied), src.audit_plan, src.name
    session.add(p)
    await session.flush()
    await audit(session, who, "project.created", p.id)
    await session.commit()
    return await full(session, p)


@router.get("/{project_id}")
async def get_project(p: Project = Depends(project_for), session: AsyncSession = Depends(get_session)):
    return await full(session, p)


class ProjectPatch(BaseModel):
    name: str | None = None
    mapping: dict | None = None
    mapping_confirmed: bool | None = None
    audit_reviewed: bool | None = None
    setup: dict | None = None
    features: dict | None = None
    results_seen: bool | None = None
    scenarios_seen: bool | None = None


@router.patch("/{project_id}")
async def patch_project(body: ProjectPatch, p: Project = Depends(project_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    who.require("analyst")
    p.updated_by = who.user.id
    data = body.model_dump(exclude_unset=True)
    if "mapping" in data:
        v, df = await _frame(session, p)
        mapping = {k: c for k, c in data["mapping"].items() if c and c in df.columns and k in {f["key"] for f in FIELDS}}
        if mapping != p.mapping:
            p.mapping, p.audit_score = mapping, None
            _touch(p)
    if "setup" in data:
        if data["setup"].get("term") and "train_terms" not in data["setup"]:
            v, df = await _frame(session, p)
            info = await _terms(v, df, p)
            data["setup"]["train_terms"] = recommended_train_terms(data["setup"]["term"], info["past"])
        if data["setup"].get("group") not in (None, "FTF", "TRN"):
            raise HTTPException(422, "Population must be First-Time Freshman or Transfer.")
        setup = {**p.setup, **data["setup"]}
        if setup != p.setup:
            p.setup = setup
            _touch(p)
    if "features" in data:
        if "selected" in data["features"] and sorted(data["features"]["selected"] or []) != sorted(p.features.get("selected") or []):
            _touch(p)
        p.features = {**p.features, **data["features"]}
    for k in ("name", "mapping_confirmed", "audit_reviewed", "results_seen", "scenarios_seen"):
        if k in data and data[k] is not None:
            setattr(p, k, data[k])
    if p.stale and p.forecast_id:  # back to exactly what the shown forecast used: it is current again
        f, v = await session.get(Forecast, p.forecast_id), await _version(session, p)
        if f and v and f.dataset_version_id == v.id and f.spec == (await spec_of(session, p)).__dict__:
            p.stale = False
    await session.commit()
    return await full(session, p)


@router.delete("/{project_id}")
async def delete_project(p: Project = Depends(project_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """Delete a prediction and its reports. Its data stays available under "Previously used data"."""
    who.require("analyst")
    manage_only(who, p.created_by, "this prediction")
    runs.cancel(p.id)
    for f in (await session.scalars(select(Forecast).where(Forecast.project_id == p.id))).all():
        await drop_forecast(session, f)
    await audit(session, who, "project.deleted", p.id, name=p.name)
    await session.delete(p)
    await session.commit()
    return {"ok": True}


async def drop_forecast(session: AsyncSession, f: Forecast) -> None:
    """Delete a forecast (report) everywhere: its shares, the notifications that pointed people to it, its activity
    entries, its stored model and predictions, and its Vertex AI registration. Nobody it was shared with keeps a copy."""
    for sh in (await session.scalars(select(Share).where(Share.forecast_id == f.id))).all():
        await session.delete(sh)
    for n in (await session.scalars(select(Notification).where(Notification.link.contains(f.id)))).all():
        await session.delete(n)
    for e in (await session.scalars(select(AuditEvent).where(AuditEvent.target == f.id))).all():
        await session.delete(e)
    others = await session.scalar(select(func.count()).select_from(Forecast).where(Forecast.model_key == f.model_key, Forecast.id != f.id))
    if f.model_key and not others:  # older forecasts could share files with an identical run; those stay while in use
        forget(f.predictions_key)
        await run_in_threadpool(storage().delete_prefix, f.model_key.rsplit("/", 1)[0] + "/")
    if f.registry:
        threading.Thread(target=_unregister, args=(dict(f.registry),), daemon=True).start()
    await session.delete(f)
    await session.flush()


def _unregister(entry: dict) -> None:
    try:
        registry.unregister(entry)
    except Exception:
        log.exception("couldn't remove a deleted report from Vertex AI")


def _reset(p: Project) -> None:
    """Back to step 1: no data, and every later step cleared."""
    p.dataset_id, p.dataset_version, p.source, p.mapping, p.audit_plan = None, None, {}, {}, None
    p.mapping_confirmed, p.audit_score, p.audit_status, p.audit_reviewed = False, None, None, False
    p.fixes_applied, p.setup, p.features, p.forecast_id, p.stale = [], {}, {}, None, False
    p.results_seen = p.scenarios_seen = False
    p.summary = None


@router.delete("/{project_id}/data")
async def delete_data(p: Project = Depends(project_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """Delete this prediction's data everywhere, leaving no trace: every version and its files (the protected copy and the
    student ID key), the original upload, the forecasts made from it (with their models, shares and Vertex AI entries),
    its activity entries, and a connection's memory of the import."""
    who.require("data_manager")
    ds_id = p.dataset_id
    if ds_id:
        owner = await session.scalar(select(Dataset.created_by).where(Dataset.id == ds_id))
        manage_only(who, owner, "this data")
    runs.cancel(p.id)
    _reset(p)
    if ds_id:
        versions = (await session.scalars(select(DatasetVersion).where(DatasetVersion.dataset_id == ds_id))).all()
        for f in (await session.scalars(select(Forecast).where(Forecast.dataset_version_id.in_([v.id for v in versions])))).all():
            await drop_forecast(session, f)
        for other in (await session.scalars(select(Project).where(Project.dataset_id == ds_id, Project.id != p.id))).all():
            _reset(other)  # another prediction on the same data loses it too: nothing may point at deleted data
        for up in (await session.scalars(select(Upload).where(Upload.dataset_id == ds_id))).all():
            await run_in_threadpool(storage().delete_prefix, f"{who.institution.id}/uploads/{up.id}/")
            await session.delete(up)
        for e in (await session.scalars(select(AuditEvent).where(AuditEvent.institution_id == who.institution.id,
                                                                 (AuditEvent.target == ds_id) | AuditEvent.target.startswith(f"{ds_id}/")
                                                                 | (AuditEvent.meta["dataset"].as_string() == ds_id)))).all():
            await session.delete(e)
        for c in (await session.scalars(select(Connection).where(Connection.institution_id == who.institution.id))).all():
            imports = (c.config or {}).get("imports") or {}
            kept = {k: v for k, v in imports.items() if v.get("dataset_id") != ds_id}
            if len(kept) != len(imports):
                c.config = {**c.config, "imports": kept}
        for v in versions:
            forget(v.data_key, v.idmap_key)
            await session.delete(v)
        await session.flush()
        ds = await session.get(Dataset, ds_id)
        if ds:
            await session.delete(ds)
        await run_in_threadpool(storage().delete_prefix, f"{who.institution.id}/datasets/{ds_id}/")
    await session.commit()
    return await full(session, p)


class Reuse(BaseModel):
    dataset_id: str


@router.post("/{project_id}/data/reuse")
async def reuse_data(body: Reuse, p: Project = Depends(project_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """Start this prediction from data imported before (its latest version)."""
    who.require("analyst")
    p.updated_by = who.user.id
    ds = await session.scalar(select(Dataset).where(Dataset.id == body.dataset_id, Dataset.institution_id == who.institution.id))
    v = await latest_version(session, body.dataset_id, who.institution.id) if ds else None
    if v is None:
        raise HTTPException(404, "That data is no longer available.")
    df = await load_frame(v.data_key)
    await attach(session, p, v, df, {"connector": "previous", "label": ds.name, "detail": f"{v.rows:,} rows · version {v.version}"})
    await audit(session, who, "dataset.reused", f"{ds.id}/v{v.version}", project=p.id)
    await session.commit()
    return await full(session, p)


# --------------------------------------------------------------------------------------------- data


_orders: "OrderedDict[str, np.ndarray]" = OrderedDict()


def sort_order(s: pd.Series, descending: bool) -> np.ndarray:
    """Row order for a column: numbers sort as numbers, text alphabetically, blanks last."""
    x = engine.recipe.to_number(s)
    key = x if x.notna().mean() >= 0.9 else s.astype(str).str.lower().replace("", np.nan)
    return key.sort_values(ascending=not descending, na_position="last", kind="stable").index.to_numpy()


@router.get("/{project_id}/rows")
async def rows(
    offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500),
    sort: str | None = Query(None, max_length=200), desc: bool = False,
    col: str | None = Query(None, max_length=200), q: str | None = Query(None, max_length=200),
    p: Project = Depends(project_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session),
):
    """A page of the stored data, optionally sorted by a column and filtered by a column's text. `_row` is each row's
    position in the data, so edits and deletes hit the right row whatever the view."""
    v, df = await _frame(session, p)

    def order() -> np.ndarray:
        idx = df.index.to_numpy()
        if col in df.columns and q:
            idx = df.index[df[col].astype(str).str.contains(q.strip(), case=False, regex=False)].to_numpy()
        if sort in df.columns:
            ranked = sort_order(df[sort], desc)
            idx = ranked[np.isin(ranked, idx)] if len(idx) != len(df) else ranked
        return idx

    if sort or q:
        k = ckey(v.data_key, sort, desc, col, q)
        if k not in _orders:
            _orders[k] = await run_in_threadpool(order)
            while len(_orders) > 8:  # each is a row order for the whole dataset: keep only the latest few views
                _orders.popitem(last=False)
        idx = _orders[k]
    else:
        idx = df.index.to_numpy()
    page = df.loc[idx[offset: offset + limit]].copy()
    if v.id_column in page and who.user.role != "viewer":
        page[v.id_column] = (await reidentify(v, page[v.id_column])).to_numpy()
    page.insert(0, "_row", page.index)
    return {"total": len(idx), "offset": offset, "columns": list(df.columns), "rows": page.to_dict(orient="records"),
            "can_undo": v.parent_version is not None}


ESSENTIAL = ("term", "outcome", "studentId", "admitStatus", "studentType", "college")
FIELD_LABEL = {f["key"]: f["label"] for f in FIELDS}


class Edit(BaseModel):
    op: str  # delete_rows | delete_columns | edit_cell
    rows: list[int] = []
    columns: list[str] = []
    row: int | None = None
    column: str | None = None
    value: str | None = None


@router.post("/{project_id}/edits")
async def edit(body: Edit, p: Project = Depends(project_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    who.require("data_manager")
    p.updated_by = who.user.id
    v, df = await _frame(session, p)
    if body.op == "delete_rows":
        out, note = df.drop(index=[i for i in body.rows if 0 <= i < len(df)]).reset_index(drop=True), f"Deleted {len(body.rows)} row(s)"
    elif body.op == "delete_columns":
        if v.id_column in body.columns:
            raise HTTPException(422, "The student ID column can't be removed.")
        needed = {p.mapping.get(k): FIELD_LABEL.get(k, k) for k in ESSENTIAL if p.mapping.get(k)}
        if hit := [c for c in body.columns if c in needed]:
            raise HTTPException(422, f"{hit[0]} can't be removed: the forecast needs it ({needed[hit[0]]}).")
        out, note = df.drop(columns=[c for c in body.columns if c in df]), f"Removed {', '.join(body.columns)}"
    elif body.op == "edit_cell" and body.row is not None and body.column in df and body.column != v.id_column:
        out = df.copy()
        out.at[body.row, body.column] = (body.value or "").strip()
        note = f"Edited a value in {body.column}"
    else:
        raise HTTPException(422, "Unsupported edit.")
    await _derive(session, p, v, out, who, note)
    await audit(session, who, "dataset.edited", f"{v.dataset_id}/v{v.version}", op=body.op)
    await session.commit()
    return await full(session, p)


async def _derive(session: AsyncSession, p: Project, v: DatasetVersion, out: pd.DataFrame, who: Principal, note: str) -> DatasetVersion:
    ds = await session.get(Dataset, v.dataset_id, with_for_update=True)
    digest = hashlib.sha256(pd.util.hash_pandas_object(out, index=False).values.tobytes()).hexdigest()
    nv = await new_version(session, ds, who.user.id, v.source_filename, out, idmap_key=v.idmap_key, id_column=v.id_column, checksum=digest,
                           dropped=v.dropped, profile=v.profile, warnings=v.warnings, parent=v.version, note=note)
    p.dataset_version = nv.version
    p.mapping = {k: c for k, c in p.mapping.items() if c in out.columns}
    p.audit_score = None
    _touch(p)
    return nv


@router.get("/{project_id}/data/trim")
async def trim_options(p: Project = Depends(project_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """The choices for keeping the plan's number of rows: rows per term and the values of short-list columns, with exact counts."""
    who.require("data_manager")
    limit = await plans.rows_limit(session, who.institution.id)
    _, df = await _frame(session, p)
    return {"limit": limit, **(await run_in_threadpool(trim.summary, df, p.mapping.get("term")))}


@router.post("/{project_id}/data/trim")
async def trim_data(body: trim.Keep, p: Project = Depends(project_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """Keep only the rows the plan allows, as a new version of this prediction's data (the earlier version stays in its history)."""
    who.require("data_manager")
    limit = await plans.rows_limit(session, who.institution.id)
    v, df = await _frame(session, p)
    if limit is None or len(df) <= limit:
        raise HTTPException(422, "This data already fits your plan.")
    out, kept = await run_in_threadpool(trim.cut, df, limit, body, p.mapping.get("term"))
    p.updated_by = who.user.id
    await _derive(session, p, v, out, who, f"Kept {kept} to fit the plan")
    await audit(session, who, "dataset.trimmed", f"{v.dataset_id}/v{v.version}", rows=len(out), mode=body.mode, kept=kept[:200])
    await session.commit()
    return await full(session, p)


@router.post("/{project_id}/undo")
async def undo(p: Project = Depends(project_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    who.require("data_manager")
    p.updated_by = who.user.id
    v = await _version(session, p)
    if v is None or v.parent_version is None:
        raise HTTPException(409, "Nothing to undo.")
    p.dataset_version, p.audit_score = v.parent_version, None
    _touch(p)
    await audit(session, who, "dataset.undo", f"{v.dataset_id}/v{v.version}")
    await session.commit()
    return await full(session, p)


# --------------------------------------------------------------------------------------------- audit


@router.get("/{project_id}/audit")
async def get_audit(p: Project = Depends(project_for), session: AsyncSession = Depends(get_session)):
    v, df = await _frame(session, p)
    result = await run_in_threadpool(memo, ckey("audit", v.data_key, p.mapping), lambda: auditor.run_audit(df, p.mapping))
    p.audit_score, p.audit_status = result["score"], result["status"]
    await session.commit()
    return result


@router.get("/{project_id}/audit/plan")
async def audit_plan(request: Request, p: Project = Depends(project_for)):
    """Gemini's review of the current data version: what is wrong, why it matters, and a proposed fix for each problem."""
    project_id = p.id

    async def work(prog: Progress):
        async with Session() as session:
            proj = await session.get(Project, project_id)
            v, df = await _frame(session, proj)
            key = ai_audit.plan_key(v.id, proj.mapping)
            if not proj.audit_plan or proj.audit_plan.get("key") != key:
                prog(5, "Running the quality checks")
                checks = (await run_in_threadpool(memo, ckey("audit", v.data_key, proj.mapping), lambda: auditor.run_audit(df, proj.mapping)))["checks"]
                proj.audit_plan = {"key": key, **await run_in_threadpool(ai_audit.plan, df, proj.mapping, v.id_column, checks, prog)}
                await session.commit()
            return {k: proj.audit_plan[k] for k in ("summary", "issues", "source")}

    return await respond(request, work)


class Fixes(BaseModel):
    ids: list[str] = Field(min_length=1)


@router.post("/{project_id}/fixes")
async def fixes(body: Fixes, p: Project = Depends(project_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """Run the fixes the user approved on a copy of the data, saved as a new version (the previous one stays, with undo)."""
    who.require("data_manager")
    p.updated_by = who.user.id
    v, df = await _frame(session, p)
    if not p.audit_plan or p.audit_plan.get("key") != ai_audit.plan_key(v.id, p.mapping):
        raise HTTPException(409, "The data changed since the review. Refresh the recommended fixes.")
    chosen = [i for i in p.audit_plan["issues"] if i["id"] in set(body.ids)]
    if not chosen:
        raise HTTPException(422, "Choose at least one fix.")
    out, done = await run_in_threadpool(ai_audit.apply, df, p.mapping, v.id_column, chosen)
    await _derive(session, p, v, out, who, "Fixed: " + "; ".join(done)[:180])
    p.fixes_applied = [*p.fixes_applied, *done]
    p.audit_plan = None
    await audit(session, who, "dataset.fixed", f"{v.dataset_id}/v{v.version}", fixes=done, rows_before=len(df), rows_after=len(out))
    await session.commit()
    return await full(session, p)


# --------------------------------------------------------------------------------------------- setup


async def _terms(v: DatasetVersion, df: pd.DataFrame, p: Project) -> dict:
    custom = p.setup.get("custom_terms", [])
    return await run_in_threadpool(memo, ckey("terms", v.data_key, p.mapping, custom), lambda: term_info(df, p.mapping, custom))


async def _profiles(v: DatasetVersion, df: pd.DataFrame, m: dict, term: str | None = None) -> list[dict]:
    """Column profiles for the Features step. The forecast term's outcomes are hidden from them."""
    def build():
        adm = vmap(df[m["admitStatus"]], admitted).astype(bool) if m.get("admitStatus") in df else None
        return profile_features(df, m, adm, term)
    return await run_in_threadpool(memo, ckey("profiles", v.data_key, m, term), build)


@router.get("/{project_id}/terms")
async def terms(p: Project = Depends(project_for), session: AsyncSession = Depends(get_session)):
    v, df = await _frame(session, p)
    info = await _terms(v, df, p)
    target = p.setup.get("term") or default_target(info)
    prior = prior_like(target, info["past"]) if target else None
    return {**info, "default_term": default_target(info), "prior_term": prior,
            "recommended_train_terms": recommended_train_terms(target, info["past"]) if target else []}


class NewTerm(BaseModel):
    season: str = Field(pattern="^(Fall|Spring|Summer|Winter)$")
    year: int = Field(ge=2000, le=2099)


@router.post("/{project_id}/terms")
async def add_term(body: NewTerm, p: Project = Depends(project_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """Add a term that isn't in the data yet (e.g. next Fall), in the data's own code style, and select it."""
    who.require("analyst")
    p.updated_by = who.user.id
    _, df = await _frame(session, p)
    custom = p.setup.get("custom_terms", [])
    info = await run_in_threadpool(term_info, df, p.mapping, custom)
    term = make_term(body.season, body.year, [e["code"] for e in info["terms"]])
    if term in {e["code"] for e in info["terms"]}:
        raise HTTPException(409, "That term is already in the list. Pick it above instead.")
    p.setup = {**p.setup, "custom_terms": [*custom, term], "term": term, "train_terms": recommended_train_terms(term, info["past"])}
    _touch(p)
    await session.commit()
    return await full(session, p)


@router.get("/{project_id}/features")
async def features(p: Project = Depends(project_for), session: AsyncSession = Depends(get_session)):
    v, df = await _frame(session, p)
    profiles = await _profiles(v, df, p.mapping, p.setup.get("term"))
    picks = recommend(profiles)
    unusable = {x["name"] for x in profiles if x["excluded"]}
    changed = _adopt(p, picks)
    if any(c in unusable for c in p.features.get("selected") or []):
        p.features = {**p.features, "selected": [c for c in p.features["selected"] if c not in unusable]}
        changed = True
    if changed:
        _touch(p)
        await session.commit()
    return {"profiles": profiles, "recommended": picks}


def _adopt(p: Project, picks: list[str]) -> bool:
    """Start from the current recommendation. An untouched older recommendation is replaced; the user's own choice never is."""
    f = p.features
    if f.get("rec") == REC_VERSION and f.get("ai"):
        return False
    untouched = f.get("selected") is None or f.get("selected") == f.get("ai")
    p.features = {**f, "ai": picks, "rec": REC_VERSION, **({"selected": picks} if untouched else {})}
    return True


# --------------------------------------------------------------------------------------------- forecasts


async def spec_of(session: AsyncSession, p: Project) -> engine.Spec:
    """The spec a Run uses: the prediction's own model settings on top of its workspace's default settings."""
    inst = await session.get(Institution, p.institution_id)
    return _spec(p, (inst.model_defaults or {}) if inst else {})


def _spec(p: Project, defaults: dict | None = None) -> engine.Spec:
    m, s = p.mapping, p.setup
    return engine.Spec(
        term=m.get("term", ""), outcome=m.get("outcome", ""), target_term=s.get("term", ""), student_id=m.get("studentId"),
        admit_status=m.get("admitStatus"), student_type=m.get("studentType"), group=s.get("group") if m.get("studentType") else None,
        college=m.get("college"), major=m.get("major"), train_terms=s.get("train_terms", []), features=p.features.get("selected", []),
        dims=[m[k] for k in ("residency", "housing") if m.get(k)], params={**(defaults or {}), **(p.model_params or {})},
    )


async def ensure_setup(session: AsyncSession, p: Project, v: DatasetVersion, df: pd.DataFrame) -> None:
    """Fill any step the user skipped with the recommended choice, so nothing blocks."""
    m = p.mapping
    if not m.get("term") or not m.get("outcome"):
        raise HTTPException(422, "Match the term and enrollment outcome columns in Detected Fields first.")
    info = await _terms(v, df, p)
    setup = dict(p.setup)
    setup.setdefault("term", default_target(info))
    if not setup.get("term"):
        raise HTTPException(422, "No terms found in this data.")
    if m.get("studentType") and setup.get("group") not in ("FTF", "TRN"):
        setup["group"] = "FTF"
    if not setup.get("train_terms"):
        setup["train_terms"] = recommended_train_terms(setup["term"], info["past"])
    p.setup = setup
    profiles = await _profiles(v, df, m, setup["term"])
    if p.features.get("rec") != REC_VERSION or p.features.get("selected") is None:  # never chosen, or an older recommendation
        _adopt(p, recommend(profiles))
    unusable = {x["name"] for x in profiles if x["excluded"]}  # e.g. too detailed: the model can't use them anyway
    if any(c in unusable for c in p.features["selected"]):
        p.features = {**p.features, "selected": [c for c in p.features["selected"] if c not in unusable]}
    if not p.features["selected"]:  # chosen, but everything removed: say so instead of quietly using everything
        raise HTTPException(422, "Include at least one piece of information in Features before running the forecast.")


async def guard_rows(session: AsyncSession, institution_id: str, rows: int) -> None:
    """Data larger than the plan allows can't be run (a plan downgraded, or older data reused): trim it on the Data page first."""
    limit = await plans.rows_limit(session, institution_id)
    if limit is not None and rows > limit:
        raise HTTPException(402, f"This data has {rows:,} rows and your plan allows {limit:,} per dataset. Keep {limit:,} of them on the Data "
                                 "page (Data Sources), or an owner can upgrade in Billing.")


async def _forecast(session: AsyncSession, p: Project, who: Principal, progress=None) -> dict:
    v, df = await _frame(session, p)
    await guard_rows(session, who.institution.id, len(df))
    await ensure_setup(session, p, v, df)
    s = p.setup
    spec = await spec_of(session, p)
    spec_hash = spec.hash(v.checksum)
    await plans.check_run(session, who.institution.id, who.user.id, runs.active(who.institution.id))
    began = time.monotonic()
    try:  # every Run trains the model again from scratch, even with the same settings
        out = await runs.wait(runs.start(who.institution.id, p.id, v.data_key, v.idmap_key, spec), progress)
    except runs.Cancelled:
        await _log_run(who, p.id, None, "cancelled", began)
        raise
    except ValueError as e:
        await _log_run(who, p.id, None, "failed", began, str(e))
        raise HTTPException(422, str(e))
    except Exception as e:
        await _log_run(who, p.id, None, "failed", began, type(e).__name__)
        raise
    summary = out["summary"]
    f = Forecast(institution_id=who.institution.id, project_id=p.id, dataset_version_id=v.id, spec=spec.__dict__, spec_hash=spec_hash,
                 summary=json.loads(json.dumps(summary, default=float)), model_key=out["model_key"], predictions_key=out["predictions_key"],
                 created_by=who.user.id)
    session.add(f)
    await session.flush()
    await audit(session, who, "forecast.created", f.id, expected=summary["expected"], term=s["term"], recipe=engine.RECIPE_VERSION)
    p.forecast_id, p.stale, p.results_seen, p.updated_by = f.id, False, False, who.user.id
    if p.created_by != who.user.id:  # a colleague ran the study: tell the person who made it
        owner = await session.get(User, p.created_by)
        if owner is not None:
            session.add(Notification(institution_id=who.institution.id, recipient_email=owner.email, kind="run",
                                     title=f"{who.user.name or who.user.email} ran a new forecast on {p.name}",
                                     body=f"{assistant.term_name(s['term'])}: {summary['expected']:,.0f} expected to enroll", link="/reports/history"))
    compute = summary.get("compute") or {}
    session.add(RunLog(institution_id=who.institution.id, user_id=who.user.id, project_id=p.id, forecast_id=f.id, outcome="done",
                       seconds=round(time.monotonic() - began, 1), vcpu=settings().run_vcpu, memory_gib=settings().run_memory_gib,
                       cpu_seconds=compute.get("cpu_seconds"), peak_memory_mb=compute.get("peak_memory_mb")))
    await session.commit()
    return await full(session, p)


async def _log_run(who: Principal, project_id: str, forecast_id: str | None, outcome: str, began: float, error: str | None = None) -> None:
    """A Run that didn't finish is still recorded (it never counts against a plan); its own session, as the run's may be failing."""
    async with Session() as s:
        s.add(RunLog(institution_id=who.institution.id, user_id=who.user.id, project_id=project_id, forecast_id=forecast_id,
                     outcome=outcome, seconds=round(time.monotonic() - began, 1), vcpu=settings().run_vcpu, memory_gib=settings().run_memory_gib,
                     error=error[:300] if error else None))
        await s.commit()


@router.post("/{project_id}/forecasts")
async def run_forecast(p: Project = Depends(project_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    who.require("analyst")
    return await _forecast(session, p, who)


@router.post("/{project_id}/forecasts/stream")
async def run_forecast_stream(p: Project = Depends(project_for), who: Principal = Depends(current)):
    """The same run with real progress (NDJSON): finished trees during training, then each later step."""
    who.require("analyst")
    project_id = p.id

    async def work(prog: Progress):
        async with Session() as session:
            return await _forecast(session, await session.get(Project, project_id), who, prog)

    return stream(work)


@router.post("/{project_id}/forecasts/cancel")
async def cancel_forecast(p: Project = Depends(project_for), who: Principal = Depends(current)):
    """Stop the run in progress for this prediction (the Cancel button)."""
    who.require("analyst")
    return {"stopped": runs.cancel(p.id)}


@router.get("/{project_id}/forecasts")
async def history(p: Project = Depends(project_for), session: AsyncSession = Depends(get_session)):
    q = select(Forecast).where(Forecast.project_id == p.id)
    cutoff = await plans.history_cutoff(session, p.institution_id)
    if cutoff:
        q = q.where(Forecast.created_at >= cutoff)
    rows = (await session.scalars(q.order_by(Forecast.created_at.desc()).limit(50))).all()
    shares = dict((await session.execute(
        select(Share.forecast_id, func.count()).where(Share.forecast_id.in_([f.id for f in rows])).group_by(Share.forecast_id))).all()) if rows else {}
    v = await _version(session, p)
    people = await names(session, [f.created_by for f in rows])
    return [{
        "id": f.id, "created_at": f.created_at.isoformat(), "current": f.id == p.forecast_id, "is_production": f.is_production,
        "run_by": people.get(f.created_by), "run_by_id": f.created_by,
        "term": f.summary.get("target_term"), "group": GROUPS.get(f.summary.get("group") or "", "All admits"),
        "applications": f.summary.get("applications"), "admits": f.summary.get("admits"), "expected": f.summary.get("expected"),
        "yield": f.summary.get("yield"), "prior_yield": (f.summary.get("prior") or {}).get("yield"), "confidence": f.summary.get("confidence"),
        "train_terms": f.summary.get("train_terms"), "features": len(f.summary.get("features", [])),
        "feature_names": f.summary.get("features", []), "auc": (f.summary.get("backtest") or {}).get("auc"),
        "error_pct": (f.summary.get("backtest") or {}).get("error_pct"), "range": f.summary.get("range"),
        "dataset": v.source_filename if v else "", "shares": shares.get(f.id, 0),
    } for f in rows]


@router.post("/{project_id}/forecasts/{forecast_id}/open")
async def open_forecast(forecast_id: str, p: Project = Depends(project_for), who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    who.require("analyst")  # this changes the current forecast for everyone in the workspace
    f = await session.scalar(select(Forecast).where(Forecast.id == forecast_id, Forecast.project_id == p.id))
    if f is None:
        raise HTTPException(404, "Forecast not found.")
    p.forecast_id, p.stale = f.id, False
    await session.commit()
    return await full(session, p)


# --------------------------------------------------------------------------------------------- assistant


async def assistant_context(session: AsyncSession, p: Project) -> assistant.Context:
    v, df = await _frame(session, p)
    f = await session.get(Forecast, p.forecast_id) if p.forecast_id else None
    art = students = None
    if f is not None:
        art, students = await load_artifact(f.model_key), await load_frame(f.predictions_key)
    meta = {"filename": v.source_filename, "version": v.version, "profile": v.profile, "id_column": v.id_column,
            "audit": {"score": p.audit_score, "status": p.audit_status, "fixes_applied": p.fixes_applied}}
    return await run_in_threadpool(assistant.Context, df, p.mapping, p.setup, meta, f.summary if f else None, art, students)


class Ask(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    history: list[dict] = []


@router.post("/{project_id}/chat")
async def chat(body: Ask, p: Project = Depends(project_for), session: AsyncSession = Depends(get_session)):
    await plans.check_ai(session, p.institution_id)
    ctx = await assistant_context(session, p)
    return {"answer": await run_in_threadpool(assistant.answer, ctx, body.question, body.history)}
