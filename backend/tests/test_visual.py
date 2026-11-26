import os
import shutil
from pathlib import Path

import pytest

from marthouse import visual

SPEC = {"materialized": "table", "steps": [
    {"type": "source", "ref": "customers"},
    {"type": "filter", "match": "all", "conditions": [{"column": "number_of_orders", "op": "gt", "value": "0"},
                                                      {"column": "first_name", "op": "contains", "value": "O'Ne"}]},
    {"type": "join", "how": "left", "with": {"ref": "orders"}, "on": [{"left": "customer_id", "right": "customer_id"}],
     "columns": [{"name": "amount", "as": "order_amount"}]},
    {"type": "formula", "name": "big", "expression": "order_amount > 20"},
    {"type": "group", "by": ["customer_id", "first_name"], "aggs": [{"fn": "sum", "column": "order_amount", "as": "total"}, {"fn": "count", "as": "orders"}]},
    {"type": "sort", "by": [{"column": "total", "desc": True}], "limit": "10"},
]}


def test_sql_is_readable_and_round_trips():
    sql = visual.model_sql(SPEC)
    assert sql.startswith("{# marthouse:visual ")
    old = sql.replace("marthouse:visual", "workbench:visual", 1)
    assert visual.parse(old)["edited"] is False  # files saved before the rename still open
    assert "{{ config(materialized='table') }}" in sql and "{{ ref('customers') }}" in sql and "{{ ref('orders') }} as joined" in sql
    assert "first_name like '%O''Ne%'" in sql and "number_of_orders > 0" in sql
    assert "sum(order_amount) as total" in sql and "count(*) as orders" in sql and "group by 1, 2" in sql
    assert "order by total desc" in sql and "limit 10" in sql
    assert sql.strip().endswith("select * from sorted_6")
    parsed = visual.parse(sql)
    assert parsed == {"spec": {"steps": SPEC["steps"], "materialized": "table"}, "edited": False}
    assert visual.parse(sql.replace("limit 10", "limit 20"))["edited"] is True
    assert visual.parse("select 1") is None


def test_partial_and_errors():
    assert "select * from filtered_2" in visual.body(SPEC, upto=1)
    with pytest.raises(visual.VisualError):
        visual.body({"steps": [{"type": "filter"}]})
    with pytest.raises(visual.VisualError):
        visual.step_sql({"type": "formula", "name": "x", "expression": "1; drop table t"}, "prev")
    assert visual.q("Order Date") == '"Order Date"' and visual.lit("5") == "5" and visual.lit("a'b") == "'a''b'"


DBT = os.environ.get("MARTHOUSE_TEST_DBT")
EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "jaffle_shop_duckdb"
H = {"X-Marthouse": "1"}


@pytest.mark.skipif(not DBT, reason="set MARTHOUSE_TEST_DBT to a dbt with the duckdb adapter")
def test_builder_against_dbt(app_env, tmp_path):
    proj = tmp_path / "shop"
    shutil.copytree(EXAMPLE, proj, ignore=shutil.ignore_patterns("target", "*.duckdb", "logs", "pipelines"))
    with app_env("local", no_token=1) as c:
        c.post("/api/dbt/default", json={"path": DBT}, headers=H)
        pid = c.post("/api/projects/open", json={"path": str(proj)}, headers=H).json()["id"]
        import time
        j = c.post(f"/api/projects/{pid}/jobs", json={"kind": "build"}, headers=H).json()
        for _ in range(240):
            if c.get(f"/api/jobs/{j['id']}").json()["status"] in ("success", "error"):
                break
            time.sleep(0.25)
        spec = {**SPEC, "steps": SPEC["steps"][:1] + SPEC["steps"][2:]}  # drop the name filter
        for i in range(len(spec["steps"])):
            r = c.post(f"/api/projects/{pid}/visual/preview", json={"spec": spec, "upto": i, "limit": 5}, headers=H).json()
            assert not r["errors"], (i, r["errors"])
            assert r["columns"], i
        last = c.post(f"/api/projects/{pid}/visual/preview", json={"spec": spec, "upto": 4}, headers=H).json()
        assert last["columns"] == ["customer_id", "first_name", "total", "orders"] and len(last["rows"]) == 10
        empty = {"steps": [{"type": "source", "ref": "customers"}, {"type": "filter", "conditions": [{"column": "customer_id", "op": "lt", "value": "0"}]}]}
        e = c.post(f"/api/projects/{pid}/visual/preview", json={"spec": empty, "upto": 1}, headers=H).json()
        assert e["rows"] == [] and "customer_id" in e["columns"]
        s = c.post(f"/api/projects/{pid}/visual/save", json={"spec": spec, "path": "models/marts/top_customers.sql"}, headers=H)
        assert s.status_code == 200
        f = c.get(f"/api/projects/{pid}/file", params={"path": "models/marts/top_customers.sql"}).json()
        assert f["visual"] == {"edited": False}
        assert c.get(f"/api/projects/{pid}/visual/load", params={"path": "models/marts/top_customers.sql"}).json()["spec"]["steps"] == spec["steps"]
        j = c.post(f"/api/projects/{pid}/jobs", json={"kind": "build", "select": "top_customers"}, headers=H).json()
        for _ in range(240):
            d = c.get(f"/api/jobs/{j['id']}").json()
            if d["status"] in ("success", "error"):
                break
            time.sleep(0.25)
        assert d["status"] == "success", [l["text"] for l in d["log"]][-10:]
