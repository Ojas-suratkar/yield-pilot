"""Who may open what. An institution is one shared workspace: every member sees every study, dataset, run and report,
each tagged with who made it. Analysts and above work on any study; deleting something takes its creator or an admin.
Guests (people outside the institution who were sent a report) see only the reports shared with them."""

from fastapi import Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import Principal, current
from ..db import get_session
from ..models import Forecast, Project, Share, User


async def project_for(project_id: str, who: Principal = Depends(current), session: AsyncSession = Depends(get_session)) -> Project:
    p = await session.scalar(select(Project).where(Project.id == project_id, Project.institution_id == who.institution.id))
    if p is None or not who.member:
        raise HTTPException(404, "Project not found.")
    return p


async def shared_with(session: AsyncSession, who: Principal, forecast_id: str) -> bool:
    email = who.user.email.lower()
    rows = await session.scalars(select(Share.recipients).where(Share.forecast_id == forecast_id, Share.institution_id == who.institution.id))
    return any(email in [r.lower() for r in (recipients or [])] for recipients in rows)


async def forecast_for(forecast_id: str, who: Principal = Depends(current), session: AsyncSession = Depends(get_session)) -> Forecast:
    """Any forecast in the institution for a member; for a guest, only a report shared with them. `owned` means this person
    may change, share or delete it (its creator, or an admin)."""
    f = await session.scalar(select(Forecast).where(Forecast.id == forecast_id, Forecast.institution_id == who.institution.id))
    if f is None or not (who.member or await shared_with(session, who, f.id)):
        raise HTTPException(404, "Forecast not found.")
    f.owned = who.member and who.manages(f.created_by)
    return f


def owner_only(f: Forecast) -> None:
    if not getattr(f, "owned", False):
        raise HTTPException(403, "Only the person who ran this forecast, or an admin, can change or delete it.")


def manage_only(who: Principal, owner_id: str | None, what: str = "this") -> None:
    if not who.manages(owner_id):
        raise HTTPException(403, f"Only the person who created {what}, or an admin, can delete it.")


async def names(session: AsyncSession, ids) -> dict[str, str]:
    """Display names for user ids (name, else email), for the "by" tags on studies, runs and reports."""
    ids = [i for i in set(ids) if i]
    if not ids:
        return {}
    return {u: (n or e) for u, n, e in (await session.execute(select(User.id, User.name, User.email).where(User.id.in_(ids)))).all()}
