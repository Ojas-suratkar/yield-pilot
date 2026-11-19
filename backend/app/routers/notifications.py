from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import Principal, signed_in
from ..db import get_session
from ..models import Notification

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("")
async def list_notifications(who: Principal = Depends(signed_in), session: AsyncSession = Depends(get_session)):
    rows = await session.scalars(select(Notification).where(Notification.recipient_email == who.user.email).order_by(Notification.created_at.desc()).limit(30))
    return [{"id": n.id, "kind": n.kind, "title": n.title, "body": n.body, "link": n.link, "read": n.read, "created_at": n.created_at.isoformat()} for n in rows]


class ReadIn(BaseModel):
    ids: list[str] = []


@router.post("/read")
async def mark_read(body: ReadIn, who: Principal = Depends(signed_in), session: AsyncSession = Depends(get_session)):
    q = update(Notification).where(Notification.recipient_email == who.user.email)
    if body.ids:
        q = q.where(Notification.id.in_(body.ids))
    await session.execute(q.values(read=True))
    await session.commit()
    return {"ok": True}
