H = {"X-Marthouse": "1"}


def test_local_needs_token_header_and_localhost(app_env):
    c = app_env("local", launch_token="tok123")
    assert c.get("/api/system").status_code == 401
    r = c.get("/launch", params={"token": "nope"}, follow_redirects=False)
    assert r.status_code == 403
    r = c.get("/launch", params={"token": "tok123"}, follow_redirects=False)
    assert r.status_code in (302, 307)
    assert c.get("/api/system").status_code == 200  # cookie set
    assert c.patch("/api/settings", json={"appearance": "light"}).status_code == 403  # no X-Marthouse header
    assert c.patch("/api/settings", json={"appearance": "light"}, headers=H).json()["appearance"] == "light"
    assert c.get("/api/system", headers={"host": "evil.example:8765"}).status_code == 403


def test_path_confinement(app_env, tmp_path):
    c = app_env("local", no_token=1)
    proj = tmp_path / "p"
    from marthouse.projects import scaffold

    scaffold(tmp_path, "p")
    pid = c.post("/api/projects/open", json={"path": str(proj)}, headers=H).json()["id"]
    assert c.get(f"/api/projects/{pid}/file", params={"path": "../../etc/passwd"}).status_code == 400
    assert c.put(f"/api/projects/{pid}/file", json={"path": "models/a.sql", "content": "select 1"}, headers=H).status_code == 200
    assert c.get(f"/api/projects/{pid}/file", params={"path": "models/a.sql"}).json()["content"] == "select 1"
    assert c.get(f"/api/projects/{pid}/graph").status_code == 409  # never parsed


def test_hosted_accounts_and_roles(app_env, tmp_path):
    c = app_env("hosted")
    assert c.get("/api/system").status_code == 401
    assert c.post("/api/auth/signup", json={"email": "a@x.io", "password": "short"}, headers=H).status_code == 400
    r = c.post("/api/auth/signup", json={"email": "a@x.io", "password": "long-enough-pw", "name": "Ann", "workspace": "Acme"}, headers=H)
    assert r.status_code == 200
    ws = r.json()["workspace"]
    assert c.get("/api/system").json()["role"] == "owner"
    # no plan limits: any number of projects
    for n in ("one", "two"):
        r = c.post("/api/projects/new", json={"name": n}, headers=H)
        assert r.status_code == 200, r.text
    # second user, added as viewer, cannot edit
    c.post("/api/auth/logout", headers=H)
    c.post("/api/auth/signup", json={"email": "b@x.io", "password": "long-enough-pw"}, headers=H)
    c.post("/api/auth/logout", headers=H)
    c.post("/api/auth/login", json={"email": "a@x.io", "password": "long-enough-pw"}, headers=H)
    assert c.post("/api/workspace/members", json={"email": "b@x.io", "role": "viewer"}, headers={**H, "X-Workspace": ws}).status_code == 200
    c.post("/api/auth/logout", headers=H)
    assert c.post("/api/auth/login", json={"email": "b@x.io", "password": "wrong-password"}, headers=H).status_code == 401
    c.post("/api/auth/login", json={"email": "b@x.io", "password": "long-enough-pw"}, headers=H)
    hv = {**H, "X-Workspace": ws}
    projects = c.get("/api/projects", headers=hv).json()
    assert len(projects) == 2 and all(p["path"] == "" for p in projects)  # server paths are never shown in hosted mode
    pid = projects[0]["id"]
    assert c.put(f"/api/projects/{pid}/file", json={"path": "models/x.sql", "content": "x"}, headers=hv).status_code == 403
    assert c.get("/api/system/browse", headers=hv).status_code == 404  # no server file browsing
    # someone outside the workspace can't see it
    c.post("/api/auth/logout", headers=H)
    c.post("/api/auth/signup", json={"email": "c@x.io", "password": "long-enough-pw"}, headers=H)
    assert c.get(f"/api/projects/{pid}", headers=hv).status_code == 403
    assert c.get(f"/api/projects/{pid}").status_code == 404
