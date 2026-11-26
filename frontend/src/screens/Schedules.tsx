import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, fmt } from "../api";
import { I } from "../icons";
import { useShell } from "../Shell";
import { useHello } from "../store";
import { Alert, Btn, Callout, Check, Empty, Field, Seg, Select, Sheet, Spinner, Status, Switch, TbBtn, errText, useToast } from "../ui";

type Step = { type: "pipeline"; name: string; refresh?: boolean } | { type: "dbt"; kind: string; select?: string };
type Sched = { id: string; name: string; cadence: any; steps: Step[]; enabled: boolean; description: string; next_run_at: string | null; last_run_at: string | null; last_job: any; alert_on_failure: boolean; has_webhook: boolean };
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function Schedules() {
  const { pid } = useShell();
  const [params, setParams] = useSearchParams();
  const hello = useHello();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const list = useQuery<Sched[]>({ queryKey: ["schedules", pid], queryFn: () => api(`/api/projects/${pid}/schedules`), refetchInterval: 15000 });
  const [edit, setEdit] = useState<Partial<Sched> | null>(null);
  const [del, setDel] = useState<Sched | null>(null);
  useEffect(() => {
    const p = params.get("pipeline");
    if (p) {
      setEdit({ name: `Load ${p}`, cadence: { kind: "daily", time: "06:00", tz: TZ }, steps: [{ type: "pipeline", name: p }], enabled: true });
      params.delete("pipeline");
      setParams(params, { replace: true });
    }
  }, [params]); // eslint-disable-line
  const reload = () => { qc.invalidateQueries({ queryKey: ["schedules", pid] }); };
  const toggle = async (s: Sched) => {
    try { await api(`/api/projects/${pid}/schedules/${s.id}`, { method: "PUT", body: { ...s, enabled: !s.enabled } }); reload(); } catch (e) { toast(errText(e), "error"); }
  };
  const runNow = async (s: Sched) => {
    try { const j = await api(`/api/projects/${pid}/schedules/${s.id}/run`, { body: {} }); nav(`/p/${pid}/runs/${j.id}`); } catch (e) { toast(errText(e), "error"); }
  };
  return (
    <>
      <header className="toolbar">
        <div className="title"><b>Schedules</b><small>{hello.data?.mode === "hosted" ? "Run on Marthouse's servers" : "Run while Marthouse is open on this computer"}</small></div>
        <div className="spacer" />
        <TbBtn icon="plus" label="New schedule" prominent onClick={() => setEdit({ name: "", cadence: { kind: "daily", time: "06:00", tz: TZ }, steps: [{ type: "dbt", kind: "build" }], enabled: true })} />
      </header>
      {list.isLoading ? <div className="empty"><Spinner /></div> : !list.data?.length ? (
        <Empty icon="calendar" title="Nothing is scheduled" actions={<Btn kind="prominent" onClick={() => setEdit({ name: "Morning refresh", cadence: { kind: "daily", time: "06:00", tz: TZ }, steps: [{ type: "dbt", kind: "build" }], enabled: true })}>New schedule</Btn>}>
          A schedule runs steps in order on a timetable, for example: load the API, then build everything that reads it, every weekday at 6:00.
        </Empty>
      ) : (
        <div className="vstack scroll fill" style={{ padding: "18px 22px", gap: 12 }}>
          {hello.data?.mode !== "hosted" && <Callout tone="accent" icon="info" title="Schedules run while Marthouse is running on this computer.">If it was closed at a scheduled time, that run is skipped rather than run late. The hosted version runs them on a server.</Callout>}
          <div className="tbl">
            <div className="table-head"><span style={{ width: 44 }}>On</span><span className="grow">Schedule</span><span style={{ width: 170 }}>Next run</span><span style={{ width: 170 }}>Last run</span><span style={{ width: 160 }} /></div>
            {list.data.map((s) => (
              <div key={s.id} className="list-row" style={{ minHeight: 56 }}>
                <span style={{ width: 44 }}><Switch on={s.enabled} onChange={() => toggle(s)} label={`Turn ${s.name} on or off`} /></span>
                <span className="grow vstack" style={{ gap: 2, minWidth: 0 }}>
                  <b>{s.name}</b>
                  <span className="t-subhead c2">{s.description}</span>
                  <span className="t-subhead c2 trunc">{s.steps.map((st) => (st.type === "pipeline" ? `load ${st.name}` : `dbt ${st.kind}${st.select ? ` ${st.select}` : ""}`)).join("  →  ")}</span>
                </span>
                <span style={{ width: 170 }} className="t-callout">{s.enabled && s.next_run_at ? fmt.time(s.next_run_at) : <span className="c3">Paused</span>}</span>
                <span style={{ width: 170 }}>{s.last_job ? <button onClick={() => nav(`/p/${pid}/runs/${s.last_job.id}`)}><Status s={s.last_job.status} label={`${fmt.ago(s.last_job.created_at)}`} /></button> : <span className="c3 t-callout">Never</span>}</span>
                <span style={{ width: 160 }} className="hstack"><span className="spacer" /><Btn size="sm" onClick={() => runNow(s)}>Run now</Btn><Btn size="sm" style={{ marginLeft: 6 }} onClick={() => setEdit(s)}>Edit</Btn><button className="btn sm borderless" aria-label="Delete" onClick={() => setDel(s)}><I n="trash" size={14} /></button></span>
              </div>
            ))}
          </div>
        </div>
      )}
      {edit && <Editor initial={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
      <Alert open={!!del} icon="trash" title={`Delete ${del?.name}?`} message="Past runs stay in the Runs history."
        actions={[{ label: "Delete", destructive: true, onClick: async () => { const s = del!; setDel(null); await api(`/api/projects/${pid}/schedules/${s.id}`, { method: "DELETE" }); reload(); } }, { label: "Cancel", preferred: true, onClick: () => setDel(null) }]} />
    </>
  );
}

function Editor({ initial, onClose, onSaved }: { initial: Partial<Sched>; onClose: () => void; onSaved: () => void }) {
  const { pid, project } = useShell();
  const toast = useToast();
  const pipes = useQuery<any[]>({ queryKey: ["pipelines", pid], queryFn: () => api(`/api/projects/${pid}/pipelines`) });
  const [name, setName] = useState(initial.name ?? "");
  const [cad, setCad] = useState<any>(initial.cadence ?? { kind: "daily", time: "06:00", tz: TZ });
  const [steps, setSteps] = useState<Step[]>(initial.steps ?? []);
  const [enabled, setEnabled] = useState(initial.enabled ?? true);
  const [alert, setAlert] = useState(initial.alert_on_failure ?? false);
  const [webhook, setWebhook] = useState("");
  const [preview, setPreview] = useState<{ next: string[]; description: string } | null>(null);
  const [perr, setPerr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const h = setTimeout(() => api(`/api/projects/${pid}/schedules-preview`, { body: { cadence: cad } }).then((r) => { setPreview(r); setPerr(""); }).catch((e) => { setPreview(null); setPerr(errText(e)); }), 250);
    return () => clearTimeout(h);
  }, [cad, pid]);
  const setStep = (i: number, s: Step) => setSteps(steps.map((x, j) => (j === i ? s : x)));
  const save = async () => {
    setBusy(true);
    const body = { name, cadence: cad, steps, enabled, alert_on_failure: alert, webhook_url: webhook };
    try {
      if (initial.id) await api(`/api/projects/${pid}/schedules/${initial.id}`, { method: "PUT", body });
      else await api(`/api/projects/${pid}/schedules`, { body });
      onSaved();
    } catch (e) { toast(errText(e), "error"); } finally { setBusy(false); }
  };
  const hasDbt = !!project.info?.has_dbt;
  return (
    <Sheet open onClose={onClose} label="Schedule" width={640}>
      <b className="t-title2">{initial.id ? `Edit ${initial.name}` : "New schedule"}</b>
      <div className="group">
        <div className="form-row"><span className="lead">Name</span><Field value={name} onChange={setName} width={260} placeholder="Morning refresh" autoFocus={!initial.id} /></div>
        <div className="form-row"><span className="lead">Runs</span>
          <Select label="Cadence" value={cad.kind} onChange={(k) => setCad({ ...cad, kind: k })} options={[{ value: "hourly", label: "Every hour" }, { value: "daily", label: "Every day" }, { value: "weekdays", label: "Weekdays" }, { value: "weekly", label: "Every week" }, { value: "cron", label: "Custom (cron)" }]} />
        </div>
        {cad.kind === "hourly" && <div className="form-row"><span className="lead">At minute</span><Field value={cad.minute ?? 0} onChange={(v) => setCad({ ...cad, minute: Number(v.replace(/\D/g, "")) % 60 })} width={70} /></div>}
        {cad.kind === "weekly" && <div className="form-row"><span className="lead">Day</span><Seg label="Day" value={cad.day ?? "mon"} onChange={(d) => setCad({ ...cad, day: d })} options={["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => ({ value: d, label: d[0].toUpperCase() + d.slice(1) }))} /></div>}
        {["daily", "weekdays", "weekly"].includes(cad.kind) && <div className="form-row"><span className="lead">At</span><input type="time" className="field" value={cad.time ?? "06:00"} onChange={(e) => setCad({ ...cad, time: e.target.value })} style={{ width: 110 }} aria-label="Time" /></div>}
        {cad.kind === "cron" && <div className="form-row"><span className="lead">Cron<small>minute hour day month weekday</small></span><Field value={cad.cron ?? ""} onChange={(v) => setCad({ ...cad, cron: v })} mono width={170} placeholder="0 6 * * 1-5" /></div>}
        <div className="form-row"><span className="lead">Time zone</span><Field value={cad.tz ?? TZ} onChange={(v) => setCad({ ...cad, tz: v })} width={200} /></div>
        <div className="form-row"><span className="lead">Next runs</span><span className="t-callout c2" style={{ textAlign: "right" }}>{perr ? <span style={{ color: "var(--red)" }}>{perr}</span> : preview?.next.map((t) => fmt.time(t)).join(" · ")}</span></div>
      </div>
      <div className="hstack" style={{ padding: "4px 4px 0" }}><b className="grow">Steps, in order</b>
        <Btn size="sm" icon="plus" disabled={!pipes.data?.length} onClick={() => {
          // loads go before dbt steps: data has to arrive before it's transformed
          const firstDbt = steps.findIndex((x) => x.type === "dbt");
          const at = firstDbt === -1 ? steps.length : firstDbt;
          setSteps([...steps.slice(0, at), { type: "pipeline", name: pipes.data![0].name }, ...steps.slice(at)]);
        }}>Load a pipeline</Btn>
        {hasDbt && <Btn size="sm" icon="plus" style={{ marginLeft: 6 }} onClick={() => setSteps([...steps, { type: "dbt", kind: "build" }])}>dbt command</Btn>}
      </div>
      <div className="group">
        {steps.length === 0 && <div className="form-row"><span className="c2">Add at least one step.</span></div>}
        {steps.map((s, i) => (
          <div key={i} className="form-row">
            <span className="c2 cell-num" style={{ width: 18 }}>{i + 1}</span>
            {s.type === "pipeline" ? (
              <span className="hstack grow" style={{ gap: 8 }}>
                <I n="pipeline" className="ca" />Load
                <Select label="Pipeline" value={s.name} onChange={(n) => setStep(i, { ...s, name: n })} options={(pipes.data ?? []).map((p) => ({ value: p.name, label: p.name }))} />
                <span className="hstack t-subhead c2" style={{ gap: 6 }}><Check on={!!s.refresh} onChange={(v) => setStep(i, { ...s, refresh: v })} label="Full refresh" />full refresh</span>
              </span>
            ) : (
              <span className="hstack grow" style={{ gap: 8 }}>
                <I n="model" className="ca" />dbt
                <Select label="Command" value={s.kind} onChange={(k) => setStep(i, { ...s, kind: k })} options={["build", "run", "test", "seed", "snapshot", "freshness", "docs"].map((k) => ({ value: k, label: k === "freshness" ? "source freshness" : k === "docs" ? "docs generate" : k }))} />
                <Field value={s.select ?? ""} onChange={(v) => setStep(i, { ...s, select: v })} mono width={180} placeholder="select (optional)" />
              </span>
            )}
            <button className="btn sm borderless" aria-label="Move step up" title="Move up" disabled={i === 0} style={i === 0 ? { opacity: 0.3 } : undefined}
              onClick={() => { const n = [...steps]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setSteps(n); }}><I n="chevronDown" size={14} style={{ transform: "rotate(180deg)" }} /></button>
            <button className="btn sm borderless" aria-label="Move step down" title="Move down" disabled={i === steps.length - 1} style={i === steps.length - 1 ? { opacity: 0.3 } : undefined}
              onClick={() => { const n = [...steps]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; setSteps(n); }}><I n="chevronDown" size={14} /></button>
            <button className="btn sm borderless" aria-label="Remove step" onClick={() => setSteps(steps.filter((_, j) => j !== i))}><I n="x" size={14} /></button>
          </div>
        ))}
      </div>
      <div className="group">
        <div className="form-row"><span className="lead">On</span><Switch on={enabled} onChange={setEnabled} label="Enabled" /></div>
        <div className="form-row"><span className="lead">Alert when it fails<small>Posts to a webhook, e.g. a Slack incoming webhook</small></span><Switch on={alert} onChange={setAlert} label="Alert on failure" /></div>
        {alert && <div className="form-row"><span className="lead">Webhook URL{initial.has_webhook && <small>Saved. Leave empty to keep it.</small>}</span><Field value={webhook} onChange={setWebhook} type="password" width={280} placeholder="https://hooks.slack.com/…" /></div>}
      </div>
      <div className="acts"><Btn onClick={onClose}>Cancel</Btn><Btn kind="prominent" busy={busy} disabled={!name || !steps.length || !!perr} onClick={save}>Save</Btn></div>
    </Sheet>
  );
}
