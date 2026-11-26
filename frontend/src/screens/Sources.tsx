import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, fmt, useJob } from "../api";
import { I } from "../icons";
import { StagingGenerator } from "../components/StagingGenerator";
import { useShell } from "../Shell";
import { Btn, Callout, Empty, Spinner, Status, TbBtn } from "../ui";

type Row = { id: string; name: string; description: string; loader: string; loaded_at_field: string | null; status: string | null; age_s: number | null; max_loaded_at: string | null; warn_s: number | null; error_s: number | null; error: string | null; downstream: number };

export function Sources() {
  const { pid, runJob, refresh } = useShell();
  const nav = useNavigate();
  const q = useQuery<{ rows: Row[]; checked_at: string | null }>({ queryKey: ["fresh", pid], queryFn: () => api(`/api/projects/${pid}/freshness`), retry: false });
  const [jobId, setJobId] = useState<string | null>(null);
  const [staging, setStaging] = useState<string | null>(null);
  const job = useJob(jobId, () => { refresh(); q.refetch(); setJobId(null); });
  const check = async () => setJobId(await runJob("freshness", {}, { stay: true }));
  const checking = !!jobId && job?.status !== "success" && job?.status !== "error";

  if (q.error instanceof ApiError && q.error.status === 409) {
    return (<><header className="toolbar"><div className="title"><b>Sources</b></div></header><Empty icon="db" title="Parse the project first" actions={<Btn kind="prominent" onClick={() => runJob("parse")}>Run dbt parse</Btn>}>Sources are read from your _sources.yml files.</Empty></>);
  }
  const rows = q.data?.rows ?? [];
  const worst = rows.filter((r) => r.status === "error" || r.status === "warn").sort((a, b) => (b.age_s ?? 0) - (a.age_s ?? 0))[0];
  return (
    <>
      <header className="toolbar">
        <div className="title"><b>Sources</b><small>{rows.length} tables · {q.data?.checked_at ? `checked ${fmt.time(q.data.checked_at)}` : "freshness not checked yet"}</small></div>
        <div className="spacer" />
        <TbBtn icon="plus" label="Add source" onClick={() => nav(`/p/${pid}/models?file=${encodeURIComponent(rows[0] ? "models/staging/_sources.yml" : "models/_sources.yml")}`)} />
        <TbBtn icon="clock" label={checking ? "Checking…" : "Check freshness"} prominent busy={checking} onClick={check} />
      </header>
      {q.isLoading ? <div className="empty"><Spinner /></div> : rows.length === 0 ? (
        <Empty icon="db" title="No sources yet" actions={<Btn kind="prominent" onClick={() => nav(`/p/${pid}/models?file=models%2F_sources.yml`)}>Create _sources.yml</Btn>}>Sources describe the raw tables your loaders write. Declare them once and models can use source('name', 'table').</Empty>
      ) : (
        <div className="vstack fill scroll" style={{ padding: "18px 22px", gap: 16 }}>
          {worst && (
            <Callout tone={worst.status === "error" ? "error" : "warn"} title={`${worst.name} is ${fmt.age(worst.age_s)} old.`}
              action={<Btn onClick={() => nav(`/p/${pid}/lineage?select=${encodeURIComponent(`source:${worst.name}+`)}`)}>Show affected</Btn>}>
              {worst.status === "error" ? "It's past its error limit." : `It passed its ${fmt.age(worst.warn_s)} warning${worst.error_s ? ` and errors after ${fmt.age(worst.error_s)}` : ""}.`} {worst.downstream} {worst.downstream === 1 ? "node reads" : "nodes read"} from it.
            </Callout>
          )}
          <div className="tbl">
            <div style={{ minWidth: 930 }}>
              <div className="table-head"><span style={{ width: 96 }}>Status</span><span style={{ width: 230 }}>Table</span><span className="grow">Age against thresholds</span><span style={{ width: 120 }}>Loaded at</span><span style={{ width: 100 }}>Loader</span><span style={{ width: 130 }} /></div>
              <div className="zebra">
                {rows.map((r) => {
                  const max = r.error_s ?? (r.warn_s ? r.warn_s * 2 : null);
                  const pct = max && r.age_s !== null ? Math.min(100, Math.max(1, (r.age_s / max) * 100)) : 0;
                  const warnPct = max && r.warn_s ? (r.warn_s / max) * 100 : null;
                  const color = r.status === "error" ? "var(--red)" : r.status === "warn" ? "var(--yellow)" : "var(--green)";
                  return (
                    <div key={r.id} className="list-row click" style={{ minHeight: 46, cursor: "pointer" }} onClick={() => nav(`/p/${pid}/catalog?node=${encodeURIComponent(r.id)}`)}>
                      <span style={{ width: 96 }}>{r.status === "pass" ? <Status s="fresh" /> : r.status === "runtime error" ? <Status s="error" /> : <Status s={r.status ?? "queued"} label={r.status ? undefined : "Not checked"} />}</span>
                      <span style={{ width: 230 }} className="vstack"><span className="trunc">{r.name}</span><span className="t-subhead c2 trunc">{r.description}</span></span>
                      <span className="grow vstack" style={{ gap: 4, paddingRight: 20 }}>
                        {r.status === "none" ? <span className="t-callout c2">{r.loaded_at_field ? "No thresholds set" : "Add loaded_at_field to check"}</span> : r.error ? <span className="t-callout" style={{ color: "var(--red)" }}>{r.error}</span> : (
                          <>
                            <span style={{ position: "relative", height: 6, borderRadius: 3, background: "var(--fill2)", display: "block" }}>
                              {r.age_s !== null && <i style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct}%`, borderRadius: 3, background: color, display: "block" }} />}
                              {warnPct !== null && <i style={{ position: "absolute", left: `${warnPct}%`, top: -3, width: 1, height: 12, background: "var(--yellow)", display: "block" }} />}
                              {r.error_s && <i style={{ position: "absolute", right: 0, top: -3, width: 1, height: 12, background: "var(--red)", display: "block" }} />}
                            </span>
                            <span className="t-caption c2">{r.age_s !== null ? fmt.age(r.age_s) : "Not checked yet"}</span>
                          </>
                        )}
                      </span>
                      <span style={{ width: 120 }} className="t-callout c2">{r.max_loaded_at ? fmt.time(r.max_loaded_at) : "—"}</span>
                      <span style={{ width: 100 }} className="t-callout c2 trunc">{r.loader || "—"}</span>
                      <span style={{ width: 130, textAlign: "right" }}><Btn size="sm" onClick={(e) => { e.stopPropagation(); setStaging(r.id); }}>Staging model…</Btn></span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="hstack t-subhead c2" style={{ gap: 16, flexWrap: "wrap" }}>
            <span className="hstack" style={{ gap: 6 }}><i style={{ width: 1, height: 12, background: "var(--yellow)", display: "block" }} />warn threshold</span>
            <span className="hstack" style={{ gap: 6 }}><i style={{ width: 1, height: 12, background: "var(--red)", display: "block" }} />error threshold</span>
            <span className="hstack" style={{ gap: 6 }}><I n="info" size={14} />Thresholds come from each source's freshness block.</span>
          </div>
        </div>
      )}
      <StagingGenerator sourceId={staging} onClose={() => setStaging(null)} />
    </>
  );
}
