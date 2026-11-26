"""Read dbt's JSON artifacts (manifest, run_results, catalog, sources) into what the screens need."""
from __future__ import annotations

import json
import re
from collections import deque
from functools import lru_cache
from pathlib import Path
from typing import Any

GRAPH_TYPES = {"model", "seed", "snapshot", "source", "exposure", "metric", "semantic_model", "analysis"}


def _load(path: Path) -> dict | None:
    if not path.exists():
        return None
    return _load_cached(str(path), path.stat().st_mtime)


@lru_cache(maxsize=16)
def _load_cached(path: str, mtime: float) -> dict:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if path.endswith("manifest.json"):
        _posix_paths(data)
    return data


PATH_KEYS = ("original_file_path", "path", "patch_path")


def _posix_paths(m: dict) -> None:
    """dbt on Windows writes file paths with backslashes; the app always uses forward slashes."""
    for section in ("nodes", "sources", "exposures", "metrics", "semantic_models", "macros", "saved_queries"):
        for n in (m.get(section) or {}).values():
            for k in PATH_KEYS:
                v = n.get(k)
                if isinstance(v, str) and "\\" in v:
                    n[k] = v.replace("\\", "/")


def target_dir(root: str | Path, target_path: str = "target") -> Path:
    return Path(root) / target_path


def manifest(root: str | Path, tp: str = "target") -> dict | None:
    return _load(target_dir(root, tp) / "manifest.json")


def run_results(root: str | Path, tp: str = "target") -> dict | None:
    return _load(target_dir(root, tp) / "run_results.json")


def catalog(root: str | Path, tp: str = "target") -> dict | None:
    return _load(target_dir(root, tp) / "catalog.json")


def sources_json(root: str | Path, tp: str = "target") -> dict | None:
    return _load(target_dir(root, tp) / "sources.json")


def _all_nodes(m: dict) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for key in ("nodes", "sources", "exposures", "metrics", "semantic_models"):
        out.update(m.get(key) or {})
    return out


def _label(n: dict) -> str:
    if n.get("resource_type") == "source":
        return f"{n.get('source_name')}.{n.get('name')}"
    return n.get("name", n.get("unique_id", ""))


def _materialized(n: dict) -> str:
    return (n.get("config") or {}).get("materialized", "") if n.get("resource_type") in ("model", "snapshot", "seed") else ""


def compiled_sql(root: str | Path, n: dict, tp: str = "target") -> str:
    """Compiled SQL for a node. A later `dbt parse` drops it from manifest.json, but the file dbt
    wrote under target/compiled is still there."""
    if n.get("compiled_code") or n.get("compiled_sql"):
        return n.get("compiled_code") or n.get("compiled_sql")
    base = target_dir(root, tp) / "compiled" / (n.get("package_name") or "")
    ofp = n.get("original_file_path") or ""
    for cand in (base / ofp, base / ofp / (n.get("path") or "")):
        if cand.is_file():
            try:
                return cand.read_text(encoding="utf-8")
            except OSError:
                pass
    return ""


def _folder(n: dict) -> str:
    parts = Path(n.get("original_file_path") or "").parts
    if len(parts) > 2:
        return "/".join(parts[1:-1])
    return parts[0] if parts else ""


def _owner(n: dict) -> str | None:
    if isinstance(n.get("owner"), dict):
        return n["owner"].get("name") or n["owner"].get("email")
    meta = n.get("meta") or ((n.get("config") or {}).get("meta") or {})
    return meta.get("owner")


LAST_RUN = "marthouse_last_results.json"


def remember_run(root: str | Path, tp: str = "target") -> None:
    """dbt overwrites run_results.json on every command (compile, docs...). Keep the latest
    real result for each node in our own file so statuses survive."""
    rr = run_results(root, tp)
    if not rr:
        return
    f = target_dir(root, tp) / LAST_RUN
    keep = _load(f) or {"metadata": {}, "results": []}
    by_id = {r["unique_id"]: r for r in keep.get("results", [])}
    for r in rr.get("results", []):
        by_id[r["unique_id"]] = r
    out = {"metadata": rr.get("metadata") or {}, "elapsed_time": rr.get("elapsed_time"), "results": list(by_id.values())}
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(out), encoding="utf-8")
    tmp.replace(f)


def last_status(root: str | Path, tp: str = "target") -> dict[str, dict]:
    rr = _load(target_dir(root, tp) / LAST_RUN) or {}
    out = {}
    for r in rr.get("results", []):
        out[r["unique_id"]] = {"status": r.get("status"), "time": r.get("execution_time"), "message": r.get("message"),
                               "failures": r.get("failures"), "generated_at": (rr.get("metadata") or {}).get("generated_at")}
    return out


