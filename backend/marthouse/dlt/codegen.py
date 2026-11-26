"""Turn a pipeline spec (pipelines/<name>.pipeline.yml) into a readable dlt script.

Secrets never appear in the script: it reads them from environment variables that Marthouse
sets when it runs the pipeline. The destination is configured the same way (dlt reads
DESTINATION__<NAME>__CREDENTIALS), so the script says which warehouse type it loads into but
not where or as whom.
"""
from __future__ import annotations

import re
from typing import Any

NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,62}$")
DRIVERS = {"postgresql": "postgresql", "mysql": "mysql+pymysql", "mssql": "mssql+pyodbc", "sqlite": "sqlite", "redshift": "postgresql"}
READERS = {"csv": "read_csv", "parquet": "read_parquet", "jsonl": "read_jsonl"}


class Code(str):
    """A Python expression written into the script as-is (e.g. an os.environ lookup)."""


def secret_env(pipeline: str, field: str) -> str:
    return re.sub(r"[^A-Z0-9_]", "_", f"MARTHOUSE_PIPE_{pipeline}_{field}".upper())


def env(pipeline: str, field: str) -> Code:
    return Code(f'os.environ["{secret_env(pipeline, field)}"]')


def render(v: Any, ind: int = 0) -> str:
    pad, inner = "    " * ind, "    " * (ind + 1)
    if isinstance(v, Code):
        return str(v)
    if isinstance(v, dict):
        if not v:
            return "{}"
        items = [f"{inner}{render(k)}: {render(x, ind + 1)}," for k, x in v.items()]
        return "{\n" + "\n".join(items) + f"\n{pad}}}"
    if isinstance(v, (list, tuple)):
        if not v:
            return "[]"
        if all(isinstance(x, (str, int, float)) and not isinstance(x, Code) for x in v) and len(repr(v)) < 70:
            return repr(list(v))
        return "[\n" + "\n".join(f"{inner}{render(x, ind + 1)}," for x in v) + f"\n{pad}]"
    return repr(v)


def validate(spec: dict) -> list[str]:
    errs = []
    if not NAME_RE.match(spec.get("name") or ""):
        errs.append("Name: use lowercase letters, numbers and _ (start with a letter).")
    if not NAME_RE.match(spec.get("dataset") or ""):
        errs.append("Dataset: use lowercase letters, numbers and _.")
    kind = spec.get("kind")
    if kind == "rest_api":
        r = spec.get("rest_api") or {}
        if not str(r.get("base_url", "")).startswith(("http://", "https://")):
            errs.append("Base URL must start with https://")
        if not r.get("resources"):
            errs.append("Add at least one endpoint.")
        for res in r.get("resources") or []:
            if not NAME_RE.match(res.get("name") or ""):
                errs.append(f"Endpoint table name '{res.get('name')}': lowercase letters, numbers and _.")
    elif kind == "sql_database":
        s = spec.get("sql_database") or {}
        if s.get("dialect") not in DRIVERS:
            errs.append("Choose a database type.")
        if not s.get("tables"):
            errs.append("Pick at least one table.")
    elif kind == "filesystem":
        f = spec.get("filesystem") or {}
        if not f.get("bucket_url"):
            errs.append("Set a folder or bucket URL.")
        for t in f.get("tables") or []:
            if not NAME_RE.match(t.get("name") or ""):
                errs.append(f"Table name '{t.get('name')}': lowercase letters, numbers and _.")
        if not f.get("tables"):
            errs.append("Add at least one table (a file pattern).")
    elif kind != "verified":
        errs.append("Unknown source kind.")
    return errs


# ---------- per source kind ----------

def _rest_api(spec: dict) -> tuple[list[str], str]:
    name, r = spec["name"], spec["rest_api"]
    client: dict[str, Any] = {"base_url": r["base_url"].rstrip("/") + "/"}
    auth = r.get("auth") or {}
    t = auth.get("type", "none")
    if t == "bearer":
        client["auth"] = {"type": "bearer", "token": env(name, "token")}
    elif t == "api_key":
        client["auth"] = {"type": "api_key", "name": auth.get("name") or "X-API-Key", "api_key": env(name, "api_key"),
                          "location": auth.get("location") or "header"}
    elif t == "http_basic":
        client["auth"] = {"type": "http_basic", "username": auth.get("username", ""), "password": env(name, "password")}
    if r.get("headers"):
        client["headers"] = dict(r["headers"])
    pg = r.get("paginator") or {"type": "auto"}
    if pg.get("type") and pg["type"] != "auto":
        client["paginator"] = {k: v for k, v in pg.items() if v not in (None, "")}
    resources = []
    for res in r["resources"]:
        ep: dict[str, Any] = {"path": res.get("path") or res["name"]}
        params = dict(res.get("params") or {})
        parent = res.get("parent") or {}
        if parent.get("resource") and parent.get("field") and parent.get("param"):
            params[parent["param"]] = {"type": "resolve", "resource": parent["resource"], "field": parent["field"]}
        if params:
            ep["params"] = params
        if res.get("data_selector"):
            ep["data_selector"] = res["data_selector"]
        inc = res.get("incremental") or {}
        if inc.get("cursor_path"):
            ep["incremental"] = {k: v for k, v in {"start_param": inc.get("param"), "cursor_path": inc["cursor_path"],
                                                   "initial_value": inc.get("initial_value")}.items() if v not in (None, "")}
        item: dict[str, Any] = {"name": res["name"], "endpoint": ep}
        if res.get("primary_key"):
            item["primary_key"] = res["primary_key"]
        if res.get("write_disposition"):
            item["write_disposition"] = res["write_disposition"]
        resources.append(item)
    config = {"client": client, "resources": resources}
    imports = ["from dlt.sources.rest_api import rest_api_source"]
    body = f"def source():\n    return rest_api_source({render(config, 1)}, name={name!r})\n"
    return imports, body


