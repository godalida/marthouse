import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError, fmt } from "../api";
import { DataGrid } from "../components/DataGrid";
import { I } from "../icons";
import { useShell } from "../Shell";
import { Btn, Callout, Empty, Seg, Spinner, Status, TbBtn, errText } from "../ui";

type T = { id: string; name: string; full_name: string; kind: string; column: string | null; model: string; model_id: string; severity: string; status: string | null; failures: number | null; message: string | null; time: number | null; path: string; compiled_code: string };
type Overview = { tests: T[]; counts: Record<string, number>; models: number; tested_models: number; untested: string[]; ran_at: string | null };

export function Tests() {
  const { pid, runJob, refresh } = useShell();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const q = useQuery<Overview>({ queryKey: ["tests", pid], queryFn: () => api(`/api/projects/${pid}/tests`), retry: false });
  const [f, setF] = useState<"all" | "failing" | "warn" | "notrun">("all");
  const [search, setSearch] = useState("");
  const [sel, setSel] = useState<string | null>(params.get("test"));
  const [parsing, setParsing] = useState(false);

  const tests = q.data?.tests ?? [];
  const shown = useMemo(() => tests.filter((t) =>
    (f === "all" || (f === "failing" && ["fail", "error"].includes(t.status ?? "")) || (f === "warn" && t.status === "warn") || (f === "notrun" && !t.status)) &&
    (!search || `${t.name} ${t.model} ${t.column ?? ""}`.toLowerCase().includes(search.toLowerCase()))), [tests, f, search]);
  useEffect(() => {
    if (!sel && q.data) setSel(q.data.tests.find((t) => ["fail", "error"].includes(t.status ?? ""))?.id ?? null);
  }, [q.data]); // eslint-disable-line
  const failing = tests.filter((t) => ["fail", "error"].includes(t.status ?? ""));

  if (q.error instanceof ApiError && q.error.status === 409) {
    return (
      <>
        <header className="toolbar"><div className="title"><b>Tests</b></div></header>
        <Empty icon="tests" title="Parse the project to list its tests" actions={<Btn kind="prominent" busy={parsing} onClick={async () => { setParsing(true); await api(`/api/projects/${pid}/parse`, { body: {} }).catch(() => {}); setParsing(false); refresh(); q.refetch(); }}>Run dbt parse</Btn>}>
          Marthouse reads tests from dbt's manifest.json.
        </Empty>
      </>
    );
  }
  const c = q.data?.counts ?? {};
  const pct = q.data?.models ? Math.round((q.data.tested_models / q.data.models) * 100) : 0;
  const t = tests.find((x) => x.id === sel) ?? null;

  return (
    <>
      <header className="toolbar">
        <div className="title"><b>Tests</b><small>{q.data ? `${tests.length} tests · last run ${fmt.ago(q.data.ran_at)}` : ""}</small></div>
        <div className="spacer" />
        <label className="glass tb-search" style={{ width: 200 }}><I n="search" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tests" aria-label="Search tests" /></label>
        {failing.length > 0 && <TbBtn icon="refresh" label={`Re-run ${failing.length} failing`} onClick={() => runJob("test", { select: failing.map((x) => x.full_name).join(" ") })} />}
        <TbBtn icon="play" label="Run all tests" prominent onClick={() => runJob("test")} />
      </header>
      {q.isLoading ? <div className="empty"><Spinner /></div> : (
        <div className="hstack fill" style={{ alignItems: "stretch" }}>
          <section className="vstack fill scroll" style={{ padding: "18px 22px", gap: 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
              <Tile label="Passing" value={c.pass ?? 0} cls="pass" icon="check" />
              <Tile label="Failing" value={(c.fail ?? 0) + (c.error ?? 0)} cls="error" icon="x" />
              <Tile label="Warnings" value={c.warn ?? 0} cls="warn" icon="warn" />
              <Tile label="Not run yet" value={c.not_run ?? 0} cls="skip" icon="minus" />
              <div className="tile">
                <span className="t-subhead c2">Models with tests</span>
                <b className="t-title2">{pct}%</b>
                <div className="progress"><i style={{ width: `${pct}%` }} /></div>
                <span className="t-subhead c2">{q.data?.tested_models} of {q.data?.models}</span>
              </div>
            </div>
            {(q.data?.untested.length ?? 0) > 0 && (
              <Callout tone="accent" icon="info" title={`${q.data!.untested.length} ${q.data!.untested.length === 1 ? "model has" : "models have"} no tests:`}>
                <span >{q.data!.untested.slice(0, 6).join(", ")}{q.data!.untested.length > 6 ? "…" : ""}</span>. Add unique and not_null to each primary key in its .yml file.
              </Callout>
            )}
            <div className="hstack" style={{ gap: 8 }}>
              <Seg label="Filter" value={f} onChange={setF} options={[{ value: "all", label: `All ${tests.length}` }, { value: "failing", label: `Failing ${(c.fail ?? 0) + (c.error ?? 0)}` }, { value: "warn", label: `Warn ${c.warn ?? 0}` }, { value: "notrun", label: `Not run ${c.not_run ?? 0}` }]} />
            </div>
            <div className="tbl">
              <div style={{ minWidth: 760 }}>
                <div className="table-head"><span style={{ width: 90 }}>Status</span><span className="grow">Test</span><span style={{ width: 170 }}>Model</span><span style={{ width: 130 }}>Column</span><span style={{ width: 70 }}>Severity</span><span style={{ width: 70, textAlign: "right" }}>Rows</span></div>
                <div className="zebra">
                  {shown.length === 0 && <div className="list-row c2">No tests match.</div>}
                  {shown.map((x) => (
                    <div key={x.id} className={`list-row click ${sel === x.id ? "sel" : ""}`} style={{ cursor: "pointer" }} onClick={() => setSel(x.id)}>
                      <span style={{ width: 90 }}>{sel === x.id ? <span className="st" style={{ color: "inherit" }}>{x.status ?? "not run"}</span> : <Status s={x.status} />}</span>
                      <span className="grow trunc">{x.name}{x.kind === "singular" && <span className={sel === x.id ? "" : "c2"} style={{ fontFamily: "var(--sf)" }}> · singular</span>}</span>
                      <span style={{ width: 170 }} className="trunc t-callout">{x.model}</span>
                      <span style={{ width: 130 }} className="trunc t-callout c2">{x.column ?? "—"}</span>
                      <span style={{ width: 70 }} className="t-callout c2">{x.severity.toLowerCase()}</span>
                      <span style={{ width: 70, textAlign: "right" }} className="t-callout cell-num">{x.failures ?? "—"}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>
          <aside className="inspector scroll" style={{ maxWidth: 400, flexBasis: 360 }}>
            {!t && <div className="insp-sec"><span className="c2 t-callout">Choose a test to see its SQL and failing rows.</span></div>}
            {t && <TestPanel key={t.id} t={t} onOpenModel={() => nav(`/p/${pid}/lineage?node=${encodeURIComponent(t.model_id)}`)} />}
          </aside>
        </div>
      )}
    </>
  );
}

function Tile({ label, value, cls, icon }: { label: string; value: number; cls: string; icon: any }) {
  return (
    <div className="tile">
      <span className="t-subhead c2">{label}</span>
      <span className={`st ${cls}`} style={{ fontSize: 22, gap: 8 }}><I n={icon} size={18} /><b className="cell-num" style={{ color: "var(--label)" }}>{value}</b></span>
    </div>
  );
}

function TestPanel({ t, onOpenModel }: { t: T; onOpenModel: () => void }) {
  const { pid, runJob } = useShell();
  const nav = useNavigate();
  const [rows, setRows] = useState<{ rows: any[]; columns: string[]; errors: string[]; sql: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    try { setRows(await api(`/api/projects/${pid}/tests/failures`, { body: { node: t.id, limit: 100 } })); }
    catch (e) { setRows({ rows: [], columns: [], errors: [errText(e)], sql: "" }); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (["fail", "warn"].includes(t.status ?? "")) load(); }, [t.id]); // eslint-disable-line
  return (
    <>
      <div className="insp-sec">
        <Status s={t.status} />
        <b style={{ wordBreak: "break-all" }}>{t.name}</b>
        <div className="kv"><span>Model</span><button className="ca" onClick={onOpenModel}>{t.model}</button></div>
        {t.column && <div className="kv"><span>Column</span><span >{t.column}</span></div>}
        <div className="kv"><span>Kind</span><span>{t.kind} · severity {t.severity.toLowerCase()}</span></div>
        {t.time !== null && <div className="kv"><span>Took</span><span>{fmt.dur(t.time)}</span></div>}
        {t.message && <p className="t-callout c2" style={{ lineHeight: "17px" }}>{t.message}</p>}
        <div className="hstack" style={{ gap: 6 }}>
          <Btn kind="tinted" icon="play" onClick={() => runJob("test", { select: t.full_name })}>Run this test</Btn>
          {t.path && <Btn onClick={() => nav(`/p/${pid}/models?file=${encodeURIComponent(t.path)}`)}>Open {t.path.split("/").pop()}</Btn>}
        </div>
      </div>
      <div className="insp-sec">
        <div className="hstack"><span className="upper grow">Failing rows</span><Btn size="sm" busy={busy} onClick={load}>{rows ? "Load again" : "Load"}</Btn></div>
        {rows?.errors?.length ? <span className="t-callout" style={{ color: "var(--red)" }}>{rows.errors[0]}</span> : null}
        {rows && !rows.errors?.length && rows.rows.length === 0 && <span className="t-callout c2">No rows fail right now.</span>}
        {rows && rows.rows.length > 0 && <div className="scroll" style={{ maxHeight: 260, borderRadius: 8, boxShadow: "0 0 0 1px var(--sep)" }}><DataGrid rows={rows.rows} columns={rows.columns} /></div>}
      </div>
      <div className="insp-sec">
        <span className="upper">Compiled SQL</span>
        <div className="console" style={{ borderRadius: 8, whiteSpace: "pre-wrap", maxHeight: 260 }}>{rows?.sql || t.compiled_code || "Run the test once to see its SQL."}</div>
      </div>
    </>
  );
}
