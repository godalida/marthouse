"""Pipelines in a project folder: pipelines/<name>.pipeline.yml (spec) + pipelines/<name>.py (generated)."""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

from ruamel.yaml import YAML
from sqlalchemy.orm import Session

from .. import appsettings, secrets_store
from ..models import Project
from . import codegen, destinations, tool

DIR = "pipelines"
INSPECTOR = Path(__file__).with_name("inspector.py")


class PipelineError(ValueError):
    pass


def _yaml() -> YAML:
    y = YAML()
    y.default_flow_style = False
    y.indent(mapping=2, sequence=4, offset=2)
    return y


def pdir(project: Project) -> Path:
    return Path(project.path) / DIR


def data_dir(project: Project) -> Path:
    return pdir(project) / ".dlt-data"


def cache_path(project: Project, name: str) -> Path:
    return data_dir(project) / f"{name}.inspect.json"


def list_specs(project: Project) -> list[dict]:
    d = pdir(project)
    if not d.is_dir():
        return []
    out = []
    for f in sorted(d.glob("*.pipeline.yml")):
        try:
            spec = dict(YAML(typ="safe").load(f.read_text(encoding="utf-8")) or {})
            spec.setdefault("name", f.name.removesuffix(".pipeline.yml"))
            out.append(spec)
        except Exception as e:
            out.append({"name": f.name.removesuffix(".pipeline.yml"), "kind": "broken", "error": str(e)})
    return out


def get_spec(project: Project, name: str) -> dict:
    f = pdir(project) / f"{name}.pipeline.yml"
    if not f.is_file():
        raise PipelineError(f"No pipeline called {name}.")
    spec = dict(YAML(typ="safe").load(f.read_text(encoding="utf-8")) or {})
    spec["name"] = name
    return spec


def script_path(project: Project, spec: dict) -> Path:
    if spec.get("kind") == "verified":
        return pdir(project) / (spec.get("verified") or {}).get("script", f"{spec['name']}.py")
    return pdir(project) / f"{spec['name']}.py"


def pipeline_name(spec: dict) -> str:
    if spec.get("kind") == "verified":
        return (spec.get("verified") or {}).get("pipeline_name") or spec["name"]
    return spec["name"]


def resolve_destination(db: Session, project: Project, spec: dict) -> tuple[str, dict[str, str]]:
    from ..jobs import profiles_path
    from ..projects import info as project_info

    d = spec.get("destination") or {"type": "dbt"}
    if d.get("type") == "duckdb":
        return destinations.from_duckdb_file(project.path, d.get("path") or "warehouse.duckdb")
    try:
        profile = project_info(project.path)["profile"]
    except Exception as e:
        raise PipelineError("This folder has no dbt project, so choose a DuckDB file as the destination.") from e
    target = d.get("target") or ""
    if not target:
        from .. import profiles

        data = profiles.load(profiles_path(project))
        target = str((data.get(profile) or {}).get("target") or "")
    if not target:
        raise PipelineError("The dbt project has no connection yet. Add one in Connections.")
    return destinations.from_dbt_target(db, project.workspace_id, profiles_path(project), project.path, profile, target)


def save(db: Session, project: Project, spec: dict, secrets: dict[str, str]) -> dict:
    errs = codegen.validate(spec)
    if errs:
        raise PipelineError(" ".join(errs))
    dest_type, _ = resolve_destination(db, project, spec) if spec.get("kind") != "verified" else ("", {})
    d = pdir(project)
    d.mkdir(parents=True, exist_ok=True)
    gi = d / ".gitignore"
    if not gi.exists():
        gi.write_text(".dlt-data/\n.dlt/secrets.toml\n*.duckdb\n", encoding="utf-8")
    clean = {k: v for k, v in spec.items() if k not in ("secrets",)}
    with open(d / f"{spec['name']}.pipeline.yml", "w", encoding="utf-8") as f:
        _yaml().dump(clean, f)
    if spec["kind"] != "verified":
        (d / f"{spec['name']}.py").write_text(codegen.generate(spec, dest_type), encoding="utf-8")
    for k, v in (secrets or {}).items():
        if v:
            secrets_store.set_secret(db, project.workspace_id, codegen.secret_env(spec["name"], k), v)
    return clean


