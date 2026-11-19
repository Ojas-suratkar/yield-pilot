import asyncio
import os
import tempfile
import time
from datetime import datetime, timedelta, timezone

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import Principal, audit, current
from ..config import settings
from ..db import Session, get_session
from ..ingest import SUPPORTED, checksum, ingest_frame, read_any, safe_filename, sniff_kind
from ..models import Dataset, DatasetVersion, Project, Upload
from ..services import usage
from ..services.fields import ai_map
from ..services.progress import Progress, respond
from ..services.store import save_ingested
from ..services import plans, trim
from ..services.trim import Keep
from .deps import names
from .projects import attach, full
from ..storage import storage

router = APIRouter(prefix="/datasets", tags=["datasets"])


class StartUpload(BaseModel):
    filename: str = Field(max_length=300)
    size: int = Field(gt=0)
    content_type: str = "application/octet-stream"
    dataset_id: str | None = None


def _version_out(v: DatasetVersion) -> dict:
    return {
        "dataset_id": v.dataset_id,
        "version": v.version,
        "rows": v.rows,
        "columns": v.columns,
        "dropped": v.dropped,
        "profile": v.profile,
        "warnings": v.warnings,
        "filename": v.source_filename,
        "created_at": v.created_at.isoformat(),
    }


@router.post("/uploads")
async def start_upload(body: StartUpload, who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    who.require("data_manager")
    await _sweep(session, who.institution.id)
    ext = body.filename.rsplit(".", 1)[-1].lower() if "." in body.filename else ""
    if ext not in SUPPORTED:
        raise HTTPException(415, "Use a CSV, TSV, Excel or Parquet file.")
    if body.size > settings().max_upload_mb * 1024 * 1024:
        raise HTTPException(413, f"Files up to {settings().max_upload_mb} MB are supported.")
    if body.dataset_id and not await session.scalar(
        select(Dataset).where(Dataset.id == body.dataset_id, Dataset.institution_id == who.institution.id)
    ):
        raise HTTPException(404, "Dataset not found.")
    up = Upload(institution_id=who.institution.id, user_id=who.user.id, dataset_id=body.dataset_id, filename=body.filename, object_key="", size=body.size)
    session.add(up)
    await session.flush()
    up.object_key = f"{who.institution.id}/uploads/{up.id}/{safe_filename(body.filename)}"
    url, headers = storage().upload_url(up.object_key, body.content_type, up.id)
    await session.commit()
    return {"upload_id": up.id, "upload_url": url, "headers": headers}


async def _sweep(session: AsyncSession, institution_id: str) -> None:
    """Uploads that never finished (Cancel, a closed tab, a file that couldn't be read): their files and records go."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=6)
    for up in (await session.scalars(select(Upload).where(Upload.institution_id == institution_id, Upload.status != "processed",
                                                          Upload.created_at < cutoff))).all():
        await run_in_threadpool(storage().delete_prefix, f"{institution_id}/uploads/{up.id}/")
        await session.delete(up)


@router.put("/uploads/{upload_id}/content")
async def put_content(upload_id: str, request: Request, who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """The file through the API, into Cloud Storage: when the API can't sign a direct upload link (on a laptop)."""
    store = storage()
    up = await session.scalar(select(Upload).where(Upload.id == upload_id, Upload.institution_id == who.institution.id, Upload.user_id == who.user.id, Upload.status == "pending"))
    if up is None:
        raise HTTPException(404, "Upload not found.")
    limit, written = settings().max_upload_mb * 1024 * 1024, 0
    with store.open_write(up.object_key) as f:
        async for chunk in request.stream():
            written += len(chunk)
            if written > limit:
                raise HTTPException(413, "File too large.")
            f.write(chunk)
    return {"ok": True}


class Complete(BaseModel):
    project_id: str | None = None
    trim: Keep | Literal["recent", "first", "sample"] | None = None  # over the plan's rows: which rows to keep (never more than the plan allows)


@router.post("/uploads/{upload_id}/complete")
async def complete_upload(request: Request, upload_id: str, body: Complete | None = None, who: Principal = Depends(current)):
    who.require("data_manager")
    project_id, cut_mode = (body.project_id, body.trim) if body else (None, None)

    async def work(prog: Progress):
        async with Session() as session:
            return await _complete(session, upload_id, project_id, who, prog, cut_mode)

    return await respond(request, work)


async def _complete(session: AsyncSession, upload_id: str, project_id: str | None, who: Principal, prog: Progress, cut_mode: str | None = None) -> dict:
    up = await session.scalar(select(Upload).where(Upload.id == upload_id, Upload.institution_id == who.institution.id, Upload.user_id == who.user.id, Upload.status == "pending"))
    if up is None:
        raise HTTPException(404, "Upload not found.")
    began = time.monotonic()
    store = storage()
    if not store.exists(up.object_key):
        raise HTTPException(409, "The file hasn't finished uploading.")
    limit = await plans.rows_limit(session, who.institution.id)
    term = (await session.scalar(select(Project.mapping).where(Project.id == project_id, Project.institution_id == who.institution.id)) or {}).get("term") if project_id else None
    keep_file, kept = False, None
    # the original file, with real student IDs, is only kept while it is read: the protected copy replaces it
    try:
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "source")
            prog(5, "Receiving your file")
            await run_in_threadpool(store.download, up.object_key, src)
            prog(15, "Removing personal information and cleaning")
            try:
                raw = await run_in_threadpool(read_any, src, sniff_kind(src, up.filename))
                if limit is not None and len(raw) > limit:
                    if not cut_mode:  # keep the uploaded file so they can choose which rows to keep without uploading it again
                        keep_file = True
                        raise trim.over(raw, limit, up.id, term)
                    raw, kept = await run_in_threadpool(trim.cut, raw, limit, cut_mode, term)
                result = await run_in_threadpool(ingest_frame, raw, f"{settings().pseudonym_key}:{who.institution.id}")
            except ValueError as e:
                up.status = "failed"
                await session.commit()
                raise HTTPException(422, str(e))
            prog(55, "Saving a protected copy while the AI matches your columns", f"{len(result.data):,} rows")
            # the AI matches columns while the protected copy is saved
            matching = asyncio.create_task(run_in_threadpool(
                ai_map, result.data, result.id_column, lambda k, n: prog(60 + 36 * k / n, "AI is matching your columns", f"{k} of {n} fields matched"))) if project_id else None
            digest = await run_in_threadpool(checksum, src)
    finally:
        if not keep_file:
            await run_in_threadpool(store.delete_prefix, f"{who.institution.id}/uploads/{up.id}/")

    ds = await session.scalar(select(Dataset).where(Dataset.id == up.dataset_id, Dataset.institution_id == who.institution.id)) if up.dataset_id else None
    if ds is None:
        ds = Dataset(institution_id=who.institution.id, name=up.filename, created_by=who.user.id, latest_version=0)
        session.add(ds)
        await session.flush()
    version = await save_ingested(session, ds, who.user.id, up.filename, result, digest)
    if kept:
        version.note = f"Kept {kept} to fit the plan"
    up.status, up.dataset_id = "processed", ds.id
    await audit(session, who, "dataset.version.created", f"{ds.id}/v{version.version}", rows=len(result.data), dropped=[d["column"] for d in result.dropped])
    await session.flush()
    out = _version_out(version)
    if project_id:
        p = await session.scalar(select(Project).where(Project.id == project_id, Project.institution_id == who.institution.id))
        if p is None:
            raise HTTPException(404, "Project not found.")
        m, used, fit = await matching
        p.updated_by = who.user.id
        await attach(session, p, version, result.data, {"connector": "csv", "label": up.filename, "detail": f"{up.size / 1048576:.1f} MB"},
                     None, {"mapping": m, "used_ai": used, "fit": fit})
        prog(97, "Opening your data")
        await session.commit()
        out["project"] = await full(session, p)
    else:
        await session.commit()
    usage.record("import", "file_upload", seconds=round(time.monotonic() - began, 1), rows=len(result.data))
    return out


