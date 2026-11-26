import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, fmt } from "../api";
import { DataGrid } from "../components/DataGrid";
import { Editor } from "../components/Editor";
import { I, typeIcon } from "../icons";
import { useShell } from "../Shell";
import { useSettings, useTheme } from "../store";
import { Btn, Empty, Field, Select, Sheet, Spinner, TbBtn, errText, useToast } from "../ui";

type Hist = { sql: string; at: number; rows?: number; ok: boolean };
const KEY = (pid: string) => `workbench.sql.${pid}`;

export function Sql() {
  const { pid, project } = useShell();
  const nav = useNavigate();
  const toast = useToast();
  const settings = useSettings();
  const theme = useTheme(settings.data?.appearance);
  const saved = JSON.parse(localStorage.getItem(KEY(pid)) ?? "null") as { draft: string; history: Hist[] } | null;
  const [sql, setSql] = useState(saved?.draft ?? "select *\nfrom {{ ref('customers') }}\nlimit 10\n");
  const [history, setHistory] = useState<Hist[]>(saved?.history ?? []);
  const [limit, setLimit] = useState(500);
  const [res, setRes] = useState<{ rows: any[]; columns: string[]; errors: string[]; ms: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveAs, setSaveAs] = useState<string | null>(null);
  const graph = useQuery<any>({ queryKey: ["graph", pid, ""], queryFn: () => api(`/api/projects/${pid}/graph`), retry: false, enabled: !!project.info?.has_dbt });
  useEffect(() => { localStorage.setItem(KEY(pid), JSON.stringify({ draft: sql, history: history.slice(0, 40) })); }, [sql, history, pid]);

  const run = useCallback(async () => {
    if (!sql.trim() || busy) return;
    setBusy(true);
    const t0 = performance.now();
    try {
      const r = await api(`/api/projects/${pid}/show`, { body: { inline: sql, limit } });
      setRes({ ...r, ms: performance.now() - t0 });
      setHistory((h) => [{ sql, at: Date.now(), rows: r.rows.length, ok: !r.errors.length }, ...h.filter((x) => x.sql !== sql)].slice(0, 40));
    } catch (e) {
      setRes({ rows: [], columns: [], errors: [errText(e)], ms: 0 });
    } finally {
      setBusy(false);
    }
  }, [sql, limit, pid, busy]);

  const save = async () => {
    if (!saveAs) return;
    try {
      await api(`/api/projects/${pid}/file`, { method: "PUT", body: { path: saveAs, content: sql.replace(/\s*limit\s+\d+\s*;?\s*$/i, "\n") } });
      toast(`Saved ${saveAs}`);
      nav(`/p/${pid}/models?file=${encodeURIComponent(saveAs)}`);
    } catch (e) { toast(errText(e), "error"); }
  };
  const insert = (text: string) => setSql((s) => (s.endsWith("\n") || !s ? s : s + "\n") + text);

  if (!project.info?.has_dbt) return <><header className="toolbar"><div className="title"><b>SQL</b></div></header><Empty icon="sql" title="SQL needs a dbt project">Queries run through dbt so ref() and source() work. Add a dbt project to this folder first.</Empty></>;
  const nodes: any[] = (graph.data?.nodes ?? []).filter((n: any) => ["model", "seed", "snapshot", "source"].includes(n.type) && (n.package === graph.data?.project || n.type === "source"));
  return (
    <>
      <header className="toolbar">
        <div className="title"><b>SQL</b><small>Runs through dbt, so ref() and source() work · nothing is saved to the warehouse</small></div>
        <div className="spacer" />
        <Select label="Row limit" value={limit} onChange={setLimit} options={[100, 500, 1000, 5000].map((n) => ({ value: n, label: `${n} rows` }))} />
        <TbBtn icon="save" label="Save as model…" onClick={() => setSaveAs(`models/${"new_model"}.sql`)} />
        <TbBtn icon="play" label="Run" prominent busy={busy} onClick={run} title="Run (⌘↩)" />
      </header>
      <div className="hstack fill" style={{ alignItems: "stretch" }}>
        <nav className="vstack" style={{ width: 240, flex: "none", borderRight: "1px solid var(--sep)", background: "var(--inspector-bg)" }} aria-label="Tables">
          <div className="sb-header" style={{ padding: "12px 0 4px 14px" }}>Insert a reference</div>
          <div className="scroll fill" style={{ padding: "0 6px 8px" }}>
            {graph.isLoading && <Spinner />}
            {nodes.map((n) => (
              <button key={n.id} className="tree-row" title={`Insert ${n.type === "source" ? "source" : "ref"} for ${n.name}`}
                onClick={() => insert(n.type === "source" ? `{{ source('${n.name.split(".")[0]}', '${n.name.split(".").slice(1).join(".")}') }}` : `{{ ref('${n.name}') }}`)}>
                <I n={typeIcon[n.type] ?? "cube"} /><span className="trunc">{n.name}</span>
              </button>
            ))}
          </div>
          <div className="sb-header" style={{ padding: "8px 0 4px 14px", borderTop: "1px solid var(--hairline)" }}>History</div>
          <div className="scroll" style={{ maxHeight: "35%", padding: "0 6px 10px" }}>
            {history.length === 0 && <span className="t-subhead c2" style={{ padding: "4px 8px", display: "block" }}>Queries you run show up here.</span>}
            {history.map((h) => (
              <button key={h.at} className="tree-row" style={{ height: "auto", padding: "5px 8px", alignItems: "flex-start" }} onClick={() => setSql(h.sql)}>
                <i className={`dot ${h.ok ? "pass" : "error"}`} style={{ marginTop: 5 }} />
                <span className="vstack" style={{ minWidth: 0 }}><span className="mono trunc" style={{ fontSize: 11 }}>{h.sql.replace(/\s+/g, " ").slice(0, 60)}</span><span className="t-caption c2">{fmt.ago(new Date(h.at).toISOString())}{h.ok ? ` · ${h.rows} rows` : " · failed"}</span></span>
              </button>
            ))}
          </div>
        </nav>
        <section className="vstack fill">
          <div className="vstack" style={{ flex: "0 0 42%", minHeight: 160, borderBottom: "1px solid var(--sep)" }}>
            <Editor path="query.sql" value={sql} onChange={setSql} theme={theme} fontSize={settings.data?.font_size ?? 12} onPreview={run} onRun={() => run()} />
          </div>
          <div className="hstack" style={{ height: 34, padding: "0 14px", gap: 10, borderBottom: "1px solid var(--hairline)", background: "var(--inspector-bg)", flex: "none" }}>
            <span className="upper">Results</span>
            {busy ? <span className="hstack t-subhead c2" style={{ gap: 6 }}><Spinner />Running with dbt show…</span> : res && <span className="t-subhead c2">{res.errors.length ? "Failed" : `${res.rows.length} rows · ${fmt.dur(res.ms / 1000)}${res.rows.length >= limit ? ` · first ${limit}` : ""}`}</span>}
            <span className="spacer" />
            {res && res.rows.length > 0 && <Btn size="sm" onClick={() => {
              const csv = [res.columns.join(","), ...res.rows.map((r) => res.columns.map((c) => JSON.stringify(r[c] ?? "")).join(","))].join("\n");
              const a = document.createElement("a");
              a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
              a.download = "results.csv";
              a.click();
            }}>Download CSV</Btn>}
          </div>
          <div className="scroll fill">
            {!res && !busy && <div className="empty"><span className="c2 t-callout">Press Run or ⌘↩ to see results.</span></div>}
            {res?.errors.length ? <div className="console" style={{ color: "var(--red)", whiteSpace: "pre-wrap" }}>{res.errors.join("\n")}</div> : null}
            {res && !res.errors.length && res.rows.length === 0 && <div className="c2 t-callout" style={{ padding: 14 }}>The query returned no rows.</div>}
            {res && res.rows.length > 0 && <DataGrid rows={res.rows} columns={res.columns} />}
          </div>
        </section>
      </div>
      <Sheet open={saveAs !== null} onClose={() => setSaveAs(null)} label="Save as model" width={460}>
        <b className="t-title3">Save as a model</b>
        <p className="c2 t-callout" style={{ lineHeight: "17px" }}>The query becomes a dbt model you can build, test and document. A trailing limit is removed.</p>
        <Field value={saveAs ?? ""} onChange={setSaveAs} mono autoFocus onEnter={save} />
        <div className="acts"><Btn onClick={() => setSaveAs(null)}>Cancel</Btn><Btn kind="prominent" disabled={!saveAs?.match(/^models\/.+\.sql$/)} onClick={save}>Save</Btn></div>
      </Sheet>
    </>
  );
}
