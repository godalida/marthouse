"""Unit tests for dlt code generation, the dbt hand-off, YAML editing, staging models and schedules."""
import ast
import re
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from marthouse import schema_yml, staging
from marthouse.dlt import codegen
from marthouse.scheduler import CadenceError, next_run, to_cron

REST = {"name": "gh", "kind": "rest_api", "dataset": "raw_gh", "write_disposition": "merge",
        "rest_api": {"base_url": "https://api.example.com/v1", "auth": {"type": "bearer"},
                     "paginator": {"type": "json_link", "next_url_path": "next"},
                     "resources": [{"name": "issues", "path": "issues", "primary_key": "id", "data_selector": "items",
                                    "incremental": {"cursor_path": "updated_at", "param": "since", "initial_value": "2024-01-01"}},
                                   {"name": "comments", "path": "issues/{n}/comments", "parent": {"resource": "issues", "field": "number", "param": "n"}}]}}
SQL = {"name": "shop", "kind": "sql_database", "dataset": "raw_shop",
       "sql_database": {"dialect": "postgresql", "host": "db", "port": 5432, "database": "shop", "username": "app",
                        "tables": [{"name": "orders", "incremental_column": "updated_at", "primary_key": "id"}, {"name": "customers"}]}}
FILES = {"name": "csvs", "kind": "filesystem", "dataset": "raw_files",
         "filesystem": {"bucket_url": "data", "tables": [{"name": "orders", "glob": "orders*.csv", "format": "csv", "incremental": True}]}}


@pytest.mark.parametrize("spec", [REST, SQL, FILES])
def test_codegen_is_valid_python_without_secrets(spec):
    assert codegen.validate(spec) == []
    code = codegen.generate(spec, "duckdb")
    ast.parse(code)
    assert "dataset_name='" + spec["dataset"] in code
    # secrets are only ever read from the environment
    assert not any("password" in line.lower() and ("'" in line.split("=", 1)[-1] and "environ" not in line) for line in code.splitlines() if "=" in line)
    if spec["kind"] == "sql_database":
        assert 'os.environ["MARTHOUSE_PIPE_SHOP_PASSWORD"]' in code


def test_codegen_rest_details():
    code = codegen.generate(REST, "postgres")
    assert 'os.environ["MARTHOUSE_PIPE_GH_TOKEN"]' in code
    assert "'type': 'resolve'" in code and "'start_param': 'since'" in code and "'data_selector': 'items'" in code
    assert codegen.secret_fields(REST) == [{"key": "token", "label": "Token"}]


def test_validate_catches_mistakes():
    bad = {**REST, "name": "Bad Name", "rest_api": {**REST["rest_api"], "base_url": "ftp://x", "resources": []}}
    errs = " ".join(codegen.validate(bad))
    assert "Name" in errs and "https" in errs and "endpoint" in errs


def test_dbt_sources_from_dlt_schema_keeps_user_edits(tmp_path):
    from marthouse.dlt import service
    from marthouse.models import Project

    root = tmp_path / "proj"
    (root / "pipelines" / ".dlt-data").mkdir(parents=True)
    (root / "dbt_project.yml").write_text("name: p\nprofile: p\nmodel-paths: ['models']\n")
    p = Project(id="x", workspace_id="local", name="p", path=str(root))
    data = {"ok": True, "dataset": "raw_gh", "tables": [
        {"name": "issues", "parent": None, "resource": "issues", "columns": [
            {"name": "id", "type": "bigint", "primary_key": True, "dlt": False},
            {"name": "title", "type": "text", "primary_key": False, "dlt": False},
            {"name": "_dlt_load_id", "type": "text", "primary_key": False, "dlt": True},
            {"name": "_dlt_id", "type": "text", "primary_key": False, "dlt": True}]},
        {"name": "issues__labels", "parent": "issues", "resource": None, "columns": [
            {"name": "name", "type": "text", "primary_key": False, "dlt": False},
            {"name": "_dlt_parent_id", "type": "text", "primary_key": False, "dlt": True}]}]}
    service.cache_path(p, "gh").write_text(json.dumps(data))
    r = service.generate_sources(p, "gh", "duckdb")
    f = root / r["path"]
    text = f.read_text()
    assert "name: raw_gh" in text and "loader: dlt" in text and "to_timestamp" in text
    assert "_dlt_parent_id" not in text and "unique" in text
    f.write_text(text.replace("name: title", "name: title\n            description: The issue title  # mine"))
    data["tables"][0]["columns"].append({"name": "state", "type": "text", "primary_key": False, "dlt": False})
    service.cache_path(p, "gh").write_text(json.dumps(data))
    r2 = service.generate_sources(p, "gh", "duckdb")
    t2 = f.read_text()
    assert "The issue title  # mine" in t2 and "name: state" in t2 and r2["columns_added"] == 1 and r2["tables_added"] == 0