def delete(project: Project, name: str) -> None:
    spec = get_spec(project, name)
    for f in (pdir(project) / f"{name}.pipeline.yml", pdir(project) / f"{name}.py", cache_path(project, name)):
        if f.exists() and (spec.get("kind") != "verified" or f.suffix != ".py"):
            f.unlink()


def default_python(db: Session, ws: str, project: Project | None = None) -> str:
    py = appsettings.get(db, "default_dlt", ws) or ""
    if py and os.access(py, os.X_OK):
        return py
    for inst in tool.scan([project.path] if project else []):
        if inst.status == "ok":
            return inst.python
    raise PipelineError("dlt isn't installed yet. Install it in Settings › Tools.")


def run_env(db: Session, project: Project, spec: dict, refresh: bool = False) -> dict[str, str]:
    """Environment for running (or inspecting) a pipeline: state dir, destination, source secrets."""
    _, denv = resolve_destination(db, project, spec)
    env = {"DLT_DATA_DIR": str(data_dir(project)), "RUNTIME__LOG_LEVEL": "WARNING", "RUNTIME__DLTHUB_TELEMETRY": "false",
           "PYTHONUNBUFFERED": "1", **denv}
    for f in codegen.secret_fields(spec):
        v = secrets_store.get_secret(db, project.workspace_id, codegen.secret_env(spec["name"], f["key"]))
        if v is None:
            continue
        env[codegen.secret_env(spec["name"], f["key"])] = v
        if spec.get("kind") == "verified":  # dlt reads verified-source config from SOURCES__<SOURCE>__<KEY>
            src = (spec.get("verified") or {}).get("source", spec["name"]).upper()
            env[f"SOURCES__{src}__{f['key'].upper().replace('.', '__')}"] = v
    if spec.get("kind") == "filesystem":
        for k in ("access_key_id", "secret_access_key"):
            v = env.get(codegen.secret_env(spec["name"], k))
            if v:
                env[f"SOURCES__FILESYSTEM__CREDENTIALS__AWS_{k.upper()}"] = v
    if refresh:
        env["WORKBENCH_REFRESH"] = "drop_sources"
    return env


def check_duckdb(db: Session, project: Project, spec: dict, dlt_py: str) -> None:
    """A DuckDB file can only be opened by the DuckDB version that wrote it (or newer). When dbt and dlt
    share one file, their environments must have the same DuckDB."""
    try:
        dest, _ = resolve_destination(db, project, spec)
    except PipelineError:
        return
    if dest != "duckdb" or (spec.get("destination") or {}).get("type") == "duckdb":
        return
    from ..dbt import detect
    from ..jobs import JobError, resolve_dbt

    try:
        dbt_py = detect.inspect(resolve_dbt(db, project, project.workspace_id)).python
    except JobError:
        return
    a, b = tool.duckdb_version(dbt_py) if dbt_py else None, tool.duckdb_version(dlt_py)
    if a and b and a != b:
        raise PipelineError(f"duckdb_mismatch:{a}:{b}")


def run_step(db: Session, project: Project, spec: dict) -> dict:
    py = default_python(db, project.workspace_id, project)
    check_duckdb(db, project, spec, py)
    script = script_path(project, spec)
    if not script.exists():
        raise PipelineError(f"{script.name} is missing. Save the pipeline again.")
    return {"label": f"Load {spec['name']}", "argv": [py, script.name], "cwd": str(pdir(project)), "pipeline": spec["name"]}


