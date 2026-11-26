"""Who is calling.

Local mode: the server only listens on 127.0.0.1, accepts only localhost Host headers (stops DNS
rebinding), and needs the one-time launch token (turned into a cookie) so other local web pages
can't drive it. Hosted mode: email + password accounts, session cookies, workspace roles.
Both: state-changing requests must carry X-Marthouse: 1, which a cross-site form can't send.
"""
from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_db
from .models import Membership, SessionToken, User, Workspace

COOKIE = "marthouse_session"
LOCAL_COOKIE = "marthouse_local"
ROLES = ["viewer", "member", "admin", "owner"]
_ph = PasswordHasher()


@dataclass
class Ctx:
    ws: str
    role: str
    user: User | None = None
    workspace: Workspace | None = None

    def at_least(self, role: str) -> bool:
        return ROLES.index(self.role) >= ROLES.index(role)


def hash_password(p: str) -> str:
    return _ph.hash(p)


def verify_password(h: str, p: str) -> bool:
    try:
        return _ph.verify(h, p)
    except VerifyMismatchError:
        return False


def _th(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_session(db: Session, user: User) -> str:
    token = secrets.token_urlsafe(32)
    db.add(SessionToken(token_hash=_th(token), user_id=user.id, expires_at=datetime.now(timezone.utc) + timedelta(days=30)))
    db.commit()
    return token


def end_session(db: Session, token: str) -> None:
    row = db.get(SessionToken, _th(token))
    if row:
        db.delete(row)
        db.commit()


def allowed_hosts() -> set[str]:
    s = get_settings()
    hosts = {f"127.0.0.1:{s.port}", f"localhost:{s.port}", "127.0.0.1", "localhost", "testserver"}
    hosts |= {h.strip() for h in s.extra_hosts.split(",") if h.strip()}
    return hosts


def check_request(request: Request) -> None:
    """Runs on every API request (middleware)."""
    s = get_settings()
    if not s.hosted:
        host = request.headers.get("host", "")
        if host not in allowed_hosts():
            raise HTTPException(403, "Marthouse only answers on localhost.")
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        if request.headers.get("x-marthouse") != "1":
            raise HTTPException(403, "Missing X-Marthouse header.")


def current_user(request: Request, db: Session = Depends(get_db)) -> User | None:
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    row = db.get(SessionToken, _th(token))
    if not row:
        return None
    exp = row.expires_at if row.expires_at.tzinfo else row.expires_at.replace(tzinfo=timezone.utc)
    if exp < datetime.now(timezone.utc):
        return None
    return db.get(User, row.user_id)


def ctx(request: Request, db: Session = Depends(get_db), user: User | None = Depends(current_user)) -> Ctx:
    s = get_settings()
    if not s.hosted:
        if not s.no_token and request.cookies.get(LOCAL_COOKIE) != s.launch_token:
            raise HTTPException(401, "Open Marthouse from the link the marthouse command printed.")
        return Ctx(ws="local", role="owner")
    if user is None:
        raise HTTPException(401, "Sign in to continue.")
    ws_id = request.headers.get("x-workspace") or request.query_params.get("ws")
    q = db.query(Membership).filter(Membership.user_id == user.id)
    m = q.filter(Membership.workspace_id == ws_id).first() if ws_id else q.order_by(Membership.id).first()
    if m is None:
        raise HTTPException(403, "You're not a member of this workspace.")
    return Ctx(ws=m.workspace_id, role=m.role, user=user, workspace=db.get(Workspace, m.workspace_id))


def need(role: str):
    def dep(c: Ctx = Depends(ctx)) -> Ctx:
        if not c.at_least(role):
            raise HTTPException(403, f"This needs the {role} role.")
        return c

    return dep
