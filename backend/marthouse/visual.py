"""Visual model builder: a list of steps -> readable dbt SQL (one CTE per step).

The steps are saved in a Jinja comment on the first line of the model, which dbt ignores:
    {# marthouse:visual {...} #}   (files saved before the rename say workbench:visual; both are read)
If the SQL below it no longer matches what the steps produce, someone edited it by hand and the
builder leaves the file to the code editor.
"""
from __future__ import annotations

import json
import re
from typing import Any

HEADER_RE = re.compile(r"^\{#\s*(marthouse|workbench):visual\s+(\{.*\})\s*#\}\s*\n", re.S)
IDENT = re.compile(r"^[a-z_][a-z0-9_]*$")
OPS = {"eq": "=", "ne": "<>", "gt": ">", "ge": ">=", "lt": "<", "le": "<="}
AGGS = {"count", "count_distinct", "sum", "avg", "min", "max"}
MATS = {"view", "table", "ephemeral"}


class VisualError(ValueError):
    pass


def q(col: str) -> str:
    if not col:
        raise VisualError("A column is missing.")
    return col if IDENT.match(col) else '"' + col.replace('"', '""') + '"'


def lit(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    s = str(v).strip()
    if re.fullmatch(r"-?\d+(\.\d+)?", s):
        return s
    return "'" + s.replace("'", "''") + "'"


def relation(x: dict) -> str:
    if x.get("ref"):
        if not re.fullmatch(r"[A-Za-z0-9_.]+", x["ref"]):
            raise VisualError("Bad model name.")
        return f"{{{{ ref('{x['ref']}') }}}}"
    if x.get("source") and x.get("table"):
        if not re.fullmatch(r"[A-Za-z0-9_]+", x["source"]) or not re.fullmatch(r"[A-Za-z0-9_.]+", x["table"]):
            raise VisualError("Bad source name.")
        return f"{{{{ source('{x['source']}', '{x['table']}') }}}}"
    raise VisualError("Choose a model or source to start from.")


def _cond(c: dict) -> str:
    col, op, v = q(c.get("column", "")), c.get("op", "eq"), c.get("value", "")
    if op in OPS:
        return f"{col} {OPS[op]} {lit(v)}"
    if op in ("contains", "starts", "ends"):
        s = str(v).replace("'", "''").replace("%", "\\%")
        pat = {"contains": f"%{s}%", "starts": f"{s}%", "ends": f"%{s}"}[op]
        return f"{col} like '{pat}'"
    if op == "empty":
        return f"{col} is null"
    if op == "not_empty":
        return f"{col} is not null"
    if op in ("in", "not_in"):
        vals = [x for x in (v if isinstance(v, list) else str(v).split(",")) if str(x).strip()]
        if not vals:
            raise VisualError("List at least one value.")
        return f"{col} {'not in' if op == 'not_in' else 'in'} ({', '.join(lit(x) for x in vals)})"
    raise VisualError(f"Unknown comparison {op}.")


def _alias(name: str, alias: str | None) -> str:
    return q(name) if not alias or alias == name else f"{q(name)} as {q(alias)}"


def step_sql(step: dict, prev: str | None) -> str:
    t = step.get("type")
    if t == "source":
        return f"select * from {relation(step)}"
    if prev is None:
        raise VisualError("The first step must choose what to start from.")
    if t == "columns":
        keep = [c for c in step.get("keep") or [] if c.get("name")]
        if not keep:
            raise VisualError("Keep at least one column.")
        return "select\n        " + ",\n        ".join(_alias(c["name"], c.get("as")) for c in keep) + f"\n    from {prev}"
    if t == "filter":
        conds = [c for c in step.get("conditions") or [] if c.get("column")]
        if not conds:
            return f"select * from {prev}"
        joiner = "\n        or " if step.get("match") == "any" else "\n        and "
        return f"select * from {prev}\n    where " + joiner.join(_cond(c) for c in conds)
    if t == "join":
        on = [p for p in step.get("on") or [] if p.get("left") and p.get("right")]
        if not on:
            raise VisualError("Pick the columns to join on.")
        how = "inner" if step.get("how") == "inner" else "left"
        cols = [c for c in step.get("columns") or [] if c.get("name")]
        picked = "".join(f",\n        joined.{_alias(c['name'], c.get('as'))}" for c in cols)
        cond = "\n        and ".join(f"{prev}.{q(p['left'])} = joined.{q(p['right'])}" for p in on)
        return f"select\n        {prev}.*{picked}\n    from {prev}\n    {how} join {relation(step.get('with') or {})} as joined\n        on {cond}"
    if t == "formula":
        if not step.get("name") or not str(step.get("expression", "")).strip():
            raise VisualError("Give the new column a name and a formula.")
        if ";" in step["expression"]:
            raise VisualError("A formula can't contain ;")
        return f"select\n        *,\n        {step['expression'].strip()} as {q(step['name'])}\n    from {prev}"
    if t == "group":
        by = [b for b in step.get("by") or [] if b]
        aggs = [a for a in step.get("aggs") or [] if a.get("fn") in AGGS and a.get("as")]
        if not aggs and not by:
            raise VisualError("Choose what to group by or what to add up.")
        parts = [q(b) for b in by]
        for a in aggs:
            col = a.get("column")
            if a["fn"] == "count":
                expr = f"count({q(col)})" if col else "count(*)"
            elif a["fn"] == "count_distinct":
                expr = f"count(distinct {q(col)})"
            else:
                expr = f"{a['fn']}({q(col)})"
            parts.append(f"{expr} as {q(a['as'])}")
        group = f"\n    group by {', '.join(str(i + 1) for i in range(len(by)))}" if by else ""
        return "select\n        " + ",\n        ".join(parts) + f"\n    from {prev}{group}"
    if t == "sort":
        by = [b for b in step.get("by") or [] if b.get("column")]
        order = f"\n    order by {', '.join(q(b['column']) + (' desc' if b.get('desc') else '') for b in by)}" if by else ""
        lim = f"\n    limit {int(step['limit'])}" if str(step.get("limit") or "").isdigit() else ""
        return f"select * from {prev}{order}{lim}"
    if t == "distinct":
        return f"select distinct * from {prev}"
    raise VisualError(f"Unknown step {t}.")


def cte_name(step: dict, i: int) -> str:
    base = {"source": "source", "columns": "selected", "filter": "filtered", "join": "joined_data", "formula": "with_formula",
            "group": "grouped", "sort": "sorted", "distinct": "deduplicated"}.get(step.get("type"), "step")
    return f"{base}_{i + 1}" if i else base


def body(spec: dict, upto: int | None = None) -> str:
    steps = spec.get("steps") or []
    if not steps:
        raise VisualError("Add a first step.")
    n = len(steps) if upto is None else min(upto + 1, len(steps))
    ctes, prev = [], None
    for i, st in enumerate(steps[:n]):
        name = cte_name(st, i)
        ctes.append(f"{name} as (\n\n    {step_sql(st, prev)}\n\n)")
        prev = name
    return "with " + ",\n\n".join(ctes) + f"\n\nselect * from {prev}\n"


def header(spec: dict, tag: str = "marthouse") -> str:
    data = json.dumps({k: spec[k] for k in ("steps", "materialized", "description") if k in spec}, separators=(",", ":"))
    return "{# " + tag + ":visual " + data.replace("#}", "#\\u007d") + " #}\n"


def model_sql(spec: dict, tag: str = "marthouse") -> str:
    mat = spec.get("materialized") or "view"
    if mat not in MATS:
        raise VisualError("Unknown materialization.")
    cfg = f"{{{{ config(materialized='{mat}') }}}}\n\n"
    return header(spec, tag) + cfg + body(spec)


def parse(text: str) -> dict | None:
    """Returns {"spec": ..., "edited": bool} for files made by the builder, else None."""
    m = HEADER_RE.match(text)
    if not m:
        return None
    try:
        spec = json.loads(m.group(2))
    except json.JSONDecodeError:
        return None
    try:
        edited = _norm(model_sql(spec, m.group(1))) != _norm(text)
    except VisualError:
        edited = True
    return {"spec": spec, "edited": edited}


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def columns_probe(sql: str) -> str:
    """Wraps a query so it returns one row even when empty, so dbt show still reports the column names."""
    return f"select q.* from (\n{sql}\n) as q\nright join (select 1 as wb_probe_one) as wb_probe on true"