def inspect(db: Session, project: Project, name: str, refresh_cache: bool = True) -> dict:
    spec = get_spec(project, name)
    py = default_python(db, project.workspace_id, project)
    env = {**os.environ, **run_env(db, project, spec)}
    r = subprocess.run([py, str(INSPECTOR), pipeline_name(spec)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120, env=env,
                       cwd=str(pdir(project)))
    line = next((l for l in r.stdout.splitlines() if l.startswith("@@WB")), None)
    if not line:
        raise PipelineError((r.stderr or "dlt couldn't read the pipeline").strip().splitlines()[-1][:300])
    data = json.loads(line[4:])
    if refresh_cache and data.get("ok"):
        cache_path(project, name).parent.mkdir(parents=True, exist_ok=True)
        cache_path(project, name).write_text(json.dumps(data), encoding="utf-8")
    return data


def cached(project: Project, name: str) -> dict | None:
    f = cache_path(project, name)
    try:
        return json.loads(f.read_text(encoding="utf-8")) if f.exists() else None
    except Exception:
        return None


# ---------- hand-off to dbt ----------

def loaded_at_expr(adapter: str) -> str | None:
    return {"duckdb": "to_timestamp(cast(_dlt_load_id as double))",
            "postgres": "to_timestamp(cast(_dlt_load_id as double precision))",
            "redshift": "timestamp 'epoch' + cast(_dlt_load_id as double precision) * interval '1 second'",
            "snowflake": "to_timestamp(cast(_dlt_load_id as double))",
            "bigquery": "timestamp_seconds(cast(cast(_dlt_load_id as float64) as int64))",
            "databricks": "cast(cast(_dlt_load_id as double) as timestamp)"}.get(adapter)


def generate_sources(project: Project, name: str, adapter: str) -> dict:
    """Write (or update) models/staging/_<dataset>__sources.yml from the pipeline's dlt schema.
    Existing descriptions and tests are kept; new tables and columns are added."""
    data = cached(project, name)
    if not data or not data.get("tables"):
        raise PipelineError("Run the pipeline once so Marthouse knows its tables.")
    from ..projects import info as project_info

    model_dir = (project_info(project.path)["model_paths"] or ["models"])[0]
    dataset = data["dataset"]
    rel = f"{model_dir}/staging/_{dataset}__sources.yml"
    f = Path(project.path) / rel
    y = YAML()
    y.preserve_quotes = True
    y.indent(mapping=2, sequence=4, offset=2)
    doc = y.load(f.read_text(encoding="utf-8")) if f.exists() else None
    from ruamel.yaml.comments import CommentedMap, CommentedSeq

    if not doc:
        doc = CommentedMap({"version": 2, "sources": CommentedSeq()})
    sources = doc.setdefault("sources", CommentedSeq())
    src = next((s for s in sources if s.get("name") == dataset), None)
    if src is None:
        src = CommentedMap({"name": dataset, "description": f"Loaded by the dlt pipeline {name}.", "schema": dataset, "loader": "dlt"})
        sources.append(src)
    expr = loaded_at_expr(adapter)
    if expr and "loaded_at_field" not in src:
        src["loaded_at_field"] = expr
        src["freshness"] = CommentedMap({"warn_after": CommentedMap({"count": 24, "period": "hour"}),
                                         "error_after": CommentedMap({"count": 48, "period": "hour"})})
    tables = src.setdefault("tables", CommentedSeq())
    added_t, added_c = 0, 0
    for t in data["tables"]:
        tbl = next((x for x in tables if x.get("name") == t["name"]), None)
        if tbl is None:
            desc = f"Nested rows of {t['parent']}." if t.get("parent") else f"From the {t.get('resource') or t['name']} resource."
            tbl = CommentedMap({"name": t["name"], "description": desc, "columns": CommentedSeq()})
            tables.append(tbl)
            added_t += 1
        cols = tbl.setdefault("columns", CommentedSeq())
        for c in t["columns"]:
            if c["dlt"] and c["name"] not in ("_dlt_id", "_dlt_load_id"):
                continue
            if any(x.get("name") == c["name"] for x in cols):
                continue
            col = CommentedMap({"name": c["name"]})
            if c["primary_key"]:
                col["data_tests"] = CommentedSeq(["unique", "not_null"])
            cols.append(col)
            added_c += 1
    f.parent.mkdir(parents=True, exist_ok=True)
    with open(f, "w", encoding="utf-8") as fh:
        y.dump(doc, fh)
    return {"path": rel, "tables_added": added_t, "columns_added": added_c, "source": dataset}


def lineage_nodes(project: Project) -> tuple[list[dict], list[tuple[str, str, str]]]:
    """Pipeline nodes for the lineage graph, plus (pipeline_id, dataset, table) for linking to dbt sources."""
    nodes, links = [], []
    for spec in list_specs(project):
        if spec.get("kind") == "broken":
            continue
        c = cached(project, spec["name"]) or {}
        rows = sum(((c.get("trace") or {}).get("rows") or {}).values())
        uid = f"pipeline.{spec['name']}"
        nodes.append({"id": uid, "name": spec["name"], "type": "pipeline", "materialized": spec.get("kind", ""),
                      "path": f"{DIR}/{spec['name']}.pipeline.yml", "package": None, "tags": [], "description": "",
                      "status": "success" if c.get("trace") and not any(s.get("error") for s in c["trace"].get("steps", [])) else None,
                      "tests": 0, "tests_failing": 0, "tests_warning": 0, "folder": DIR,
                      "rows": rows, "loaded_at": (c.get("trace") or {}).get("finished_at")})
        for t in c.get("tables") or []:
            links.append((uid, c.get("dataset") or spec.get("dataset"), t["name"]))
        if not c.get("tables"):
            links.append((uid, spec.get("dataset"), "*"))
    return nodes, links


def try_request(url: str, headers: dict[str, str], hosted: bool) -> dict:
    """Fetch one page so the builder can show the JSON and suggest a data selector and paginator."""
    import ipaddress
    import socket
    from urllib.parse import urlparse

    import httpx

    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise PipelineError("Use an http(s) URL.")
    if hosted:  # don't let the server be used to reach private networks
        for info in socket.getaddrinfo(u.hostname, None):
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                raise PipelineError("That address is on a private network.")
    r = httpx.get(url, headers=headers, timeout=15, follow_redirects=False)
    ctype = r.headers.get("content-type", "")
    body: Any
    try:
        body = r.json()
    except Exception:
        body = r.text[:2000]
    lists: list[dict] = []

    def walk(v: Any, path: str) -> None:
        if isinstance(v, list):
            lists.append({"path": path or "(root)", "count": len(v), "sample_keys": sorted(v[0].keys())[:12] if v and isinstance(v[0], dict) else []})
        elif isinstance(v, dict) and path.count(".") < 3:
            for k, x in v.items():
                walk(x, f"{path}.{k}" if path else k)

    walk(body, "")
    hint = None
    if "link" in {k.lower() for k in r.headers}:
        hint = {"type": "header_link"}
    elif isinstance(body, dict):
        for k in ("next", "next_url", "nextPage"):
            if isinstance(body.get(k), str):
                hint = {"type": "json_link", "next_url_path": k}
        for k in ("cursor", "next_cursor", "nextCursor"):
            if body.get(k):
                hint = {"type": "cursor", "cursor_path": k, "cursor_param": "cursor"}
        if hint is None and any(k in body for k in ("total", "total_count", "count")) and lists:
            hint = {"type": "offset", "limit": 100, "total_path": next(k for k in ("total", "total_count", "count") if k in body)}
    preview = json.dumps(body, indent=2, default=str)[:6000] if not isinstance(body, str) else body
    return {"status": r.status_code, "content_type": ctype, "preview": preview, "lists": lists[:8], "paginator": hint}


def verified_sources(py: str) -> list[dict]:
    dlt_bin = str(Path(py).with_name("dlt"))
    r = subprocess.run([dlt_bin, "--non-interactive", "init", "--list-sources"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    out = []
    for line in r.stdout.splitlines():
        m = re.match(r"^([a-z0-9_]+):\s+(.*)$", line.strip())
        if m and m.group(1) not in ("verified", "core"):
            out.append({"name": m.group(1), "description": m.group(2)})
    if not out:
        raise PipelineError((r.stderr or r.stdout or "dlt couldn't list sources").strip().splitlines()[-1][:300])
    return out


def read_verified_secrets(project: Project, source: str) -> list[str]:
    """Keys dlt init left for the user to fill in .dlt/secrets.toml (e.g. access_token)."""
    f = pdir(project) / ".dlt" / "secrets.toml"
    if not f.exists():
        return []
    keys, section = [], ""
    for line in f.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s.startswith("["):
            section = s.strip("[]")
        elif "=" in s and not s.startswith("#") and section.startswith(f"sources.{source}"):
            k = s.split("=", 1)[0].strip()
            sub = section[len(f"sources.{source}"):].strip(".")
            keys.append(f"{sub}.{k}" if sub else k)
    return keys