def tests_by_node(m: dict) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for uid, n in (m.get("nodes") or {}).items():
        if n.get("resource_type") != "test":
            continue
        attached = n.get("attached_node") or next(iter((n.get("depends_on") or {}).get("nodes") or []), None)
        if attached:
            out.setdefault(attached, []).append(uid)
    return out


def graph(root: str | Path, tp: str = "target") -> dict | None:
    m = manifest(root, tp)
    if m is None:
        return None
    nodes = _all_nodes(m)
    status = last_status(root, tp)
    tests = tests_by_node(m)
    out_nodes = []
    for uid, n in nodes.items():
        rt = n.get("resource_type")
        if rt not in GRAPH_TYPES:
            continue
        t_ids = tests.get(uid, [])
        t_status = [status.get(t, {}).get("status") for t in t_ids]
        out_nodes.append({
            "id": uid, "name": _label(n), "type": rt, "materialized": _materialized(n),
            "path": n.get("original_file_path", ""), "package": n.get("package_name"),
            "tags": n.get("tags") or [], "description": n.get("description", ""),
            "status": (status.get(uid) or {}).get("status"),
            "tests": len(t_ids),
            "tests_failing": sum(1 for s in t_status if s in ("fail", "error")),
            "tests_warning": sum(1 for s in t_status if s == "warn"),
            "folder": _folder(n),
        })
    ids = {n["id"] for n in out_nodes}
    edges = []
    for child, parents in (m.get("parent_map") or {}).items():
        if child not in ids:
            continue
        for p in parents:
            if p in ids:
                edges.append({"source": p, "target": child})
    return {"nodes": out_nodes, "edges": edges, "generated_at": (m.get("metadata") or {}).get("generated_at"),
            "dbt_version": (m.get("metadata") or {}).get("dbt_version"), "project": (m.get("metadata") or {}).get("project_name")}


# ---------- selection (a fast subset of dbt's selector syntax) ----------

def select(g: dict, expr: str) -> set[str]:
    """Supports: name, +name, name+, n+name, name+n, @name, tag:x, path:x, type:x, source:x, unions (space) and intersections (comma)."""
    expr = (expr or "").strip()
    if not expr:
        return {n["id"] for n in g["nodes"]}
    parents: dict[str, list[str]] = {}
    children: dict[str, list[str]] = {}
    for e in g["edges"]:
        parents.setdefault(e["target"], []).append(e["source"])
        children.setdefault(e["source"], []).append(e["target"])

    def walk(start: set[str], adj: dict[str, list[str]], depth: int | None) -> set[str]:
        seen, q = set(start), deque((s, 0) for s in start)
        while q:
            cur, d = q.popleft()
            if depth is not None and d >= depth:
                continue
            for nxt in adj.get(cur, []):
                if nxt not in seen:
                    seen.add(nxt)
                    q.append((nxt, d + 1))
        return seen

    def base(term: str) -> set[str]:
        if ":" in term:
            method, val = term.split(":", 1)
            if method == "tag":
                return {n["id"] for n in g["nodes"] if val in n["tags"]}
            if method == "path":
                return {n["id"] for n in g["nodes"] if n["path"].startswith(val)}
            if method in ("type", "resource_type"):
                return {n["id"] for n in g["nodes"] if n["type"] == val}
            if method == "source":
                return {n["id"] for n in g["nodes"] if n["type"] == "source" and (n["name"] == val or n["name"].startswith(val + "."))}
            if method == "status":
                return {n["id"] for n in g["nodes"] if n["status"] == val}
            return set()
        pat = re.compile("^" + re.escape(term).replace(r"\*", ".*") + "$")
        return {n["id"] for n in g["nodes"] if pat.match(n["name"]) or pat.match(n["id"]) or pat.match(n["name"].split(".")[-1])}

    def one(term: str) -> set[str]:
        at = term.startswith("@")
        term = term.lstrip("@")
        m = re.fullmatch(r"(\d*)(\+?)(.*?)(\+?)(\d*)", term)
        assert m
        up_n, up, core, down, down_n = m.groups()
        hits = base(core)
        res = set(hits)
        if up:
            res |= walk(hits, parents, int(up_n) if up_n else None)
        if down or at:
            d = walk(hits, children, int(down_n) if down_n else None)
            res |= d
            if at:
                res |= walk(d, parents, None)
        return res

    result: set[str] = set()
    for union in expr.split():
        parts = [one(p) for p in union.split(",") if p]
        if parts:
            result |= set.intersection(*parts)
    return result


def impact(g: dict, uid: str) -> dict:
    children: dict[str, list[str]] = {}
    for e in g["edges"]:
        children.setdefault(e["source"], []).append(e["target"])
    seen, q = set(), deque([uid])
    while q:
        cur = q.popleft()
        for c in children.get(cur, []):
            if c not in seen:
                seen.add(c)
                q.append(c)
    by_id = {n["id"]: n for n in g["nodes"]}
    down = [by_id[i] for i in seen if i in by_id]
    return {
        "downstream": len(down),
        "models": sum(1 for n in down if n["type"] == "model"),
        "exposures": [n["name"] for n in down if n["type"] == "exposure"],
        "tables": sum(1 for n in down if n["materialized"] in ("table", "incremental")),
        "nodes": sorted(n["name"] for n in down),
    }


