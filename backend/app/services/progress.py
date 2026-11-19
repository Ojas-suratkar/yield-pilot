"""Real progress for long requests.

A request that sends `Accept: application/x-ndjson` gets NDJSON lines {"pct", "label", "detail"} as the work
advances (a line at least every 3 seconds, which also keeps proxies and the instance's CPU awake), then
{"done": true, "result": ...} or {"error": ..., "status": ...}. Without that header the same endpoint answers
with plain JSON, so scripts and older clients keep working.
"""

import asyncio
import json
import logging
import time
from typing import Any, Awaitable, Callable

from fastapi import HTTPException, Request
from fastapi.responses import StreamingResponse

log = logging.getLogger("yieldpilot.progress")
NDJSON = "application/x-ndjson"


class Progress:
    """Where a task is, 0-100. Safe to call from worker threads: it only ever moves forward."""

    def __init__(self) -> None:
        self.pct, self.label, self.detail = 0.0, "Starting", ""
        self.cancelled = False  # the person closed the page or pressed Cancel: long work should stop

    def __call__(self, pct: float, label: str | None = None, detail: str = "") -> None:
        self.pct = max(self.pct, min(100.0, float(pct)))
        if label is not None:
            self.label = label
        self.detail = detail

    def span(self, start: float, end: float) -> "Callable[[float, str | None, str], None]":
        """A sub-task's own 0-100 mapped onto [start, end] of this one."""
        return lambda pct, label=None, detail="": self(start + (end - start) * pct / 100, label, detail)


def wants_stream(request: Request) -> bool:
    return NDJSON in request.headers.get("accept", "")


def stream(work: Callable[[Progress], Awaitable[Any]]) -> StreamingResponse:
    prog = Progress()

    async def lines():
        task = asyncio.create_task(work(prog))
        last, beat = None, 0.0
        try:
            while not task.done():
                await asyncio.wait({task}, timeout=0.12)
                now = (round(prog.pct), prog.label, prog.detail)
                if now != last or time.monotonic() - beat > 3:
                    last, beat = now, time.monotonic()
                    yield json.dumps({"pct": round(prog.pct, 1), "label": prog.label, "detail": prog.detail}) + "\n"
        finally:
            if not task.done():  # the connection closed early (Cancel, or the page was left): tell the work to stop
                prog.cancelled = True
        try:
            yield json.dumps({"done": True, "result": task.result()}, default=str) + "\n"
        except HTTPException as e:
            yield json.dumps({"error": e.detail, "status": e.status_code}) + "\n"
        except Exception:
            log.exception("streamed task failed")
            yield json.dumps({"error": "Something went wrong on our side. Please try again.", "status": 500}) + "\n"

    return StreamingResponse(lines(), media_type=NDJSON, headers={"Cache-Control": "no-cache", "Content-Encoding": "identity", "X-Accel-Buffering": "no"})


async def respond(request: Request, work: Callable[[Progress], Awaitable[Any]]) -> Any:
    """Stream progress when the caller asks for it, plain JSON otherwise. `work` must open its own database
    session: a streamed response outlives the request's."""
    return stream(work) if wants_stream(request) else await work(Progress())
