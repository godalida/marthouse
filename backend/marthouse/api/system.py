from __future__ import annotations

import os
import platform
import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import __version__, appsettings
from ..config import get_settings
from ..db import get_db
from ..models import Membership, Workspace
from ..security import Ctx, current_user, ctx

router = APIRouter(prefix="/api/system", tags=["system"])


@router.get("/hello")
def hello(db: Session = Depends(get_db), user=Depends(current_user)) -> dict:
    """Unauthenticated: tells the UI which mode it is in and whether it must sign in."""
    s = get_settings()
    out = {"mode": s.mode, "version": __version__, "platform": sys.platform, "signed_in": user is not None}
    if s.hosted and user:
        rows = db.query(Membership, Workspace).join(Workspace, Workspace.id == Membership.workspace_id).filter(Membership.user_id == user.id).all()
        out["user"] = {"id": user.id, "email": user.email, "name": user.name}
        out["workspaces"] = [{"id": w.id, "name": w.name, "role": m.role} for m, w in rows]
    return out


@router.get("")
def system(c: Ctx = Depends(ctx), db: Session = Depends(get_db)) -> dict:
    s = get_settings()
    st = appsettings.get_all(db, c.ws)
    default = st.get("default_dbt") or ""
    return {
        "mode": s.mode, "version": __version__, "platform": sys.platform, "os": platform.platform(terse=True),
        "home": str(Path.home()) if not s.hosted else "", "private_dir": str(s.private_dbt_dir) if not s.hosted else "",
        "setup_done": bool(st.get("setup_done")), "default_dbt": default,
        "default_dbt_missing": bool(default) and not os.access(default, os.X_OK),
        "role": c.role, "workspace": c.ws,
        "example": _example() if not s.hosted else "",
    }


def _example() -> str:
    for base in (Path(__file__).resolve().parents[3], Path(__file__).resolve().parents[1]):
        ex = base / "examples" / "jaffle_shop_duckdb"
        if (ex / "dbt_project.yml").exists():
            return str(ex)
    return ""


def _local_only() -> None:
    if get_settings().hosted:
        raise HTTPException(404, "Not available in the hosted app.")


@router.post("/choose-folder")
def choose_folder(_: Ctx = Depends(ctx)) -> dict:
    """Native folder picker (macOS and Windows) for Open Project and offline installs."""
    _local_only()
    if sys.platform == "win32":
        ps = ("[Console]::OutputEncoding = [Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; "
              "$f.Description = 'Choose a folder'; if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath }")
        r = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", ps], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
        return {"path": r.stdout.strip() or None}
    if sys.platform != "darwin":
        raise HTTPException(501, "Type the folder path instead.")
    r = subprocess.run(["osascript", "-e", 'POSIX path of (choose folder with prompt "Choose a folder")'],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
    if r.returncode != 0:
        return {"path": None}
    return {"path": r.stdout.strip().rstrip("/") or "/"}


@router.get("/browse")
def browse(path: str = "~", _: Ctx = Depends(ctx)) -> dict:
    _local_only()
    p = Path(path).expanduser().resolve()
    if not p.is_dir():
        raise HTTPException(404, "Folder not found.")
    dirs = []
    try:
        for d in sorted(p.iterdir(), key=lambda x: x.name.lower()):
            if d.is_dir() and not d.name.startswith("."):
                dirs.append({"name": d.name, "path": str(d), "dbt": (d / "dbt_project.yml").exists()})
    except PermissionError:
        pass
    return {"path": str(p), "parent": str(p.parent) if p.parent != p else None, "dirs": dirs[:500],
            "dbt": (p / "dbt_project.yml").exists()}


class PathBody(BaseModel):
    path: str


@router.post("/reveal")
def reveal(body: PathBody, _: Ctx = Depends(ctx)) -> dict:
    _local_only()
    if sys.platform == "darwin":
        subprocess.Popen(["open", "-R", body.path])
    elif sys.platform == "win32":
        subprocess.Popen(["explorer", f"/select,{body.path}"])
    return {"ok": True}


@router.post("/terminal")
def terminal(body: PathBody, c: Ctx = Depends(ctx), db: Session = Depends(get_db)) -> dict:
    _local_only()
    app = appsettings.get(db, "terminal_app", c.ws) or "Terminal"
    if sys.platform == "darwin":
        subprocess.Popen(["open", "-a", app, body.path])
    elif sys.platform == "win32" and Path(body.path).is_dir():
        subprocess.Popen(["cmd.exe"], cwd=body.path, creationflags=subprocess.CREATE_NEW_CONSOLE)
    return {"ok": True}
