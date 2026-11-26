from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import jobs, scheduler, secrets_store
from ..db import get_db
from ..models import Job, Project, Schedule
from ..security import Ctx, ctx, need
from .common import get_project
from .jobs_api import job_dict

router = APIRouter(prefix="/api/projects/{project_id}/schedules", tags=["schedules"])


def sched_dict(db: Session, s: Schedule) -> dict:
    last = db.get(Job, s.last_job_id) if s.last_job_id else None
    return {"id": s.id, "name": s.name, "cadence": s.cadence, "steps": s.steps, "enabled": s.enabled,
            "description": scheduler.describe(s.cadence), "next_run_at": s.next_run_at, "last_run_at": s.last_run_at,
            "last_job": job_dict(last) if last else None, "alert_on_failure": s.alert_on_failure,
            "has_webhook": secrets_store.has_secret(db, s.workspace_id, f"WEBHOOK_{s.id}")}


@router.get("")
def list_schedules(p: Project = Depends(get_project), db: Session = Depends(get_db)) -> list[dict]:
    return [sched_dict(db, s) for s in db.query(Schedule).filter(Schedule.project_id == p.id).order_by(Schedule.created_at)]


class Body(BaseModel):
    name: str
    cadence: dict
    steps: list[dict]
    enabled: bool = True
    alert_on_failure: bool = False
    webhook_url: str = ""


def _check(body: Body, db: Session, p: Project, ws: str) -> datetime:
    if not body.name.strip():
        raise HTTPException(400, "Give the schedule a name.")
    try:
        nxt = scheduler.next_run(body.cadence, datetime.now(timezone.utc))
        scheduler.build_steps(db, p, body.steps, ws)
    except (scheduler.CadenceError, jobs.JobError, ValueError) as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # e.g. a pipeline that no longer exists
        raise HTTPException(400, str(e)) from e
    if body.webhook_url and not body.webhook_url.startswith("https://"):
        raise HTTPException(400, "Use an https:// webhook URL.")
    return nxt


@router.post("")
def create(body: Body, p: Project = Depends(get_project), c: Ctx = Depends(need("admin")), db: Session = Depends(get_db)) -> dict:
    nxt = _check(body, db, p, c.ws)
    s = Schedule(workspace_id=c.ws, project_id=p.id, name=body.name.strip(), cadence=body.cadence, steps=body.steps,
                 enabled=body.enabled, alert_on_failure=body.alert_on_failure, next_run_at=nxt if body.enabled else None)
    db.add(s)
    db.commit()
    if body.webhook_url:
        secrets_store.set_secret(db, c.ws, f"WEBHOOK_{s.id}", body.webhook_url)
    return sched_dict(db, s)


def _get(db: Session, p: Project, sid: str) -> Schedule:
    s = db.get(Schedule, sid)
    if s is None or s.project_id != p.id:
        raise HTTPException(404, "Schedule not found.")
    return s


@router.put("/{sid}")
def update(sid: str, body: Body, p: Project = Depends(get_project), c: Ctx = Depends(need("admin")), db: Session = Depends(get_db)) -> dict:
    s = _get(db, p, sid)
    nxt = _check(body, db, p, c.ws)
    s.name, s.cadence, s.steps, s.enabled, s.alert_on_failure = body.name.strip(), body.cadence, body.steps, body.enabled, body.alert_on_failure
    s.next_run_at = nxt if body.enabled else None
    db.commit()
    if body.webhook_url:
        secrets_store.set_secret(db, c.ws, f"WEBHOOK_{s.id}", body.webhook_url)
    return sched_dict(db, s)


@router.delete("/{sid}")
def delete(sid: str, p: Project = Depends(get_project), c: Ctx = Depends(need("admin")), db: Session = Depends(get_db)) -> dict:
    s = _get(db, p, sid)
    secrets_store.delete_secret(db, c.ws, f"WEBHOOK_{s.id}")
    db.delete(s)
    db.commit()
    return {"ok": True}


@router.post("/{sid}/run")
async def run_now(sid: str, p: Project = Depends(get_project), c: Ctx = Depends(need("member")), db: Session = Depends(get_db)) -> dict:
    s = _get(db, p, sid)
    try:
        job = await scheduler.start(db, s, manual=True)
    except jobs.JobError as e:
        raise HTTPException(400, str(e)) from e
    return job_dict(job)


class PreviewBody(BaseModel):
    cadence: dict


@router.post("-preview")
def preview(body: PreviewBody, p: Project = Depends(get_project), c: Ctx = Depends(ctx)) -> dict:
    try:
        t = datetime.now(timezone.utc)
        runs = []
        for _ in range(3):
            t = scheduler.next_run(body.cadence, t)
            runs.append(t)
        return {"next": runs, "description": scheduler.describe(body.cadence), "cron": scheduler.to_cron(body.cadence)}
    except scheduler.CadenceError as e:
        raise HTTPException(400, str(e)) from e
