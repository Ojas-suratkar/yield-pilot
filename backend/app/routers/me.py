from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import ROLES, Principal, audit, current, delete_account, end_sessions, signed_in
from ..db import get_session
from ..models import Institution, Invitation, Membership, Notification, User
from ..services import members as ms
from ..services import images, mailer, plans
from ..config import settings

router = APIRouter(tags=["account"])


async def _me(who: Principal, session: AsyncSession) -> dict:
    u, i = who.user, who.institution
    return {"workspaces": await ms.workspaces(session, u),"id": u.id, "email": u.email, "name": u.name, "title": u.title, "department": u.department, "photo": u.photo, "role": u.role,
            "operator": who.operator, "ml": who.ml,
            "institution": None if i is None else {"id": i.id, "name": i.name, "domain": i.domain, "personal": "@" in (i.domain or ""),
                                                   "logo": i.logo, "website": i.website}}


@router.get("/me")
async def me(who: Principal = Depends(signed_in), session: AsyncSession = Depends(get_session)):
    return await _me(who, session)


class WorkspaceIn(BaseModel):
    institution_id: str = Field(max_length=32)


@router.post("/me/workspace")
async def switch_workspace(body: WorkspaceIn, who: Principal = Depends(signed_in), session: AsyncSession = Depends(get_session)):
    """Work in another of your workspaces."""
    m = await ms.get(session, who.user.id, body.institution_id)
    inst = await session.get(Institution, body.institution_id)
    if m is None or not m.active or inst is None:
        raise HTTPException(404, "You're not a member of that workspace.")
    if inst.suspended and not who.operator:
        raise HTTPException(403, f"{inst.name} is suspended on YieldPilot.")
    ms.use(who.user, m)
    await session.commit()
    who.institution, who.ml_granted = inst, m.ml_access
    return await _me(who, session)


class MeIn(BaseModel):
    name: str | None = Field(None, max_length=200)
    title: str | None = Field(None, max_length=200)
    department: str | None = Field(None, max_length=200)


class PhotoIn(BaseModel):
    photo: str = Field(max_length=1_600_000)  # a data: URL from the browser


@router.put("/me/photo")
async def set_photo(body: PhotoIn, who: Principal = Depends(signed_in), session: AsyncSession = Depends(get_session)):
    """Your own profile photo: re-drawn on the server as a 256px square PNG. Signing in with Google or Microsoft doesn't replace it."""
    user = await session.get(User, who.user.id)
    user.photo, user.photo_custom = images.redraw(body.photo, 256, "photo", square=True), True
    await session.commit()
    who.user = user
    return await _me(who, session)


@router.delete("/me/photo")
async def remove_photo(who: Principal = Depends(signed_in), session: AsyncSession = Depends(get_session)):
    """Back to your initials; your Google or Microsoft picture returns the next time you sign in with it."""
    user = await session.get(User, who.user.id)
    user.photo, user.photo_custom = None, False
    await session.commit()
    who.user = user
    return await _me(who, session)


@router.patch("/me")
async def update_me(body: MeIn, who: Principal = Depends(signed_in), session: AsyncSession = Depends(get_session)):
    user = await session.get(User, who.user.id)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(user, k, (v or "").strip() or None)
    await session.commit()
    who.user = user
    return await _me(who, session)


