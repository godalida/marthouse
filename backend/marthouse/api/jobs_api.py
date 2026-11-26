from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from .. import jobs
from ..config import get_settings
from ..db import SessionLocal, get_db
from ..events import hub
from ..models import Job, Membership
from ..security import COOKIE, LOCAL_COOKIE, Ctx, ctx, current_user, need

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


def job_dict(j: Job, full: bool = False) -> dict:
    d = {"id": j.id, "project_id": j.project_id, "kind": j.kind, "title": j.title, "status": j.status,
         "created_at": j.created_at, "started_at": j.started_at, "finished_at": j.finished_at, "params": j.params,
         "summary": (j.result or {}).get("summary"),
         "command": [s.get("display") for s in j.command]}
    if full:
        d["log"] = [{"level": l.split("\t", 1)[0], "text": l.split("\t", 1)[-1]} for l in (j.log or "").splitlines()]
        d["nodes"] = j.nodes
        d["result"] = {k: v for k, v in (j.result or {}).items()}
        d["steps"] = [{"label": s["label"], "display": s.get("display")} for s in j.command]
    return d


@router.get("")
def list_jobs(project_id: str | None = None, kinds: str | None = None, limit: int = 50,
              c: Ctx = Depends(ctx), db: Session = Depends(get_db)) -> list[dict]:
    q = db.query(Job).filter(Job.workspace_id == c.ws)
    if project_id:
        q = q.filter(Job.project_id == project_id)
    ks = kinds.split(",") if kinds else sorted(jobs.HISTORY_KINDS)
    q = q.filter(Job.kind.in_(ks))
    return [job_dict(j) for j in q.order_by(Job.created_at.desc()).limit(min(limit, 200))]


@router.get("/{job_id}")
def get_job(job_id: str, c: Ctx = Depends(ctx), db: Session = Depends(get_db)) -> dict:
    j = db.get(Job, job_id)
    if j is None or j.workspace_id != c.ws:
        raise HTTPException(404, "Job not found.")
    return job_dict(j, full=True)


@router.post("/{job_id}/cancel")
async def cancel(job_id: str, c: Ctx = Depends(need("member")), db: Session = Depends(get_db)) -> dict:
    j = db.get(Job, job_id)
    if j is None or j.workspace_id != c.ws:
        raise HTTPException(404, "Job not found.")
    return {"ok": await jobs.cancel(job_id)}


@router.websocket("/{job_id}/ws")
async def stream(ws: WebSocket, job_id: str) -> None:
    s = get_settings()
    # authorise like ctx(), using the cookies the browser sends with the upgrade
    with SessionLocal() as db:
        j = db.get(Job, job_id)
        ok = j is not None
        if ok and not s.hosted:
            ok = s.no_token or ws.cookies.get(LOCAL_COOKIE) == s.launch_token
        elif ok:
            from starlette.requests import Request

            class _R:  # minimal shim for current_user
                cookies = ws.cookies

            user = current_user(_R(), db)  # type: ignore[arg-type]
            ok = user is not None and db.query(Membership).filter(Membership.user_id == user.id, Membership.workspace_id == j.workspace_id).first() is not None
        status = j.status if j else None
    if not ok:
        await ws.close(code=4403)
        return
    await ws.accept()
    try:
        if status in ("success", "error", "cancelled") and not getattr(hub(), "has", lambda _: True)(job_id):
            with SessionLocal() as db:
                j = db.get(Job, job_id)
                await ws.send_json({"type": "status", "status": j.status, "nodes": j.nodes, "replay": True})
            await ws.close()
            return
        async for ev in hub().subscribe(job_id):
            await ws.send_json(ev)
        await ws.close()
    except WebSocketDisconnect:
        return
