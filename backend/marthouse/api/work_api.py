from __future__ import annotations

import asyncio
import re
import io
import subprocess
import zipfile
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from packaging.version import Version
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..oscompat import exe
from .. import __version__, appsettings, jobs, profiles
from ..config import get_settings
from ..db import get_db
from ..dbt import artifacts, detect, install
from ..models import Project
from ..security import Ctx, ctx, need
from .common import get_project, tp
from .jobs_api import job_dict

router = APIRouter(prefix="/api/projects/{project_id}", tags=["work"])
top = APIRouter(prefix="/api", tags=["settings"])


def _no_manifest() -> HTTPException:
    return HTTPException(409, "needs_parse")


# ---------- running dbt ----------

class JobBody(BaseModel):
    kind: str
    select: str = ""
    exclude: str = ""
    full_refresh: bool = False
    fail_fast: bool = False
    target: str = ""
    threads: int | None = None
    vars: dict | str | None = None


@router.post("/jobs")
async def start_job(body: JobBody, p: Project = Depends(get_project), c: Ctx = Depends(need("member")),
                    db: Session = Depends(get_db)) -> dict:
    if body.kind not in jobs.DBT_KINDS or body.kind in ("show", "ls"):
        raise HTTPException(400, "Unknown command.")
    params = body.model_dump(exclude={"kind"}, exclude_none=True)
    try:
        job = jobs.create(db, c.ws, body.kind, params, p)
    except jobs.JobError as e:
        raise HTTPException(409, str(e)) from e
    await jobs.dispatch(job.id)
    return job_dict(job)


async def _quick(db: Session, c: Ctx, kind: str, params: dict, p: Project, timeout: float = 300) -> dict:
    try:
        job = await jobs.run_now(db, c.ws, kind, params, p, timeout)
    except jobs.JobError as e:
        raise HTTPException(409, str(e)) from e
    d = job_dict(job, full=True)
    return d


class CompileBody(BaseModel):
    path: str = ""
    node: str = ""
    inline: str = ""


@router.post("/compile")
async def compile_(body: CompileBody, p: Project = Depends(get_project), c: Ctx = Depends(need("member")),
                   db: Session = Depends(get_db)) -> dict:
    node = body.node or (artifacts.node_for_path(p.path, body.path, tp(p)) if body.path else "")
    params: dict = {"node": node}
    if body.inline:
        params["inline"] = body.inline
    elif node:
        params["select"] = _selector(node)
    elif body.path:
        params["select"] = f"path:{body.path}"
    d = await _quick(db, c, "compile", params, p)
    compiled = d["result"].get("compiled")
    if compiled is None and body.path and not node:
        node = artifacts.node_for_path(p.path, body.path, tp(p)) or ""
        detail = artifacts.node_detail(p.path, node, tp(p)) if node else None
        compiled = detail["compiled_code"] if detail else None
    return {"status": d["status"], "compiled": compiled, "node": node,
            "errors": [l["text"] for l in d["log"] if l["level"] == "err"]}


def _selector(uid: str) -> str:
    parts = uid.split(".")
    if parts[0] == "source":
        return f"source:{parts[2]}.{parts[3]}"
    if parts[0] == "test":
        return parts[2]  # test ids end in a hash: test.pkg.name.abc123
    if parts[0] in ("model", "seed", "snapshot", "analysis"):
        return parts[-1] if len(parts) == 3 else ".".join(parts[2:])
    return parts[-1]


def wrap_inline(sql: str) -> str:
    """dbt show appends its own `limit`, which breaks a query that already ends in one (or in `;`).
    Running the query as a subquery lets both limits apply."""
    body = sql.strip().rstrip(";").strip()
    return f"select * from (\n{body}\n) as wb_query"


class ShowBody(BaseModel):
    node: str = ""
    path: str = ""
    inline: str = ""
    limit: int | None = None


@router.post("/show")
async def show(body: ShowBody, p: Project = Depends(get_project), c: Ctx = Depends(need("member")),
               db: Session = Depends(get_db)) -> dict:
    limit = body.limit or int(appsettings.get(db, "preview_limit", c.ws) or 500)
    params: dict = {"limit": min(limit, 10000)}
    node = body.node or (artifacts.node_for_path(p.path, body.path, tp(p)) if body.path else "")
    if body.inline:
        params["inline"] = wrap_inline(body.inline)
    elif node:
        params["select"] = _selector(node)
    else:
        raise HTTPException(400, "Nothing to preview. Parse the project first.")
    d = await _quick(db, c, "show", params, p)
    rows = d["result"].get("rows") or []
    cols = list(rows[0].keys()) if rows else []
    return {"status": d["status"], "rows": rows, "columns": cols, "limit": params["limit"],
            "errors": [l["text"] for l in d["log"] if l["level"] == "err"], "job_id": d["id"]}


