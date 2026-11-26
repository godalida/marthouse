"""Find and install dlt. Installs live in <data_dir>/tools/<name>, separate from dbt."""
from __future__ import annotations

import glob
import json
import os
import re
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path

from packaging.version import Version

from ..oscompat import WINDOWS, env_python, exe, venv_bin, venv_glob
from ..config import get_settings
from ..dbt.detect import _shebang_python, login_shell_path
from ..dbt.install import display, uv_bin

MIN_VERSION = Version("1.0")

DESTINATIONS = [
    {"id": "duckdb", "name": "DuckDB", "extra": "duckdb"},
    {"id": "postgres", "name": "Postgres", "extra": "postgres"},
    {"id": "snowflake", "name": "Snowflake", "extra": "snowflake"},
    {"id": "bigquery", "name": "BigQuery", "extra": "bigquery"},
    {"id": "redshift", "name": "Redshift", "extra": "redshift"},
    {"id": "databricks", "name": "Databricks", "extra": "databricks"},
    {"id": "mssql", "name": "SQL Server", "extra": "mssql"},
    {"id": "motherduck", "name": "MotherDuck", "extra": "motherduck"},
]
SOURCE_KINDS = [
    {"id": "rest_api", "name": "REST APIs", "pkgs": []},
    {"id": "sql_database", "name": "SQL databases", "extras": ["sql-database"], "pkgs": ["pymysql", "psycopg2-binary"]},
    {"id": "filesystem", "name": "Files and buckets", "extras": ["filesystem", "parquet"], "pkgs": ["pandas"]},
]

PROBE = (
    "import json, importlib.metadata as m, importlib.util as u\n"
    "out = {'dlt': m.version('dlt')}\n"
    "mods = {'duckdb': 'duckdb', 'postgres': 'psycopg2', 'snowflake': 'snowflake.connector', 'bigquery': 'google.cloud.bigquery',\n"
    "        'redshift': 'psycopg2', 'databricks': 'databricks.sql', 'mssql': 'pyodbc', 'motherduck': 'duckdb',\n"
    "        'sql_database': 'sqlalchemy', 'filesystem': 'fsspec', 'pandas': 'pandas'}\n"
    "out['has'] = sorted(k for k, mod in mods.items() if u.find_spec(mod.split('.')[0]) is not None)\n"
    "print(json.dumps(out))\n"
)


@dataclass
class DltInstall:
    python: str
    kind: str
    label: str
    version: str | None = None
    has: list[str] = field(default_factory=list)
    status: str = "ok"  # ok|too_old|broken
    note: str = ""

    def to_dict(self) -> dict:
        d = asdict(self)
        d["path"] = self.python
        d["destinations"] = [x["id"] for x in DESTINATIONS if x["id"] in self.has]
        d["sources"] = ["rest_api"] + [k for k in ("sql_database", "filesystem") if k in self.has]
        return d


