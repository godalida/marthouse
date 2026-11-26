"""Runs inside the dlt environment (not Marthouse's): prints one JSON line describing a pipeline.

Usage: python inspector.py <pipeline_name>   (DLT_DATA_DIR and destination env vars set by Marthouse)
"""
import json
import sys


def main() -> None:
    import dlt

    name = sys.argv[1]
    out = {"pipeline": name, "ok": True}
    try:
        p = dlt.attach(pipeline_name=name)
    except Exception as e:  # never run yet
        print("@@WB" + json.dumps({"pipeline": name, "ok": False, "error": f"{type(e).__name__}: {e}"}))
        return
    out["dataset"] = p.dataset_name
    out["destination"] = p.destination.destination_name if p.destination else None
    tables = []
    try:
        for t in p.default_schema.data_tables():
            tables.append({
                "name": t["name"], "parent": t.get("parent"), "resource": t.get("resource"),
                "write_disposition": t.get("write_disposition"),
                "columns": [{"name": c["name"], "type": c.get("data_type"), "nullable": c.get("nullable", True),
                             "primary_key": bool(c.get("primary_key")), "dlt": c["name"].startswith("_dlt_")}
                            for c in t["columns"].values()],
            })
    except Exception as e:
        out["schema_error"] = str(e)
    out["tables"] = tables
    tr = p.last_trace
    if tr:
        out["trace"] = {
            "started_at": str(tr.started_at), "finished_at": str(tr.finished_at),
            "steps": [{"step": s.step, "started_at": str(s.started_at), "finished_at": str(s.finished_at),
                       "error": str(s.step_exception) if getattr(s, "step_exception", None) else None} for s in tr.steps],
            "rows": {k: v for k, v in (tr.last_normalize_info.row_counts.items() if tr.last_normalize_info else []) if not k.startswith("_dlt")},
        }
    try:
        out["state"] = p.state.get("sources") or {}
    except Exception:
        out["state"] = {}
    try:
        with p.sql_client() as c:
            rows = c.execute_sql(f"select load_id, status, inserted_at from {c.make_qualified_table_name('_dlt_loads')} order by inserted_at desc limit 25")
            out["loads"] = [{"load_id": r[0], "status": r[1], "inserted_at": str(r[2])} for r in rows]
    except Exception as e:
        out["loads"] = []
        out["loads_error"] = str(e).splitlines()[0][:200]
    print("@@WB" + json.dumps(out, default=str))


if __name__ == "__main__":
    main()