class DebugBody(BaseModel):
    target: str = ""


@router.post("/debug")
async def debug(body: DebugBody, p: Project = Depends(get_project), c: Ctx = Depends(need("member")),
                db: Session = Depends(get_db)) -> dict:
    d = await _quick(db, c, "debug", {"target": body.target} if body.target else {}, p, timeout=120)
    return {"status": d["status"], "checks": d["result"].get("checks", []), "log": d["log"], "job_id": d["id"],
            "finished_at": d["finished_at"]}


@router.post("/parse")
async def parse(p: Project = Depends(get_project), c: Ctx = Depends(need("member")), db: Session = Depends(get_db)) -> dict:
    d = await _quick(db, c, "parse", {}, p)
    return {"status": d["status"], "errors": [l["text"] for l in d["log"] if l["level"] == "err"], "log": d["log"]}


# ---------- graph, nodes ----------

@router.get("/graph")
def graph(select: str = "", p: Project = Depends(get_project)) -> dict:
    g = artifacts.graph(p.path, tp(p))
    if g is None:
        raise _no_manifest()
    _add_pipelines(p, g)
    try:
        g["selected"] = sorted(artifacts.select(g, select)) if select else None
    except Exception as e:
        raise HTTPException(400, f"Couldn't read that selector: {e}") from e
    g["stale"] = projects_stale(p)
    return g


def _add_pipelines(p: Project, g: dict) -> None:
    """Put dlt pipelines upstream of the dbt sources they load."""
    from ..dlt import service as dlt_service

    nodes, links = dlt_service.lineage_nodes(p)
    if not nodes:
        return
    m = artifacts.manifest(p.path, tp(p)) or {}
    srcs = [(uid, (s.get("schema") or "").lower(), (s.get("identifier") or s.get("name") or "").lower())
            for uid, s in (m.get("sources") or {}).items()]
    g["nodes"] += nodes
    seen = set()
    for pid, dataset, table in links:
        for uid, schema, ident in srcs:
            if schema == (dataset or "").lower() and (table == "*" or ident == table.lower()) and (pid, uid) not in seen:
                seen.add((pid, uid))
                g["edges"].append({"source": pid, "target": uid})


def projects_stale(p: Project) -> list[str]:
    from ..projects import stale_files

    return stale_files(p.path)


@router.get("/node")
def node(id: str, p: Project = Depends(get_project)) -> dict:
    d = artifacts.node_detail(p.path, id, tp(p))
    if d is None:
        raise HTTPException(404, "Not in the manifest. Parse the project again.")
    g = artifacts.graph(p.path, tp(p))
    d["impact"] = artifacts.impact(g, id) if g else None
    return d


# ---------- tests ----------

@router.get("/tests")
def tests(p: Project = Depends(get_project)) -> dict:
    t = artifacts.tests_overview(p.path, tp(p))
    if t is None:
        raise _no_manifest()
    return t


@router.post("/tests/failures")
async def failures(body: ShowBody, p: Project = Depends(get_project), c: Ctx = Depends(need("member")),
                   db: Session = Depends(get_db)) -> dict:
    """Failing rows for a test: runs the test's compiled SQL with dbt show."""
    t = artifacts.tests_overview(p.path, tp(p)) or {"tests": []}
    test = next((x for x in t["tests"] if x["id"] == body.node), None)
    if test is None:
        raise HTTPException(404, "Test not found.")
    sql = test["compiled_code"]
    if not sql:
        await _quick(db, c, "compile", {"select": _selector(body.node), "node": body.node}, p)
        t = artifacts.tests_overview(p.path, tp(p)) or {"tests": []}
        test = next((x for x in t["tests"] if x["id"] == body.node), test)
        sql = test["compiled_code"]
    if not sql:
        raise HTTPException(409, "Couldn't compile this test.")
    d = await _quick(db, c, "show", {"inline": sql, "limit": body.limit or 100}, p)
    rows = d["result"].get("rows") or []
    return {"status": d["status"], "rows": rows, "columns": list(rows[0].keys()) if rows else [], "sql": sql,
            "errors": [l["text"] for l in d["log"] if l["level"] == "err"]}


# ---------- sources, docs ----------

