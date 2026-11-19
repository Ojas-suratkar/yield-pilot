"""Remove what earlier deletes left behind in production: files of deleted datasets, uploads and forecasts, and records
that point at deleted data. Shows what it would remove; --apply removes it. --originals also removes the original upload
files of data still in use (their protected copies stay; new uploads no longer keep the original).

    cd backend && .venv/bin/python scripts/cleanup_orphans.py [--apply] [--originals]
"""

import asyncio
import json
import sys
from datetime import datetime, timedelta, timezone

from dotenv import dotenv_values
from google.cloud import storage
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

APPLY = "--apply" in sys.argv
ORIGINALS = "--originals" in sys.argv
env = dotenv_values(".env")
NOW = datetime.now(timezone.utc)


def as_dict(v):
    return json.loads(v) if isinstance(v, str) else (v or {})


async def main() -> None:
    bucket = storage.Client(project=env["GCP_PROJECT"]).bucket(env["GCS_BUCKET"])
    engine = create_async_engine(env["DATABASE_URL"])
    async with engine.begin() as c:
        datasets = set((await c.execute(text("select id from datasets"))).scalars())
        uploads = {r.id: r for r in (await c.execute(text("select id, dataset_id, status, created_at from uploads"))).all()}
        run_dirs = {k.rsplit("/", 1)[0] + "/" for k in (await c.execute(text("select model_key from forecasts where model_key is not null"))).scalars()}

        files: dict[str, list] = {"uploads of deleted or unfinished data": [], "deleted datasets": [], "forecasts that no longer exist": []}
        originals = []
        for b in bucket.client.list_blobs(bucket):
            parts = b.name.split("/")
            if len(parts) < 3:
                continue
            kind = parts[1]
            if kind == "uploads":
                up = uploads.get(parts[2])
                if up is None or (up.dataset_id and up.dataset_id not in datasets) or (up.status != "processed" and NOW - up.created_at > timedelta(hours=6)):
                    files["uploads of deleted or unfinished data"].append(b)
                elif up.status == "processed":
                    originals.append(b)
            elif kind == "datasets" and parts[2] not in datasets:
                files["deleted datasets"].append(b)
            elif kind == "runs" and "/".join(parts[:3]) + "/" not in run_dirs and NOW - b.time_created > timedelta(days=1):
                files["forecasts that no longer exist"].append(b)

        stale_uploads = [u for u, r in uploads.items() if (r.dataset_id and r.dataset_id not in datasets)
                         or (r.status != "processed" and NOW - r.created_at > timedelta(hours=6))]
        events = [r.id for r in (await c.execute(text("select id, action, target, meta from audit_events"))).all()
                  if (r.action.startswith("dataset.") and (r.target or "").split("/")[0] not in datasets)
                  or (as_dict(r.meta).get("dataset") and as_dict(r.meta)["dataset"] not in datasets)]
        connections = []
        for r in (await c.execute(text("select id, config from connections"))).all():
            cfg = as_dict(r.config)
            imports = cfg.get("imports") or {}
            kept = {k: v for k, v in imports.items() if v.get("dataset_id") in datasets}
            if len(kept) != len(imports):
                connections.append((r.id, {**cfg, "imports": kept}, len(imports) - len(kept)))

        for label, blobs in files.items():
            print(f"{label}: {len(blobs)} files, {sum(b.size or 0 for b in blobs) / 1048576:.1f} MB")
        print(f"original files of data still in use: {len(originals)} files, {sum(b.size or 0 for b in originals) / 1048576:.1f} MB"
              + ("" if ORIGINALS else " (kept; --originals removes them)"))
        if ORIGINALS:
            files["original files of data still in use"] = originals
        print(f"upload records for deleted or unfinished uploads: {len(stale_uploads)}")
        print(f"activity entries about deleted datasets: {len(events)}")
        print(f"remembered imports of deleted datasets: {sum(n for *_, n in connections)} (in {len(connections)} connections)")

        if not APPLY:
            print("\nNothing removed. Run again with --apply to remove all of the above.")
            return
        for blobs in files.values():
            for b in blobs:
                b.delete()
        if stale_uploads:
            await c.execute(text("delete from uploads where id = any(:ids)"), {"ids": stale_uploads})
        if events:
            await c.execute(text("delete from audit_events where id = any(:ids)"), {"ids": events})
        for cid, cfg, _ in connections:
            await c.execute(text("update connections set config = cast(:cfg as json) where id = :id"), {"cfg": json.dumps(cfg), "id": cid})
        print("\nRemoved.")
    await engine.dispose()


asyncio.run(main())
