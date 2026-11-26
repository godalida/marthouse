"""Use a dbt connection (a profiles.yml target) as the dlt destination, so one connection serves both tools.

Returns the dlt destination type plus environment variables for the run. Secret values are read
from the secrets store at run time and are never written to disk.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import quote, quote_plus

from sqlalchemy.orm import Session

from .. import profiles, secrets_store

DBT_TO_DLT = {"duckdb": "duckdb", "postgres": "postgres", "snowflake": "snowflake", "bigquery": "bigquery",
              "redshift": "redshift", "databricks": "databricks", "sqlserver": "mssql"}


class DestinationError(ValueError):
    pass


def _secret(db: Session, ws: str, info: dict, key: str) -> str:
    s = (info.get("secrets") or {}).get(key)
    if not s:
        return ""
    if s.get("where") in ("keychain", "encrypted") and s.get("env"):
        return secrets_store.get_secret(db, ws, s["env"]) or ""
    if s.get("where") == "env":
        name = str(s.get("env") or "").split("'")[1] if "'" in str(s.get("env")) else ""
        return os.environ.get(name, "")
    raise DestinationError(f"The {key} for this connection is written in profiles.yml as plain text. "
                           "Save the connection once in Connections to move it to the secure store.")


def from_dbt_target(db: Session, ws: str, profiles_path: Path, dbt_project_dir: str, profile: str, target: str) -> tuple[str, dict[str, str]]:
    try:
        info = profiles.get_target(db, ws, profiles_path, profile, target)
    except KeyError as e:
        raise DestinationError(f"There's no {target} target in profiles.yml.") from e
    t, f = info["type"], info["fields"]
    if t not in DBT_TO_DLT:
        raise DestinationError(f"dlt can't load into a {t} connection.")
    dest = DBT_TO_DLT[t]
    p = dest.upper()
    env: dict[str, str] = {}
    if t == "duckdb":
        path = str(f.get("path") or "dev.duckdb")
        if path.startswith("md:"):
            dest, env = "motherduck", {"DESTINATION__MOTHERDUCK__CREDENTIALS": path}
        else:
            env[f"DESTINATION__{p}__CREDENTIALS"] = path if os.path.isabs(path) else str(Path(dbt_project_dir) / path)
    elif t in ("postgres", "redshift"):
        pw = quote(_secret(db, ws, info, "password"), safe="")
        env[f"DESTINATION__{p}__CREDENTIALS"] = f"postgresql://{quote(str(f.get('user', '')), safe='')}:{pw}@{f.get('host', 'localhost')}:{f.get('port') or 5432}/{f.get('dbname', '')}"
    elif t == "snowflake":
        pw = quote(_secret(db, ws, info, "password"), safe="")
        q = "&".join(f"{k}={quote_plus(str(f[k]))}" for k in ("warehouse", "role") if f.get(k))
        env[f"DESTINATION__{p}__CREDENTIALS"] = f"snowflake://{quote(str(f.get('user', '')), safe='')}:{pw}@{f.get('account', '')}/{f.get('database', '')}" + (f"?{q}" if q else "")
    elif t == "bigquery":
        if f.get("location"):
            env[f"DESTINATION__{p}__LOCATION"] = str(f["location"])
        kf = f.get("keyfile")
        if kf and Path(str(kf)).expanduser().is_file():
            env[f"DESTINATION__{p}__CREDENTIALS"] = Path(str(kf)).expanduser().read_text(encoding="utf-8")
        elif f.get("project"):
            env[f"DESTINATION__{p}__CREDENTIALS__PROJECT_ID"] = str(f["project"])
    elif t == "databricks":
        env.update({f"DESTINATION__{p}__CREDENTIALS__SERVER_HOSTNAME": str(f.get("host", "")),
                    f"DESTINATION__{p}__CREDENTIALS__HTTP_PATH": str(f.get("http_path", "")),
                    f"DESTINATION__{p}__CREDENTIALS__ACCESS_TOKEN": _secret(db, ws, info, "token"),
                    f"DESTINATION__{p}__CREDENTIALS__CATALOG": str(f.get("catalog", ""))})
    elif t == "sqlserver":
        pw = quote(_secret(db, ws, info, "password"), safe="")
        drv = quote_plus(str(f.get("driver") or "ODBC Driver 18 for SQL Server"))
        env[f"DESTINATION__{p}__CREDENTIALS"] = f"mssql://{quote(str(f.get('user', '')), safe='')}:{pw}@{f.get('server', '')}:{f.get('port') or 1433}/{f.get('database', '')}?driver={drv}"
    return dest, env


def from_duckdb_file(project_dir: str, path: str) -> tuple[str, dict[str, str]]:
    full = path if os.path.isabs(path) else str(Path(project_dir) / path)
    return "duckdb", {"DESTINATION__DUCKDB__CREDENTIALS": full}


def describe(dest: str, env: dict[str, str]) -> str:
    v = env.get(f"DESTINATION__{dest.upper()}__CREDENTIALS", "")
    if dest == "duckdb":
        return Path(v).name
    return dest
