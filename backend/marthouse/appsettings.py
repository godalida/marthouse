"""User-facing settings (the Settings window), stored per workspace."""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from .models import Setting

DEFAULTS: dict[str, Any] = {
    # General
    "appearance": "dark",  # light|dark|auto
    "on_launch": "last",  # last|projects
    "show_command": True,
    "terminal_app": "Terminal",
    # dbt
    "default_dbt": "",  # path to a dbt executable; empty = first working one
    "default_dlt": "",  # python of an environment with dlt; empty = first working one
    "hidden_installs": [],
    "check_updates": True,
    "allowed_versions": ">=1.8,<2",
    "index_url": "",
    "offline_folder": "",
    # Editor
    "font_size": 12,
    "compile_on_save": True,
    "preview_limit": 500,
    "formatter": "none",  # none|sqlfmt
    # Updates
    "auto_update": True,
    # internal
    "setup_done": False,
    "last_project": "",
}


def get_all(db: Session, ws: str = "local") -> dict[str, Any]:
    out = dict(DEFAULTS)
    for row in db.query(Setting).filter(Setting.workspace_id == ws):
        if row.key in DEFAULTS:
            out[row.key] = row.value
    return out


def get(db: Session, key: str, ws: str = "local") -> Any:
    row = db.get(Setting, (ws, key))
    return row.value if row else DEFAULTS.get(key)


def update(db: Session, values: dict[str, Any], ws: str = "local") -> dict[str, Any]:
    for k, v in values.items():
        if k not in DEFAULTS:
            continue
        row = db.get(Setting, (ws, k))
        if row:
            row.value = v
        else:
            db.add(Setting(workspace_id=ws, key=k, value=v))
    db.commit()
    return get_all(db, ws)
