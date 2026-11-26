"""Every dbt (and install) command runs as a Job: queued, streamed live, kept in history."""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from .oscompat import BIN, exe, venv_bin
from . import appsettings, profiles
from .config import get_settings
from .db import SessionLocal
from .dbt import artifacts, detect
from .dbt.install import display
from .events import RedisHub, hub
from .models import Job, Project

HISTORY_KINDS = {"run", "build", "test", "seed", "snapshot", "freshness", "docs", "deps", "install", "clean", "pipeline", "chain", "dlt_init", "dlt_align"}
DBT_KINDS = {"run", "build", "test", "seed", "snapshot", "compile", "parse", "docs", "freshness", "debug", "show", "deps", "ls", "clean"}
RESULT_EVENTS = {"LogModelResult", "LogTestResult", "LogSeedResult", "LogSnapshotResult", "LogFreshnessResult", "LogNodeResult"}
_running: dict[str, asyncio.subprocess.Process] = {}
_tasks: set[asyncio.Task] = set()


class JobError(RuntimeError):
    pass


def now() -> datetime:
    return datetime.now(timezone.utc)


# ---------- resolving which dbt and which profiles ----------

def resolve_dbt(db: Session, project: Project | None, ws: str = "local") -> str:
    if project and project.dbt_path and os.access(project.dbt_path, os.X_OK):
        return project.dbt_path
    default = appsettings.get(db, "default_dbt", ws)
    if default and os.access(default, os.X_OK):
        return default
    if get_settings().hosted:
        found = sorted(get_settings().private_dbt_dir.glob(f"*/{BIN}/{exe('dbt')}"))
        if found:
            return str(found[-1])
        raise JobError("No dbt is installed for this workspace yet. Install one in Settings › dbt.")
    if default:
        raise JobError(f"dbt is no longer at {default}.")
    for inst in detect.scan([project.path] if project else []):
        if inst.status == "ok":
            return inst.path
    raise JobError("dbt isn't installed. Open Settings › dbt to find or install it.")


def profiles_path(project: Project) -> Path:
    if project.profiles_dir:
        return Path(project.profiles_dir) / "profiles.yml"
    if get_settings().hosted:
        return get_settings().workspaces_dir / project.workspace_id / "profiles" / project.id / "profiles.yml"
    return profiles.default_dir(project.path) / "profiles.yml"


def job_env(db: Session, project: Project | None, ws: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("MARTHOUSE_")}
    env["PYTHONUNBUFFERED"] = "1"
    env["DBT_USE_COLORS"] = "false"
    env.setdefault("DBT_SEND_ANONYMOUS_USAGE_STATS", "false")
    env.setdefault("PYTHONUTF8", "1")  # dbt and dlt print UTF-8 on every OS (Windows defaults to its code page)
    env.setdefault("PYTHONIOENCODING", "utf-8")
    if project:
        env.update(profiles.secret_env(db, ws, profiles_path(project)))
    return env


def dbt_argv(dbt: str, kind: str, p: dict[str, Any], project: Project) -> list[str]:
    sub = {"docs": ["docs", "generate"], "freshness": ["source", "freshness"]}.get(kind, [kind])
    a: list[str] = []
    if p.get("select"):
        a += ["--select", *str(p["select"]).split()]
    if p.get("exclude"):
        a += ["--exclude", *str(p["exclude"]).split()]
    if p.get("full_refresh") and kind in ("run", "build", "seed"):
        a.append("--full-refresh")
    if p.get("fail_fast") and kind in ("run", "build", "test"):
        a.append("--fail-fast")
    if p.get("target"):
        a += ["--target", str(p["target"])]
    if p.get("threads"):
        a += ["--threads", str(int(p["threads"]))]
    if p.get("vars"):
        a += ["--vars", json.dumps(p["vars"]) if isinstance(p["vars"], dict) else str(p["vars"])]
    if kind in ("show", "compile") and p.get("inline"):
        a += ["--inline", str(p["inline"])]
    if kind == "show":
        a += ["--limit", str(int(p.get("limit") or 500)), "--output", "json"]
    if kind == "ls":
        a += ["--output", "json"]
    if kind == "docs" and p.get("no_compile"):
        a.append("--no-compile")
    argv = [dbt, *sub, *a, "--project-dir", project.path, "--profiles-dir", str(profiles_path(project).parent)]
    if kind != "debug":
        argv[1:1] = ["--log-format", "json"]
    return argv


