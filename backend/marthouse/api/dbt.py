from __future__ import annotations

import asyncio
import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..oscompat import exe, venv_bin
from .. import appsettings, jobs
from ..config import get_settings
from ..db import get_db
from ..dbt import detect, install
from ..models import Project
from ..security import Ctx, ctx, need

router = APIRouter(prefix="/api/dbt", tags=["dbt"])


def _project_dirs(db: Session, ws: str) -> list[str]:
    return [p.path for p in db.query(Project).filter(Project.workspace_id == ws).order_by(Project.last_opened.desc()).limit(20)]


def _decorate(installs: list[dict], st: dict) -> list[dict]:
    hidden = set(st.get("hidden_installs") or [])
    default = st.get("default_dbt") or ""
    if not default:
        ok = [i for i in installs if i["status"] == "ok"]
        default = ok[0]["path"] if ok else ""
    for i in installs:
        i["default"] = i["path"] == default
        i["hidden"] = i["path"] in hidden
        i["allowed"] = detect.allowed(i.get("core"), st.get("allowed_versions"))
    return installs


@router.get("/locations")
def locations(c: Ctx = Depends(ctx), db: Session = Depends(get_db)) -> list[dict]:
    if get_settings().hosted:
        return [{"id": "private", "label": "Workspace installs", "detail": "dbt installed on Marthouse's servers"}]
    return [l.__dict__ for l in detect.locations(_project_dirs(db, c.ws))]


@router.get("/scan")
async def scan(loc: str | None = None, c: Ctx = Depends(ctx), db: Session = Depends(get_db)) -> list[dict]:
    """One location at a time (so the first-run screen can tick them off), or everything."""
    dirs = _project_dirs(db, c.ws)
    st = appsettings.get_all(db, c.ws)
    locs = ["private"] if get_settings().hosted else ([loc] if loc else [l.id for l in detect.locations(dirs)])

    def work() -> list[dict]:
        seen: set[str] = set()
        out: list[dict] = []
        for l in locs:
            out += [i.to_dict() for i in detect.scan_location(l, dirs, seen)]
        return out

    found = await asyncio.to_thread(work)
    custom = st.get("default_dbt")
    if not loc and custom and all(os.path.realpath(i["path"]) != os.path.realpath(custom) for i in found) and os.path.exists(custom):
        found.append(detect.inspect(custom, "custom").to_dict())
    return _decorate(found, st)


class PathBody(BaseModel):
    path: str


@router.post("/inspect")
async def inspect(body: PathBody, c: Ctx = Depends(need("admin")), db: Session = Depends(get_db)) -> dict:
    if get_settings().hosted:
        raise HTTPException(404)
    p = Path(body.path).expanduser()
    if p.is_dir():
        p = venv_bin(p, "dbt") if venv_bin(p, "dbt").exists() else p / exe("dbt")
    private = get_settings().private_dbt_dir.resolve()
    kind = "private" if private in p.resolve().parents else "project" if ".venv" in p.parts else "custom"
    inst = await asyncio.to_thread(detect.inspect, str(p), kind)
    return _decorate([inst.to_dict()], appsettings.get_all(db, c.ws))[0]


@router.post("/default")
def set_default(body: PathBody, c: Ctx = Depends(need("admin")), db: Session = Depends(get_db)) -> dict:
    appsettings.update(db, {"default_dbt": body.path}, c.ws)
    return {"ok": True}


class HideBody(BaseModel):
    path: str
    hidden: bool = True


@router.post("/hide")
def hide(body: HideBody, c: Ctx = Depends(need("admin")), db: Session = Depends(get_db)) -> dict:
    cur = set(appsettings.get(db, "hidden_installs", c.ws) or [])
    (cur.add if body.hidden else cur.discard)(body.path)
    appsettings.update(db, {"hidden_installs": sorted(cur)}, c.ws)
    return {"ok": True}


@router.get("/versions")
async def versions(c: Ctx = Depends(ctx), db: Session = Depends(get_db)) -> dict:
    st = appsettings.get_all(db, c.ws)
    return await asyncio.to_thread(install.available_versions, st["allowed_versions"], st["index_url"])


@router.get("/adapters")
def adapters() -> list[dict]:
    return install.ADAPTERS


class InstallBody(BaseModel):
    version: str
    adapters: list[str]
    location: str = "private"  # private|project
    project_id: str | None = None
    python: str = "3.12"
    make_default: bool = True
    offline_folder: str | None = None


def _plan(body: InstallBody, c: Ctx, db: Session) -> tuple[list[dict], Path]:
    st = appsettings.get_all(db, c.ws)
    target = None
    if body.location == "project":
        if get_settings().hosted:
            raise HTTPException(400, "The hosted app installs dbt for the whole workspace.")
        proj = db.get(Project, body.project_id or "")
        if proj is None or proj.workspace_id != c.ws:
            raise HTTPException(400, "Choose a project first.")
        target = str(Path(proj.path) / ".venv")
    try:
        steps, root = install.install_steps(body.version, body.adapters, python=body.python, index_url=st["index_url"],
                                            offline_folder=body.offline_folder if body.offline_folder is not None else st["offline_folder"],
                                            target_dir=target)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return steps, root


@router.post("/install/plan")
def install_plan(body: InstallBody, c: Ctx = Depends(ctx), db: Session = Depends(get_db)) -> dict:
    steps, root = _plan(body, c, db)
    return {"root": str(root), "steps": [{"label": s["label"], "display": install.display(s["argv"])} for s in steps]}


@router.post("/install")
async def do_install(body: InstallBody, c: Ctx = Depends(need("admin")), db: Session = Depends(get_db)) -> dict:
    steps, root = _plan(body, c, db)
    job = jobs.create(db, c.ws, "install", {"root": str(root), "version": body.version, "adapters": body.adapters,
                                            "make_default": body.make_default}, steps=steps,
                      title=f"Install dbt-core {body.version} with {', '.join(body.adapters)}")
    await jobs.dispatch(job.id)
    return {"job_id": job.id, "root": str(root)}
