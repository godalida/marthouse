"""Install dbt into Lineage's private folder with uv (shipped as a Python dependency)."""
from __future__ import annotations

import re
import shutil
import time
from pathlib import Path

import httpx
from packaging.specifiers import SpecifierSet
from packaging.version import Version

from ..config import get_settings
from ..oscompat import venv_bin

ADAPTERS = [
    {"id": "postgres", "name": "Postgres", "pkg": "dbt-postgres"},
    {"id": "snowflake", "name": "Snowflake", "pkg": "dbt-snowflake"},
    {"id": "bigquery", "name": "BigQuery", "pkg": "dbt-bigquery"},
    {"id": "redshift", "name": "Redshift", "pkg": "dbt-redshift"},
    {"id": "databricks", "name": "Databricks", "pkg": "dbt-databricks"},
    {"id": "duckdb", "name": "DuckDB", "pkg": "dbt-duckdb"},
    {"id": "trino", "name": "Trino", "pkg": "dbt-trino"},
    {"id": "sqlserver", "name": "SQL Server", "pkg": "dbt-sqlserver"},
]
ADAPTER_PKG = {a["id"]: a["pkg"] for a in ADAPTERS}
FALLBACK_VERSIONS = ["1.12.7", "1.11.9", "1.10.23", "1.9.8", "1.8.9"]
_cache: tuple[float, list[str]] | None = None


def uv_bin() -> str:
    try:
        from uv import find_uv_bin

        return find_uv_bin()
    except Exception:
        found = shutil.which("uv")
        if not found:
            raise RuntimeError("uv is missing. Reinstall Marthouse.")
        return found


def available_versions(spec: str = ">=1.8,<2", index_url: str = "") -> dict:
    """Newest patch of each minor dbt-core release inside the allowed range."""
    global _cache
    online = True
    if _cache and time.time() - _cache[0] < 3600:
        releases = _cache[1]
    else:
        try:
            base = (index_url.rstrip("/").removesuffix("/simple") if index_url else "https://pypi.org")
            r = httpx.get(f"{base}/pypi/dbt-core/json", timeout=6)
            r.raise_for_status()
            releases = [v for v, files in r.json()["releases"].items() if files and not any(f.get("yanked") for f in files)]
            _cache = (time.time(), releases)
        except Exception:
            releases, online = FALLBACK_VERSIONS, False
    try:
        ss = SpecifierSet(spec or ">=1.8")
    except Exception:
        ss = SpecifierSet(">=1.8")
    best: dict[tuple[int, int], Version] = {}
    for raw in releases:
        try:
            v = Version(raw)
        except Exception:
            continue
        if v.is_prerelease or v not in ss:
            continue
        key = (v.major, v.minor)
        if key not in best or v > best[key]:
            best[key] = v
    versions = [str(v) for v in sorted(best.values(), reverse=True)]
    return {"versions": versions, "online": online, "latest": versions[0] if versions else None}


def slug(version: str, adapters: list[str]) -> str:
    return re.sub(r"[^a-z0-9.\-]", "", f"dbt-{version}-{'-'.join(sorted(adapters))}".lower())[:80]


def install_steps(version: str, adapters: list[str], name: str | None = None, python: str = "3.12",
                  index_url: str = "", offline_folder: str = "", target_dir: str | None = None) -> tuple[list[dict], Path]:
    """The exact commands the install runs. Shown to the user before they agree."""
    bad = [a for a in adapters if a not in ADAPTER_PKG]
    if bad:
        raise ValueError(f"Unknown adapter: {', '.join(bad)}")
    if not adapters:
        raise ValueError("Pick at least one adapter")
    root = Path(target_dir) if target_dir else get_settings().private_dbt_dir / (name or slug(version, adapters))
    uv = uv_bin()
    pkgs = [f"dbt-core=={version}"] + [ADAPTER_PKG[a] for a in adapters]
    idx: list[str] = []
    if offline_folder:
        idx = ["--no-index", "--find-links", offline_folder]
    elif index_url:
        idx = ["--index-url", index_url]
    steps = [
        # Marthouse's own folders are replaced (a failed earlier attempt may have left a partial one);
        # a project's .venv is never cleared, dbt is added to what's there
        {"label": "Create a Python environment", "argv": [uv, "venv", "--python", python, "--seed",
                                                         "--allow-existing" if target_dir else "--clear", str(root)]},
        {"label": "Download and install dbt", "argv": [uv, "pip", "install", "--python", str(venv_bin(root, "python")), *idx, *pkgs]},
        {"label": "Check that dbt starts", "argv": [str(venv_bin(root, "dbt")), "--version"]},
    ]
    return steps, root


def display(argv: list[str]) -> str:
    """Shorten absolute paths so the command reads like what a person would type."""
    home = str(Path.home())
    out = []
    for a in argv:
        if a.endswith("/uv") or a == "uv":
            a = "uv"
        a = a.replace(home, "~")
        out.append(f'"{a}"' if " " in a else a)
    return " ".join(out)
