"""Schedules: chains of pipeline loads and dbt commands run on a cadence.

Local mode: a loop inside the app checks every 30 s (so schedules only run while Marthouse is open).
Hosted mode with the queue: the worker calls tick() every minute (arq cron).
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx
from sqlalchemy.orm import Session

from . import jobs, secrets_store
from .db import SessionLocal
from .models import Job, Project, Schedule

log = logging.getLogger("marthouse.scheduler")
WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


class CadenceError(ValueError):
    pass


def _field(spec: str, lo: int, hi: int) -> set[int]:
    out: set[int] = set()
    for part in spec.split(","):
        step = 1
        if "/" in part:
            part, s = part.split("/", 1)
            step = int(s)
        if part in ("*", ""):
            a, b = lo, hi
        elif "-" in part:
            a, b = (int(x) for x in part.split("-", 1))
        else:
            a = b = int(part)
        if a < lo or b > hi or a > b or step < 1:
            raise CadenceError(f"'{spec}' is out of range")
        out |= set(range(a, b + 1, step))
    return out


def parse_cron(expr: str) -> tuple[set[int], set[int], set[int], set[int], set[int]]:
    parts = expr.split()
    if len(parts) != 5:
        raise CadenceError("A cron expression has five parts: minute hour day month weekday.")
    try:
        m, h, dom, mon, dow = (_field(parts[0], 0, 59), _field(parts[1], 0, 23), _field(parts[2], 1, 31),
                               _field(parts[3], 1, 12), _field(parts[4].replace("7", "0"), 0, 6))
    except ValueError as e:
        raise CadenceError(f"Couldn't read that cron expression: {e}") from e
    return m, h, dom, mon, dow


def to_cron(c: dict) -> str:
    kind = c.get("kind", "daily")
    hh, mm = (int(x) for x in (c.get("time") or "07:00").split(":"))
    if kind == "hourly":
        return f"{int(c.get('minute', 0))} * * * *"
    if kind == "daily":
        return f"{mm} {hh} * * *"
    if kind == "weekdays":
        return f"{mm} {hh} * * 1-5"
    if kind == "weekly":
        d = WEEKDAYS.index(c.get("day", "mon"))
        return f"{mm} {hh} * * {(d + 1) % 7}"
    if kind == "cron":
        return c.get("cron", "")
    raise CadenceError("Unknown cadence.")


def next_run(c: dict, after: datetime) -> datetime:
    """Next time (UTC) the cadence fires strictly after `after`, evaluated in the schedule's time zone."""
    tz = ZoneInfo(c.get("tz") or "UTC")
    m, h, dom, mon, dow = parse_cron(to_cron(c))
    t = after.astimezone(tz).replace(second=0, microsecond=0) + timedelta(minutes=1)
    for _ in range(60 * 24 * 370):
        cron_dow = (t.weekday() + 1) % 7
        if t.minute in m and t.hour in h and t.day in dom and t.month in mon and cron_dow in dow:
            return t.astimezone(timezone.utc)
        if t.hour not in h or t.day not in dom or t.month not in mon or cron_dow not in dow:
            t = (t + timedelta(hours=1)).replace(minute=0)
        else:
            t += timedelta(minutes=1)
    raise CadenceError("That cadence never runs.")


def describe(c: dict) -> str:
    kind = c.get("kind", "daily")
    tz = c.get("tz") or "UTC"
    if kind == "hourly":
        return f"Every hour at :{int(c.get('minute', 0)):02d}"
    if kind == "daily":
        return f"Every day at {c.get('time', '07:00')} ({tz})"
    if kind == "weekdays":
        return f"Weekdays at {c.get('time', '07:00')} ({tz})"
    if kind == "weekly":
        return f"Every {c.get('day', 'mon').title()} at {c.get('time', '07:00')} ({tz})"
    return f"cron {c.get('cron', '')} ({tz})"


def build_steps(db: Session, project: Project, steps: list[dict], ws: str) -> list[dict]:
    from .dlt import service as dlt_service

    out = []
    dbt = None
    for s in steps:
        if s.get("type") == "pipeline":
            spec = dlt_service.get_spec(project, s["name"])
            st = dlt_service.run_step(db, project, spec)
            st["refresh"] = bool(s.get("refresh"))
            out.append(st)
        elif s.get("type") == "dbt":
            dbt = dbt or jobs.resolve_dbt(db, project, ws)
            params = {k: v for k, v in s.items() if k in ("select", "exclude", "full_refresh", "target") and v}
            out.append({"label": jobs.describe(s["kind"], params), "argv": jobs.dbt_argv(dbt, s["kind"], params, project), "dbt": s["kind"]})
        else:
            raise jobs.JobError("Unknown step.")
    if not out:
        raise jobs.JobError("Add at least one step.")
    return out


async def start(db: Session, sched: Schedule, manual: bool = False) -> Job:
    project = db.get(Project, sched.project_id)
    if project is None:
        raise jobs.JobError("The project is gone.")
    steps = build_steps(db, project, sched.steps, sched.workspace_id)
    job = jobs.create(db, sched.workspace_id, "chain", {"schedule_id": sched.id, "schedule": sched.name, "manual": manual},
                      project, steps=steps, title=f"{sched.name}" + (" (run now)" if manual else ""))
    sched.last_run_at = datetime.now(timezone.utc)
    sched.last_job_id = job.id
    db.commit()
    await jobs.dispatch(job.id)
    return job


async def tick() -> int:
    now = datetime.now(timezone.utc)
    started = 0
    with SessionLocal() as db:
        due = db.query(Schedule).filter(Schedule.enabled.is_(True)).all()
        for s in due:
            nra = s.next_run_at if (s.next_run_at is None or s.next_run_at.tzinfo) else s.next_run_at.replace(tzinfo=timezone.utc)
            if nra is None:
                s.next_run_at = next_run(s.cadence, now)
                continue
            if nra > now:
                continue
            s.next_run_at = next_run(s.cadence, now)
            db.commit()
            if nra < now - timedelta(hours=6):  # missed while the app was closed; don't pile up old runs
                log.info("skipping missed run of %s", s.name)
                continue
            try:
                await start(db, s)
                started += 1
            except Exception as e:  # keep the loop alive
                log.warning("schedule %s couldn't start: %s", s.name, e)
        db.commit()
    return started


async def loop() -> None:
    while True:
        try:
            await tick()
        except Exception as e:
            log.warning("scheduler tick failed: %s", e)
        await asyncio.sleep(30)


async def notify_if_failed(job_id: str) -> None:
    """Called when a job finishes: send the schedule's failure alert, if it has one."""
    with SessionLocal() as db:
        j = db.get(Job, job_id)
        if not j or j.status != "error" or not (j.params or {}).get("schedule_id"):
            return
        s = db.get(Schedule, j.params["schedule_id"])
        if not s or not s.alert_on_failure:
            return
        url = secrets_store.get_secret(db, s.workspace_id, f"WEBHOOK_{s.id}")
        project = db.get(Project, s.project_id)
    if not url:
        return
    text = f"Marthouse: schedule \"{s.name}\" failed in {project.name if project else 'a project'}."
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post(url, json={"text": text, "schedule": s.name, "job_id": job_id, "status": "error"})
    except Exception as e:
        log.warning("alert for %s failed: %s", s.name, e)
