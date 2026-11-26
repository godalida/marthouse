"""Edit model/source docs and column tests in the project's .yml files without hand-writing YAML.

Finds the file that already describes the node (manifest patch_path) or creates _<folder>.yml next
to the model. Uses ruamel's round-trip mode, so comments and ordering in the file are kept.
"""
from __future__ import annotations

import io
from pathlib import Path
from typing import Any

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq

GENERIC = ("unique", "not_null", "accepted_values", "relationships")


def _y() -> YAML:
    y = YAML()
    y.preserve_quotes = True
    y.indent(mapping=2, sequence=4, offset=2)
    y.width = 4096
    return y


def yml_path_for(node: dict, project_name: str) -> str:
    pp = node.get("patch_path") or ""
    if "://" in pp:
        return pp.split("://", 1)[1]
    if node.get("resource_type") == "source":
        return node.get("original_file_path") or ""
    ofp = Path(node.get("original_file_path") or f"models/{node.get('name')}.sql")
    return str(ofp.parent / f"_{ofp.parent.name}.yml")


def _test_name(t: Any) -> str:
    return t if isinstance(t, str) else next(iter(t.keys()))


def _build_test(t: dict, new_style: bool) -> Any:
    kind = t["type"]
    if kind in ("unique", "not_null"):
        return kind
    if kind == "accepted_values":
        args = CommentedMap({"values": CommentedSeq(t.get("values") or [])})
    elif kind == "relationships":
        args = CommentedMap({"to": f"ref('{t.get('to')}')" if not str(t.get("to", "")).startswith(("ref(", "source(")) else t["to"],
                             "field": t.get("field") or "id"})
    else:
        raise ValueError(kind)
    body = CommentedMap({"arguments": args}) if new_style else args
    if t.get("severity") == "warn":
        body["config"] = CommentedMap({"severity": "warn"})
    return CommentedMap({kind: body})


def describe_tests(tests: list) -> list[dict]:
    """Turn YAML test entries into simple dicts for the UI."""
    out = []
    for t in tests or []:
        name = _test_name(t)
        d: dict[str, Any] = {"type": name}
        if isinstance(t, dict):
            body = t[name] or {}
            args = body.get("arguments", body)
            if name == "accepted_values":
                d["values"] = list(args.get("values") or [])
            if name == "relationships":
                d["to"] = str(args.get("to", "")).removeprefix("ref('").removesuffix("')")
                d["field"] = args.get("field")
            if (body.get("config") or {}).get("severity") == "warn":
                d["severity"] = "warn"
        out.append(d)
    return out


def _find_entry(doc: CommentedMap, node: dict) -> CommentedMap:
    if node.get("resource_type") == "source":
        srcs = doc.setdefault("sources", CommentedSeq())
        src = next((s for s in srcs if s.get("name") == node["source_name"]), None)
        if src is None:
            src = CommentedMap({"name": node["source_name"], "tables": CommentedSeq()})
            srcs.append(src)
        tables = src.setdefault("tables", CommentedSeq())
        e = next((t for t in tables if t.get("name") == node["name"]), None)
        if e is None:
            e = CommentedMap({"name": node["name"]})
            tables.append(e)
        return e
    key = {"seed": "seeds", "snapshot": "snapshots"}.get(node.get("resource_type"), "models")
    items = doc.setdefault(key, CommentedSeq())
    e = next((m for m in items if m.get("name") == node["name"]), None)
    if e is None:
        e = CommentedMap({"name": node["name"]})
        items.append(e)
    return e


def apply(root: str | Path, node: dict, project_name: str, description: str | None,
          columns: dict[str, dict], new_style: bool, dry_run: bool = False) -> dict:
    """columns: {name: {"description": str|None, "tests": [ {type, values, to, field, severity} ] | None}}"""
    rel = yml_path_for(node, project_name)
    f = Path(root) / rel
    y = _y()
    doc = y.load(f.read_text(encoding="utf-8")) if f.exists() else None
    if not doc:
        doc = CommentedMap({"version": 2})
    entry = _find_entry(doc, node)
    if description is not None:
        if description:
            entry["description"] = description
        else:
            entry.pop("description", None)
    if columns:
        cols = entry.setdefault("columns", CommentedSeq())
        for name, ch in columns.items():
            col = next((c for c in cols if str(c.get("name", "")).lower() == name.lower()), None)
            if col is None:
                col = CommentedMap({"name": name})
                cols.append(col)
            if ch.get("description") is not None:
                if ch["description"]:
                    col["description"] = ch["description"]
                else:
                    col.pop("description", None)
            if ch.get("tests") is not None:
                key = "tests" if "tests" in col and "data_tests" not in col else "data_tests"
                existing = {_test_name(t): t for t in (col.get(key) or [])}
                new = CommentedSeq()
                for t in ch["tests"]:
                    # keep a test exactly as written if it's unchanged (custom args, configs, comments)
                    old = existing.get(t["type"])
                    if old is not None and describe_tests([old])[0] == {k: v for k, v in t.items() if v not in (None, [], "")}:
                        new.append(old)
                    else:
                        new.append(_build_test(t, new_style))
                for n, old in existing.items():  # tests the form doesn't know (custom/package tests) stay
                    if n not in GENERIC:
                        new.append(old)
                if new:
                    col[key] = new
                else:
                    col.pop(key, None)
    buf = io.StringIO()
    y.dump(doc, buf)
    if not dry_run:
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(buf.getvalue(), encoding="utf-8")
    return {"path": rel, "text": buf.getvalue()}


def read(root: str | Path, node: dict, project_name: str) -> dict:
    rel = yml_path_for(node, project_name)
    f = Path(root) / rel
    out: dict[str, Any] = {"path": rel, "exists": f.exists(), "columns": {}}
    if not f.exists():
        return out
    doc = _y().load(f.read_text(encoding="utf-8")) or {}
    try:
        entry = _find_entry(doc, node)
    except Exception:
        return out
    for c in entry.get("columns") or []:
        out["columns"][str(c.get("name"))] = {"description": c.get("description") or "",
                                              "tests": describe_tests(c.get("data_tests") or c.get("tests") or [])}
    return out