def test_schema_yml_edit_keeps_comments_and_custom_tests(tmp_path):
    (tmp_path / "models").mkdir()
    yml = tmp_path / "models" / "_models.yml"
    yml.write_text("""version: 2
# team notes
models:
  - name: orders
    columns:
      - name: id
        data_tests:
          - unique
          - dbt_utils.at_least_one
""")
    node = {"resource_type": "model", "name": "orders", "patch_path": "p://models/_models.yml", "original_file_path": "models/orders.sql"}
    schema_yml.apply(tmp_path, node, "p", "One row per order.", {
        "id": {"description": "Key", "tests": [{"type": "unique"}, {"type": "not_null"}]},
        "status": {"tests": [{"type": "accepted_values", "values": ["a", "b"]}]},
        "customer_id": {"tests": [{"type": "relationships", "to": "customers", "field": "customer_id", "severity": "warn"}]},
    }, new_style=True)
    t = yml.read_text()
    assert "# team notes" in t and "dbt_utils.at_least_one" in t and "description: One row per order." in t
    assert "arguments:" in t and "values: [a, b]" in t or "- a" in t
    r = schema_yml.read(tmp_path, node, "p")
    assert r["columns"]["customer_id"]["tests"] == [{"type": "relationships", "to": "customers", "field": "customer_id", "severity": "warn"}]
    assert [x["type"] for x in r["columns"]["id"]["tests"]] == ["unique", "not_null", "dbt_utils.at_least_one"]


def test_staging_generator(tmp_path):
    prop = staging.propose("shop", "raw_orders", [{"name": "id", "type": "int"}, {"name": "OrderDate", "type": "date"},
                                                  {"name": "_dlt_id"}, {"name": "_dlt_load_id"}])
    assert prop["model"] == "stg_shop__raw_orders" and prop["key"] == "id"
    aliases = {c["name"]: c["alias"] for c in prop["columns"]}
    assert aliases == {"id": "order_id", "OrderDate": "order_date", "_dlt_load_id": "_dlt_load_id"}
    sql = staging.render_sql("shop", "raw_orders", prop["columns"])
    assert "{{ source('shop', 'raw_orders') }}" in sql and re.search(r'"OrderDate"\s+as order_date', sql)
    r = staging.write(tmp_path, "shop", "raw_orders", prop["path"], prop["columns"], "order_id", True)
    assert (tmp_path / r["sql"]).exists() and "order_id" in (tmp_path / r["yml"]).read_text()
    with pytest.raises(Exception):
        staging.write(tmp_path, "shop", "raw_orders", "../evil.sql", prop["columns"], None, True)


def test_schedule_times():
    t = datetime(2026, 11, 25, 6, 30, tzinfo=timezone.utc)
    assert next_run({"kind": "daily", "time": "07:00", "tz": "Asia/Manila"}, t) == datetime(2026, 11, 25, 23, 0, tzinfo=timezone.utc)
    assert next_run({"kind": "weekdays", "time": "07:00"}, datetime(2026, 11, 28, 8, tzinfo=timezone.utc)).weekday() == 0
    assert next_run({"kind": "cron", "cron": "*/15 * * * *"}, t).minute == 45
    assert to_cron({"kind": "weekly", "day": "sun", "time": "09:30"}) == "30 9 * * 0"
    with pytest.raises(CadenceError):
        next_run({"kind": "cron", "cron": "61 * * * *"}, t)
