from __future__ import annotations

import asyncio
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import jobs
from ..config import get_settings
from ..db import get_db
from ..dlt import codegen, service
from ..models import Job, Project, Schedule
from ..security import Ctx, ctx, need
from .common import get_project
from .jobs_api import job_dict

router = APIRouter(prefix="/api/projects/{project_id}/pipelines", tags=["pipelines"])


def _err(e: Exception) -> HTTPException:
    return HTTPException(400, str(e))


def _summary(db: Session, p: Project, spec: dict) -> dict:
    c = service.cached(p, spec["name"]) or {}
    last = (db.query(Job).filter(Job.project_id == p.id, Job.kind.in_(("pipeline", "chain")))
            .order_by(Job.created_at.desc()).limit(40).all())
    last_job = next((j for j in last if any(st.get("pipeline") == spec["name"] for st in j.command)), None)
    rows = (c.get("trace") or {}).get("rows") or {}
    scheds = [s for s in db.query(Schedule).filter(Schedule.project_id == p.id, Schedule.enabled.is_(True))
              if any(st.get("type") == "pipeline" and st.get("name") == spec["name"] for st in s.steps)]
    nxt = min((s.next_run_at for s in scheds if s.next_run_at), default=None)
    return {"name": spec["name"], "kind": spec.get("kind"), "dataset": spec.get("dataset"), "destination": spec.get("destination") or {"type": "dbt"},
            "error": spec.get("error"), "tables": len(c.get("tables") or []), "rows": sum(rows.values()),
            "last_job": job_dict(last_job) if last_job else None, "loaded_at": (c.get("trace") or {}).get("finished_at"),
            "next_run": nxt}


@router.get("")
def list_pipelines(p: Project = Depends(get_project), db: Session = Depends(get_db)) -> list[dict]:
    return [_summary(db, p, s) for s in service.list_specs(p)]


class SpecBody(BaseModel):
    spec: dict
    secrets: dict[str, str] = {}


@router.post("/preview")
def preview(body: SpecBody, p: Project = Depends(get_project), db: Session = Depends(get_db)) -> dict:
    spec = body.spec
    errs = codegen.validate(spec)
    try:
        dest, env = service.resolve_destination(db, p, spec)
        dest_err = ""
    except Exception as e:
        dest, env, dest_err = "duckdb", {}, str(e)
    code = ""
    if not errs and spec.get("kind") != "verified":
        try:
            code = codegen.generate(spec, dest)
        except Exception as e:
            errs.append(str(e))
    env_names = sorted(set(re.findall(r'os\.environ\["([A-Z0-9_]+)"\]', code)) | {k for k in env})
    return {"code": code, "errors": errs, "destination": dest, "destination_error": dest_err,
            "secrets": codegen.secret_fields(spec), "env": env_names}


@router.get("/{name}")
def get_pipeline(name: str, p: Project = Depends(get_project), db: Session = Depends(get_db)) -> dict:
    try:
        spec = service.get_spec(p, name)
    except service.PipelineError as e:
        raise HTTPException(404, str(e)) from e
    from .. import secrets_store

    script = service.script_path(p, spec)
    secrets = [{**f, "stored": secrets_store.has_secret(db, p.workspace_id, codegen.secret_env(name, f["key"]))}
               for f in codegen.secret_fields(spec)]
    return {"spec": spec, "summary": _summary(db, p, spec), "inspect": service.cached(p, name),
            "code": script.read_text(encoding="utf-8") if script.exists() else "", "script": script.name, "secrets": secrets}


@router.put("/{name}")
def save(name: str, body: SpecBody, p: Project = Depends(get_project), c: Ctx = Depends(need("member")),
         db: Session = Depends(get_db)) -> dict:
    spec = {**body.spec, "name": name}
    try:
        return {"spec": service.save(db, p, spec, body.secrets)}
    except Exception as e:
        raise _err(e) from e


@router.delete("/{name}")
def delete(name: str, p: Project = Depends(get_project), c: Ctx = Depends(need("member"))) -> dict:
    try:
        service.delete(p, name)
    except service.PipelineError as e:
        raise HTTPException(404, str(e)) from e
    return {"ok": True}


class RunBody(BaseModel):
    refresh: bool = False
    then_build: bool = False  # load, then dbt build everything that reads this dataset


@router.post("/{name}/run")
async def run(name: str, body: RunBody, p: Project = Depends(get_project), c: Ctx = Depends(need("member")),
              db: Session = Depends(get_db)) -> dict:
    try:
        spec = service.get_spec(p, name)
        step = service.run_step(db, p, spec)
        step["refresh"] = body.refresh
        steps = [step]
        kind, title = "pipeline", f"Load {name}" + (" (full refresh)" if body.refresh else "")
        if body.then_build:
            dbt = jobs.resolve_dbt(db, p, c.ws)
            params = {"select": f"source:{spec['dataset']}+"}
            steps.append({"label": jobs.describe("build", params), "argv": jobs.dbt_argv(dbt, "build", params, p), "dbt": "build"})
            kind, title = "chain", f"Load {name}, then build what reads it"
        job = jobs.create(db, c.ws, kind, {"pipeline": name}, p, steps=steps, title=title)
    except (service.PipelineError, jobs.JobError) as e:
        raise _err(e) from e
    await jobs.dispatch(job.id)
    return job_dict(job)


@router.post("/{name}/inspect")
async def inspect(name: str, p: Project = Depends(get_project), db: Session = Depends(get_db)) -> dict:
    try:
        return await asyncio.to_thread(service.inspect, db, p, name)
    except Exception as e:
        raise _err(e) from e


