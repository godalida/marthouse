"""dlt pipelines end to end, then the hand-off to dbt.
Opt in: MARTHOUSE_TEST_DLT_PY=/path/to/python (env with dlt[duckdb,sql-database,filesystem] + pandas)
        MARTHOUSE_TEST_DBT=/path/to/bin/dbt (with dbt-duckdb)"""
import json
import os
import shutil
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

DLT_PY = os.environ.get("MARTHOUSE_TEST_DLT_PY")
DBT = os.environ.get("MARTHOUSE_TEST_DBT")
EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "jaffle_shop_duckdb"
H = {"X-Marthouse": "1"}


class Api(BaseHTTPRequestHandler):
    def do_GET(self):  # /items?page=N  -> {"data": [...], "next": url|null}
        q = parse_qs(urlparse(self.path).query)
        page = int(q.get("page", ["1"])[0])
        items = [{"id": (page - 1) * 3 + i, "name": f"item {(page - 1) * 3 + i}", "tags": [{"t": "a"}]} for i in range(1, 4)]
        nxt = f"http://127.0.0.1:{self.server.server_port}/items?page={page + 1}" if page < 3 else None
        body = json.dumps({"data": items, "next": nxt}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


@pytest.mark.skipif(not (DLT_PY and DBT), reason="set MARTHOUSE_TEST_DLT_PY and MARTHOUSE_TEST_DBT")
def test_dlt_pipelines_then_dbt(app_env, tmp_path):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Api)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    proj = tmp_path / "shop"
    shutil.copytree(EXAMPLE, proj, ignore=shutil.ignore_patterns("target", "*.duckdb", "logs"))
    db = sqlite3.connect(tmp_path / "app.db")
    db.execute("create table products (id integer primary key, title text, updated_at text)")
    db.executemany("insert into products values (?,?,?)", [(i, f"p{i}", f"2026-01-0{i}") for i in range(1, 6)])
    db.commit()
    db.close()

    with app_env("local", no_token=1) as c:
        c.post("/api/dbt/default", json={"path": DBT}, headers=H)
        c.post("/api/tools/dlt/default", json={"path": DLT_PY}, headers=H)
        pid = c.post("/api/projects/open", json={"path": str(proj)}, headers=H).json()["id"]
        base = f"/api/projects/{pid}/pipelines"

        # dbt and dlt share one DuckDB file, so their DuckDB versions must match; Workbench offers to fix it
        from marthouse.dbt import detect
        from marthouse.dlt import tool

        want = tool.duckdb_version(detect.inspect(DBT).python)
        if tool.duckdb_version(DLT_PY) != want:
            j = c.post("/api/tools/dlt/align-duckdb", json={"version": want}, headers=H).json()
            for _ in range(240):
                if c.get(f"/api/jobs/{j['job_id']}").json()["status"] in ("success", "error"):
                    break
                time.sleep(0.25)
        assert tool.duckdb_version(DLT_PY) == want

        def wait(job_id):
            for _ in range(600):
                d = c.get(f"/api/jobs/{job_id}").json()
                if d["status"] in ("success", "error", "cancelled"):
                    return d
                time.sleep(0.25)
            raise AssertionError("timed out")

        port = srv.server_port
        tried = c.post(f"{base}/try-request", json={"url": f"http://127.0.0.1:{port}/items"}, headers=H).json()
        assert tried["status"] == 200 and tried["lists"][0]["path"] == "data" and tried["paginator"]["type"] == "json_link"

        specs = {
            "api_items": {"kind": "rest_api", "dataset": "raw_api", "write_disposition": "merge",
                          "rest_api": {"base_url": f"http://127.0.0.1:{port}", "paginator": {"type": "json_link", "next_url_path": "next"},
                                       "resources": [{"name": "items", "path": "items", "data_selector": "data", "primary_key": "id"}]}},
            "app_db": {"kind": "sql_database", "dataset": "raw_app",
                       "sql_database": {"dialect": "sqlite", "path": str(tmp_path / "app.db"),
                                        "tables": [{"name": "products", "incremental_column": "updated_at", "primary_key": "id"}]}},
            "csv_files": {"kind": "filesystem", "dataset": "raw_files",
                          "filesystem": {"bucket_url": "seeds", "tables": [{"name": "customers", "glob": "raw_customers.csv", "format": "csv"}]}},
        }
        for name, spec in specs.items():
            pv = c.post(f"{base}/preview", json={"spec": {"name": name, **spec}}, headers=H).json()
            assert pv["errors"] == [] and pv["destination"] == "duckdb", pv
            r = c.put(f"{base}/{name}", json={"spec": spec}, headers=H)
            assert r.status_code == 200, r.text
            job = wait(c.post(f"{base}/{name}/run", json={}, headers=H).json()["id"])
            assert job["status"] == "success", [l["text"] for l in job["log"]][-15:]
            rows = job["result"]["pipelines"][name]["rows"]
            assert sum(rows.values()) > 0, job["result"]

        listed = {p["name"]: p for p in c.get(base).json()}
        assert listed["api_items"]["rows"] == 9 + 9 and listed["app_db"]["rows"] == 5  # 9 items + 9 nested tags
        assert c.get(f"{base}/api_items").json()["inspect"]["loads"]

        # hand-off: sources yml, parse, graph, staging, build
        r = c.post(f"{base}/api_items/dbt-sources", headers=H).json()
        assert r["source"] == "raw_api" and r["tables_added"] == 2
        assert c.post(f"/api/projects/{pid}/parse", json={}, headers=H).json()["status"] == "success"
        g = c.get(f"/api/projects/{pid}/graph").json()
        assert {"source": "pipeline.api_items", "target": "source.jaffle_shop.raw_api.items"} in g["edges"]
        prop = c.get(f"/api/projects/{pid}/staging/propose", params={"id": "source.jaffle_shop.raw_api.items"}).json()
        assert prop["key"] == "id" and prop["model"] == "stg_raw_api__items"
        w = c.post(f"/api/projects/{pid}/staging", json={"id": "source.jaffle_shop.raw_api.items", "path": prop["path"],
                                                        "columns": prop["columns"], "key_alias": "item_id"}, headers=H).json()
        assert (proj / w["sql"]).exists()
        chain = wait(c.post(f"{base}/api_items/run", json={"then_build": True}, headers=H).json()["id"])
        assert chain["status"] == "success", [l["text"] for l in chain["log"]][-20:]
        assert chain["nodes"].get("model.jaffle_shop.stg_raw_api__items", {}).get("status") == "success"

        # docs without YAML
        d = c.post(f"/api/projects/{pid}/docs/yml", json={"id": "model.jaffle_shop.stg_raw_api__items", "description": "API items.",
                                                          "columns": {"name": {"description": "Item name", "tests": [{"type": "not_null"}]}}}, headers=H)
        assert d.status_code == 200 and "Item name" in (proj / d.json()["path"]).read_text()

        # schedules: run now, and the background loop picks up a due one
        s = c.post(f"/api/projects/{pid}/schedules", json={"name": "Morning load", "cadence": {"kind": "daily", "time": "07:00", "tz": "UTC"},
                                                           "steps": [{"type": "pipeline", "name": "app_db"}, {"type": "dbt", "kind": "build", "select": "source:raw_app+"}]},
                   headers=H).json()
        assert wait(c.post(f"/api/projects/{pid}/schedules/{s['id']}/run", headers=H).json()["id"])["status"] == "success"
        from marthouse.db import SessionLocal
        from marthouse.models import Schedule
        from datetime import datetime, timedelta, timezone

        with SessionLocal() as db:
            row = db.get(Schedule, s["id"])
            row.next_run_at = datetime.now(timezone.utc) - timedelta(minutes=1)
            db.commit()
        for _ in range(100):
            jobs_ = c.get("/api/jobs", params={"project_id": pid, "kinds": "chain"}).json()
            if any(j["params"].get("schedule_id") == s["id"] and not j["params"].get("manual") for j in jobs_):
                break
            time.sleep(0.5)
        else:
            raise AssertionError("schedule didn't fire")
    srv.shutdown()