@router.get("/members")
async def members(who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    rows = (await session.execute(ms.people(who.institution.id).order_by(Membership.created_at))).all()
    return [{"id": u.id, "email": u.email, "name": u.name, "title": u.title, "department": u.department, "photo": u.photo, "role": m.role,
             "active": m.active and u.active, "you": u.id == who.user.id, "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None}
            for u, m in rows]


class RoleIn(BaseModel):
    role: str | None = None
    active: bool | None = None


@router.patch("/members/{user_id}")
async def update_member(user_id: str, body: RoleIn, who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    who.require("admin")
    row = (await session.execute(ms.people(who.institution.id).where(User.id == user_id))).first()
    if row is None:
        raise HTTPException(404, "Member not found.")
    u, m = row
    if u.id == who.user.id:
        raise HTTPException(422, "You can't change your own role or access. Ask another owner.")
    if ROLES.index(m.role) > ROLES.index(who.user.role):
        raise HTTPException(403, "You can't change someone with a higher role than yours.")
    owners = await ms.owners(session, who.institution.id)
    if m.role == "owner" and owners <= 1 and (body.role not in (None, "owner") or body.active is False):
        raise HTTPException(422, "Every workspace needs at least one owner.")
    if body.role:
        if body.role not in ROLES or ROLES.index(body.role) > ROLES.index(who.user.role):
            raise HTTPException(403, "You can't assign that role.")
        m.role = body.role
        if u.institution_id == who.institution.id:
            u.role = body.role
    if body.active is not None:
        await ms.set_active(session, u, m, body.active)  # this workspace only: their other workspaces are untouched
    await audit(session, who, "member.updated", u.email, role=m.role, active=m.active)
    await session.commit()
    return {"id": u.id, "role": u.role, "active": u.active}


@router.delete("/members/{user_id}")
async def delete_member(user_id: str, who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """Delete someone's account. They're signed out at once and sign up again as a new person; the workspace keeps their shared work."""
    who.require("admin")
    row = (await session.execute(ms.people(who.institution.id).where(User.id == user_id))).first()
    if row is None:
        raise HTTPException(404, "Member not found.")
    u, m = row
    if u.id == who.user.id:
        raise HTTPException(422, "You can't delete your own account here. Ask another owner.")
    if ROLES.index(m.role) > ROLES.index(who.user.role):
        raise HTTPException(403, "You can't delete someone with a higher role than yours.")
    # in other workspaces too, or YieldPilot staff (whose account must stay): only this workspace is taken away. Their standing outside
    # this workspace is never shown or used here: the owner decides what they can do in it, like anyone else.
    if settings().is_operator(u.email) or await ms.fallback(session, u, exclude=who.institution.id) is not None:
        await ms.leave(session, u, who.institution.id)
        await audit(session, who, "member.removed", u.id)
        await session.commit()
        return {"ok": True, "account_deleted": False}
    await delete_account(session, u)  # the person deleting can't be them and outranks or matches them, so an owner always remains
    await audit(session, who, "member.deleted", u.id)
    await session.commit()
    return {"ok": True, "account_deleted": True}


class InviteIn(BaseModel):
    email: str = Field(max_length=320, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    role: str = "viewer"


@router.get("/invitations")
async def invitations(who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    who.require("admin")
    rows = await session.scalars(select(Invitation).where(Invitation.institution_id == who.institution.id, Invitation.accepted_at.is_(None)).order_by(Invitation.created_at.desc()))
    return [{"id": i.id, "email": i.email, "role": i.role, "created_at": i.created_at.isoformat()} for i in rows]


@router.post("/invitations")
async def invite(body: InviteIn, who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    """Invite anyone by email; they join this workspace with the given role the next time they sign in."""
    who.require("admin")
    email = body.email.strip().lower()
    if body.role not in ROLES or ROLES.index(body.role) > ROLES.index(who.user.role):
        raise HTTPException(403, "You can't assign that role.")
    member = await session.scalar(select(User).where(User.email == email))
    if member is not None and member.institution_id == who.institution.id:
        raise HTTPException(409, f"{email} is already a member. Change their role in the list.")
    old = await session.scalar(select(Invitation).where(Invitation.institution_id == who.institution.id, Invitation.email == email, Invitation.accepted_at.is_(None)))
    if old is None:
        await plans.check_seat(session, who.institution.id)
    if old is not None:
        old.role = body.role
    else:
        session.add(Invitation(institution_id=who.institution.id, email=email, role=body.role, invited_by=who.user.id))
    session.add(Notification(institution_id=who.institution.id, recipient_email=email, kind="invite",
                             title=f"{who.user.name or who.user.email} invited you to {who.institution.name} on YieldPilot", link="/welcome"))
    mailer.notify(email, f"{who.user.name or who.user.email} invited you to {who.institution.name} on YieldPilot",
                  f"{who.user.name or who.user.email} invited you to join {who.institution.name} on YieldPilot, the admission yield "
                  f"forecasting workspace, as {body.role.replace('_', ' ')}.",
                  f"Sign in with {email} to accept", f"{settings().frontend_origin.rstrip('/')}/login?email={email}")
    await audit(session, who, "member.invited", email, role=body.role)
    await session.commit()
    return {"ok": True}


@router.delete("/invitations/{invitation_id}")
async def cancel_invite(invitation_id: str, who: Principal = Depends(current), session: AsyncSession = Depends(get_session)):
    who.require("admin")
    i = await session.scalar(select(Invitation).where(Invitation.id == invitation_id, Invitation.institution_id == who.institution.id))
    if i is None:
        raise HTTPException(404, "Invitation not found.")
    await session.delete(i)
    await audit(session, who, "member.invite_cancelled", i.email)
    await session.commit()
    return {"ok": True}