# ---------- node details ----------

def node_detail(root: str | Path, uid: str, tp: str = "target") -> dict | None:
    m = manifest(root, tp)
    if m is None:
        return None
    nodes = _all_nodes(m)
    n = nodes.get(uid)
    if n is None:
        return None
    cat = catalog(root, tp) or {}
    centry = (cat.get("nodes") or {}).get(uid) or (cat.get("sources") or {}).get(uid) or {}
    ccols = {k.lower(): v for k, v in (centry.get("columns") or {}).items()}
    tests = tests_by_node(m).get(uid, [])
    status = last_status(root, tp)
    col_tests: dict[str, list[dict]] = {}
    model_tests = []
    for t in tests:
        tn = m["nodes"][t]
        meta = tn.get("test_metadata") or {}
        entry = {"id": t, "name": meta.get("name") or tn.get("name"), "status": (status.get(t) or {}).get("status")}
        col = (tn.get("column_name") or "").lower()
        if col:
            col_tests.setdefault(col, []).append(entry)
        else:
            model_tests.append(entry)
    cols = []
    declared = {k.lower(): v for k, v in (n.get("columns") or {}).items()}
    names = list(declared.keys()) + [k for k in ccols if k not in declared]
    for c in names:
        d = declared.get(c, {})
        cc = ccols.get(c, {})
        cols.append({"name": d.get("name") or cc.get("name") or c, "type": cc.get("type") or d.get("data_type") or "",
                     "description": d.get("description", ""), "tests": col_tests.get(c, [])})
    stats = {k: v.get("value") for k, v in (centry.get("stats") or {}).items() if v.get("include")}
    parents = (m.get("parent_map") or {}).get(uid, [])
    child = (m.get("child_map") or {}).get(uid, [])
    return {
        "id": uid, "name": _label(n), "type": n.get("resource_type"), "materialized": _materialized(n),
        "path": n.get("original_file_path"), "description": n.get("description", ""),
        "relation": n.get("relation_name"), "database": n.get("database"), "schema": n.get("schema"),
        "tags": n.get("tags") or [], "meta": n.get("meta") or {}, "config": n.get("config") or {},
        "owner": _owner(n),
        "contract": ((n.get("config") or {}).get("contract") or {}).get("enforced", False),
        "raw_code": n.get("raw_code") or n.get("raw_sql") or "",
        "compiled_code": compiled_sql(root, n, tp),
        "columns": cols, "model_tests": model_tests,
        "parents": [{"id": p, "name": _label(nodes[p]), "type": nodes[p].get("resource_type")} for p in parents if p in nodes],
        "children": [{"id": c, "name": _label(nodes[c]), "type": nodes[c].get("resource_type")} for c in child
                     if c in nodes and nodes[c].get("resource_type") != "test"],
        "stats": stats, "catalog_type": (centry.get("metadata") or {}).get("type"),
        "last": status.get(uid),
        "freshness": n.get("freshness"), "loaded_at_field": n.get("loaded_at_field"),
        "url": n.get("url"), "exposure_type": n.get("type") if n.get("resource_type") == "exposure" else None,
    }


def node_for_path(root: str | Path, rel: str, tp: str = "target") -> str | None:
    m = manifest(root, tp)
    if not m:
        return None
    for uid, n in (m.get("nodes") or {}).items():
        if n.get("original_file_path") == rel and n.get("resource_type") != "test":
            return uid
    return None


def docs_index(root: str | Path, tp: str = "target") -> dict | None:
    m = manifest(root, tp)
    if m is None:
        return None
    groups: dict[str, list[dict]] = {}
    for uid, n in _all_nodes(m).items():
        rt = n.get("resource_type")
        if rt not in ("model", "seed", "snapshot", "source", "exposure"):
            continue
        if n.get("package_name") != (m.get("metadata") or {}).get("project_name") and rt != "source":
            continue
        cols = n.get("columns") or {}
        documented = sum(1 for c in cols.values() if c.get("description"))
        pct = round(100 * documented / len(cols)) if cols else (100 if n.get("description") else 0)
        if rt == "source":
            group = "Sources"
        elif rt == "exposure":
            group = "Exposures"
        else:
            parts = Path(n.get("original_file_path", "")).parts
            group = (parts[1] if len(parts) > 2 else parts[0] if parts else "other").replace("_", " ").title()
        groups.setdefault(group, []).append({"id": uid, "name": _label(n), "type": rt, "documented": pct,
                                             "has_description": bool(n.get("description"))})
    cat = catalog(root, tp)
    return {"groups": [{"name": k, "items": sorted(v, key=lambda x: x["name"])} for k, v in sorted(groups.items())],
            "catalog_at": (cat or {}).get("metadata", {}).get("generated_at"),
            "manifest_at": (m.get("metadata") or {}).get("generated_at")}


