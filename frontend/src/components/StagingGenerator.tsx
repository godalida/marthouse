import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useShell } from "../Shell";
import { useSettings, useTheme } from "../store";
import { Btn, Check, Field, Select, Sheet, Spinner, errText, useToast } from "../ui";
import { Editor } from "./Editor";

type Col = { name: string; alias: string; include: boolean; type: string };

/** Proposes stg_<source>__<table>.sql for a source table: clean names, renamed key, tests on the key. */
export function StagingGenerator({ sourceId, onClose }: { sourceId: string | null; onClose: () => void }) {
  const { pid, refresh } = useShell();
  const nav = useNavigate();
  const toast = useToast();
  const settings = useSettings();
  const theme = useTheme(settings.data?.appearance);
  const [prop, setProp] = useState<any>(null);
  const [err, setErr] = useState("");
  const [cols, setCols] = useState<Col[]>([]);
  const [path, setPath] = useState("");
  const [key, setKey] = useState("");
  const [sql, setSql] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!sourceId) return;
    setProp(null);
    setErr("");
    api(`/api/projects/${pid}/staging/propose`, { query: { id: sourceId } }).then((p) => {
      setProp(p);
      setCols(p.columns);
      setPath(p.path);
      setKey(p.columns.find((c: Col) => c.name === p.key)?.alias ?? "");
      setSql(p.sql);
    }).catch((e) => setErr(errText(e)));
  }, [sourceId, pid]);
  useEffect(() => {
    if (!prop || !sourceId) return;
    const h = setTimeout(() => api(`/api/projects/${pid}/staging`, { body: { id: sourceId, path, columns: cols, preview: true } }).then((r) => setSql(r.sql)).catch(() => {}), 200);
    return () => clearTimeout(h);
  }, [cols]); // eslint-disable-line

  const create = async () => {
    setBusy(true);
    try {
      const r = await api(`/api/projects/${pid}/staging`, { body: { id: sourceId, path, columns: cols, key_alias: key || null } });
      toast(`Created ${r.model}`);
      onClose();
      refresh();
      nav(`/p/${pid}/models?file=${encodeURIComponent(r.sql)}`);
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={!!sourceId} onClose={onClose} label="Staging model" width={980}>
      <div className="vstack" style={{ gap: 4 }}>
        <b className="t-title2">Staging model{prop ? ` for ${prop.source}.${prop.table}` : ""}</b>
        <span className="c2 t-callout">One clean model per raw table: tidy column names, a clear key, and tests on that key. Everything else should read the staging model, not the raw table.</span>
      </div>
      {err && <span className="t-callout" style={{ color: "var(--red)" }}>{err}</span>}
      {!prop && !err && <Spinner />}
      {prop && (
        <div className="hstack" style={{ gap: 16, alignItems: "stretch" }}>
          <div className="vstack" style={{ flex: "1 1 440px", gap: 10, minWidth: 0 }}>
            <div className="group">
              <div className="form-row"><span className="lead">File</span><Field value={path} onChange={setPath} mono width={330} /></div>
              <div className="form-row"><span className="lead">Primary key<small>Gets unique and not_null tests</small></span>
                <Select label="Key" value={key} onChange={setKey} options={[{ value: "", label: "None" }, ...cols.filter((c) => c.include).map((c) => ({ value: c.alias, label: c.alias }))]} />
              </div>
            </div>
            <div className="tbl" style={{ maxHeight: 340 }}>
              <div className="table-head"><span style={{ width: 28 }} /><span style={{ width: 170 }}>Column</span><span className="grow">Name in the model</span><span style={{ width: 80 }}>Type</span></div>
              {cols.map((c, i) => (
                <div key={c.name} className="list-row" style={{ opacity: c.include ? 1 : 0.5 }}>
                  <span style={{ width: 28 }}><Check on={c.include} onChange={(v) => setCols(cols.map((x, j) => (j === i ? { ...x, include: v } : x)))} label={`Include ${c.name}`} /></span>
                  <span style={{ width: 170 }} className="trunc t-callout">{c.name}</span>
                  <span className="grow"><Field value={c.alias} onChange={(v) => setCols(cols.map((x, j) => (j === i ? { ...x, alias: v.replace(/[^A-Za-z0-9_]/g, "_") } : x)))} mono width="100%" /></span>
                  <span style={{ width: 80 }} className="c2 t-subhead trunc">{c.type}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="vstack" style={{ flex: "1 1 400px", minWidth: 0, gap: 6 }}>
            <span className="upper">{path.split("/").pop()}</span>
            <div className="vstack" style={{ flex: 1, minHeight: 320, borderRadius: 10, overflow: "hidden", boxShadow: "0 0 0 1px var(--sep)" }}>
              <Editor path="x.sql" value={sql} readOnly theme={theme} fontSize={11.5} />
            </div>
          </div>
        </div>
      )}
      <div className="acts"><Btn onClick={onClose}>Cancel</Btn><Btn kind="prominent" busy={busy} disabled={!prop} onClick={create}>Create model</Btn></div>
    </Sheet>
  );
}
