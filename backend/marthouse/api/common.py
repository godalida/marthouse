from __future__ import annotations

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Project
from ..projects import info
from ..security import Ctx, ctx


def get_project(project_id: str, c: Ctx = Depends(ctx), db: Session = Depends(get_db)) -> Project:
    p = db.get(Project, project_id)
    if p is None or p.workspace_id != c.ws:
        raise HTTPException(404, "Project not found.")
    return p


def tp(p: Project) -> str:
    try:
        return info(p.path)["target_path"]
    except Exception:
        return "target"