def describe(kind: str, p: dict) -> str:
    sub = {"docs": "docs generate", "freshness": "source freshness"}.get(kind, kind)
    parts = ["dbt", sub]
    if p.get("select"):
        parts += ["--select", str(p["select"])]
    if p.get("exclude"):
        parts += ["--exclude", str(p["exclude"])]
    if p.get("full_refresh"):
        parts.append("--full-refresh")
    if p.get("target"):
        parts += ["--target", str(p["target"])]
    return " ".join(parts)


# ---------- creating and dispatching ----------

def create(db: Session, ws: str, kind: str, params: dict | None = None, project: Project | None = None,
           steps: list[dict] | None = None, title: str = "") -> Job:
    params = params or {}
    if steps is None:
        if kind not in DBT_KINDS or project is None:
            raise JobError(f"Unknown job {kind}")
        dbt = resolve_dbt(db, project, ws)
        steps = [{"label": describe(kind, params), "argv": dbt_argv(dbt, kind, params, project)}]
    for s in steps:
        s.setdefault("display", display(s["argv"]))
    job = Job(workspace_id=ws, project_id=project.id if project else None, kind=kind,
              title=title or (describe(kind, params) if kind in DBT_KINDS else kind),
              command=steps, params=params, status="queued")
    db.add(job)
    db.commit()
    return job


async def dispatch(job_id: str) -> None:
    s = get_settings()
    if s.hosted and s.use_queue:
        from arq import create_pool
        from arq.connections import RedisSettings

        pool = await create_pool(RedisSettings.from_dsn(s.redis_url))
        await pool.enqueue_job("run_job", job_id, _job_id=job_id)
        await pool.aclose()
    else:
        t = asyncio.create_task(execute(job_id))
        _tasks.add(t)
        t.add_done_callback(_tasks.discard)


async def wait(job_id: str, timeout: float = 600) -> Job:
    """Wait for a job to finish (used by quick jobs such as compile, show and debug)."""
    async def _w() -> None:
        async for ev in hub().subscribe(job_id):
            if ev.get("type") == "status" and ev.get("status") in ("success", "error", "cancelled"):
                return
    try:
        await asyncio.wait_for(_w(), timeout)
    except asyncio.TimeoutError:
        await cancel(job_id)
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        assert job
        return job


_project_locks: dict[str, asyncio.Lock] = {}


async def run_now(db: Session, ws: str, kind: str, params: dict, project: Project, timeout: float = 300) -> Job:
    """Quick commands (show, compile, parse, debug) take turns per project: two dbt processes
    writing the same target/ folder at once can fail or read a half-written manifest."""
    lock = _project_locks.setdefault(project.id, asyncio.Lock())
    async with lock:
        job = create(db, ws, kind, params, project)
        await dispatch(job.id)
        return await wait(job.id, timeout)


_cancel_requested: set[str] = set()


async def cancel(job_id: str) -> bool:
    _cancel_requested.add(job_id)
    proc = _running.get(job_id)
    if proc and proc.returncode is None:
        proc.terminate()
        return True
    h = hub()
    if isinstance(h, RedisHub):
        await h.request_cancel(job_id)
        return True
    return False


# ---------- executing ----------

def _level(info: dict, data: dict) -> str:
    lvl = info.get("level", "info")
    name = info.get("name", "")
    st = ((data.get("node_info") or {}).get("node_status") or data.get("status") or "").lower()
    if lvl == "error" or st in ("error", "fail", "runtime error"):
        return "err"
    if lvl == "warn" or st == "warn":
        return "wrn"
    if name in RESULT_EVENTS and st in ("success", "pass"):
        return "ok"
    if name in ("StatsLine", "EndOfRunSummary", "FinishedRunningStats", "CommandCompleted"):
        return "hi"
    return "info"


ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
DEBUG_RE = re.compile(r"^(?:\d\d:\d\d:\d\d)?\s*(?:-\s*)?(.+?)\s*\[(OK|ERROR|WARNING)\s*(.*?)\]\s*$")