@router.get("")
async def list_datasets(who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """Every dataset the institution has imported, newest first, with who imported it and its latest version's size (for reuse)."""
    if not who.member:
        return []
    rows = (await session.scalars(select(Dataset).where(Dataset.institution_id == who.institution.id).order_by(Dataset.created_at.desc()))).all()
    people = await names(session, [d.created_by for d in rows])
    latest = {v.dataset_id: v for v in (await session.scalars(select(DatasetVersion).where(DatasetVersion.dataset_id.in_([d.id for d in rows])))).all()
              if v.version == next((d.latest_version for d in rows if d.id == v.dataset_id), None)} if rows else {}
    return [{"id": d.id, "name": d.name, "latest_version": d.latest_version, "created_at": d.created_at.isoformat(),
             "by": people.get(d.created_by), "mine": d.created_by == who.user.id,
             "rows": latest[d.id].rows if d.id in latest else None, "columns": len(latest[d.id].columns) if d.id in latest else None}
            for d in rows if d.id in latest]


@router.get("/{dataset_id}/versions")
async def list_versions(dataset_id: str, who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    rows = await session.scalars(
        select(DatasetVersion).join(Dataset, Dataset.id == DatasetVersion.dataset_id)
        .where(DatasetVersion.dataset_id == dataset_id, DatasetVersion.institution_id == who.institution.id)
        .order_by(DatasetVersion.version.desc())
    )
    return [_version_out(v) for v in rows]
