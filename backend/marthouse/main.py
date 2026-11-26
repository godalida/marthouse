from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .api import account, dbt, jobs_api, pipelines_api, projects_api, schedules_api, system, tools_api, work_api
from .config import get_settings
from .db import init_db
from .security import LOCAL_COOKIE, check_request

STATIC = Path(__file__).parent / "static"


def create_app() -> FastAPI:
    s = get_settings()
    init_db()
    app = FastAPI(title="Marthouse", version=__version__, docs_url="/api/docs" if not s.hosted else None, redoc_url=None)

    @app.middleware("http")
    async def guard(request: Request, call_next):
        if request.url.path.startswith("/api"):
            try:
                check_request(request)
            except HTTPException as e:
                return JSONResponse({"detail": e.detail}, status_code=e.status_code)
        resp = await call_next(request)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        return resp

    @app.on_event("startup")
    async def _scheduler() -> None:
        # local mode, and hosted without the worker queue: run schedules in this process
        if not (s.hosted and s.use_queue):
            import asyncio

            from .scheduler import loop

            app.state.scheduler = asyncio.create_task(loop())

    for r in (system.router, dbt.router, jobs_api.router, projects_api.router, work_api.router, work_api.top, account.router, tools_api.router, pipelines_api.router, schedules_api.router):
        app.include_router(r)

    @app.get("/launch")
    def launch(token: str, to: str = "/"):
        """The link `lineage` opens: swaps the one-time launch token for a cookie."""
        if s.hosted or token != s.launch_token:
            raise HTTPException(403, "This link has expired. Run lineage again.")
        resp = RedirectResponse(to if to.startswith("/") and not to.startswith("//") else "/")
        resp.set_cookie(LOCAL_COOKIE, token, httponly=True, samesite="strict")
        return resp

    if STATIC.exists():
        app.mount("/assets", StaticFiles(directory=STATIC / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            f = STATIC / path
            if path and f.is_file() and STATIC in f.resolve().parents:
                return FileResponse(f)
            return FileResponse(STATIC / "index.html")

    return app


app = create_app() if __name__ != "__main__" else None