class _Run:
    def __init__(self, job: Job) -> None:
        self.job_id = job.id
        self.kind = job.kind
        self.lines: list[str] = []
        self.nodes: dict[str, dict] = dict(job.nodes or {})
        self.extra: dict[str, Any] = {}
        self.seq = 0

    async def emit(self, ev: dict) -> None:
        await hub().publish(self.job_id, ev)

    async def line(self, text: str, level: str = "info") -> None:
        self.lines.append(f"{level}\t{text}")
        await self.emit({"type": "line", "text": text, "level": level})

    async def handle(self, raw: str) -> None:
        raw = ANSI.sub("", raw.rstrip("\n"))
        if not raw:
            return
        if raw.startswith("{"):
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                obj = None
            if isinstance(obj, dict) and "info" in obj:
                info, data = obj.get("info") or {}, obj.get("data") or {}
                name = info.get("name", "")
                ni = data.get("node_info") or {}
                uid = ni.get("unique_id")
                if uid:
                    cur = self.nodes.get(uid, {})
                    cur.update({"name": ni.get("node_name"), "type": ni.get("resource_type"),
                                "status": ni.get("node_status"), "started": ni.get("node_started_at") or cur.get("started"),
                                "finished": ni.get("node_finished_at") or None, "path": ni.get("node_path")})
                    if name in RESULT_EVENTS:
                        cur["time"] = data.get("execution_time")
                        cur["message"] = info.get("msg")
                        if data.get("num_failures") is not None:
                            cur["failures"] = data.get("num_failures")
                    self.nodes[uid] = cur
                    await self.emit({"type": "node", "id": uid, "node": cur})
                if name == "ShowNode":
                    try:
                        self.extra["rows"] = json.loads(data.get("preview") or "[]")
                    except Exception:
                        self.extra["rows_raw"] = data.get("preview")
                    if isinstance(self.extra.get("rows"), dict):  # newer dbt wraps rows
                        self.extra["rows"] = self.extra["rows"].get("show", self.extra["rows"])
                    return
                if name == "CompiledNode":
                    self.extra["compiled"] = data.get("compiled")
                    return
                if name == "ListCmdOut":
                    self.extra.setdefault("ls", []).append(data.get("msg") or info.get("msg"))
                    return
                if info.get("level") == "debug":
                    return
                msg = info.get("msg") or ""
                for part in msg.splitlines() or [""]:
                    await self.line(part, _level(info, data))
                return
        await self.line(raw, "err" if re.search(r"\berror\b", raw, re.I) and self.kind != "debug" else "info")


def _preexec():  # pragma: no cover - Linux hosted workers only
    # Own process group, so Stop ends dbt/dlt and anything they started. Memory is limited by the
    # worker container (cgroups), not RLIMIT_AS: uv, DuckDB and warehouse drivers reserve far more
    # virtual memory than they use, and an address-space cap makes them crash.
    os.setsid()


