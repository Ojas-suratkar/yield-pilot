"""Reading and writing dataset versions and model artifacts in Cloud Storage."""

import os
import tempfile
from collections import OrderedDict

import joblib
import pandas as pd
from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..ingest import Ingested, to_parquet
from ..models import Dataset, DatasetVersion
from ..storage import storage
from . import plans

_frames: OrderedDict[str, pd.DataFrame] = OrderedDict()
_models: OrderedDict[str, dict] = OrderedDict()


def _cache(cache: OrderedDict, key: str, value, size: int):
    cache[key] = value
    cache.move_to_end(key)
    while len(cache) > size:
        cache.popitem(last=False)
    return value


def _read_parquet(key: str) -> pd.DataFrame:
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "f.parquet")
        storage().download(key, path)
        return pd.read_parquet(path)


def forget(*keys: str | None) -> None:
    """Drop deleted data from the in-memory caches."""
    for k in keys:
        _frames.pop(k, None)


async def load_frame(key: str) -> pd.DataFrame:
    if key in _frames:
        _frames.move_to_end(key)
        return _frames[key]
    return _cache(_frames, key, await run_in_threadpool(_read_parquet, key), 8)


async def load_artifact(key: str) -> dict:
    if key in _models:
        _models.move_to_end(key)
        return _models[key]

    def read():
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "m.joblib")
            storage().download(key, path)
            return joblib.load(path)

    try:
        art = await run_in_threadpool(read)
    except Exception:  # saved by an earlier engine whose libraries can't read it back
        raise HTTPException(409, "This forecast was made with an earlier version of the model. Run the prediction again to update it.")
    return _cache(_models, key, art, 16)


def write_artifact(key: str, art: dict) -> None:
    """Save a model (from a worker thread). It is cached first, so it can be used before the upload finishes."""
    _cache(_models, key, art, 16)
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "m.joblib")
        joblib.dump(art, path, compress=1)  # zlib level 1: a fraction of level 3's time, nearly the same size
        storage().write_file(key, path)


def write_frame(key: str, df: pd.DataFrame) -> None:
    _cache(_frames, key, df, 8)
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "f.parquet")
        to_parquet(df, path)
        storage().write_file(key, path)


async def save_artifact(key: str, art: dict) -> None:
    await run_in_threadpool(write_artifact, key, art)


async def save_frame(key: str, df: pd.DataFrame) -> None:
    await run_in_threadpool(write_frame, key, df)


async def latest_version(session: AsyncSession, dataset_id: str, institution_id: str, version: int | None = None) -> DatasetVersion | None:
    q = select(DatasetVersion).where(DatasetVersion.dataset_id == dataset_id, DatasetVersion.institution_id == institution_id)
    q = q.where(DatasetVersion.version == version) if version else q.order_by(DatasetVersion.version.desc())
    return await session.scalar(q.limit(1))


async def new_version(session: AsyncSession, ds: Dataset, user_id: str, filename: str, data: pd.DataFrame, *, idmap_key: str | None,
                      id_column: str | None, checksum: str, dropped: list, profile: list, warnings: list, parent: int | None = None,
                      note: str | None = None) -> DatasetVersion:
    await plans.check_data(session, ds.institution_id, len(data))
    ds.latest_version += 1
    key = f"{ds.institution_id}/datasets/{ds.id}/v{ds.latest_version}/data.parquet"
    await save_frame(key, data)
    v = DatasetVersion(dataset_id=ds.id, institution_id=ds.institution_id, version=ds.latest_version, source_filename=filename,
                       data_key=key, idmap_key=idmap_key, id_column=id_column, rows=len(data), columns=list(data.columns),
                       dropped=dropped, profile=profile, warnings=warnings, checksum=checksum, created_by=user_id,
                       parent_version=parent, note=note)
    session.add(v)
    return v


async def save_ingested(session: AsyncSession, ds: Dataset, user_id: str, filename: str, result: Ingested, checksum: str) -> DatasetVersion:
    idmap_key = None
    if result.idmap is not None:
        idmap_key = f"{ds.institution_id}/datasets/{ds.id}/v{ds.latest_version + 1}/restricted/idmap.parquet"
        await save_frame(idmap_key, result.idmap)
    return await new_version(session, ds, user_id, filename, result.data, idmap_key=idmap_key, id_column=result.id_column,
                             checksum=checksum, dropped=result.dropped, profile=result.profile, warnings=result.warnings, note="upload")


async def reidentify(version: DatasetVersion, tokens: pd.Series) -> pd.Series:
    """Map pseudonymous tokens back to real student IDs (only for roles allowed to see them)."""
    if not version.idmap_key:
        return tokens
    idmap = await load_frame(version.idmap_key)
    lookup = dict(zip(idmap["token"], idmap["value"]))
    return tokens.map(lambda t: lookup.get(t, t))