def _sql(spec: dict) -> tuple[list[str], str]:
    name, s = spec["name"], spec["sql_database"]
    dialect = s["dialect"]
    lines = ["def source():"]
    if dialect == "sqlite":
        lines.append(f"    url = {('sqlite:///' + s.get('path', '')).__repr__()}")
    else:
        q = ""
        if dialect == "mssql":
            q = "?driver=" + (s.get("driver") or "ODBC Driver 18 for SQL Server").replace(" ", "+")
        lines.append(f"    password = quote_plus({env(name, 'password')})")
        lines.append(f"    url = f\"{DRIVERS[dialect]}://{s.get('username', '')}:{{password}}@{s.get('host', 'localhost')}:{s.get('port') or ''}/{s.get('database', '')}{q}\"")
    tables = [t["name"] for t in s["tables"]]
    schema = f", schema={s['schema']!r}" if s.get("schema") else ""
    lines.append(f"    src = sql_database(credentials=url{schema}, table_names={render(tables, 1)}, backend=\"sqlalchemy\", chunk_size={int(s.get('chunk_size') or 50000)})")
    for t in s["tables"]:
        hints = []
        if t.get("incremental_column"):
            hints.append(f"incremental=dlt.sources.incremental({t['incremental_column']!r})")
        if t.get("primary_key"):
            hints.append(f"primary_key={t['primary_key']!r}")
        if hints:
            lines.append(f"    src.resources[{t['name']!r}].apply_hints({', '.join(hints)})")
    lines.append("    return src")
    return ["from urllib.parse import quote_plus", "from dlt.sources.sql_database import sql_database"], "\n".join(lines) + "\n"


def _files(spec: dict) -> tuple[list[str], str]:
    f = spec["filesystem"]
    readers = sorted({READERS[t.get("format", "csv")] for t in f["tables"]})
    lines = ["def source():", "    resources = []"]
    for t in f["tables"]:
        lines.append(f"    files = filesystem(bucket_url=BUCKET_URL, file_glob={t.get('glob') or '*'!r})")
        if t.get("incremental"):
            lines.append('    files.apply_hints(incremental=dlt.sources.incremental("modification_date"))')
        lines.append(f"    resources.append((files | {READERS[t.get('format', 'csv')]}()).with_name({t['name']!r}))")
    lines.append("    return resources")
    bucket = f["bucket_url"]
    head = f"BUCKET_URL = {bucket!r}\n\n" if "://" in bucket or bucket.startswith("/") else f"BUCKET_URL = os.path.join(PROJECT_DIR, {bucket!r})\n\n"
    return [f"from dlt.sources.filesystem import filesystem, {', '.join(readers)}"], head + "\n".join(lines) + "\n"


def generate(spec: dict, destination_type: str) -> str:
    if spec["kind"] == "verified":
        raise ValueError("Verified sources keep the script dlt init wrote.")
    imports, body = {"rest_api": _rest_api, "sql_database": _sql, "filesystem": _files}[spec["kind"]](spec)
    wd = spec.get("write_disposition") or "append"
    name = spec["name"]
    return f'''"""{name}: generated by Marthouse from {name}.pipeline.yml.

Marthouse rewrites this file when you save the pipeline; change the pipeline there.
To run it yourself, set the environment variables Marthouse lists in the pipeline's Code tab.
"""
import os

import dlt
{chr(10).join(imports)}

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


{body}

if __name__ == "__main__":
    pipeline = dlt.pipeline(
        pipeline_name={name!r},
        destination={destination_type!r},
        dataset_name={spec["dataset"]!r},
        progress="log",
    )
    info = pipeline.run(
        source(),
        write_disposition={wd!r},
        refresh=os.environ.get("WORKBENCH_REFRESH") or None,
    )
    print(info)
'''


def secret_fields(spec: dict) -> list[dict]:
    """The secrets a spec needs, so the form can ask for them."""
    out = []
    if spec.get("kind") == "rest_api":
        t = ((spec.get("rest_api") or {}).get("auth") or {}).get("type", "none")
        f = {"bearer": "token", "api_key": "api_key", "http_basic": "password"}.get(t)
        if f:
            out.append({"key": f, "label": {"token": "Token", "api_key": "API key", "password": "Password"}[f]})
    elif spec.get("kind") == "sql_database" and (spec.get("sql_database") or {}).get("dialect") != "sqlite":
        out.append({"key": "password", "label": "Password"})
    elif spec.get("kind") == "filesystem" and str((spec.get("filesystem") or {}).get("bucket_url", "")).startswith(("s3://", "gs://", "az://")):
        out += [{"key": "access_key_id", "label": "Access key ID"}, {"key": "secret_access_key", "label": "Secret access key"}]
    elif spec.get("kind") == "verified":
        out += [{"key": k, "label": k} for k in (spec.get("verified") or {}).get("secret_keys", [])]
    return out
