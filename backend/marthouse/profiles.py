"""profiles.yml: read and write targets without losing comments, keep secrets out of the file."""
from __future__ import annotations

import io
import os
import re
from pathlib import Path
from typing import Any

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap
from sqlalchemy.orm import Session

from . import secrets_store

SECRET_FIELDS = {"password", "token", "private_key_passphrase", "client_secret", "keyfile_json", "private_key"}
ENV_RE = re.compile(r"env_var\(\s*['\"](MARTHOUSE_[A-Z0-9_]+)['\"]")

# Form fields per adapter, in the order the Connections screen shows them.
SCHEMAS: dict[str, list[dict[str, Any]]] = {
    "postgres": [
        {"key": "host", "label": "Host", "group": "Server", "default": "localhost"},
        {"key": "port", "label": "Port", "group": "Server", "type": "int", "default": 5432},
        {"key": "dbname", "label": "Database", "group": "Server"},
        {"key": "schema", "label": "Schema", "group": "Server", "hint": "Your personal dev schema"},
        {"key": "user", "label": "User", "group": "Sign in"},
        {"key": "password", "label": "Password", "group": "Sign in", "secret": True},
    ],
    "redshift": [
        {"key": "host", "label": "Host", "group": "Server"},
        {"key": "port", "label": "Port", "group": "Server", "type": "int", "default": 5439},
        {"key": "dbname", "label": "Database", "group": "Server"},
        {"key": "schema", "label": "Schema", "group": "Server"},
        {"key": "user", "label": "User", "group": "Sign in"},
        {"key": "password", "label": "Password", "group": "Sign in", "secret": True},
    ],
    "snowflake": [
        {"key": "account", "label": "Account", "group": "Server", "hint": "e.g. xy12345.eu-west-1"},
        {"key": "warehouse", "label": "Warehouse", "group": "Server"},
        {"key": "database", "label": "Database", "group": "Server"},
        {"key": "schema", "label": "Schema", "group": "Server"},
        {"key": "role", "label": "Role", "group": "Server"},
        {"key": "user", "label": "User", "group": "Sign in"},
        {"key": "password", "label": "Password", "group": "Sign in", "secret": True},
    ],
    "bigquery": [
        {"key": "method", "label": "Sign-in method", "group": "Sign in", "options": ["oauth", "service-account"], "default": "oauth"},
        {"key": "project", "label": "GCP project", "group": "Server"},
        {"key": "dataset", "label": "Dataset", "group": "Server"},
        {"key": "location", "label": "Location", "group": "Server", "default": "US"},
        {"key": "keyfile", "label": "Key file", "group": "Sign in", "hint": "Path to the service account JSON"},
    ],
    "databricks": [
        {"key": "host", "label": "Host", "group": "Server"},
        {"key": "http_path", "label": "HTTP path", "group": "Server"},
        {"key": "catalog", "label": "Catalog", "group": "Server"},
        {"key": "schema", "label": "Schema", "group": "Server"},
        {"key": "token", "label": "Access token", "group": "Sign in", "secret": True},
    ],
    "duckdb": [
        {"key": "path", "label": "Database file", "group": "Server", "default": "dev.duckdb"},
        {"key": "schema", "label": "Schema", "group": "Server", "default": "main"},
    ],
    "trino": [
        {"key": "method", "label": "Method", "group": "Sign in", "options": ["none", "ldap"], "default": "none"},
        {"key": "host", "label": "Host", "group": "Server"},
        {"key": "port", "label": "Port", "group": "Server", "type": "int", "default": 443},
        {"key": "database", "label": "Catalog", "group": "Server"},
        {"key": "schema", "label": "Schema", "group": "Server"},
        {"key": "user", "label": "User", "group": "Sign in"},
        {"key": "password", "label": "Password", "group": "Sign in", "secret": True},
    ],
    "sqlserver": [
        {"key": "server", "label": "Server", "group": "Server"},
        {"key": "port", "label": "Port", "group": "Server", "type": "int", "default": 1433},
        {"key": "database", "label": "Database", "group": "Server"},
        {"key": "schema", "label": "Schema", "group": "Server"},
        {"key": "driver", "label": "ODBC driver", "group": "Server", "default": "ODBC Driver 18 for SQL Server"},
        {"key": "user", "label": "User", "group": "Sign in"},
        {"key": "password", "label": "Password", "group": "Sign in", "secret": True},
    ],
}


def _rt() -> YAML:
    y = YAML()
    y.preserve_quotes = True
    y.indent(mapping=2, sequence=4, offset=2)
    y.width = 4096
    return y


def default_dir(project_root: str | Path) -> Path:
    if (Path(project_root) / "profiles.yml").exists():
        return Path(project_root)
    return Path.home() / ".dbt"


def load(path: Path) -> CommentedMap:
    if not path.exists():
        return CommentedMap()
    data = _rt().load(path.read_text())
    return data if isinstance(data, CommentedMap) else CommentedMap()


def dump(data: CommentedMap) -> str:
    buf = io.StringIO()
    _rt().dump(data, buf)
    return buf.getvalue()


def env_name(profile: str, target: str, field: str) -> str:
    return re.sub(r"[^A-Z0-9_]", "_", f"MARTHOUSE_{profile}_{target}_{field}".upper())


