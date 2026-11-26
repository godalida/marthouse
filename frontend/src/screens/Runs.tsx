import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, fmt, ts, useJob, type NodeRun } from "../api";
import { I, typeIcon } from "../icons";
import { useShell } from "../Shell";
import { useSettings } from "../store";
import { Btn, Check, Console, Empty, Field, Seg, Select, Sheet, Spinner, Status, TbBtn, dotClass, errText, useToast } from "../ui";

type JobRow = { id: string; kind: string; title: string; status: string; created_at: string; started_at: string | null; finished_at: string | null; params: any; summary: any; command: string[] };

export function Runs() {
  return <RunsView />;
}
export function RunDetail() {
  const { jid } = useParams();
  return <RunsView jid={jid} />;
}

const KINDS = [
  { value: "build", label: "build" }, { value: "run", label: "run" }, { value: "test", label: "test" }, { value: "seed", label: "seed" },
  { value: "snapshot", label: "snapshot" }, { value: "freshness", label: "source freshness" }, { value: "docs", label: "docs generate" }, { value: "deps", label: "deps" }, { value: "clean", label: "clean" },
];

function RunsView({ jid }: { jid?: string }) {
  const { pid, runJob } = useShell();
  const nav = useNavigate();
  const list = useQuery<JobRow[]>({ queryKey: ["jobs", pid], queryFn: () => api("/api/jobs", { query: { project_id: pid, limit: 100 } }), refetchInterval: 5000 });
  const current = jid ?? list.data?.[0]?.id;
  const [newRun, setNewRun] = useState(false);
  return (
    <>
      <header className="toolbar">
        <div className="title"><b>Runs</b><small>{list.data ? `${list.data.length} recent` : ""}</small></div>
        <div className="spacer" />
        <TbBtn icon="tests" label="Test" onClick={() => runJob("test")} />
        <TbBtn icon="plus" label="New run…" onClick={() => setNewRun(true)} />
        <TbBtn icon="play" label="Build" prominent onClick={() => runJob("build")} />
      </header>
      <div className="hstack fill" style={{ alignItems: "stretch" }}>
        <nav className="vstack scroll" style={{ width: 270, flex: "none", borderRight: "1px solid var(--sep)", background: "var(--inspector-bg)", padding: "8px 8px" }} aria-label="Run history">
          {list.isLoading && <Spinner />}
          {list.data?.length === 0 && <span className="c2 t-callout" style={{ padding: 10 }}>No runs yet.</span>}
          {list.data?.map((j) => (
            <button key={j.id} className={`sb-item ${j.id === current ? "on" : ""}`} style={{ height: "auto", padding: "8px 10px", alignItems: "flex-start" }} onClick={() => nav(`/p/${pid}/runs/${j.id}`)}>
              <i className={`dot ${j.status === "running" || j.status === "queued" ? "run" : dotClass(j.status)}`} style={{ marginTop: 4 }} />
              <span className="vstack grow" style={{ gap: 2, minWidth: 0 }}>
                <span className="trunc">{j.title}</span>
                <span className="t-subhead c2">{fmt.time(j.created_at)} · {j.status === "running" ? "running" : duration(j)}{summaryText(j.summary)}</span>
              </span>
            </button>
          ))}
        </nav>
        {current ? <RunPanel key={current} jobId={current} /> : <Empty icon="play" title="Nothing has run yet" actions={<Btn kind="prominent" onClick={() => runJob("build")}>Build the project</Btn>}>Build runs seeds, models, snapshots and tests in order. The log and each node's result show up here.</Empty>}
      </div>
      <NewRunSheet open={newRun} onClose={() => setNewRun(false)} />
    </>
  );
}

function duration(j: { started_at: string | null; finished_at: string | null }) {
  if (!j.started_at || !j.finished_at) return "—";
  return fmt.dur((ts(j.finished_at) - ts(j.started_at)) / 1000);
}
function summaryText(s: any) {
  if (!s?.counts) return "";
  const c = s.counts;
  const bad = (c.error ?? 0) + (c.fail ?? 0);
  return bad ? ` · ${bad} failed` : c.warn ? ` · ${c.warn} warn` : "";
}

function NewRunSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { runJob } = useShell();
  const [kind, setKind] = useState("build");
  const [select, setSelect] = useState("");
  const [exclude, setExclude] = useState("");
  const [full, setFull] = useState(false);
  const [failFast, setFailFast] = useState(false);
  const cmd = ["dbt", KINDS.find((k) => k.value === kind)?.label, select && `--select ${select}`, exclude && `--exclude ${exclude}`, full && "--full-refresh", failFast && "--fail-fast"].filter(Boolean).join(" ");
  return (
    <Sheet open={open} onClose={onClose} label="New run" width={520}>
      <b className="t-title2">New run</b>
      <div className="group">
        <div className="form-row"><span className="lead">Command</span><Select label="Command" value={kind} onChange={setKind} options={KINDS} /></div>
        <div className="form-row"><span className="lead">Select<small>Empty runs everything</small></span><Field value={select} onChange={setSelect} placeholder="+orders tag:daily" mono width={240} /></div>
        <div className="form-row"><span className="lead">Exclude</span><Field value={exclude} onChange={setExclude} placeholder="tag:slow" mono width={240} /></div>
        {["build", "run", "seed"].includes(kind) && <div className="form-row"><span className="lead">Full refresh<small>Rebuild incremental models and seeds from scratch</small></span><Check on={full} onChange={setFull} label="Full refresh" /></div>}
        {["build", "run", "test"].includes(kind) && <div className="form-row"><span className="lead">Stop at the first failure</span><Check on={failFast} onChange={setFailFast} label="Fail fast" /></div>}
      </div>
      <div className="console" style={{ borderRadius: 8 }}><span className="hi">{cmd}</span></div>
      <div className="acts"><Btn onClick={onClose}>Cancel</Btn><Btn kind="prominent" onClick={() => { onClose(); runJob(kind, { select, exclude, full_refresh: full, fail_fast: failFast }); }}>Run</Btn></div>
    </Sheet>
  );
}