async def execute(job_id: str) -> None:
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        if job is None:
            return
        project = db.get(Project, job.project_id) if job.project_id else None
        env = job_env(db, project, job.workspace_id)
        job.status, job.started_at = "running", now()
        if project and job.kind in ("run", "build", "seed", "snapshot"):
            g = artifacts.graph(project.path, _tp(project))
            if g:
                types = {"run": {"model"}, "seed": {"seed"}, "snapshot": {"snapshot"}, "build": {"model", "seed", "snapshot"}}[job.kind]
                picked = artifacts.select(g, job.params.get("select", "")) if job.params.get("select") else {n["id"] for n in g["nodes"]}
                if job.params.get("exclude"):
                    picked -= artifacts.select(g, job.params["exclude"])
                job.nodes = {n["id"]: {"name": n["name"], "type": n["type"], "status": "queued"} for n in g["nodes"]
                             if n["id"] in picked and n["type"] in types and n["package"] == g.get("project")}
        db.commit()
        steps, kind, ws = list(job.command), job.kind, job.workspace_id
        run = _Run(job)
        # pipeline steps need their destination and source secrets; they're worked out now and never stored
        step_env: dict[int, dict[str, str]] = {}
        for i, st in enumerate(steps):
            if st.get("pipeline") and project:
                from .dlt import service as dlt_service

                try:
                    spec = dlt_service.get_spec(project, st["pipeline"])
                    step_env[i] = dlt_service.run_env(db, project, spec, refresh=bool(st.get("refresh")))
                except Exception as e:  # reported when the step runs
                    step_env[i] = {"__error__": str(e)}
    await run.emit({"type": "status", "status": "running", "nodes": run.nodes})

    status = "success"
    cwd = project.path if project else str(Path.home())
    s = get_settings()
    for i, step in enumerate(steps):
        await run.emit({"type": "step", "index": i, "state": "running", "label": step["label"]})
        await run.line(f"$ {step.get('display') or display(step['argv'])}", "hi")
        extra = step_env.get(i, {})
        if "__error__" in extra:
            await run.line(extra["__error__"], "err")
            status = "error"
            await run.emit({"type": "step", "index": i, "state": "error"})
            break
        try:
            proc = await asyncio.create_subprocess_exec(
                *step["argv"], cwd=step.get("cwd") or cwd, env={**env, **extra}, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                limit=16 * 1024 * 1024,
                **({"preexec_fn": _preexec} if s.hosted and sys.platform.startswith("linux") else {}),
            )
        except (FileNotFoundError, PermissionError) as e:
            await run.line(str(e), "err")
            status = "error"
            await run.emit({"type": "step", "index": i, "state": "error"})
            break
        _running[job_id] = proc
        canceller = asyncio.create_task(_watch_cancel(job_id, proc)) if isinstance(hub(), RedisHub) else None
        try:
            async def pump() -> None:
                assert proc.stdout
                async for raw in proc.stdout:
                    await run.handle(raw.decode(errors="replace"))
            await asyncio.wait_for(pump(), timeout=s.job_timeout_s)
            code = await proc.wait()
        except asyncio.TimeoutError:
            proc.kill()
            await run.line(f"Stopped after {s.job_timeout_s // 60} minutes.", "err")
            code = -9
        finally:
            _running.pop(job_id, None)
            if canceller:
                canceller.cancel()
        if code < 0 and code != -9:
            if job_id in _cancel_requested or (isinstance(hub(), RedisHub) and await hub().cancel_requested(job_id)):
                status = "cancelled"
                await run.line("Stopped.", "wrn")
            else:
                import signal

                try:
                    name = signal.Signals(-code).name
                except ValueError:
                    name = f"signal {-code}"
                status = "error"
                await run.line(f"The process ended unexpectedly ({name}). It may have run out of memory.", "err")
            await run.emit({"type": "step", "index": i, "state": "error"})
            break
        # dbt exits 1 when models/tests fail (results are still read below) and 2 on hard errors
        if code != 0:
            status = "error"
            await run.emit({"type": "step", "index": i, "state": "error"})
            break
        await run.emit({"type": "step", "index": i, "state": "done"})

    result: dict[str, Any] = dict(run.extra)
    try:
        result.update(_post(kind, project, run, status, ws))
    except Exception as e:  # never lose the run because post-processing failed
        result["post_error"] = str(e)

    with SessionLocal() as db:
        job = db.get(Job, job_id)
        assert job
        job.status = status
        job.finished_at = now()
        job.log = "\n".join(run.lines)[-2_000_000:]
        job.nodes = run.nodes
        job.result = result
        db.commit()
    await run.emit({"type": "status", "status": status, "result": _light(result), "nodes": run.nodes})
    if status == "error":
        from .scheduler import notify_if_failed

        await notify_if_failed(job_id)


def _tp(project: Project) -> str:
    try:
        from .projects import info

        return info(project.path)["target_path"]
    except Exception:
        return "target"


