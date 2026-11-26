"""Write a staging model for a source table: clean column names, the key renamed, tests on the key."""
from __future__ import annotations

import re
from pathlib import Path

from .projects import ProjectError, safe_path


def snake(name: str) -> str:
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name)
    s = re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_").lower()
    return s or "col"


def singular(table: str) -> str:
    t = table.split("__")[-1]
    if t.endswith("ies"):
        return t[:-3] + "y"
    if t.endswith("ses"):
        return t[:-2]
    return t[:-1] if t.endswith("s") and not t.endswith("ss") else t


def propose(source: str, table: str, columns: list[dict], key: str | None = None) -> dict:
    """columns: [{name, type, primary_key?}] -> proposed rename list and file names."""
    base = re.sub(r"^raw_", "", table.split("__")[-1])
    model = f"stg_{snake(source)}__{snake(table)}"
    if key is None:
        key = next((c["name"] for c in columns if c.get("primary_key")), None) or \
            next((c["name"] for c in columns if c["name"].lower() in ("id", f"{singular(base)}_id")), None)
    out = []
    for c in columns:
        n = c["name"]
        if n.startswith("_dlt_") and n not in ("_dlt_load_id",):
            continue
        alias = snake(n)
        if key and n == key and alias == "id":
            alias = f"{singular(snake(base))}_id"
        if n == "_dlt_load_id":
            alias = "_dlt_load_id"
        out.append({"name": n, "alias": alias, "include": True, "type": c.get("type") or ""})
    return {"model": model, "path": f"models/staging/{snake(source)}/{model}.sql", "key": key, "columns": out}


def render_sql(source: str, table: str, columns: list[dict]) -> str:
    cols = [c for c in columns if c.get("include", True)]
    if not cols:
        raise ProjectError("Keep at least one column.")
    def q(n: str) -> str:
        return n if re.fullmatch(r"[a-z_][a-z0-9_]*", n) else f'"{n}"'
    width = max(len(q(c["name"])) for c in cols)
    lines = []
    for i, c in enumerate(cols):
        src = q(c["name"])
        line = src if c["alias"] == c["name"] else f"{src.ljust(width)} as {c['alias']}"
        lines.append(f"        {line}{',' if i < len(cols) - 1 else ''}")
    return (f"with source as (\n\n    select * from {{{{ source('{source}', '{table}') }}}}\n\n),\n\n"
            f"renamed as (\n\n    select\n" + "\n".join(lines) + "\n\n    from source\n\n)\n\nselect * from renamed\n")


def write(root: str | Path, source: str, table: str, path: str, columns: list[dict], key_alias: str | None,
          new_style: bool) -> dict:
    from . import schema_yml

    if not re.fullmatch(r"[A-Za-z0-9_./-]+\.sql", path) or not path.startswith("models/"):
        raise ProjectError("Save staging models under models/ with a .sql name.")
    f = safe_path(root, path)
    if f.exists():
        raise ProjectError(f"{path} already exists.")
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(render_sql(source, table, columns), encoding="utf-8")
    model = Path(path).stem
    node = {"resource_type": "model", "name": model, "original_file_path": path}
    cols: dict[str, dict] = {}
    if key_alias:
        cols[key_alias] = {"description": "Primary key.", "tests": [{"type": "unique"}, {"type": "not_null"}]}
    y = schema_yml.apply(root, node, "", None, cols, new_style)
    return {"sql": path, "yml": y["path"], "model": model}
