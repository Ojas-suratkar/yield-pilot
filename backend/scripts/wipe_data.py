"""Remove every piece of data from production and keep the accounts: imported data, studies, forecasts, reports and
shares, notifications, activity, every file in the bucket, and the Vertex AI model entries. Users, institutions,
invitations and saved connections stay (a connection forgets what it imported). Shows counts; --apply removes.

    cd backend && .venv/bin/python scripts/wipe_data.py [--apply]
"""

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from google.cloud import storage  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.config import settings  # noqa: E402
from app.db import engine  # noqa: E402
from app.services import registry  # noqa: E402

APPLY = "--apply" in sys.argv
TABLES = ["shares", "notifications", "audit_events", "forecasts", "projects", "uploads", "dataset_versions", "datasets"]


async def main() -> None:
    s = settings()
    bucket = storage.Client(project=s.gcp_project).bucket(s.gcs_bucket)
    blobs = list(bucket.client.list_blobs(bucket))
    async with engine.begin() as c:
        counts = {t: (await c.execute(text(f"select count(*) from {t}"))).scalar() for t in TABLES}
        entries = [json.loads(r) if isinstance(r, str) else r for r in (await c.execute(text("select registry from forecasts where registry is not null"))).scalars()]
        for t, n in counts.items():
            print(f"{t}: {n} rows")
        print(f"bucket files: {len(blobs)} ({sum(b.size or 0 for b in blobs) / 1048576:.1f} MB)")
        print(f"Vertex AI model entries: {len(entries)}")
        if not APPLY:
            print("\nNothing removed. Run again with --apply to remove all of the above.")
            return
        for e in entries:
            try:
                registry.unregister(e)
            except Exception as err:  # already gone, or registration never finished
                print("Vertex AI entry not removed:", type(err).__name__)
        for t in TABLES:
            await c.execute(text(f"delete from {t}"))
        for cid, cfg in (await c.execute(text("select id, config from connections"))).all():
            cfg = json.loads(cfg) if isinstance(cfg, str) else (cfg or {})
            if cfg.pop("imports", None) is not None:
                await c.execute(text("update connections set config = cast(:cfg as json) where id = :id"), {"cfg": json.dumps(cfg), "id": cid})
    for b in blobs:
        b.delete()
    print("\nRemoved.")


asyncio.run(main())
