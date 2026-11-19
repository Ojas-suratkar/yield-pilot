"""Fill in the profile (logo, website, location, description) of institutions created before profiles existed, from their
email domain's website. A name that is only an abbreviation of the domain ("csulb", "VT") becomes the official name; any
other name is kept. Personal workspaces are skipped. Shows the changes; --apply saves them.

    cd backend && .venv/bin/python scripts/backfill_profiles.py [--apply]
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import select  # noqa: E402

from app.db import Session, engine  # noqa: E402
from app.models import Institution  # noqa: E402
from app.services import orginfo  # noqa: E402

APPLY = "--apply" in sys.argv


async def main() -> None:
    async with Session() as s:
        for inst in (await s.scalars(select(Institution).order_by(Institution.created_at))).all():
            if not inst.domain or "@" in inst.domain or (inst.logo and inst.website):
                continue
            info = await asyncio.to_thread(orginfo.lookup, inst.domain)
            if not info.get("found"):
                print(f"{inst.name}: nothing found at {inst.domain}")
                continue
            stem = inst.domain.split(".")[0]
            rename = " " not in inst.name.strip() and inst.name.strip().lower() == stem and info.get("name")
            print(f"{inst.name} -> {info['name'] if rename else inst.name} | website {info.get('website')} | logo {bool(info.get('logo'))} | "
                  f"{info.get('region') or ''} {info.get('country') or ''}".rstrip())
            if APPLY:
                if rename:
                    inst.name = info["name"]
                inst.website = inst.website or info.get("website")
                inst.logo = inst.logo or info.get("logo")
                for k in ("description", "kind", "country", "region"):
                    if not getattr(inst, k) and info.get(k):
                        setattr(inst, k, info[k])
        if APPLY:
            await s.commit()
            print("saved")
    await engine.dispose()


asyncio.run(main())