@router.get("/freshness")
def fresh(p: Project = Depends(get_project)) -> dict:
    f = artifacts.freshness(p.path, tp(p))
    if f is None:
        raise _no_manifest()
    return f


@router.get("/docs")
def docs(p: Project = Depends(get_project)) -> dict:
    d = artifacts.docs_index(p.path, tp(p))
    if d is None:
        raise _no_manifest()
    return d


@router.get("/docs/export")
def export_docs(p: Project = Depends(get_project)) -> StreamingResponse:
    t = Path(p.path) / tp(p)
    if not (t / "index.html").exists() or not (t / "catalog.json").exists():
        raise HTTPException(409, "Generate docs first.")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name in ("index.html", "manifest.json", "catalog.json", "run_results.json", "sources.json"):
            if (t / name).exists():
                z.write(t / name, name)
    buf.seek(0)
    return StreamingResponse(buf, media_type="application/zip",
                             headers={"Content-Disposition": f'attachment; filename="{p.name}-docs.zip"'})


# ---------- connections ----------

def _profile_name(p: Project) -> str:
    from ..projects import info

    return info(p.path)["profile"]


@router.get("/connections")
def connections(p: Project = Depends(get_project), c: Ctx = Depends(ctx), db: Session = Depends(get_db)) -> dict:
    out = profiles.summary(db, c.ws, jobs.profiles_path(p), _profile_name(p))
    out["adapters"] = {k: v for k, v in profiles.SCHEMAS.items()}
    if get_settings().hosted:
        out["path"] = "profiles.yml (stored by Marthouse)"
    return out


@router.get("/connections/target")
def get_target(profile: str, target: str, p: Project = Depends(get_project), c: Ctx = Depends(ctx),
               db: Session = Depends(get_db)) -> dict:
    try:
        d = profiles.get_target(db, c.ws, jobs.profiles_path(p), profile, target)
    except KeyError as e:
        raise HTTPException(404, "Target not found.") from e
    d["block"] = profiles.block_text(profiles.load(jobs.profiles_path(p)), profile, target)
    return d


class TargetBody(BaseModel):
    profile: str
    target: str
    fields: dict
    secrets: dict[str, str] = {}
    make_default: bool = False
    rename_to: str | None = None


@router.post("/connections/preview")
def preview_target(body: TargetBody, p: Project = Depends(get_project), c: Ctx = Depends(ctx),
                   db: Session = Depends(get_db)) -> dict:
    return profiles.save_target(db, c.ws, jobs.profiles_path(p), body.profile, body.target, body.fields,
                                {k: "x" for k, v in body.secrets.items() if v}, body.make_default, body.rename_to, dry_run=True)


@router.put("/connections/target")
def save_target(body: TargetBody, p: Project = Depends(get_project), c: Ctx = Depends(need("admin")),
                db: Session = Depends(get_db)) -> dict:
    return profiles.save_target(db, c.ws, jobs.profiles_path(p), body.profile, body.target, body.fields,
                                body.secrets, body.make_default, body.rename_to)


@router.delete("/connections/target")
def delete_target(profile: str, target: str, p: Project = Depends(get_project), c: Ctx = Depends(need("admin"))) -> dict:
    profiles.delete_target(jobs.profiles_path(p), profile, target)
    return {"ok": True}


# ---------- settings, updates, formatting ----------

@top.get("/settings")
def get_settings_(c: Ctx = Depends(ctx), db: Session = Depends(get_db)) -> dict:
    return appsettings.get_all(db, c.ws)


@top.patch("/settings")
def patch_settings(values: dict, c: Ctx = Depends(ctx), db: Session = Depends(get_db)) -> dict:
    admin_only = {"default_dbt", "allowed_versions", "index_url", "offline_folder", "hidden_installs"}
    if any(k in admin_only for k in values) and not c.at_least("admin"):
        raise HTTPException(403, "This needs the admin role.")
    return appsettings.update(db, values, c.ws)


@top.get("/updates")
async def updates(c: Ctx = Depends(ctx), db: Session = Depends(get_db)) -> dict:
    st = appsettings.get_all(db, c.ws)
    out: dict = {"app": {"current": __version__, "latest": __version__, "url": None, "configured": False}}
    feed = get_settings().update_feed_url
    if feed:
        try:
            async with httpx.AsyncClient(timeout=6) as client:
                r = (await client.get(feed)).json()
            out["app"].update({"latest": r.get("version", __version__), "url": r.get("url"), "configured": True})
        except Exception:
            out["app"]["error"] = "Couldn't reach the update server."
    out["app"]["available"] = Version(out["app"]["latest"]) > Version(__version__)
    default = st.get("default_dbt")
    current = None
    if default:
        inst = await asyncio.to_thread(detect.inspect, default)
        current = inst.core
    v = await asyncio.to_thread(install.available_versions, st["allowed_versions"], st["index_url"])
    newer = None
    if current and v["latest"]:
        try:
            newer = v["latest"] if Version(v["latest"]) > Version(current) else None
        except Exception:
            newer = None
    out["dbt"] = {"current": current, "latest": v["latest"], "newer": newer, "online": v["online"], "path": default}
    return out


