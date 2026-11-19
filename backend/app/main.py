import asyncio
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware

from .config import settings
from .routers import admin, billing, connections, datasets, forecasts, institution, me, ml, notifications, projects, sso, usage
from .services import runs
from .services import usage as ledger


@asynccontextmanager
async def lifespan(_app: FastAPI):
    threading.Thread(target=runs.warm, daemon=True).start()  # the training process is ready before the first Run
    ledger.bind(asyncio.get_running_loop())  # AI calls on worker threads save their usage on this loop
    yield


local = settings().env == "local"
app = FastAPI(
    title="YieldPilot API",
    version="0.1.0",
    docs_url="/api/docs" if local else None,
    redoc_url=None,
    openapi_url="/api/openapi.json" if local else None,
    lifespan=lifespan,
)
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.middleware("http")
async def security_headers(request, call_next):
    """No API answer is cached by a browser or proxy, sniffed as another type, framed, or sent with a referrer."""
    res = await call_next(request)
    res.headers.setdefault("Cache-Control", "no-store")
    res.headers["X-Content-Type-Options"] = "nosniff"
    res.headers["X-Frame-Options"] = "DENY"
    res.headers["Referrer-Policy"] = "no-referrer"
    return res

app.include_router(sso.router, prefix="/api")
for r in (me.router, projects.router, datasets.router, forecasts.router, connections.router, notifications.router, billing.router, admin.router, institution.router, usage.router, ml.router):
    app.include_router(r, prefix="/api/v1")


@app.get("/api/health", include_in_schema=False)
async def healthz():
    return {"ok": True}