def duckdb_version(python: str) -> str | None:
    """DuckDB version inside an environment. dbt and dlt must use the same one to share a DuckDB file."""
    try:
        r = subprocess.run([python, "-c", "import importlib.metadata as m; print(m.version('duckdb'))"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20)
        return (r.stdout.strip() or None) if r.returncode == 0 else None
    except Exception:
        return None


def tools_dir() -> Path:
    return get_settings().data_dir / "tools"


def inspect(python: str, kind: str = "custom") -> DltInstall:
    labels = {"private": "Marthouse's private copy", "project": "Project environment", "path": "On your PATH", "pipx": "pipx or uv tool", "custom": "Chosen by you"}
    inst = DltInstall(python=python, kind=kind, label=labels.get(kind, kind))
    if not os.access(python, os.X_OK):
        inst.status, inst.note = "broken", "Python is missing"
        return inst
    try:
        r = subprocess.run([python, "-c", PROBE], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
        d = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        inst.status, inst.note = "broken", "dlt isn't installed in this environment"
        return inst
    inst.version, inst.has = d["dlt"], d["has"]
    try:
        if Version(inst.version) < MIN_VERSION:
            inst.status, inst.note = "too_old", f"Older than {MIN_VERSION}"
    except Exception:
        pass
    return inst


def scan(project_dirs: list[str]) -> list[DltInstall]:
    cands: list[tuple[str, str]] = []
    for p in sorted(glob.glob(venv_glob(tools_dir(), "python"))):
        cands.append((p, "private"))
    for d in project_dirs:
        for venv in (".venv", "venv"):
            py = venv_bin(Path(d) / venv, "python")
            if venv_bin(Path(d) / venv, "dlt").exists():
                cands.append((str(py), "project"))
    for d in login_shell_path():
        prog = Path(d) / exe("dlt")
        if prog.exists():
            py = _shebang_python(str(prog)) or env_python(prog)
            if py:
                cands.append((py, "path"))
    home = Path.home()
    tool_envs = [home / ".local/share/uv/tools/dlt", home / ".local/pipx/venvs/dlt"]
    if WINDOWS:
        tool_envs += [Path(os.environ.get("APPDATA", "")) / "uv/tools/dlt", home / "pipx/venvs/dlt"]
    for p in [str(venv_bin(e, "python")) for e in tool_envs if venv_bin(e, "python").exists()]:
        cands.append((p, "pipx"))
    seen: set[str] = set()
    out = []
    for py, kind in cands:
        real = os.path.realpath(py)
        if real in seen:
            continue
        seen.add(real)
        out.append(inspect(py, kind))
    return [i for i in out if i.status != "broken" or i.kind == "private"]


def available_versions(index_url: str = "") -> dict:
    import httpx

    try:
        base = index_url.rstrip("/").removesuffix("/simple") if index_url else "https://pypi.org"
        r = httpx.get(f"{base}/pypi/dlt/json", timeout=6)
        rel = r.json()["releases"]
        vs = sorted((Version(v) for v, f in rel.items() if f and not re.search(r"[a-z]", v)), reverse=True)
        return {"versions": [str(v) for v in vs[:6]], "online": True, "latest": str(vs[0])}
    except Exception:
        return {"versions": ["1.32.0"], "online": False, "latest": "1.32.0"}


def install_steps(version: str, destinations: list[str], sources: list[str], python: str = "3.12",
                  index_url: str = "", offline_folder: str = "", duckdb_pin: str | None = None) -> tuple[list[dict], Path]:
    known = {d["id"]: d["extra"] for d in DESTINATIONS}
    bad = [d for d in destinations if d not in known]
    if bad or not destinations:
        raise ValueError("Pick at least one destination." if not destinations else f"Unknown destination: {', '.join(bad)}")
    extras = sorted({known[d] for d in destinations} | {e for s in SOURCE_KINDS if s["id"] in sources for e in s.get("extras", [])})
    pkgs = [f"dlt[{','.join(extras)}]=={version}"] + sorted({p for s in SOURCE_KINDS if s["id"] in sources for p in s["pkgs"]}) + ["psutil"]
    if duckdb_pin and ("duckdb" in destinations or "motherduck" in destinations):
        pkgs.append(f"duckdb=={duckdb_pin}")  # same DuckDB as dbt, so both can open the same file
    root = tools_dir() / re.sub(r"[^a-z0-9.\-]", "", f"dlt-{version}-{'-'.join(sorted(destinations))}".lower())[:80]
    idx: list[str] = ["--no-index", "--find-links", offline_folder] if offline_folder else (["--index-url", index_url] if index_url else [])
    uv = uv_bin()
    steps = [
        {"label": "Create a Python environment", "argv": [uv, "venv", "--python", python, "--seed", "--clear", str(root)]},
        {"label": "Download and install dlt", "argv": [uv, "pip", "install", "--python", str(venv_bin(root, "python")), *idx, *pkgs]},
        {"label": "Check that dlt starts", "argv": [str(venv_bin(root, "dlt")), "--version"]},
    ]
    for s in steps:
        s["display"] = display(s["argv"])
    return steps, root
