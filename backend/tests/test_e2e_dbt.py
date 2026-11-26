"""Full run against a real dbt. Opt in: MARTHOUSE_TEST_DBT=/path/to/bin/dbt (with dbt-duckdb) pytest -k e2e"""
import os
import shutil
import time
from pathlib import Path

import pytest

DBT = os.environ.get("MARTHOUSE_TEST_DBT")
EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "jaffle_shop_duckdb"
H = {"X-Marthouse": "1"}


@pytest.mark.skipif(not DBT, reason="set MARTHOUSE_TEST_DBT to a dbt with the duckdb adapter")
def test_e2e_build_test_docs(app_env, tmp_path):
    proj = tmp_path / "jaffle"
    shutil.copytree(EXAMPLE, proj, ignore=shutil.ignore_patterns("target", "*.duckdb", "logs"))
    with app_env("local", no_token=1) as c:
        c.post("/api/dbt/default", json={"path": DBT}, headers=H)
        pid = c.post("/api/projects/open", json={"path": str(proj)}, headers=H).json()["id"]
        assert c.post(f"/api/projects/{pid}/debug", json={}, headers=H).json()["status"] == "success"

        def run(kind):
            j = c.post(f"/api/projects/{pid}/jobs", json={"kind": kind}, headers=H).json()
            for _ in range(240):
                d = c.get(f"/api/jobs/{j['id']}").json()
                if d["status"] in ("success", "error", "cancelled"):
                    return d
                time.sleep(0.5)
            raise AssertionError("timed out")

        b = run("build")
        assert b["status"] == "success", b["log"][-20:]
        assert b["summary"]["counts"]["pass"] >= 10
        assert c.get(f"/api/projects/{pid}/tests").json()["counts"]["fail"] == 0
        assert run("docs")["status"] == "success"
        assert c.get(f"/api/projects/{pid}/docs/export").status_code == 200
        show = c.post(f"/api/projects/{pid}/show", json={"node": "model.jaffle_shop.customers", "limit": 5}, headers=H).json()
        assert show["status"] == "success" and len(show["rows"]) == 5
        comp = c.post(f"/api/projects/{pid}/compile", json={"path": "models/marts/orders.sql"}, headers=H).json()
        assert "credit_card_amount" in comp["compiled"]
        fr = run("freshness")
        assert fr["status"] in ("success", "error")
        rows = {r["name"]: r["status"] for r in c.get(f"/api/projects/{pid}/freshness").json()["rows"]}
        assert rows["jaffle.raw_orders"] == "pass" and rows["jaffle.raw_payments"] == "warn"