function RunPanel({ jobId }: { jobId: string }) {
  const { pid, runJob, refresh, project } = useShell();
  const settings = useSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const meta = useQuery<any>({ queryKey: ["job", jobId], queryFn: () => api(`/api/jobs/${jobId}`) });
  const job = useJob(jobId, () => {
    qc.invalidateQueries({ queryKey: ["jobs", pid] });
    qc.invalidateQueries({ queryKey: ["job", jobId] });
    refresh();
  });
  const [tab, setTab] = useState<"nodes" | "log">("nodes");
  const [selNode, setSelNode] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "problems">("all");
  const [now, setNow] = useState(Date.now());
  const running = job?.status === "running" || job?.status === "queued";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);

  const nodes = useMemo(() => Object.entries(job?.nodes ?? {}).map(([id, n]) => ({ id, ...n })) as (NodeRun & { id: string })[], [job?.nodes]);
  const hasNodeKinds = meta.data && ["build", "run", "test", "seed", "snapshot", "freshness"].includes(meta.data.kind);
  useEffect(() => { if (meta.data && !hasNodeKinds) setTab("log"); }, [meta.data, hasNodeKinds]);

  const startOf = (n: NodeRun) => (n.status === "skipped" ? NaN : ts(n.started));
  const endOf = (n: NodeRun) => (n.status === "skipped" ? NaN : n.finished ? ts(n.finished) : Number.isFinite(ts(n.started)) && running ? now : NaN);
  const starts = nodes.map(startOf).filter(Number.isFinite);
  const t0 = starts.length ? Math.min(...starts) : Number.isFinite(ts(meta.data?.started_at)) ? ts(meta.data?.started_at) : now;
  const tEnd = Math.max(t0 + 1000, ...nodes.map(endOf).filter(Number.isFinite));
  const span = Math.max(1, tEnd - t0);
  const counts = nodes.reduce<Record<string, number>>((a, n) => { const s = n.status ?? "queued"; a[s] = (a[s] ?? 0) + 1; return a; }, {});
  const ok = (counts.success ?? 0) + (counts.pass ?? 0);
  const bad = (counts.error ?? 0) + (counts.fail ?? 0) + (counts["runtime error"] ?? 0);
  const doneN = nodes.filter((n) => n.status && !["queued", "started", "executing", "compiling", "running"].includes(n.status)).length;
  const shown = (filter === "problems" ? nodes.filter((n) => ["error", "fail", "warn", "runtime error", "skipped"].includes(n.status ?? "")) : nodes)
    .sort((a, b) => (Number.isFinite(startOf(a)) ? startOf(a) : Infinity) - (Number.isFinite(startOf(b)) ? startOf(b) : Infinity));
  const sn = selNode ? nodes.find((n) => n.id === selNode) : nodes.find((n) => ["error", "fail", "runtime error"].includes(n.status ?? ""));
  const failedSel = sn && ["error", "fail", "warn", "runtime error"].includes(sn.status ?? "");
  const graph = qc.getQueryData<any>(["graph", pid, ""]);

  const cancel = async () => {
    try { await api(`/api/jobs/${jobId}/cancel`, { body: {} }); } catch (e) { toast(errText(e), "error"); }
  };
  const again = () => { const p = meta.data?.params ?? {}; runJob(meta.data.kind, p); };

  if (!meta.data || !job) return <div className="empty"><Spinner /></div>;
  const statusLabel = job.status === "success" ? "Finished" : job.status === "error" ? (bad ? `${bad} failed` : "Failed") : job.status === "cancelled" ? "Stopped" : job.status === "queued" ? "Waiting" : "Running";
  return (
    <section className="vstack fill">
      <div className="vstack" style={{ padding: "16px 20px 12px", gap: 10, borderBottom: "1px solid var(--hairline)" }}>
        <div className="hstack" style={{ gap: 10, flexWrap: "wrap" }}>
          <Status s={job.status === "success" ? "success" : job.status} label={statusLabel} />
          {settings.data?.show_command !== false && meta.data.command?.map((c: string, i: number) => (
            <button key={i} className="rtype" style={{ height: 24, maxWidth: 520 }} title="Copy command" onClick={() => { navigator.clipboard?.writeText(c); toast("Command copied"); }}>
              <I n="terminal" /><span className="trunc">{c.replace(/--project-dir \S+ --profiles-dir \S+/, "").replace(/\S*\/bin\/dbt/, "dbt").replace("--log-format json ", "")}</span>
            </button>
          ))}
          <span className="spacer" />
          <span className="t-subhead c2">{fmt.time(meta.data.created_at)}{meta.data.params?.target ? ` · target ${meta.data.params.target}` : ""}</span>
          {running ? <Btn kind="destructive" icon="stop" onClick={cancel}>Stop</Btn> : <Btn icon="refresh" onClick={again} disabled={meta.data.kind === "install"}>Run again</Btn>}
        </div>
        {hasNodeKinds && nodes.length > 0 && (
          <div className="hstack" style={{ gap: 18, flexWrap: "wrap" }}>
            <div className="progress grow" style={{ minWidth: 200, maxWidth: 420 }}><i style={{ width: `${(doneN / Math.max(1, nodes.length)) * 100}%`, background: bad ? "var(--red)" : undefined }} /></div>
            <span className="t-callout"><b className="cell-num">{doneN}</b><span className="c2"> of {nodes.length}</span></span>
            <span className="st pass"><I n="check" />{ok} ok</span>
            {bad > 0 && <span className="st error"><I n="x" />{bad} failed</span>}
            {counts.warn ? <span className="st warn"><I n="warn" />{counts.warn} warn</span> : null}
            {counts.skipped ? <span className="st skip"><I n="minus" />{counts.skipped} skipped</span> : null}
            <span className="t-callout c2">{fmt.dur((running ? now - t0 : Number.isFinite(ts(meta.data.finished_at)) ? ts(meta.data.finished_at) - ts(meta.data.started_at) : span) / 1000)}</span>
          </div>
        )}
        {hasNodeKinds && <div className="hstack" style={{ gap: 8 }}>
          <Seg label="Show" value={tab} onChange={setTab} options={[{ value: "nodes", label: "Nodes" }, { value: "log", label: "Log" }]} />
          {tab === "nodes" && <Seg label="Filter" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "problems", label: "Problems" }]} />}
        </div>}
      </div>
      {tab === "log" || !hasNodeKinds ? (
        <Console lines={job.lines} style={{ flex: 1, minHeight: 0 }} empty={running ? "Starting…" : "No output."} />
      ) : (
        <div className="vstack fill">
          <div className="scroll fill">
            <div style={{ minWidth: 720 }}>
              <div className="table-head" style={{ position: "sticky", top: 0, background: "var(--window-bg)", zIndex: 1 }}>
                <span style={{ width: 96 }}>Status</span><span style={{ width: 240 }}>Node</span><span className="grow">Timeline</span><span style={{ width: 70, textAlign: "right" }}>Time</span>
              </div>
              <div className="zebra">
                {shown.length === 0 && <div className="list-row c2">{running ? "Waiting for dbt…" : "No nodes."}</div>}
                {shown.map((n) => {
                  const s0 = startOf(n), e0 = endOf(n);
                  const s = Number.isFinite(s0) ? s0 : null;
                  const e = Number.isFinite(e0) ? e0 : null;
                  const color = ["error", "fail", "runtime error"].includes(n.status ?? "") ? "var(--red)" : n.status === "warn" ? "var(--yellow)" : ["success", "pass"].includes(n.status ?? "") ? "var(--green)" : "var(--accent)";
                  return (
                    <div key={n.id} className={`list-row click ${sn?.id === n.id && failedSel ? "" : ""}`} style={{ cursor: "pointer", background: sn?.id === n.id ? "var(--accent-soft)" : undefined }} onClick={() => setSelNode(n.id)}>
                      <span style={{ width: 96 }}><Status s={n.status ?? "queued"} /></span>
                      <span style={{ width: 240 }} className="hstack trunc"><I n={typeIcon[n.type ?? ""] ?? "cube"} size={14} className="ca" /><span className="trunc" style={{ marginLeft: 6 }}>{n.name ?? n.id.split(".").pop()}</span></span>
                      <span className="grow" style={{ paddingRight: 12 }}>
                        <span className="tl" style={{ display: "block" }}>{s && e && <i style={{ left: `${((s - t0) / span) * 100}%`, width: `${Math.max(0.6, ((e - s) / span) * 100)}%`, background: color }} />}</span>
                      </span>
                      <span style={{ width: 70, textAlign: "right" }} className="t-callout c2 cell-num">{n.time !== undefined ? fmt.dur(n.time) : s && e ? fmt.dur((e - s) / 1000) : ""}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          {sn && (failedSel || selNode) && (
            <div className="vstack" style={{ maxHeight: "40%", borderTop: "1px solid var(--sep)", background: "var(--inspector-bg)" }}>
              <div className="hstack" style={{ gap: 10, padding: "10px 16px" }}>
                <Status s={sn.status} />
                <b >{sn.name}</b>
                <span className="spacer" />
                {graph?.nodes?.find((x: any) => x.id === sn.id)?.path && <Btn size="sm" onClick={() => nav(`/p/${pid}/models?file=${encodeURIComponent(graph.nodes.find((x: any) => x.id === sn.id).path)}`)}>Open file</Btn>}
                {sn.type !== "test" && <Btn size="sm" onClick={() => runJob("build", { select: sn.name })}>Build again</Btn>}
                {["seed", "model"].includes(sn.type ?? "") && failedSel && <Btn size="sm" onClick={() => runJob("build", { select: `${sn.name}+`, full_refresh: true })}>Full refresh</Btn>}
                {sn.type === "test" && <Btn size="sm" onClick={() => nav(`/p/${pid}/tests?test=${encodeURIComponent(sn.id)}`)}>Show failing rows</Btn>}
                <button className="btn sm borderless" aria-label="Close" onClick={() => setSelNode(null)}><I n="x" size={14} /></button>
              </div>
              {failedSel && <p className="t-callout" style={{ padding: "0 16px 6px", lineHeight: "17px" }}>{explain(sn)}</p>}
              <div className="console" style={{ whiteSpace: "pre-wrap", margin: "0 16px 14px", borderRadius: 8, maxHeight: 220 }}>
                {sn.message || job.lines.filter((l) => l.text.includes(sn.name ?? "§")).map((l) => l.text).join("\n") || "No message."}
              </div>
            </div>
          )}
        </div>
      )}
      {job.status === "success" && meta.data.kind === "docs" && (
        <div className="hstack" style={{ gap: 8, padding: "10px 16px", borderTop: "1px solid var(--sep)" }}>
          <span className="grow t-callout">Docs are ready.</span>
          <Btn onClick={() => nav(`/p/${pid}/catalog`)}>Open docs and catalog</Btn>
          <a className="btn" href={`/api/projects/${project.id}/docs/export`}>Export site (.zip)</a>
        </div>
      )}
    </section>
  );
}

function explain(n: NodeRun) {
  const m = (n.message ?? "").toLowerCase();
  if (n.type === "test" && n.status === "fail") return `This test found ${n.failures ?? "some"} ${n.failures === 1 ? "row" : "rows"} that break the rule. Open the failing rows to see them.`;
  if (n.status === "warn") return "The test found rows, but its severity is warn, so the run continued.";
  if (m.includes("number of columns") || m.includes("columns changed") || (n.type === "seed" && m.includes("sniff")))
    return "The table in the warehouse has different columns from this file now. Build it again with Full refresh to replace the table.";
  if (m.includes("does not exist") || m.includes("not found")) return "dbt couldn't find a table or column this node reads. Check the ref, the source, or that upstream models were built.";
  if (m.includes("syntax")) return "The warehouse rejected the SQL. Check the compiled SQL for the line it points at.";
  if (m.includes("permission") || m.includes("denied")) return "The warehouse user isn't allowed to do this. Check the role or grants in Connections.";
  if (n.status === "skipped") return "Skipped because something it depends on failed.";
  return "Here is what dbt reported:";
}