def _light(result: dict) -> dict:
    return {k: v for k, v in result.items() if k not in ("rows",)} | ({"has_rows": True} if "rows" in result else {})


async def _watch_cancel(job_id: str, proc: asyncio.subprocess.Process) -> None:
    h = hub()
    assert isinstance(h, RedisHub)
    while proc.returncode is None:
        if await h.cancel_requested(job_id):
            proc.terminate()
            return
        await asyncio.sleep(1)


def _post(kind: str, project: Project | None, run: _Run, status: str, ws: str) -> dict:
    out: dict[str, Any] = {}
    if kind == "dlt_install":
        from .dlt import tool as dlt_tool

        with SessionLocal() as db:
            job = db.get(Job, run.job_id)
            py = str(venv_bin(job.params.get("root", ""), "python")) if job else ""
            if status == "success" and os.path.exists(py):
                inst = dlt_tool.inspect(py, "private")
                out["install"] = inst.to_dict()
                if not appsettings.get(db, "default_dlt", ws) or job.params.get("make_default"):
                    appsettings.update(db, {"default_dlt": py}, ws)
        return out
    if kind == "install":
        with SessionLocal() as db:
            job = db.get(Job, run.job_id)
            root = Path(job.params.get("root", "")) if job else Path()
            if status == "success" and venv_bin(root, "dbt").exists():
                inst = detect.inspect(str(venv_bin(root, "dbt")), "private")
                out["install"] = inst.to_dict()
                if not appsettings.get(db, "default_dbt", ws) or job.params.get("make_default"):
                    appsettings.update(db, {"default_dbt": inst.path}, ws)
        return out
    if project is None:
        return out
    if kind in ("pipeline", "chain", "dlt_init"):
        from .dlt import service as dlt_service

        with SessionLocal() as db:
            job = db.get(Job, run.job_id)
            cmd = list(job.command) if job else []
            names = [st["pipeline"] for st in cmd if st.get("pipeline")]
            pl = {}
            for n in names:
                try:
                    data = dlt_service.inspect(db, project, n)
                    pl[n] = {"rows": (data.get("trace") or {}).get("rows") or {}, "steps": (data.get("trace") or {}).get("steps") or [],
                             "dataset": data.get("dataset"), "destination": data.get("destination")}
                except Exception as e:
                    pl[n] = {"error": str(e)}
        out["pipelines"] = pl
        if kind != "chain" or not any(st.get("dbt") for st in cmd):
            return out
    tp = _tp(project)
    if kind in ("run", "build", "test", "seed", "snapshot", "chain"):
        summ = artifacts.summarize_run(project.path, tp)
        artifacts.remember_run(project.path, tp)
        for r in summ["results"]:
            n = run.nodes.setdefault(r["id"], {})
            n.update({"status": r["status"], "time": r["time"], "message": r["message"], "failures": r["failures"]})
            for t in r["timing"]:
                if t.get("name") == "execute":
                    n["started"], n["finished"] = t.get("started_at"), t.get("completed_at")
            n.setdefault("name", r["id"].split(".")[-1])
            n.setdefault("type", r["id"].split(".")[0])
        out["summary"] = {"counts": summ["counts"], "elapsed": summ["elapsed"]}
    elif kind == "freshness":
        f = artifacts.freshness(project.path, tp) or {"rows": []}
        counts: dict[str, int] = {}
        for r in f["rows"]:
            counts[r["status"] or "none"] = counts.get(r["status"] or "none", 0) + 1
        out["summary"] = {"counts": counts}
    elif kind == "compile":
        with SessionLocal() as db:
            job = db.get(Job, run.job_id)
            node = job.params.get("node", "") if job else ""
        if node and not run.extra.get("compiled"):
            d = artifacts.node_detail(project.path, node, tp)
            if d:
                out["compiled"] = d["compiled_code"]
    elif kind == "debug":
        checks = []
        for l in run.lines:
            text = l.split("\t", 1)[-1]
            m = DEBUG_RE.match(text)
            if m:
                checks.append({"name": m.group(1).strip(" :"), "ok": m.group(2) == "OK", "detail": m.group(3).strip()})
        out["checks"] = checks
    return out