def _plain(v: Any) -> Any:
    if isinstance(v, dict):
        return {k: _plain(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_plain(x) for x in v]
    if hasattr(v, "real") and not isinstance(v, bool):
        return v
    return str(v) if v is not None and not isinstance(v, bool) else v


def summary(db: Session, ws: str, path: Path, active_profile: str) -> dict:
    data = load(path)
    profiles = []
    for name, prof in data.items():
        if name == "config" or not isinstance(prof, dict):
            continue
        outputs = prof.get("outputs") or {}
        targets = []
        for tname, t in outputs.items():
            t = t or {}
            env_missing = [m for m in re.findall(r"env_var\(\s*['\"]([A-Z0-9_]+)['\"]\s*\)", dump_value(t))
                           if not m.startswith("MARTHOUSE_")]
            targets.append({
                "name": tname,
                "type": t.get("type", ""),
                "host": str(t.get("host") or t.get("account") or t.get("server") or t.get("path") or t.get("project") or ""),
                "default": tname == prof.get("target"),
                "env_missing": [e for e in env_missing if e not in os.environ],
            })
        profiles.append({"name": name, "targets": targets, "default_target": prof.get("target")})
    return {"path": str(path), "exists": path.exists(), "active": active_profile, "profiles": profiles,
            "secret_store": secrets_store.where()}


def dump_value(v: Any) -> str:
    try:
        return dump(CommentedMap(v)) if isinstance(v, dict) else str(v)
    except Exception:
        return str(v)


def get_target(db: Session, ws: str, path: Path, profile: str, target: str) -> dict:
    data = load(path)
    t = ((data.get(profile) or {}).get("outputs") or {}).get(target)
    if t is None:
        raise KeyError(target)
    fields: dict[str, Any] = {}
    secrets: dict[str, dict] = {}
    for k, v in t.items():
        if k in SECRET_FIELDS:
            m = ENV_RE.search(str(v))
            if m:
                secrets[k] = {"stored": secrets_store.has_secret(db, ws, m.group(1)), "where": secrets_store.where(), "env": m.group(1)}
            elif "env_var" in str(v):
                secrets[k] = {"stored": False, "where": "env", "env": str(v)}
            else:
                secrets[k] = {"stored": bool(v), "where": "file", "env": None}
        else:
            fields[k] = _plain(v)
    return {"profile": profile, "target": target, "type": t.get("type", ""), "fields": fields, "secrets": secrets,
            "default": (data.get(profile) or {}).get("target") == target,
            "schema": SCHEMAS.get(str(t.get("type", "")), [])}


def apply_target(data: CommentedMap, profile: str, target: str, fields: dict[str, Any], secret_keys: list[str],
                 make_default: bool, rename_to: str | None = None) -> CommentedMap:
    prof = data.get(profile)
    if prof is None:
        prof = CommentedMap()
        data[profile] = prof
    outputs = prof.get("outputs")
    if outputs is None:
        outputs = CommentedMap()
        prof["outputs"] = outputs
    t = outputs.get(target)
    if t is None:
        t = CommentedMap()
        outputs[target] = t
    for k, v in fields.items():
        if k in SECRET_FIELDS:
            continue
        if v is None or v == "":
            t.pop(k, None)
        else:
            t[k] = v
    for k in secret_keys:
        t[k] = f"{{{{ env_var('{env_name(profile, rename_to or target, k)}') }}}}"
    if rename_to and rename_to != target:
        outputs[rename_to] = outputs.pop(target)
        if prof.get("target") == target:
            prof["target"] = rename_to
        target = rename_to
    if make_default or not prof.get("target"):
        prof["target"] = target
    return data


def save_target(db: Session, ws: str, path: Path, profile: str, target: str, fields: dict[str, Any],
                secret_values: dict[str, str], make_default: bool = False, rename_to: str | None = None,
                dry_run: bool = False) -> dict:
    data = load(path)
    keys = list(secret_values.keys())
    existing = ((data.get(profile) or {}).get("outputs") or {}).get(target) or {}
    # keep secret fields already pointing at Lineage env vars
    keys += [k for k in existing if k in SECRET_FIELDS and ENV_RE.search(str(existing[k])) and k not in keys]
    apply_target(data, profile, target, fields, keys, make_default, rename_to)
    text = dump(data)
    if not dry_run:
        for k, v in secret_values.items():
            if v:
                secrets_store.set_secret(db, ws, env_name(profile, rename_to or target, k), v)
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            (path.with_suffix(".yml.bak")).write_text(path.read_text())
        path.write_text(text)
    return {"text": text, "block": block_text(data, profile, rename_to or target)}


def block_text(data: CommentedMap, profile: str, target: str) -> str:
    prof = data.get(profile) or {}
    t = (prof.get("outputs") or {}).get(target) or {}
    one = CommentedMap()
    p = CommentedMap()
    p["target"] = prof.get("target", target)
    o = CommentedMap()
    o[target] = t
    p["outputs"] = o
    one[profile] = p
    return dump(one)


def delete_target(path: Path, profile: str, target: str) -> None:
    data = load(path)
    outputs = (data.get(profile) or {}).get("outputs") or {}
    outputs.pop(target, None)
    if data.get(profile, {}).get("target") == target:
        data[profile]["target"] = next(iter(outputs), "")
    path.write_text(dump(data))


def secret_env(db: Session, ws: str, path: Path) -> dict[str, str]:
    """Environment variables a dbt process needs so profiles.yml can read stored secrets."""
    if not path.exists():
        return {}
    env = {}
    for name in set(ENV_RE.findall(path.read_text())):
        v = secrets_store.get_secret(db, ws, name)
        if v is not None:
            env[name] = v
    return env
