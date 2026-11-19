"""Connections to source systems. Credentials are encrypted at rest and never returned to the browser."""

import asyncio
import hashlib
import logging
import threading
import time
from datetime import datetime, timezone

import pandas as pd
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import Principal, audit, current
from ..config import settings
from ..db import Session, get_session
from ..ingest import ingest_frame
from ..models import Connection, Dataset, Project
from ..services import connectors, usage
from ..services import plans, trim
from ..services.trim import Keep
from ..services.fields import ai_map
from ..services.progress import Progress, respond
from ..services.store import latest_version, load_frame, save_ingested
from .deps import manage_only, names
from .projects import attach, full

router = APIRouter(tags=["connections"])
log = logging.getLogger("yieldpilot.connections")


@router.get("/connectors")
async def catalog():
    return connectors.CATALOG


def _out(c: Connection) -> dict:
    spec = connectors.BY_KIND.get(c.kind, {})
    where = c.config.get("host") or c.config.get("account") or c.config.get("project") or c.config.get("url", "")[:60] or c.config.get("user")
    return {"id": c.id, "name": c.name, "kind": c.kind, "source": spec.get("source"), "where": where,
            "last_used_at": c.last_used_at.isoformat() if c.last_used_at else None}


@router.get("/connections")
async def list_connections(who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """The institution's saved connections, usable by every data manager; secrets are never sent back to anyone."""
    who.require("data_manager")
    rows = list(await session.scalars(select(Connection).where(Connection.institution_id == who.institution.id)
                                      .order_by(Connection.created_at.desc())))
    people = await names(session, [c.created_by for c in rows])
    return [{**_out(c), "by": people.get(c.created_by), "manage": who.manages(c.created_by)} for c in rows]


class ConnectionIn(BaseModel):
    kind: str
    name: str = Field(min_length=1, max_length=200)
    values: dict[str, str]


@router.post("/connections")
async def create(body: ConnectionIn, who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    who.require("data_manager")
    try:
        config, secrets = connectors.split(body.kind, body.values)
        learned = await run_in_threadpool(connectors.test, body.kind, config, secrets)
    except ValueError as e:
        raise HTTPException(422, f"Couldn't connect. {e}")
    state = learned.pop("warehouse_state", None)  # a fact about right now, not a setting to keep
    config.update(learned)
    c = Connection(institution_id=who.institution.id, kind=body.kind, name=body.name, config=config, secret=connectors.encrypt(secrets), created_by=who.user.id)
    session.add(c)
    await session.flush()
    await audit(session, who, "connection.created", c.id, kind=body.kind)
    await session.commit()
    return {**_out(c), "warehouse_state": state}


@router.delete("/connections/{connection_id}")
async def remove(connection_id: str, who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    who.require("data_manager")
    c = await _conn(session, who, connection_id)
    manage_only(who, c.created_by, "this connection")
    await session.delete(c)
    await audit(session, who, "connection.deleted", connection_id)
    await session.commit()
    return {"ok": True}


async def _conn(session: AsyncSession, who: Principal, connection_id: str) -> Connection:
    who.require("data_manager")
    c = await session.scalar(select(Connection).where(Connection.id == connection_id, Connection.institution_id == who.institution.id))
    if c is None:
        raise HTTPException(404, "Connection not found.")
    return c


@router.get("/connections/{connection_id}/tables")
async def list_tables(connection_id: str, who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """The tables to pick from. Opening this list also wakes the source (a Databricks SQL warehouse) in the background,
    so it is ready by the time someone picks a table and presses Import."""
    c = await _conn(session, who, connection_id)
    secrets = connectors.decrypt(c.secret)
    threading.Thread(target=_warm, args=(c.kind, dict(c.config), secrets), daemon=True).start()
    try:
        return await run_in_threadpool(connectors.tables, c.kind, c.config, secrets)
    except ValueError as e:
        log.warning("list tables failed for %s: %s", c.kind, e)
        raise HTTPException(422, str(e))


class SourceIn(BaseModel):
    table: str | None = Field(None, max_length=300)
    query: str | None = Field(None, max_length=20000)
    path: str | None = Field(None, max_length=1000)


def _warm(kind: str, config: dict, secrets: dict) -> None:
    try:
        connectors.warm(kind, config, secrets)
    except Exception as e:  # only a head start; the import itself starts whatever it needs
        log.info("couldn't wake %s ahead of time: %s", kind, e)


@router.post("/connections/{connection_id}/preview")
async def preview(request: Request, connection_id: str, body: SourceIn, who: Principal = Depends(current)):
    """The first rows, to check before importing (with progress while a cold source starts)."""
    who.require("data_manager")

    async def work(prog: Progress):
        async with Session() as session:
            c = await _conn(session, who, connection_id)
            config, secrets = dict(c.config), connectors.decrypt(c.secret)
        prog(10, "Reading the first rows")
        try:
            df = await run_in_threadpool(connectors.preview, c.kind, config, secrets, body.model_dump(exclude_none=True), 20,
                                         lambda text, detail="": prog(10, text, detail), lambda: prog.cancelled)
        except ValueError as e:
            log.warning("preview failed for %s: %s", c.kind, e)
            raise HTTPException(422, str(e))
        return {"columns": list(df.columns), "rows": df.astype(str).to_dict(orient="records")}

    return await respond(request, work)


class ImportIn(BaseModel):
    project_id: str
    table: str | None = Field(None, max_length=300)
    query: str | None = Field(None, max_length=20000)
    path: str | None = Field(None, max_length=1000)
    trim: Keep | Literal["recent", "first", "sample"] | None = None  # over the plan's rows: which rows to keep


@router.post("/connections/{connection_id}/import")
async def import_data(request: Request, connection_id: str, body: ImportIn, who: Principal = Depends(current)):
    """Copy the source into YieldPilot: cleaned, pseudonymized and stored as a new dataset version."""
    who.require("data_manager")

    async def work(prog: Progress):
        async with Session() as session:
            return await _import(session, connection_id, body, who, prog)

    return await respond(request, work)


def _check(prog: Progress) -> None:
    if prog.cancelled:
        raise HTTPException(409, "Import cancelled.")


async def _import(session: AsyncSession, connection_id: str, body: ImportIn, who: Principal, prog: Progress) -> dict:
    c = await session.scalar(select(Connection).where(Connection.id == connection_id, Connection.institution_id == who.institution.id))
    p = await session.scalar(select(Project).where(Project.id == body.project_id, Project.institution_id == who.institution.id))
    if c is None or p is None:
        raise HTTPException(404, "Not found.")
    began = time.monotonic()
    source = body.model_dump(exclude={"project_id", "trim"}, exclude_none=True)
    limit = await plans.rows_limit(session, who.institution.id)
    name = connectors.BY_KIND.get(c.kind, {}).get("name", c.name)
    secrets = connectors.decrypt(c.secret)
    label = body.table or body.path or f"{c.name} query"
    # the same table, unchanged since the last import: reuse that copy instead of pulling every row again
    prog(2, f"Checking {label} in {name}")
    version = await run_in_threadpool(connectors.table_version, c.kind, c.config, secrets, body.table)
    seen = (c.config.get("imports") or {}).get(body.table or body.query or body.path or "")
    if version and seen and seen.get("version") == version:
        ds = await session.scalar(select(Dataset).where(Dataset.id == seen["dataset_id"], Dataset.institution_id == who.institution.id))
        v = await latest_version(session, ds.id, who.institution.id) if ds else None
        if v is not None and (limit is None or v.rows <= limit):
            prog(60, "Unchanged since your last import: using that copy", f"{v.rows:,} rows")
            df = await load_frame(v.data_key)
            p.updated_by = who.user.id
            await attach(session, p, v, df, {"connector": c.kind, "label": label, "detail": c.name},
                         lambda k, n: prog(60 + 37 * k / n, "AI is matching your columns", f"{k} of {n} fields matched"), seen)
            c.last_used_at = datetime.now(timezone.utc)
            await audit(session, who, "connection.imported", c.id, source=label, rows=v.rows, reused=True, dataset=ds.id)
            _check(prog)
            await session.commit()
            usage.record("import", "table_import", seconds=round(time.monotonic() - began, 1), rows=v.rows)
            return await full(session, p)
    try:
        prog(5, f"Connecting to {name} and reading the data")
        df = await run_in_threadpool(connectors.fetch, c.kind, c.config, secrets, source,
                                     lambda n: prog(40, f"Reading rows from {name}", f"{n:,} rows so far"),
                                     lambda text, detail="": prog(5, text, detail), lambda: prog.cancelled)
        _check(prog)
        if limit is not None and len(df) > limit:
            if not body.trim:
                raise trim.over(df, limit, None, p.mapping.get("term"))
            df, _ = await run_in_threadpool(trim.cut, df, limit, body.trim, p.mapping.get("term"))
        prog(50, "Removing personal information and cleaning", f"{len(df):,} rows read")
        result = await run_in_threadpool(ingest_frame, df, f"{settings().pseudonym_key}:{who.institution.id}")
    except ValueError as e:
        log.warning("import failed for %s: %s", c.kind, e)
        raise HTTPException(422, str(e))
    _check(prog)  # nothing is saved once someone pressed Cancel
    prog(65, "Saving a protected copy while the AI matches your columns", f"{len(result.data):,} rows")
    # the AI matches columns while the protected copy is saved (unless this table's matching is already known)
    matching = None if seen else asyncio.create_task(run_in_threadpool(
        ai_map, result.data, result.id_column, lambda k, n: prog(65 + 32 * k / n, "AI is matching your columns", f"{k} of {n} fields matched")))
    ds = Dataset(institution_id=who.institution.id, name=f"{c.name}: {label}", created_by=who.user.id, latest_version=0)
    session.add(ds)
    await session.flush()
    digest = hashlib.sha256(pd.util.hash_pandas_object(result.data, index=False).values.tobytes()).hexdigest()
    v = await save_ingested(session, ds, who.user.id, label, result, digest)
    known = seen
    if matching is not None:
        m, used, fit = await matching
        known = {"mapping": m, "used_ai": used, "fit": fit}
    p.updated_by = who.user.id
    await attach(session, p, v, result.data, {"connector": c.kind, "label": label, "detail": c.name}, None, known)
    c.last_used_at = datetime.now(timezone.utc)
    # remembered per table or query: an unchanged table is reused next time, and the column matching is kept either way
    key = body.table or body.query or body.path or ""
    c.config = {**c.config, "imports": {**(c.config.get("imports") or {}), key: {
        "version": version, "dataset_id": ds.id, "mapping": p.mapping, "used_ai": bool(p.source.get("ai_mapped")), "fit": p.source.get("fit")}}}
    await audit(session, who, "connection.imported", c.id, source=label, rows=len(result.data), dataset=ds.id)
    _check(prog)  # cancelled while the columns were matched: nothing is kept
    await session.commit()
    usage.record("import", "table_import", seconds=round(time.monotonic() - began, 1), rows=len(result.data))
    return await full(session, p)
