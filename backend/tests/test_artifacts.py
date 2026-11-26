import json

from marthouse.dbt import artifacts


def manifest(tmp_path):
    def node(uid, rt, deps=(), **kw):
        return {"unique_id": uid, "resource_type": rt, "name": uid.split(".")[-1], "package_name": "shop",
                "original_file_path": kw.pop("path", f"models/{uid.split('.')[-1]}.sql"), "config": {"materialized": kw.pop("mat", "view")},
                "depends_on": {"nodes": list(deps)}, "tags": kw.pop("tags", []), "columns": kw.pop("columns", {}), **kw}

    nodes = {
        "model.shop.stg_orders": node("model.shop.stg_orders", "model", ["source.shop.raw.orders"], path="models/staging/stg_orders.sql"),
        "model.shop.orders": node("model.shop.orders", "model", ["model.shop.stg_orders"], mat="table", tags=["finance"], path="models/marts/orders.sql",
                                  columns={"order_id": {"name": "order_id", "description": "pk"}}),
        "model.shop.untested": node("model.shop.untested", "model", ["model.shop.stg_orders"]),
        "test.shop.unique_orders_order_id": node("test.shop.unique_orders_order_id", "test", ["model.shop.orders"], attached_node="model.shop.orders",
                                                 column_name="order_id", test_metadata={"name": "unique"}),
    }
    sources = {"source.shop.raw.orders": {"unique_id": "source.shop.raw.orders", "resource_type": "source", "name": "orders", "source_name": "raw",
                                          "package_name": "shop", "original_file_path": "models/_sources.yml", "loaded_at_field": "_at",
                                          "freshness": {"warn_after": {"count": 12, "period": "hour"}, "error_after": {"count": 1, "period": "day"}}}}
    exposures = {"exposure.shop.dash": {"unique_id": "exposure.shop.dash", "resource_type": "exposure", "name": "dash", "package_name": "shop",
                                        "depends_on": {"nodes": ["model.shop.orders"]}}}
    parent_map = {k: v["depends_on"]["nodes"] for k, v in {**nodes, **exposures}.items()}
    parent_map["source.shop.raw.orders"] = []
    m = {"metadata": {"project_name": "shop", "generated_at": "2026-11-25T00:00:00Z", "dbt_version": "1.10.4"},
         "nodes": nodes, "sources": sources, "exposures": exposures, "parent_map": parent_map, "child_map": {}}
    t = tmp_path / "target"
    t.mkdir()
    (t / "manifest.json").write_text(json.dumps(m))
    (t / "run_results.json").write_text(json.dumps({"metadata": {"generated_at": "x"}, "results": [
        {"unique_id": "model.shop.orders", "status": "success", "execution_time": 0.2},
        {"unique_id": "test.shop.unique_orders_order_id", "status": "fail", "failures": 3, "execution_time": 0.1}]}))
    artifacts.remember_run(tmp_path)
    (t / "sources.json").write_text(json.dumps({"metadata": {"generated_at": "y"}, "results": [
        {"unique_id": "source.shop.raw.orders", "status": "warn", "max_loaded_at_time_ago_in_s": 50000,
         "criteria": {"warn_after": {"count": 12, "period": "hour"}, "error_after": {"count": 1, "period": "day"}}}]}))
    return tmp_path


def test_graph_select_and_impact(tmp_path):
    root = manifest(tmp_path)
    g = artifacts.graph(root)
    ids = {n["id"] for n in g["nodes"]}
    assert "test.shop.unique_orders_order_id" not in ids and "exposure.shop.dash" in ids
    orders = next(n for n in g["nodes"] if n["id"] == "model.shop.orders")
    assert orders["tests"] == 1 and orders["tests_failing"] == 1 and orders["status"] == "success"
    assert artifacts.select(g, "+orders") == {"model.shop.orders", "model.shop.stg_orders", "source.shop.raw.orders"}
    assert artifacts.select(g, "stg_orders+1") == {"model.shop.stg_orders", "model.shop.orders", "model.shop.untested"}
    assert artifacts.select(g, "tag:finance") == {"model.shop.orders"}
    assert artifacts.select(g, "path:models/staging") == {"model.shop.stg_orders"}
    assert artifacts.select(g, "source:raw+,tag:finance") == {"model.shop.orders"}
    imp = artifacts.impact(g, "model.shop.stg_orders")
    assert imp["downstream"] == 3 and imp["exposures"] == ["dash"] and imp["tables"] == 1


def test_tests_freshness_and_status_survive_other_commands(tmp_path):
    root = manifest(tmp_path)
    # a later `dbt compile` overwrites run_results.json; statuses must still come from the last real run
    (root / "target" / "run_results.json").write_text(json.dumps({"metadata": {}, "results": [
        {"unique_id": "test.shop.unique_orders_order_id", "status": "success"}]}))
    t = artifacts.tests_overview(root)
    assert t["counts"]["fail"] == 1 and t["untested"] == ["stg_orders", "untested"]
    f = artifacts.freshness(root)
    row = f["rows"][0]
    assert row["status"] == "warn" and row["warn_s"] == 43200 and row["error_s"] == 86400 and row["downstream"] == 4
    d = artifacts.node_detail(root, "model.shop.orders")
    assert d["columns"][0]["tests"][0]["status"] == "fail"
    assert artifacts.node_for_path(root, "models/marts/orders.sql") == "model.shop.orders"
