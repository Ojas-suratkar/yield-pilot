"""Memberships. A person can belong to several workspaces, with a role in each, and switch between them from the workspace menu.
User.institution_id and User.role are the workspace they're working in now; every list of a workspace's people reads memberships."""

from datetime import datetime, timezone

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Institution, Membership, User


async def get(session: AsyncSession, user_id: str, institution_id: str | None) -> Membership | None:
    if not institution_id:
        return None
    return await session.scalar(select(Membership).where(Membership.user_id == user_id, Membership.institution_id == institution_id))


def use(user: User, m: Membership) -> None:
    """Work in this workspace now."""
    user.institution_id, user.role = m.institution_id, m.role
    m.last_used_at = datetime.now(timezone.utc)


async def fallback(session: AsyncSession, user: User, exclude: str | None) -> Membership | None:
    """Another workspace this person can use, the most recently used first."""
    q = (select(Membership).join(Institution, Institution.id == Membership.institution_id)
         .where(Membership.user_id == user.id, Membership.active.is_(True))
         .order_by(Membership.last_used_at.desc().nulls_last(), Membership.created_at.desc()).limit(1))
    if exclude:
        q = q.where(Membership.institution_id != exclude)
    return await session.scalar(q)


async def add(session: AsyncSession, user: User, institution_id: str, role: str, switch: bool = True) -> Membership:
    """Add someone to a workspace (or give back their access there), keeping every other workspace they're in."""
    m = await get(session, user.id, institution_id)
    if m is None:
        m = Membership(user_id=user.id, institution_id=institution_id, role=role, active=True)
        session.add(m)
    else:
        m.role, m.active = role, True
    if switch or not user.institution_id:
        use(user, m)
    elif user.institution_id == institution_id:
        user.role = role
    await session.flush()
    return m


async def _move_off(session: AsyncSession, user: User, institution_id: str) -> None:
    if user.institution_id == institution_id:
        nxt = await fallback(session, user, exclude=institution_id)
        if nxt is not None:
            use(user, nxt)
        else:
            user.institution_id = None  # the welcome screen, to create or join one


async def leave(session: AsyncSession, user: User, institution_id: str) -> None:
    """Take someone out of one workspace; if it was the one they were in, they move to another of theirs."""
    m = await get(session, user.id, institution_id)
    if m is not None:
        await session.delete(m)
        await session.flush()
    await _move_off(session, user, institution_id)


async def set_active(session: AsyncSession, user: User, m: Membership, active: bool) -> None:
    m.active = active
    if not active:
        await session.flush()
        await _move_off(session, user, m.institution_id)


def people(institution_id: str) -> Select:
    """A workspace's people with their membership there: select (User, Membership)."""
    return (select(User, Membership).join(Membership, Membership.user_id == User.id)
            .where(Membership.institution_id == institution_id, User.deleted_at.is_(None)))


async def count(session: AsyncSession, institution_id: str, *, guests: bool = True) -> int:
    q = (select(func.count()).select_from(Membership).join(User, User.id == Membership.user_id)
         .where(Membership.institution_id == institution_id, Membership.active.is_(True), User.active.is_(True), User.deleted_at.is_(None)))
    return await session.scalar(q if guests else q.where(Membership.role != "guest"))


async def owners(session: AsyncSession, institution_id: str) -> int:
    return await session.scalar(select(func.count()).select_from(Membership).join(User, User.id == Membership.user_id).where(
        Membership.institution_id == institution_id, Membership.role == "owner", Membership.active.is_(True), User.active.is_(True),
        User.deleted_at.is_(None)))


async def ids(session: AsyncSession, user_id: str) -> set[str]:
    """Every workspace this person can use."""
    return set(await session.scalars(select(Membership.institution_id).where(Membership.user_id == user_id, Membership.active.is_(True))))


async def workspaces(session: AsyncSession, user: User) -> list[dict]:
    rows = (await session.execute(select(Membership, Institution).join(Institution, Institution.id == Membership.institution_id)
                                  .where(Membership.user_id == user.id, Membership.active.is_(True)).order_by(Institution.name))).all()
    people = dict((await session.execute(select(Membership.institution_id, func.count()).where(
        Membership.institution_id.in_([i.id for _, i in rows] or [""]), Membership.active.is_(True)).group_by(Membership.institution_id))).all())
    return [{"id": i.id, "name": i.name, "logo": i.logo, "role": m.role, "current": i.id == user.institution_id,
             "personal": "@" in (i.domain or ""), "domain": None if "@" in (i.domain or "") else i.domain, "people": people.get(i.id, 0)}
            for m, i in rows]
