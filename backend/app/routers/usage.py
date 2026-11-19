"""Usage and costs by role: the owner sees the whole workspace, everyone else only their own activity."""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import Principal, current
from ..db import get_session
from ..services import costs

router = APIRouter(prefix="/usage", tags=["usage"])
Scope = Literal["institution", "me"]


def _whose(who: Principal, scope: Scope) -> dict:
    if not who.member:  # guests see only the reports shared with them
        raise HTTPException(403, "You don't have permission to do this.")
    if scope == "institution" and who.user.role != "owner":
        raise HTTPException(403, "Only the workspace owner can see everyone's usage and costs.")
    return {"institution_id": who.institution.id, "user_id": who.user.id if scope == "me" else None}


@router.get("")
async def overview(days: int = Query(30, ge=1, le=730), scope: Scope = "me", who: Principal = Depends(current),
                   session: AsyncSession = Depends(get_session)):
    r = await costs.report(session, days, **_whose(who, scope))
    await session.commit()
    return r


@router.get("/runs")
async def runs(days: int = Query(30, ge=1, le=730), scope: Scope = "me", who: Principal = Depends(current),
               session: AsyncSession = Depends(get_session)):
    return await costs.run_rows(session, days, **_whose(who, scope))


@router.get("/events")
async def events(days: int = Query(30, ge=1, le=730), scope: Scope = "me", who: Principal = Depends(current),
                 session: AsyncSession = Depends(get_session)):
    return await costs.event_rows(session, days, **_whose(who, scope))
