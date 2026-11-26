from __future__ import annotations

import os
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import appsettings, jobs, projects, secrets_store
from ..config import get_settings
from ..db import get_db
from ..dbt import artifacts
from ..models import Project, now
from ..security import Ctx, ctx, need
from .common import get_project, tp

router = APIRouter(prefix="/api/projects", tags=["projects"])


def project_dict(db: Session, p: Project, full: bool = False) -> dict:
    d = {"id": p.id, "name": p.name, "path": p.path if not get_settings().hosted else "", "git_url": p.git_url,
         "last_opened": p.last_opened, "exists": Path(p.path).is_dir()}
    if not d["exists"]:
        return d
    try:
        i = projects.info(p.path)
        d.update({"profile": i["profile"], "n_models": i["n_models"]})
    except projects.ProjectError as e:
        d["error"] = str(e)
        return d
    g = projects.git_info(p.path)
    d["branch"] = g["branch"] if g else None
    if full:
        d["git"] = g
        d["stale"] = projects.stale_files(p.path)
        d["has_manifest"] = artifacts.manifest(p.path, tp(p)) is not None
        d["info"] = i
        try:
            d["dbt"] = jobs.resolve_dbt(db, p, p.workspace_id)
            d["dbt_missing"] = False
        except jobs.JobError as e:
            d["dbt"], d["dbt_missing"], d["dbt_error"] = None, True, str(e)
        d["dbt_override"] = p.dbt_path
        d["venv_has_dbt"] = (Path(p.path) / ".venv" / "bin" / "dbt").exists()
        d["venv_exists"] = (Path(p.path) / ".venv").exists()
        d["requirements"] = (Path(p.path) / "requirements.txt").exists()
        d["profiles_path"] = str(jobs.profiles_path(p)) if not get_settings().hosted else "profiles.yml"
    return d


@router.get("")
def list_projects(c: Ctx = Depends(ctx), db: Session = Depends(get_db)) -> list[dict]:
    rows = db.query(Project).filter(Project.workspace_id == c.ws).order_by(Project.last_opened.desc()).all()
    return [project_dict(db, p) for p in rows]


@router.get("/{project_id}")
def get(p: Project = Depends(get_project), db: Session = Depends(get_db)) -> dict:
    p.last_opened = now()
    db.commit()
    appsettings.update(db, {"last_project": p.id}, p.workspace_id)
    return project_dict(db, p, full=True)


def _register(db: Session, c: Ctx, path: Path, git_url: str = "") -> Project:
    info = projects.info(path)
    existing = db.query(Project).filter(Project.workspace_id == c.ws, Project.path == str(path)).first()
    if existing:
        existing.last_opened = now()
        db.commit()
        return existing
    p = Project(workspace_id=c.ws, name=info["name"], path=str(path), git_url=git_url)
    db.add(p)
    db.commit()
    return p


class OpenBody(BaseModel):
    path: str


@router.post("/open")
def open_project(body: OpenBody, c: Ctx = Depends(need("member")), db: Session = Depends(get_db)) -> dict:
    if get_settings().hosted:
        raise HTTPException(400, "In the hosted app, add projects from Git.")
    path = Path(body.path).expanduser().resolve()
    try:
        return project_dict(db, _register(db, c, path))
    except projects.ProjectError as e:
        raise HTTPException(400, str(e)) from e


class NewBody(BaseModel):
    name: str
    parent: str = "~"
    kind: str = "dbt"  # dbt | pipelines


@router.post("/new")
def new_project(body: NewBody, c: Ctx = Depends(need("member")), db: Session = Depends(get_db)) -> dict:
    parent = Path(body.parent).expanduser()
    if get_settings().hosted:
        parent = get_settings().workspaces_dir / c.ws / "projects"
    try:
        root = projects.scaffold_pipelines_only(parent, body.name) if body.kind == "pipelines" else projects.scaffold(parent, body.name)
        return project_dict(db, _register(db, c, root))
    except projects.ProjectError as e:
        raise HTTPException(400, str(e)) from e


class CloneBody(BaseModel):
    url: str
    branch: str = ""
    token: str = ""
    parent: str = "~/code"
    subdir: str = ""  # dbt project inside the repo, if not at its root