class FormatBody(BaseModel):
    sql: str


@top.post("/format")
async def format_sql(body: FormatBody, c: Ctx = Depends(ctx), db: Session = Depends(get_db)) -> dict:
    if appsettings.get(db, "formatter", c.ws) != "sqlfmt":
        raise HTTPException(400, "Choose a formatter in Settings › Editor.")
    uvx = str(Path(install.uv_bin()).with_name(exe("uvx")))
    argv = [uvx, "--from", "shandy-sqlfmt[jinjafmt]", "sqlfmt", "-"]
    if not Path(uvx).exists():
        argv = [install.uv_bin(), "tool", "run", "--from", "shandy-sqlfmt[jinjafmt]", "sqlfmt", "-"]
    r = await asyncio.to_thread(subprocess.run, argv, input=body.sql, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    if r.returncode not in (0, 1) or not r.stdout:
        raise HTTPException(400, (r.stderr or "sqlfmt failed").strip().splitlines()[-1])
    return {"sql": r.stdout}


# ---------- docs and tests without YAML ----------

def _new_style(db: Session, p: Project, ws: str) -> bool:
    try:
        core = detect.inspect(jobs.resolve_dbt(db, p, ws)).core
        return core is None or Version(core) >= Version("1.10")
    except Exception:
        return True


def _node(p: Project, uid: str) -> dict:
    m = artifacts.manifest(p.path, tp(p))
    if m is None:
        raise _no_manifest()
    n = (m.get("nodes") or {}).get(uid) or (m.get("sources") or {}).get(uid)
    if n is None:
        raise HTTPException(404, "Not in the manifest. Parse the project again.")
    return n


@router.get("/docs/yml")
def docs_yml(id: str, p: Project = Depends(get_project)) -> dict:
    from .. import schema_yml

    return schema_yml.read(p.path, _node(p, id), "")


class DocsBody(BaseModel):
    id: str
    description: str | None = None
    columns: dict[str, dict] = {}
    dry_run: bool = False


@router.post("/docs/yml")
def docs_save(body: DocsBody, p: Project = Depends(get_project), c: Ctx = Depends(need("member")), db: Session = Depends(get_db)) -> dict:
    from .. import schema_yml

    try:
        return schema_yml.apply(p.path, _node(p, body.id), "", body.description, body.columns, _new_style(db, p, c.ws), body.dry_run)
    except Exception as e:
        raise HTTPException(400, f"Couldn't update the YAML: {e}") from e


# ---------- staging models ----------

def _source_columns(p: Project, uid: str) -> tuple[str, str, list[dict]]:
    n = _node(p, uid)
    if n.get("resource_type") != "source":
        raise HTTPException(400, "Pick a source table.")
    cols: list[dict] = []
    cat = artifacts.catalog(p.path, tp(p)) or {}
    centry = (cat.get("sources") or {}).get(uid) or {}
    for c in (centry.get("columns") or {}).values():
        cols.append({"name": c["name"], "type": c.get("type") or "", "index": c.get("index", 0)})
    cols.sort(key=lambda c: c.get("index", 0))
    if not cols:  # fall back to the dlt schema, then to what the yml declares
        from ..dlt import service as dlt_service

        for spec in dlt_service.list_specs(p):
            data = dlt_service.cached(p, spec["name"]) or {}
            if (data.get("dataset") or "").lower() != (n.get("schema") or "").lower():
                continue
            t = next((t for t in data.get("tables") or [] if t["name"] == (n.get("identifier") or n["name"])), None)
            if t:
                cols = [{"name": c["name"], "type": c.get("type") or "", "primary_key": c.get("primary_key")} for c in t["columns"]]
                break
    if not cols:
        cols = [{"name": k, "type": v.get("data_type") or ""} for k, v in (n.get("columns") or {}).items()]
    if not cols:
        raise HTTPException(409, "Marthouse doesn't know this table's columns yet. Generate docs (it reads them from the warehouse) and try again.")
    return n["source_name"], n["name"], cols


@router.get("/staging/propose")
def staging_propose(id: str, p: Project = Depends(get_project)) -> dict:
    from .. import staging

    source, table, cols = _source_columns(p, id)
    out = staging.propose(source, table, cols)
    out.update({"source": source, "table": table})
    out["sql"] = staging.render_sql(source, table, out["columns"])
    return out


class StagingBody(BaseModel):
    id: str
    path: str
    columns: list[dict]
    key_alias: str | None = None
    preview: bool = False


@router.post("/staging")
def staging_write(body: StagingBody, p: Project = Depends(get_project), c: Ctx = Depends(need("member")), db: Session = Depends(get_db)) -> dict:
    from .. import staging
    from ..projects import ProjectError

    source, table, _ = _source_columns(p, body.id)
    try:
        if body.preview:
            return {"sql": staging.render_sql(source, table, body.columns)}
        return staging.write(p.path, source, table, body.path, body.columns, body.key_alias, _new_style(db, p, c.ws))
    except ProjectError as e:
        raise HTTPException(400, str(e)) from e


# ---------- visual model builder ----------

class VisualBody(BaseModel):
    spec: dict
    upto: int | None = None
    limit: int = 100


def _visual_errs(d: dict) -> list[str]:
    return [l["text"] for l in d["log"] if l["level"] == "err"]


@router.post("/visual/sql")
def visual_sql(body: VisualBody, p: Project = Depends(get_project)) -> dict:
    from .. import visual

    try:
        return {"sql": visual.model_sql(body.spec), "step_sql": visual.body(body.spec, body.upto) if body.upto is not None else None}
    except visual.VisualError as e:
        raise HTTPException(400, str(e)) from e


@router.post("/visual/preview")
async def visual_preview(body: VisualBody, p: Project = Depends(get_project), c: Ctx = Depends(need("member")),
                         db: Session = Depends(get_db)) -> dict:
    """Rows after step `upto`, plus the column names even when there are no rows."""
    from .. import visual

    try:
        sql = visual.body(body.spec, body.upto)
    except visual.VisualError as e:
        raise HTTPException(400, str(e)) from e
    d = await _quick(db, c, "show", {"inline": sql, "limit": min(max(body.limit, 1), 1000)}, p)
    rows = d["result"].get("rows") or []
    cols = list(rows[0].keys()) if rows else []
    errors = _visual_errs(d)
    if not rows and not errors:
        probe = await _quick(db, c, "show", {"inline": visual.columns_probe(sql), "limit": 1}, p)
        prow = (probe["result"].get("rows") or [{}])[0]
        cols = [k for k in prow.keys() if k != "wb_probe_one"]
    return {"rows": rows, "columns": cols, "errors": errors, "sql": sql}


class VisualSave(BaseModel):
    spec: dict
    path: str
    overwrite: bool = False


@router.post("/visual/save")
def visual_save(body: VisualSave, p: Project = Depends(get_project), c: Ctx = Depends(need("member"))) -> dict:
    from .. import visual
    from ..projects import ProjectError, safe_path

    if not re.fullmatch(r"models/[A-Za-z0-9_./-]+\.sql", body.path) or ".." in body.path:
        raise HTTPException(400, "Save under models/ with a .sql name, using letters, numbers and _.")
    try:
        f = safe_path(p.path, body.path)
        if f.exists():
            existing = visual.parse(f.read_text(encoding="utf-8"))
            if not body.overwrite or existing is None:
                raise HTTPException(409, f"{body.path} already exists." if existing is None else "exists")
            if existing["edited"]:
                raise HTTPException(409, f"{body.path} was edited by hand since the builder saved it. Save under a new name.")
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(visual.model_sql(body.spec), encoding="utf-8")
    except visual.VisualError as e:
        raise HTTPException(400, str(e)) from e
    except ProjectError as e:
        raise HTTPException(400, str(e)) from e
    return {"path": body.path}


@router.get("/visual/load")
def visual_load(path: str, p: Project = Depends(get_project)) -> dict:
    from .. import visual
    from ..projects import ProjectError, safe_path

    try:
        f = safe_path(p.path, path)
    except ProjectError as e:
        raise HTTPException(400, str(e)) from e
    if not f.is_file():
        raise HTTPException(404, "File not found.")
    r = visual.parse(f.read_text(encoding="utf-8"))
    if r is None:
        raise HTTPException(409, "This model wasn't made in the visual builder.")
    return {**r, "path": path}
