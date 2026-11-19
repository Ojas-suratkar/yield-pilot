"""Start YieldPilot completely fresh: every row in every table (users, institutions, sessions, studies, data, forecasts,
reports, connections, subscriptions, payments, logs), every file in the bucket, the Vertex AI model entries and the Identity
Platform sign-in accounts. Kept: the database structure, its migration record, and the plan catalog (prices and limits).
Shows what it would remove; --apply removes it. Nothing can be brought back afterwards.

    cd backend && .venv/bin/python scripts/reset_everything.py [--apply]
"""

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import google.auth  # noqa: E402
import httpx  # noqa: E402
from google.auth.transport.requests import Request  # noqa: E402
from google.cloud import storage  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.config import settings  # noqa: E402
from app.db import engine  # noqa: E402
from app.services import registry  # noqa: E402

APPLY = "--apply" in sys.argv
KEEP = {"alembic_version", "plans"}


def identity_accounts(project: str) -> tuple[list[str], dict]:
    creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    creds.refresh(Request())
    headers = {"Authorization": f"Bearer {creds.token}", "x-goog-user-project": project}
    ids, token = [], None
    while True:
        r = httpx.get(f"https://identitytoolkit.googleapis.com/v1/projects/{project}/accounts:batchGet", headers=headers,
                      params={"maxResults": 1000, **({"nextPageToken": token} if token else {})}, timeout=30).json()
        ids += [u["localId"] for u in r.get("users", [])]
        token = r.get("nextPageToken")
        if not token:
            return ids, headers


async def main() -> None:
    s = settings()
    bucket = storage.Client(project=s.gcp_project).bucket(s.gcs_bucket)
    blobs = list(bucket.client.list_blobs(bucket))
    accounts, headers = identity_accounts(s.gcp_project)
    async with engine.begin() as c:
        tables = [t for t in (await c.execute(text("select tablename from pg_tables where schemaname='public' order by 1"))).scalars() if t not in KEEP]
        counts = {t: (await c.execute(text(f'select count(*) from "{t}"'))).scalar() for t in tables}
        entries = [json.loads(r) if isinstance(r, str) else r for r in (await c.execute(text("select registry from forecasts where registry is not null"))).scalars()]
        for t, n in counts.items():
            print(f"{t}: {n} rows")
        print(f"bucket files: {len(blobs)} ({sum(b.size or 0 for b in blobs) / 1048576:.1f} MB)")
        print(f"Vertex AI model entries: {len(entries)}")
        print(f"Identity Platform sign-in accounts: {len(accounts)}")
        print(f"kept: {', '.join(sorted(KEEP))}")
        if not APPLY:
            print("\nNothing removed. Run again with --apply to remove all of the above.")
            return
        for e in entries:
            try:
                registry.unregister(e)
            except Exception as err:
                print("Vertex AI entry not removed:", type(err).__name__)
        await c.execute(text("truncate table " + ", ".join(f'"{t}"' for t in tables) + " restart identity cascade"))
    for b in blobs:
        b.delete()
    for i in range(0, len(accounts), 1000):
        httpx.post(f"https://identitytoolkit.googleapis.com/v1/projects/{s.gcp_project}/accounts:batchDelete", headers=headers,
                   json={"localIds": accounts[i:i + 1000], "force": True}, timeout=30)
    await engine.dispose()
    print("\nEverything removed. YieldPilot starts fresh: the first person to sign in creates the first institution.")


asyncio.run(main())