@router.post("/clone")
async def clone(body: CloneBody, c: Ctx = Depends(need("member")), db: Session = Depends(get_db)) -> dict:
    import asyncio
    import re

    name = re.sub(r"\.git$", "", body.url.rstrip("/").split("/")[-1]) or "project"
    name = re.sub(r"[^A-Za-z0-9_.-]", "_", name)
    if get_settings().hosted:
        if not body.url.startswith("https://"):
            raise HTTPException(400, "Use an https:// Git URL.")
        parent = get_settings().workspaces_dir / c.ws / "projects"
    else:
        parent = Path(body.parent).expanduser()
    parent.mkdir(parents=True, exist_ok=True)
    dest = parent / name
    n = 2
    while dest.exists():
        dest = parent / f"{name}-{n}"
        n += 1
    try:
        await asyncio.to_thread(projects.git_clone, body.url, dest, body.branch, body.token or None)
        root = dest / body.subdir if body.subdir else dest
        p = _register(db, c, root.resolve(), git_url=body.url)
    except projects.ProjectError as e:
        if dest.exists() and get_settings().hosted:
            shutil.rmtree(dest, ignore_errors=True)
        raise HTTPException(400, str(e)) from e
    if body.token:
        secrets_store.set_secret(db, c.ws, f"GIT_{p.id}", body.token)
    return project_dict(db, p)


class PatchBody(BaseModel):
    dbt_path: str | None = None
    profiles_dir: str | None = None
    name: str | None = None


@router.patch("/{project_id}")
def patch(body: PatchBody, p: Project = Depends(get_project), c: Ctx = Depends(need("admin")), db: Session = Depends(get_db)) -> dict:
    if body.dbt_path is not None:
        if body.dbt_path and not os.access(body.dbt_path, os.X_OK):
            raise HTTPException(400, "No dbt at that path.")
        p.dbt_path = body.dbt_path
    if body.profiles_dir is not None and not get_settings().hosted:
        p.profiles_dir = body.profiles_dir
    if body.name:
        p.name = body.name
    db.commit()
    return project_dict(db, p, full=True)


@router.delete("/{project_id}")
def forget(p: Project = Depends(get_project), c: Ctx = Depends(need("admin")), db: Session = Depends(get_db)) -> dict:
    """Removes the project from Lineage. Local files are kept; hosted checkouts are deleted."""
    if get_settings().hosted:
        shutil.rmtree(p.path, ignore_errors=True)
    db.delete(p)
    db.commit()
    return {"ok": True}


# ---------- files ----------

@router.get("/{project_id}/tree")
def tree(p: Project = Depends(get_project)) -> list[dict]:
    return projects.tree(p.path)


@router.get("/{project_id}/file")
def read_file(path: str, p: Project = Depends(get_project)) -> dict:
    try:
        f = projects.read_file(p.path, path)
    except projects.ProjectError as e:
        raise HTTPException(400, str(e)) from e
    f["node"] = artifacts.node_for_path(p.path, path, tp(p))
    if path.endswith(".sql"):
        from .. import visual

        v = visual.parse(f["content"])
        f["visual"] = {"edited": v["edited"]} if v else None
    return f


class WriteBody(BaseModel):
    path: str
    content: str


@router.put("/{project_id}/file")
def write_file(body: WriteBody, p: Project = Depends(get_project), _: Ctx = Depends(need("member"))) -> dict:
    try:
        return projects.write_file(p.path, body.path, body.content)
    except projects.ProjectError as e:
        raise HTTPException(400, str(e)) from e


class RenameBody(BaseModel):
    path: str
    new_path: str


@router.post("/{project_id}/file/rename")
def rename(body: RenameBody, p: Project = Depends(get_project), _: Ctx = Depends(need("member"))) -> dict:
    try:
        projects.rename_file(p.path, body.path, body.new_path)
    except (projects.ProjectError, OSError) as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True}


@router.delete("/{project_id}/file")
def delete(path: str, p: Project = Depends(get_project), _: Ctx = Depends(need("member"))) -> dict:
    try:
        projects.delete_file(p.path, path)
    except projects.ProjectError as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True}


# ---------- git ----------

@router.get("/{project_id}/git")
def git(p: Project = Depends(get_project)) -> dict | None:
    return projects.git_info(p.path)


@router.post("/{project_id}/git/pull")
def pull(p: Project = Depends(get_project), c: Ctx = Depends(need("member")), db: Session = Depends(get_db)) -> dict:
    try:
        return {"output": projects.git_pull(p.path, secrets_store.get_secret(db, c.ws, f"GIT_{p.id}"))}
    except projects.ProjectError as e:
        raise HTTPException(400, str(e)) from e


class CommitBody(BaseModel):
    message: str
    push: bool = True


@router.post("/{project_id}/git/commit")
def commit(body: CommitBody, p: Project = Depends(get_project), c: Ctx = Depends(need("member")), db: Session = Depends(get_db)) -> dict:
    author = f"{c.user.name or c.user.email} <{c.user.email}>" if c.user else ""
    try:
        return {"output": projects.git_commit_push(p.path, body.message, author,
                                                   secrets_store.get_secret(db, c.ws, f"GIT_{p.id}"), body.push)}
    except projects.ProjectError as e:
        raise HTTPException(400, str(e)) from e
