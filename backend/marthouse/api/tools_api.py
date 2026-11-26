"""Tools other than dbt (dbt keeps /api/dbt). Today: dlt."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import appsettings, jobs
from ..db import get_db
from ..dlt import tool
from ..models import Project
from ..security import Ctx, ctx, need

router = APIRouter(prefix="/api/tools/dlt", tags=["tools"])


@router.get("")
async def scan(c: Ctx = Depends(ctx), db: Session = Depends(get_db)) -> dict:
    dirs = [p.path for p in db.query(Project).filter(Project.workspace_id == c.ws).limit(20)]
    found = [i.to_dict() for i in await asyncio.to_thread(tool.scan, dirs)]
    default = appsettings.get(db, "default_dlt", c.ws) or next((i["python"] for i in found if i["status"] == "ok"), "")
    for i in found:
        i["default"] = i["python"] == default
    return {"installs": found, "destinations": tool.DESTINATIONS, "sources": tool.SOURCE_KINDS}


@router.get("/versions")
async def versions(c: Ctx = Depends(ctx), db: Session = Depends(get_db)) -> dict:
    return await asyncio.to_thread(tool.available_versions, appsettings.get(db, "index_url", c.ws) or "")


class InstallBody(BaseModel):
    version: str
    destinations: list[str]
    sources: list[str] = ["rest_api", "sql_database", "filesystem"]
    python: str = "3.12"
    make_default: bool = True


def _dbt_duckdb(db: Session, ws: str) -> str | None:
    from ..dbt import detect

    try:
        dbt = jobs.resolve_dbt(db, None, ws)
    except jobs.JobError:
        return None
    inst = detect.inspect(dbt)
    return tool.duckdb_version(inst.python) if inst.python and "duckdb" in inst.adapters else None


def _plan(body: InstallBody, c: Ctx, db: Session):
    st = appsettings.get_all(db, c.ws)
    try:
        return tool.install_steps(body.version, body.destinations, body.sources, body.python, st["index_url"], st["offline_folder"],
                                  duckdb_pin=_dbt_duckdb(db, c.ws))
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.post("/install/plan")
def plan(body: InstallBody, c: Ctx = Depends(ctx), db: Session = Depends(get_db)) -> dict:
    steps, root = _plan(body, c, db)
    return {"root": str(root), "steps": [{"label": s["label"], "display": s["display"]} for s in steps]}


@router.post("/install")
async def install(body: InstallBody, c: Ctx = Depends(need("admin")), db: Session = Depends(get_db)) -> dict:
    steps, root = _plan(body, c, db)
    job = jobs.create(db, c.ws, "dlt_install", {"root": str(root), "version": body.version, "make_default": body.make_default},
                      steps=steps, title=f"Install dlt {body.version} for {', '.join(body.destinations)}")
    await jobs.dispatch(job.id)
    return {"job_id": job.id, "root": str(root)}


class AlignBody(BaseModel):
    version: str


@router.post("/align-duckdb")
async def align_duckdb(body: AlignBody, c: Ctx = Depends(need("member")), db: Session = Depends(get_db)) -> dict:
    """Install dbt's DuckDB version into the default dlt environment."""
    import re

    from ..dbt.install import display, uv_bin
    from ..dlt.service import PipelineError, default_python

    if not re.fullmatch(r"[0-9][0-9a-z.]*", body.version):
        raise HTTPException(400, "Bad version.")
    try:
        py = default_python(db, c.ws)
    except PipelineError as e:
        raise HTTPException(400, str(e)) from e
    argv = [uv_bin(), "pip", "install", "--python", py, f"duckdb=={body.version}"]
    job = jobs.create(db, c.ws, "dlt_align", {"python": py}, steps=[{"label": f"Install DuckDB {body.version} for dlt", "argv": argv, "display": display(argv)}],
                      title=f"Use DuckDB {body.version} in dlt")
    await jobs.dispatch(job.id)
    return {"job_id": job.id}


class PathBody(BaseModel):
    path: str


@router.post("/default")
def set_default(body: PathBody, c: Ctx = Depends(need("admin")), db: Session = Depends(get_db)) -> dict:
    appsettings.update(db, {"default_dlt": body.path}, c.ws)
    return {"ok": True}