# ---------- tests ----------

def tests_overview(root: str | Path, tp: str = "target") -> dict | None:
    m = manifest(root, tp)
    if m is None:
        return None
    nodes = _all_nodes(m)
    status = last_status(root, tp)
    by_node = tests_by_node(m)
    tests = []
    for uid, n in (m.get("nodes") or {}).items():
        if n.get("resource_type") != "test":
            continue
        meta = n.get("test_metadata") or {}
        attached = n.get("attached_node") or next(iter((n.get("depends_on") or {}).get("nodes") or []), "")
        st = status.get(uid) or {}
        tests.append({
            "id": uid, "name": meta.get("name") or n.get("name"), "full_name": n.get("name"),
            "kind": "generic" if meta else "singular", "column": n.get("column_name"),
            "model": _label(nodes[attached]) if attached in nodes else "", "model_id": attached,
            "severity": (n.get("config") or {}).get("severity", "ERROR"),
            "status": st.get("status"), "failures": st.get("failures"), "message": st.get("message"),
            "time": st.get("time"), "path": n.get("original_file_path"),
            "compiled_code": compiled_sql(root, n, tp), "raw_code": n.get("raw_code") or "",
        })
    models = [uid for uid, n in (m.get("nodes") or {}).items()
              if n.get("resource_type") == "model" and n.get("package_name") == (m.get("metadata") or {}).get("project_name")]
    untested = sorted(_label(nodes[u]) for u in models if not by_node.get(u))
    counts = {k: sum(1 for t in tests if t["status"] == k) for k in ("pass", "fail", "warn", "error", "skipped")}
    counts["not_run"] = sum(1 for t in tests if not t["status"])
    return {"tests": sorted(tests, key=lambda t: (t["model"], t["name"])), "counts": counts,
            "models": len(models), "tested_models": len(models) - len(untested), "untested": untested,
            "ran_at": ((_load(target_dir(root, tp) / LAST_RUN) or {}).get("metadata") or {}).get("generated_at")}


# ---------- source freshness ----------

PERIOD_S = {"minute": 60, "hour": 3600, "day": 86400}


def _threshold(c: dict | None) -> int | None:
    if not c or not c.get("count") or not c.get("period"):
        return None
    return int(c["count"]) * PERIOD_S.get(c["period"], 3600)


def freshness(root: str | Path, tp: str = "target") -> dict | None:
    m = manifest(root, tp)
    if m is None:
        return None
    sj = sources_json(root, tp) or {}
    res = {r["unique_id"]: r for r in sj.get("results", [])}
    rows = []
    for uid, s in (m.get("sources") or {}).items():
        r = res.get(uid) or {}
        crit = r.get("criteria") or s.get("freshness") or {}
        warn, err = _threshold(crit.get("warn_after")), _threshold(crit.get("error_after"))
        rows.append({
            "id": uid, "name": _label(s), "description": s.get("description", ""),
            "loader": s.get("loader") or "", "loaded_at_field": s.get("loaded_at_field"),
            "status": r.get("status") or ("none" if not s.get("loaded_at_field") or (warn is None and err is None) else None),
            "age_s": r.get("max_loaded_at_time_ago_in_s"), "max_loaded_at": r.get("max_loaded_at"),
            "warn_s": warn, "error_s": err, "error": (r.get("error") or r.get("message")) if r.get("status") in ("runtime error", "error") else None,
            "downstream": 0,
        })
    g = graph(root, tp)
    if g:
        for row in rows:
            row["downstream"] = impact(g, row["id"])["downstream"]
    return {"rows": sorted(rows, key=lambda x: x["name"]), "checked_at": (sj.get("metadata") or {}).get("generated_at")}


def summarize_run(root: str | Path, tp: str = "target") -> dict:
    rr = run_results(root, tp) or {}
    counts: dict[str, int] = {}
    for r in rr.get("results", []):
        counts[r.get("status") or "unknown"] = counts.get(r.get("status") or "unknown", 0) + 1
    return {"counts": counts, "elapsed": rr.get("elapsed_time"), "generated_at": (rr.get("metadata") or {}).get("generated_at"),
            "results": [{"id": r["unique_id"], "status": r.get("status"), "time": r.get("execution_time"),
                         "message": r.get("message"), "failures": r.get("failures"),
                         "timing": r.get("timing") or [], "adapter_response": r.get("adapter_response") or {}}
                        for r in rr.get("results", [])]}
