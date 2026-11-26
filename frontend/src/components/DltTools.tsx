import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { I } from "../icons";
import { InstallProgress } from "../screens/Setup";
import { Btn, Radio, Select, Sheet, Spinner, Status, errText, useToast } from "../ui";

export type DltInstall = { python: string; path: string; kind: string; label: string; version: string | null; has: string[]; status: string; note: string; default?: boolean; destinations: string[]; sources: string[] };
type ToolsInfo = { installs: DltInstall[]; destinations: { id: string; name: string }[]; sources: { id: string; name: string }[] };

export function useDlt() {
  return useQuery<ToolsInfo>({ queryKey: ["dlt-installs"], queryFn: () => api("/api/tools/dlt"), staleTime: 60_000 });
}

export function DltInstallBody({ onCancel, onStarted, initial }: { onCancel: () => void; onStarted: (jobId: string) => void; initial?: string[] }) {
  const toast = useToast();
  const info = useDlt();
  const versions = useQuery<{ versions: string[]; latest: string; online: boolean }>({ queryKey: ["dlt-versions"], queryFn: () => api("/api/tools/dlt/versions") });
  const [dests, setDests] = useState<string[]>(initial ?? ["duckdb"]);
  const [sources, setSources] = useState<string[]>(["rest_api", "sql_database", "filesystem"]);
  const [version, setVersion] = useState("");
  const [plan, setPlan] = useState<{ steps: { display: string }[] } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const v = version || versions.data?.latest || "";
  const body = useMemo(() => ({ version: v, destinations: dests, sources }), [v, dests, sources]);
  useEffect(() => {
    if (!v) return;
    api("/api/tools/dlt/install/plan", { body }).then((p) => { setPlan(p); setErr(""); }).catch((e) => { setPlan(null); setErr(errText(e)); });
  }, [body, v]);
  const toggle = (list: string[], set: (x: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  return (
    <>
      <div className="vstack" style={{ gap: 4 }}>
        <b className="t-title2">Install dlt</b>
        <span className="c2 t-callout">dlt (by dltHub) loads data from APIs, databases and files into your warehouse. Pick where it should load to.</span>
      </div>
      <div className="vstack" style={{ gap: 6 }}>
        <span className="upper">Load into</span>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
          {(info.data?.destinations ?? []).map((d) => {
            const on = dests.includes(d.id);
            return (
              <button key={d.id} className={`tile ${on ? "on" : ""}`} aria-pressed={on} onClick={() => toggle(dests, setDests, d.id)} style={{ textAlign: "left" }}>
                <span className="hstack" style={{ gap: 6 }}><I n="db" className="ca" /><b className="grow">{d.name}</b>{on && <I n="check" size={14} className="ca" />}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="vstack" style={{ gap: 6 }}>
        <span className="upper">Load from</span>
        <div className="hstack" style={{ gap: 8, flexWrap: "wrap" }}>
          {(info.data?.sources ?? []).map((s) => {
            const on = sources.includes(s.id);
            return (
              <button key={s.id} className={`tile ${on ? "on" : ""}`} aria-pressed={on} disabled={s.id === "rest_api"} onClick={() => toggle(sources, setSources, s.id)} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <I n={s.id === "rest_api" ? "api" : s.id === "sql_database" ? "db" : "file"} className="ca" />{s.name}{on && <I n="check" size={14} className="ca" />}
              </button>
            );
          })}
        </div>
      </div>
      <div className="group">
        <div className="form-row"><span className="lead">dlt version{versions.data && !versions.data.online && <small>Offline: showing a known version</small>}</span>
          {versions.isLoading ? <Spinner /> : <Select label="Version" value={v} onChange={setVersion} options={(versions.data?.versions ?? []).map((x, i) => ({ value: x, label: i === 0 ? `${x} (latest)` : x }))} />}
        </div>
      </div>
      <div className="console" style={{ borderRadius: 8, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
        {err ? <span className="err">{err}</span> : plan ? plan.steps.map((s, i) => <div key={i} className="hi">{s.display}</div>) : "…"}
      </div>
      <div className="acts">
        <span className="t-subhead c2 grow">Installs into Marthouse's own folder. Nothing else on this computer changes.</span>
        <Btn onClick={onCancel}>Cancel</Btn>
        <Btn kind="prominent" busy={busy} disabled={!plan || !!err} onClick={async () => {
          setBusy(true);
          try { onStarted((await api("/api/tools/dlt/install", { body })).job_id); } catch (e) { toast(errText(e), "error"); setBusy(false); }
        }}>Install</Btn>
      </div>
    </>
  );
}

export function DltInstallSheet({ open, onClose, initial }: { open: boolean; onClose: () => void; initial?: string[] }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const qc = useQueryClient();
  useEffect(() => { if (open) setJobId(null); }, [open]);
  return (
    <Sheet open={open} onClose={() => !jobId && onClose()} label="Install dlt" width={660}>
      {jobId ? (
        <div className="vstack" style={{ gap: 14, minHeight: 360 }}>
          <InstallProgress jobId={jobId} onDone={() => { qc.invalidateQueries({ queryKey: ["dlt-installs"] }); onClose(); }} onRetry={() => setJobId(null)} />
          <div className="acts"><Btn onClick={onClose}>Close</Btn></div>
        </div>
      ) : <DltInstallBody onCancel={onClose} onStarted={setJobId} initial={initial} />}
    </Sheet>
  );
}

export function DltSection() {
  const info = useDlt();
  const qc = useQueryClient();
  const toast = useToast();
  const [sheet, setSheet] = useState(false);
  const list = info.data?.installs ?? [];
  const makeDefault = async (i: DltInstall) => {
    try { await api("/api/tools/dlt/default", { body: { path: i.python } }); qc.invalidateQueries({ queryKey: ["dlt-installs"] }); } catch (e) { toast(errText(e), "error"); }
  };
  return (
    <>
      <div className="hstack" style={{ padding: "22px 12px 8px", gap: 8 }}>
        <span className="vstack grow"><b style={{ fontSize: 13 }}>dlt</b><span className="t-subhead c2">Loads data from APIs, databases and files. Used by Pipelines.</span></span>
        <Btn size="sm" busy={info.isFetching} onClick={() => info.refetch()}>Look again</Btn>
        <Btn size="sm" kind="tinted" onClick={() => setSheet(true)}>{list.length ? "Install another…" : "Install dlt…"}</Btn>
      </div>
      <div className="group" style={{ padding: 0 }}>
        {info.isLoading && <div className="form-row" style={{ padding: "12px 14px" }}><Spinner /><span className="c2">Looking…</span></div>}
        {!info.isLoading && list.length === 0 && <div className="form-row" style={{ padding: "12px 14px" }}><span className="c2">dlt isn't installed. Install it to build pipelines.</span></div>}
        {list.map((i, n) => (
          <div key={i.python} className="hstack" style={{ gap: 12, padding: "12px 14px", borderBottom: n < list.length - 1 ? "1px solid var(--hairline)" : 0 }}>
            <button onClick={() => makeDefault(i)} disabled={i.status !== "ok"} aria-label="Use as default"><Radio on={!!i.default} /></button>
            <span className="vstack grow" style={{ gap: 2, minWidth: 0 }}>
              <span className="hstack" style={{ gap: 8 }}><b>dlt {i.version ?? ""}</b>{i.default && <span className="t-subhead c2">Default</span>}</span>
              <span className="t-subhead c2 trunc" title={i.python}>{i.python.replace(/^\/Users\/[^/]+/, "~")}</span>
              <span className="t-subhead c2">{i.label} · loads into {i.destinations.join(", ") || "nothing yet"} · reads {i.sources.map((s) => s.replace("_", " ")).join(", ")}</span>
            </span>
            {i.status === "ok" ? <Status s="works" /> : <Status s="warn" label={i.status === "too_old" ? "Too old" : "Broken"} />}
          </div>
        ))}
      </div>
      <DltInstallSheet open={sheet} onClose={() => setSheet(false)} />
    </>
  );
}
