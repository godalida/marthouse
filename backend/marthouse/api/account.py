"""Team mode: accounts, workspaces and members."""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import Membership, User, Workspace
from ..security import COOKIE, ROLES, Ctx, ctx, end_session, hash_password, need, new_session, verify_password

router = APIRouter(prefix="/api", tags=["account"])
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _hosted() -> None:
    if not get_settings().hosted:
        raise HTTPException(404, "Accounts are only used in the hosted app.")


def _set_cookie(resp: Response, token: str) -> None:
    resp.set_cookie(COOKIE, token, httponly=True, samesite="lax", secure=get_settings().cookie_secure, max_age=30 * 86400)


class SignupBody(BaseModel):
    email: str
    password: str
    name: str = ""
    workspace: str = ""


@router.post("/auth/signup")
def signup(body: SignupBody, resp: Response, db: Session = Depends(get_db)) -> dict:
    _hosted()
    email = body.email.strip().lower()
    if not EMAIL.match(email):
        raise HTTPException(400, "Enter a valid email address.")
    if len(body.password) < 10:
        raise HTTPException(400, "Use at least 10 characters for the password.")
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(409, "There's already an account with this email. Sign in instead.")
    u = User(email=email, name=body.name.strip(), password_hash=hash_password(body.password))
    db.add(u)
    db.flush()
    w = Workspace(name=body.workspace.strip() or (f"{body.name.split()[0]}'s workspace" if body.name.strip() else "My workspace"))
    db.add(w)
    db.flush()
    db.add(Membership(workspace_id=w.id, user_id=u.id, role="owner"))
    db.commit()
    _set_cookie(resp, new_session(db, u))
    return {"ok": True, "workspace": w.id}


class LoginBody(BaseModel):
    email: str
    password: str


@router.post("/auth/login")
def login(body: LoginBody, resp: Response, db: Session = Depends(get_db)) -> dict:
    _hosted()
    u = db.query(User).filter(User.email == body.email.strip().lower()).first()
    if u is None or not verify_password(u.password_hash, body.password):
        raise HTTPException(401, "That email and password don't match.")
    _set_cookie(resp, new_session(db, u))
    return {"ok": True}


@router.post("/auth/logout")
def logout(request: Request, resp: Response, db: Session = Depends(get_db)) -> dict:
    tok = request.cookies.get(COOKIE)
    if tok:
        end_session(db, tok)
    resp.delete_cookie(COOKIE)
    return {"ok": True}


class WsBody(BaseModel):
    name: str


@router.post("/workspaces")
def create_ws(body: WsBody, c: Ctx = Depends(ctx), db: Session = Depends(get_db)) -> dict:
    _hosted()
    w = Workspace(name=body.name.strip() or "Workspace")
    db.add(w)
    db.flush()
    db.add(Membership(workspace_id=w.id, user_id=c.user.id, role="owner"))
    db.commit()
    return {"id": w.id, "name": w.name, "role": "owner"}


@router.patch("/workspace")
def rename_ws(body: WsBody, c: Ctx = Depends(need("admin")), db: Session = Depends(get_db)) -> dict:
    _hosted()
    c.workspace.name = body.name.strip() or c.workspace.name
    db.commit()
    return {"ok": True}


@router.get("/workspace")
def workspace(c: Ctx = Depends(ctx), db: Session = Depends(get_db)) -> dict:
    _hosted()
    rows = db.query(Membership, User).join(User, User.id == Membership.user_id).filter(Membership.workspace_id == c.ws).all()
    w = c.workspace
    return {"id": w.id, "name": w.name, "role": c.role,
            "members": [{"id": u.id, "email": u.email, "name": u.name, "role": m.role, "you": u.id == c.user.id} for m, u in rows]}


class MemberBody(BaseModel):
    email: str
    role: str = "member"


@router.post("/workspace/members")
def add_member(body: MemberBody, c: Ctx = Depends(need("admin")), db: Session = Depends(get_db)) -> dict:
    _hosted()
    if body.role not in ROLES or (body.role == "owner" and c.role != "owner"):
        raise HTTPException(400, "Choose another role.")
    u = db.query(User).filter(User.email == body.email.strip().lower()).first()
    if u is None:
        raise HTTPException(404, "Ask them to sign up first, then add them here.")
    if db.query(Membership).filter(Membership.workspace_id == c.ws, Membership.user_id == u.id).first():
        raise HTTPException(409, "They're already a member.")
    db.add(Membership(workspace_id=c.ws, user_id=u.id, role=body.role))
    db.commit()
    return {"ok": True}


class RoleBody(BaseModel):
    role: str


@router.patch("/workspace/members/{user_id}")
def set_role(user_id: str, body: RoleBody, c: Ctx = Depends(need("admin")), db: Session = Depends(get_db)) -> dict:
    _hosted()
    m = db.query(Membership).filter(Membership.workspace_id == c.ws, Membership.user_id == user_id).first()
    if m is None or body.role not in ROLES:
        raise HTTPException(404)
    if (m.role == "owner" or body.role == "owner") and c.role != "owner":
        raise HTTPException(403, "Only an owner can change owners.")
    if m.role == "owner" and body.role != "owner":
        owners = db.query(Membership).filter(Membership.workspace_id == c.ws, Membership.role == "owner").count()
        if owners <= 1:
            raise HTTPException(400, "A workspace needs at least one owner.")
    m.role = body.role
    db.commit()
    return {"ok": True}


@router.delete("/workspace/members/{user_id}")
def remove_member(user_id: str, c: Ctx = Depends(need("admin")), db: Session = Depends(get_db)) -> dict:
    _hosted()
    m = db.query(Membership).filter(Membership.workspace_id == c.ws, Membership.user_id == user_id).first()
    if m is None:
        raise HTTPException(404)
    if m.role == "owner" and db.query(Membership).filter(Membership.workspace_id == c.ws, Membership.role == "owner").count() <= 1:
        raise HTTPException(400, "A workspace needs at least one owner.")
    db.delete(m)
    db.commit()
    return {"ok": True}

