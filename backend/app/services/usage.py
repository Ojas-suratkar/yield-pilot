"""The usage ledger: what each AI call and data import consumed, and for which person and institution.
Recording never gets in the way of the work it measures: a problem here is logged and the work carries on."""

import asyncio
import contextvars
import logging

from ..db import Session
from ..models import UsageEvent

log = logging.getLogger(__name__)
_acting: contextvars.ContextVar[tuple[str, str] | None] = contextvars.ContextVar("usage_acting", default=None)
_loop: asyncio.AbstractEventLoop | None = None


def bind(loop: asyncio.AbstractEventLoop) -> None:
    """The API's event loop: AI calls run on worker threads, and their records are saved back on it."""
    global _loop
    _loop = loop


def acting(institution_id: str, user_id: str) -> None:
    """Who this request is working for; set when the request is signed in, and carried into its worker threads."""
    _acting.set((institution_id, user_id))


async def _save(event: dict) -> None:
    try:
        async with Session() as s:
            s.add(UsageEvent(**event))
            await s.commit()
    except Exception as e:
        log.warning("usage not recorded: %s", type(e).__name__)


def record(kind: str, purpose: str, **fields) -> None:
    """Add one line to the ledger, from any thread, without waiting for it."""
    who = _acting.get()
    if who is None or _loop is None or _loop.is_closed():
        return  # a script or a background job: nobody to charge it to
    asyncio.run_coroutine_threadsafe(_save({"institution_id": who[0], "user_id": who[1], "kind": kind, "purpose": purpose, **fields}), _loop)