class QueryBody(BaseModel):
    table: str
    limit: int = 100


@router.post("/{name}/data")
async def data(name: str, body: QueryBody, p: Project = Depends(get_project), c: Ctx = Depends(need("member")),
               db: Session = Depends(get_db)) -> dict:
    """Preview a loaded table. Uses dbt show when there's a dbt project on the same connection."""
    spec = service.get_spec(p, name)
    if not re.fullmatch(r"[a-z0-9_]+", body.table):
        raise HTTPException(400, "Bad table name.")
    from ..projects import info

    if not info(p.path)["has_dbt"]:
        raise HTTPException(409, "Previewing rows needs a dbt project on the same connection.")
    sql = f"select * from {spec['dataset']}.{body.table}"
    job = await jobs.run_now(db, c.ws, "show", {"inline": sql, "limit": min(body.limit, 1000)}, p)
    rows = (job.result or {}).get("rows") or []
    errs = [l.split("\t", 1)[-1] for l in (job.log or "").splitlines() if l.startswith("err\t")]
    return {"rows": rows, "columns": list(rows[0].keys()) if rows else [], "errors": errs, "sql": sql}


@router.post("/{name}/dbt-sources")
def dbt_sources(name: str, p: Project = Depends(get_project), c: Ctx = Depends(need("member")), db: Session = Depends(get_db)) -> dict:
    spec = service.get_spec(p, name)
    try:
        dest, _ = service.resolve_destination(db, p, spec)
        adapter = {"mssql": "sqlserver", "motherduck": "duckdb"}.get(dest, dest)
        return service.generate_sources(p, name, adapter)
    except Exception as e:
        raise _err(e) from e


class TryBody(BaseModel):
    url: str
    headers: dict[str, str] = {}
    auth: dict = {}
    secret: str = ""


@router.post("/try-request")
async def try_request(body: TryBody, p: Project = Depends(get_project), c: Ctx = Depends(need("member"))) -> dict:
    headers = dict(body.headers)
    t = body.auth.get("type")
    if t == "bearer" and body.secret:
        headers["Authorization"] = f"Bearer {body.secret}"
    elif t == "api_key" and body.secret and body.auth.get("location", "header") == "header":
        headers[body.auth.get("name") or "X-API-Key"] = body.secret
    url = body.url
    if t == "api_key" and body.secret and body.auth.get("location") == "query":
        url += ("&" if "?" in url else "?") + f"{body.auth.get('name') or 'api_key'}={body.secret}"
    try:
        return await asyncio.to_thread(service.try_request, url, headers, get_settings().hosted)
    except service.PipelineError as e:
        raise _err(e) from e
    except Exception as e:
        raise HTTPException(400, f"The request failed: {e}") from e


@router.get("-verified")
async def verified(p: Project = Depends(get_project), c: Ctx = Depends(ctx), db: Session = Depends(get_db)) -> list[dict]:
    try:
        py = service.default_python(db, c.ws, p)
        return await asyncio.to_thread(service.verified_sources, py)
    except Exception as e:
        raise _err(e) from e


class InitBody(BaseModel):
    source: str
    name: str
    dataset: str
    destination: dict = {"type": "dbt"}


@router.post("-verified")
async def init_verified(body: InitBody, p: Project = Depends(get_project), c: Ctx = Depends(need("member")),
                        db: Session = Depends(get_db)) -> dict:
    """Runs `dlt init <source> <destination>` in pipelines/ and records a spec for it."""
    if not re.fullmatch(r"[a-z0-9_]+", body.source) or not codegen.NAME_RE.match(body.name):
        raise HTTPException(400, "Use lowercase letters, numbers and _.")
    spec = {"name": body.name, "kind": "verified", "dataset": body.dataset, "destination": body.destination,
            "verified": {"source": body.source, "script": f"{body.source}_pipeline.py"}}
    try:
        dest, _ = service.resolve_destination(db, p, spec)
        py = service.default_python(db, c.ws, p)
    except Exception as e:
        raise _err(e) from e
    from pathlib import Path

    d = service.pdir(p)
    d.mkdir(parents=True, exist_ok=True)
    dlt_bin = str(Path(py).with_name("dlt"))
    steps = [{"label": f"dlt init {body.source} {dest}", "argv": [dlt_bin, "--non-interactive", "--yes", "init", body.source, dest], "cwd": str(d)}]
    job = jobs.create(db, c.ws, "dlt_init", {"source": body.source, "name": body.name}, p, steps=steps, title=f"Add the {body.source} source")
    service.save(db, p, spec, {})
    await jobs.dispatch(job.id)
    return {"job_id": job.id}


@router.post("/{name}/verified-refresh")
def verified_refresh(name: str, p: Project = Depends(get_project), c: Ctx = Depends(need("member")), db: Session = Depends(get_db)) -> dict:
    """After dlt init: find the pipeline name in the script and the secrets it expects."""
    spec = service.get_spec(p, name)
    v = spec.get("verified") or {}
    script = service.script_path(p, spec)
    if not script.exists():
        raise HTTPException(409, "dlt init hasn't written the script yet.")
    m = re.findall(r'pipeline_name\s*=\s*["\']([A-Za-z0-9_]+)["\']', script.read_text(encoding="utf-8"))
    v["pipeline_name"] = m[0] if m else v.get("pipeline_name") or name
    v["secret_keys"] = service.read_verified_secrets(p, v["source"])
    spec["verified"] = v
    service.save(db, p, spec, {})
    return {"spec": spec}
