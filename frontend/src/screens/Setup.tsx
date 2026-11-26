import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Route, Routes, useNavigate, useParams } from "react-router-dom";
import { api, useJob } from "../api";
import { AppMark, I, type IconName } from "../icons";
import { useSaveSettings, useSystem } from "../store";
import { Btn, Callout, Console, Field, Radio, Seg, Select, Sheet, Spinner, Status, Steps, errText, useToast } from "../ui";

export type Install = { path: string; kind: string; label: string; core: string | null; adapters: Record<string, string>; python: string | null; status: string; note: string; project: string | null; default?: boolean; hidden?: boolean; allowed?: boolean };

const STEP_NAMES = ["Look for dbt", "Choose dbt", "Install", "Open a project", "Connect"];

function SetupWindow({ step, children, sheet }: { step: number; children: React.ReactNode; sheet?: React.ReactNode }) {
  return (
    <div className="app">
      <nav className="sidebar" aria-label="Setup steps">
        <div className="sidebar-top" style={{ paddingLeft: 16 }}><span className="hstack" style={{ gap: 8 }}><AppMark size={22} /><b style={{ fontSize: 13 }}>Marthouse</b></span></div>
        <div className="sidebar-list">
          <div className="sb-header">First-time setup</div>
          <div style={{ padding: "6px 0 0 14px" }}><Steps steps={STEP_NAMES.map((label, i) => ({ label, state: i < step ? "done" : i === step ? "now" : "todo" }))} /></div>
        </div>
        <div className="sb-foot t-subhead c2" style={{ lineHeight: "15px" }}>Marthouse uses dbt Core, the open-source tool by dbt Labs. It never changes a dbt install it didn't make.</div>
      </nav>
      <main className="pane" style={{ position: "relative" }}>
        <header className="toolbar solo"><div className="title"><b>First-time setup</b><small>Step {step + 1} of {STEP_NAMES.length} · {STEP_NAMES[step]}</small></div></header>
        <section className="vstack fill" style={{ overflow: "auto", maxWidth: 860 }}>{children}</section>
        {sheet}
      </main>
    </div>
  );
}

function Head({ title, text }: { title: string; text: React.ReactNode }) {
  return (
    <div className="vstack" style={{ gap: 6, padding: "28px 32px 12px" }}>
      <h1 className="t-title1">{title}</h1>
      <p className="c2" style={{ lineHeight: "18px", maxWidth: 560 }}>{text}</p>
    </div>
  );
}

function Foot({ children }: { children: React.ReactNode }) {
  return <div className="hstack" style={{ gap: 8, padding: "14px 24px", borderTop: "1px solid var(--sep)", marginTop: "auto" }}>{children}</div>;
}

const store = {
  get: (): Install[] => JSON.parse(sessionStorage.getItem("marthouse.found") ?? "[]"),
  set: (x: Install[]) => sessionStorage.setItem("marthouse.found", JSON.stringify(x)),
};

export function Setup() {
  return (
    <Routes>
      <Route index element={<Scan />} />
      <Route path="found" element={<Found />} />
      <Route path="install" element={<InstallStep />} />
      <Route path="progress/:jid" element={<Progress />} />
      <Route path="project" element={<OpenProjectStep />} />
      <Route path="connect/:pid" element={<Connect />} />
    </Routes>
  );
}

function Scan() {
  const nav = useNavigate();
  const locs = useQuery<{ id: string; label: string; detail: string }[]>({ queryKey: ["locs"], queryFn: () => api("/api/dbt/locations") });
  const [done, setDone] = useState<Record<string, Install[]>>({});
  const [cur, setCur] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (!locs.data || started.current) return;
    started.current = true;
    (async () => {
      const all: Install[] = [];
      const seen = new Set<string>();
      for (const l of locs.data) {
        setCur(l.id);
        try {
          const found: Install[] = await api("/api/dbt/scan", { query: { loc: l.id } });
          const fresh = found.filter((f) => !seen.has(f.path));
          fresh.forEach((f) => seen.add(f.path));
          all.push(...fresh);
          setDone((d) => ({ ...d, [l.id]: fresh }));
        } catch {
          setDone((d) => ({ ...d, [l.id]: [] }));
        }
      }
      setCur(null);
      store.set(all);
    })();
  }, [locs.data]);
  const finished = locs.data && Object.keys(done).length === locs.data.length;
  const total = Object.values(done).flat();
  return (
    <SetupWindow step={0}>
      <Head title="Looking for dbt on this Mac" text="Marthouse checks the usual places dbt gets installed. Nothing is changed or uploaded." />
      <div className="vstack scroll" style={{ padding: "8px 32px", gap: 8 }}>
        {(locs.data ?? []).map((l) => {
          const r = done[l.id];
          return (
            <div key={l.id} className="cand" style={{ padding: "10px 14px" }}>
              <span style={{ width: 20, display: "inline-flex", justifyContent: "center" }}>
                {r ? <I n="check" className={r.length ? "ca" : "c3"} /> : cur === l.id ? <Spinner /> : <I n="minus" className="c3" />}
              </span>
              <span className="vstack grow" style={{ gap: 2 }}><span>{l.label}</span><span className="t-subhead c2 trunc">{l.detail}</span></span>
              <span className="t-subhead c2">{r ? (r.length ? `${r.length} found` : "none") : cur === l.id ? "Checking…" : ""}</span>
            </div>
          );
        })}
      </div>
      <Foot>
        <span className="t-callout c2 grow">{!finished ? "Checking…" : total.some((t) => t.status === "ok") ? `Found ${total.filter((t) => t.status === "ok").length} dbt ${total.filter((t) => t.status === "ok").length === 1 ? "install" : "installs"} Marthouse can use.` : total.length ? `Found ${total.length} dbt ${total.length === 1 ? "install" : "installs"}, but none Marthouse can use. It can install its own.` : "dbt isn't installed yet. Marthouse can install it for you."}</span>
        <Btn kind="prominent" size="lg" disabled={!finished} onClick={() => nav("found")}>Continue</Btn>
      </Foot>
    </SetupWindow>
  );
}

function adaptersText(i: Install) {
  const a = Object.entries(i.adapters ?? {});
  return a.length ? a.map(([k, v]) => `${k} ${v}`).join(", ") : "no adapter";
}

function Found() {
  const nav = useNavigate();
  const toast = useToast();
  const [found, setFound] = useState<Install[]>(store.get);
  const usable = found.filter((f) => f.status === "ok");
  const [pick, setPick] = useState<string>(usable[0]?.path ?? "new");
  const [manual, setManual] = useState(false);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  const next = async () => {
    if (pick === "new") return nav("/setup/install");
    setBusy(true);
    try {
      await api("/api/dbt/default", { body: { path: pick } });
      qc.invalidateQueries({ queryKey: ["system"] });
      nav("/setup/project");
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const addManual = async () => {
    try {
      const i: Install = await api("/api/dbt/inspect", { body: { path } });
      const all = [...found.filter((f) => f.path !== i.path), i];
      setFound(all);
      store.set(all);
      if (i.status === "ok") setPick(i.path);
      else toast(i.note || "Marthouse can't use that dbt.", "error");
      setManual(false);
    } catch (e) {
      toast(errText(e), "error");
    }
  };
  const statusOf = (i: Install) => (i.status === "ok" ? <Status s="works" /> : i.status === "too_old" ? <Status s="warn" label="Too old" /> : i.status === "fusion" ? <Status s="skipped" label="Fusion" /> : i.status === "no_adapter" ? <Status s="warn" label="No adapter" /> : <Status s="error" label="Broken" />);

  return (
    <SetupWindow step={1}>
      <Head title={usable.length ? "Choose which dbt to use" : "dbt isn't ready to use yet"} text={usable.length ? "Marthouse runs this dbt for every project unless a project has its own .venv. You can change it later in Settings." : "None of the dbt installs on this Mac can be used. Marthouse can install its own private copy, which won't touch anything else."} />
      <div className="vstack scroll" style={{ padding: "8px 32px", gap: 8 }} role="radiogroup">
        {found.map((i) => (
          <div key={i.path} className={`cand ${pick === i.path ? "on" : ""}`} onClick={() => i.status === "ok" && setPick(i.path)} style={i.status !== "ok" ? { opacity: 0.6, cursor: "default" } : undefined}>
            <Radio on={pick === i.path} />
            <span className="vstack grow" style={{ gap: 2, minWidth: 0 }}>
              <span className="hstack" style={{ gap: 8 }}><b >{i.core ? `dbt-core ${i.core}` : "dbt"}</b><span className="t-subhead c2">{i.label}</span></span>
              <span className="t-subhead c2 trunc">{i.path.replace(/^\/Users\/[^/]+/, "~")}</span>
              <span className="t-subhead c2">{i.status === "ok" ? adaptersText(i) : i.note}</span>
            </span>
            {statusOf(i)}
          </div>
        ))}
        <div className={`cand ${pick === "new" ? "on" : ""}`} onClick={() => setPick("new")}>
          <Radio on={pick === "new"} />
          <span className="vstack grow" style={{ gap: 2 }}><b>Install dbt for me</b><span className="t-subhead c2">A private copy in Marthouse's folder, with the adapters you pick. About 1 minute.</span></span>
          <I n="download" className="ca" />
        </div>
      </div>
      <Foot>
        <Btn kind="borderless" onClick={() => setManual(true)}>Choose dbt manually…</Btn>
        <span className="spacer" />
        <Btn onClick={() => nav("/setup")}>Look again</Btn>
        <Btn kind="prominent" size="lg" busy={busy} onClick={next}>{pick === "new" ? "Continue to install" : "Use this dbt"}</Btn>
      </Foot>
      <Sheet open={manual} onClose={() => setManual(false)} label="Choose dbt" width={460}>
        <b className="t-title3">Choose a dbt executable</b>
        <p className="c2 t-callout" style={{ lineHeight: "17px" }}>Paste the path to dbt, or to the environment folder that contains bin/dbt.</p>
        <Field value={path} onChange={setPath} placeholder="/path/to/venv/bin/dbt" mono autoFocus onEnter={addManual} />
        <div className="acts"><Btn onClick={() => setManual(false)}>Cancel</Btn><Btn kind="prominent" disabled={!path} onClick={addManual}>Check</Btn></div>
      </Sheet>
    </SetupWindow>
  );
}

export function InstallSheetBody({ onCancel, onStarted, projectId, initialAdapters }: { onCancel: () => void; onStarted: (jobId: string) => void; projectId?: string; initialAdapters?: string[] }) {
  const toast = useToast();
  const sys = useSystem();
  const versions = useQuery<{ versions: string[]; online: boolean; latest: string | null }>({ queryKey: ["versions"], queryFn: () => api("/api/dbt/versions") });
  const adapters = useQuery<{ id: string; name: string; pkg: string }[]>({ queryKey: ["adapters"], queryFn: () => api("/api/dbt/adapters") });
  const [sel, setSel] = useState<string[]>(initialAdapters ?? ["postgres"]);
  const [version, setVersion] = useState("");
  const [location, setLocation] = useState<"private" | "project">("private");
  const [python, setPython] = useState("3.12");
  const [offline, setOffline] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ root: string; steps: { label: string; display: string }[] } | null>(null);
  const [planErr, setPlanErr] = useState("");
  const [busy, setBusy] = useState(false);
  const v = version || versions.data?.latest || "";
  const body = useMemo(() => ({ version: v, adapters: sel, location, project_id: projectId, python, offline_folder: offline ?? undefined }), [v, sel, location, projectId, python, offline]);

  useEffect(() => {
    if (!v || !sel.length) { setPlan(null); setPlanErr(sel.length ? "" : "Pick at least one adapter."); return; }
    api("/api/dbt/install/plan", { body }).then((p) => { setPlan(p); setPlanErr(""); }).catch((e) => setPlanErr(errText(e)));
  }, [body, v, sel.length]);

  const start = async () => {
    setBusy(true);
    try {
      const r = await api("/api/dbt/install", { body });
      onStarted(r.job_id);
    } catch (e) {
      toast(errText(e), "error");
      setBusy(false);
    }
  };
  const pickFolder = async () => {
    try {
      const r = await api("/api/system/choose-folder", { body: {} });
      if (r.path) setOffline(r.path);
    } catch (e) {
      toast(errText(e), "error");
    }
  };
  const logos: Record<string, IconName> = { duckdb: "db", bigquery: "globe", snowflake: "db", databricks: "db" };
  return (
    <>
      <div className="vstack" style={{ gap: 4 }}>
        <b className="t-title2">Install dbt for me</b>
        <span className="c2 t-callout">Pick the warehouses you use. You can add more adapters later.</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
        {(adapters.data ?? []).map((a) => {
          const on = sel.includes(a.id);
          return (
            <button key={a.id} className={`tile ${on ? "on" : ""}`} aria-pressed={on} onClick={() => setSel(on ? sel.filter((x) => x !== a.id) : [...sel, a.id])} style={{ alignItems: "flex-start", textAlign: "left" }}>
              <span className="hstack" style={{ gap: 6, width: "100%" }}><I n={logos[a.id] ?? "db"} className="ca" /><b className="grow">{a.name}</b>{on && <I n="check" size={14} className="ca" />}</span>
              <span className="t-caption c2">{a.pkg}</span>
            </button>
          );
        })}
      </div>
      <div className="group">
        <div className="form-row"><span className="lead">dbt-core version{versions.data && !versions.data.online && <small>Offline: showing known versions</small>}</span>
          {versions.isLoading ? <Spinner /> : <Select label="Version" value={v} onChange={setVersion} options={(versions.data?.versions ?? []).map((x, i) => ({ value: x, label: i === 0 ? `${x} (latest)` : x }))} />}
        </div>
        <div className="form-row"><span className="lead">Install into<small>{location === "private" ? (sys.data?.private_dir ?? "").replace(/^\/Users\/[^/]+/, "~") : "the project's .venv folder"}</small></span>
          <Seg label="Location" value={location} onChange={(x) => setLocation(x)} options={[{ value: "private", label: "Marthouse's folder" }, ...(projectId ? [{ value: "project" as const, label: "Project .venv" }] : [])]} />
        </div>
        <div className="form-row"><span className="lead">Python</span><Select label="Python" value={python} onChange={setPython} options={["3.13", "3.12", "3.11", "3.10"].map((x) => ({ value: x, label: `Python ${x}` }))} /></div>
        <div className="form-row"><span className="lead">Install without internet<small>{offline ? offline : "Use wheel files from a folder"}</small></span>
          {offline ? <Btn size="sm" onClick={() => setOffline(null)}>Use the internet</Btn> : <Btn size="sm" onClick={pickFolder}>Choose folder…</Btn>}
        </div>
      </div>
      <div className="vstack" style={{ gap: 6 }}>
        <span className="upper">What Marthouse will run</span>
        <div className="console" style={{ borderRadius: 8, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          {planErr ? <span className="err">{planErr}</span> : plan ? plan.steps.map((s, i) => <div key={i} className="hi">{s.display}</div>) : "…"}
        </div>
      </div>
      <div className="acts">
        <span className="t-subhead c2 grow">Downloads from {offline ? "the folder you chose" : "PyPI"}. Nothing outside the install folder changes.</span>
        <Btn onClick={onCancel}>Cancel</Btn>
        <Btn kind="prominent" disabled={!plan || !!planErr} busy={busy} onClick={start}>Install</Btn>
      </div>
    </>
  );
}

function InstallStep() {
  const nav = useNavigate();
  return (
    <SetupWindow step={2} sheet={
      <>
        <div className="dim" />
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 41, padding: 20 }}>
          <div className="sheet" style={{ width: 640, maxHeight: "100%", overflow: "auto" }} role="dialog" aria-label="Install dbt">
            <InstallSheetBody onCancel={() => nav("/setup/found")} onStarted={(id) => nav(`/setup/progress/${id}`)} />
          </div>
        </div>
      </>
    }>
      <Head title="Choose dbt" text="" />
    </SetupWindow>
  );
}

export function InstallProgress({ jobId, onDone, onRetry }: { jobId: string; onDone?: () => void; onRetry?: () => void }) {
  const job = useJob(jobId);
  const toast = useToast();
  const [meta, setMeta] = useState<{ steps: { label: string }[]; title: string } | null>(null);
  useEffect(() => { api(`/api/jobs/${jobId}`).then(setMeta).catch(() => {}); }, [jobId]);
  const steps = meta?.steps ?? [];
  const states = job?.steps ?? {};
  const doneN = Object.values(states).filter((s) => s === "done").length;
  const failed = job?.status === "error";
  const offlineFail = failed && (job?.lines ?? []).some((l) => /dns error|failed to fetch|Connection refused|network|could not connect|timed out/i.test(l.text));
  return (
    <div className="vstack" style={{ gap: 16, flex: 1, minHeight: 0 }}>
      <div className="vstack" style={{ gap: 8 }}>
        <div className="hstack" style={{ gap: 8 }}><b className="grow">{meta?.title ?? "Installing dbt"}</b>{job && <Status s={job.status === "success" ? "success" : job.status} label={job.status === "success" ? "Installed" : undefined} />}</div>
        <div className="progress"><i style={{ width: `${steps.length ? Math.max(4, ((doneN + (job?.status === "running" ? 0.5 : 0)) / steps.length) * 100) : 4}%`, background: failed ? "var(--red)" : undefined }} /></div>
      </div>
      <Steps steps={steps.map((s, i) => ({ label: s.label, state: states[i] === "done" ? "done" : states[i] === "error" ? "error" : states[i] === "running" ? "now" : "todo" }))} />
      {offlineFail && (
        <Callout tone="error" icon="wifiOff" title="Couldn't download dbt." action={onRetry && <Btn kind="prominent" onClick={onRetry}>Try again</Btn>}>
          PyPI didn't answer. Nothing was changed on your Mac. If your company uses its own package server, set it in Settings › dbt › Package index, or install from a folder of wheel files.
        </Callout>
      )}
      {failed && !offlineFail && <Callout tone="error" title="The install stopped." action={onRetry && <Btn onClick={onRetry}>Try again</Btn>}>The log below shows what uv reported.</Callout>}
      <Console lines={job?.lines ?? []} style={{ flex: 1, minHeight: 140, borderRadius: 10 }} />
      {job?.status === "success" && onDone && (
        <div className="hstack" style={{ gap: 8 }}>
          <span className="grow t-callout c2">{job.result?.install?.core ? `dbt-core ${job.result.install.core} with ${Object.keys(job.result.install.adapters ?? {}).join(", ")} is ready.` : job.result?.install?.version ? `dlt ${job.result.install.version} is ready.` : "Done."}</span>
          {job.result?.install?.path && <Btn onClick={() => { navigator.clipboard?.writeText(job.result?.install?.path ?? ""); toast("Path copied"); }}>Copy path</Btn>}
          <Btn kind="prominent" size="lg" onClick={onDone}>Continue</Btn>
        </div>
      )}
    </div>
  );
}

function Progress() {
  const { jid = "" } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  return (
    <SetupWindow step={2}>
      <Head title="Installing dbt" text="This usually takes about a minute. You can keep this window open while it runs." />
      <div className="vstack fill" style={{ padding: "0 32px 24px" }}>
        <InstallProgress jobId={jid} onDone={() => { qc.invalidateQueries({ queryKey: ["system"] }); nav("/setup/project"); }} onRetry={() => nav("/setup/install")} />
      </div>
    </SetupWindow>
  );
}

export function OpenProjectBody({ onOpened }: { onOpened: (pid: string) => void }) {
  const sys = useSystem();
  const toast = useToast();
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState("");
  const open = async (p: string, key: string) => {
    setBusy(key);
    try {
      const r = await api("/api/projects/open", { body: { path: p } });
      onOpened(r.id);
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy("");
    }
  };
  const choose = async () => {
    try {
      const r = await api("/api/system/choose-folder", { body: {} });
      if (r.path) { setPath(r.path); open(r.path, "choose"); }
    } catch (e) {
      toast(errText(e), "error");
    }
  };
  return (
    <div className="vstack" style={{ gap: 12 }}>
      <div className="cand" style={{ alignItems: "flex-start" }}>
        <I n="folder" size={20} className="ca" />
        <span className="vstack grow" style={{ gap: 8 }}>
          <b>Open a dbt project folder</b>
          <span className="hstack" style={{ gap: 8 }}>
            <Field value={path} onChange={setPath} placeholder="~/code/my_project" mono width="100%" onEnter={() => path && open(path, "path")} />
            <Btn onClick={choose}>Choose…</Btn>
            <Btn kind="prominent" disabled={!path} busy={busy === "path"} onClick={() => open(path, "path")}>Open</Btn>
          </span>
        </span>
      </div>
      {sys.data?.example && (
        <div className="cand">
          <I n="book" size={20} className="ca" />
          <span className="vstack grow" style={{ gap: 2 }}><b>Try the example project</b><span className="t-subhead c2">jaffle_shop on DuckDB. Needs the duckdb adapter, no warehouse.</span></span>
          <Btn busy={busy === "ex"} onClick={() => open(sys.data!.example, "ex")}>Open example</Btn>
        </div>
      )}
    </div>
  );
}

function OpenProjectStep() {
  const nav = useNavigate();
  return (
    <SetupWindow step={3}>
      <Head title="Open a project" text="Pick a folder that has a dbt_project.yml. You can also create or clone projects later from the Projects window." />
      <div className="vstack" style={{ padding: "8px 32px" }}><OpenProjectBody onOpened={(pid) => nav(`/setup/connect/${pid}`)} /></div>
      <Foot><Btn kind="borderless" onClick={() => nav("/setup/found")}>Back</Btn><span className="spacer" /><Btn onClick={() => nav("/projects")}>Skip for now</Btn></Foot>
    </SetupWindow>
  );
}

export function DebugChecklist({ pid, target, auto = true }: { pid: string; target?: string; auto?: boolean }) {
  const [r, setR] = useState<{ status: string; checks: { name: string; ok: boolean; detail: string }[]; log: { text: string; level: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      setR(await api(`/api/projects/${pid}/debug`, { body: { target: target ?? "" } }));
    } catch (e) {
      setR({ status: "error", checks: [{ name: errText(e), ok: false, detail: "" }], log: [] });
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { if (auto) run(); }, [pid, target]); // eslint-disable-line
  const label = (n: string) => n.replace(/^profiles\.yml file$/, "profiles.yml").replace(/^dbt_project\.yml file$/, "dbt_project.yml").replace(/^Connection test$/, "Connection to the warehouse");
  return (
    <div className="vstack" style={{ gap: 10 }}>
      <div className="hstack" style={{ gap: 8 }}>
        <b className="grow">dbt debug</b>
        {r && !busy && <Status s={r.status === "success" ? "pass" : "error"} label={r.status === "success" ? "All checks passed" : "Needs attention"} />}
        <Btn size="sm" busy={busy} onClick={run}>{r ? "Run again" : "Run dbt debug"}</Btn>
      </div>
      <div className="group">
        {busy && !r && <div className="form-row"><Spinner /><span className="c2">Checking the project and the connection…</span></div>}
        {r?.checks.map((c, i) => (
          <div key={i} className="form-row"><span className={`st ${c.ok ? "pass" : "error"}`}><I n={c.ok ? "check" : "x"} /></span><span className="lead">{label(c.name)}<small>{c.detail}</small></span></div>
        ))}
        {r && !r.checks.length && <div className="form-row"><span className="lead c2">dbt didn't report any checks.</span></div>}
      </div>
      {r && r.log.length > 0 && <Btn kind="borderless" size="sm" onClick={() => setShowLog(!showLog)} style={{ alignSelf: "flex-start" }}>{showLog ? "Hide" : "Show"} dbt's output</Btn>}
      {showLog && r && <Console lines={r.log} style={{ maxHeight: 200, borderRadius: 8 }} />}
    </div>
  );
}

function Connect() {
  const { pid = "" } = useParams();
  const nav = useNavigate();
  const save = useSaveSettings();
  const qc = useQueryClient();
  const finish = async (to: string) => {
    await save({ setup_done: true, last_project: pid });
    qc.invalidateQueries({ queryKey: ["system"] });
    nav(to);
  };
  return (
    <SetupWindow step={4}>
      <Head title="Check the connection" text="Marthouse runs dbt debug to check the project, profiles.yml and the warehouse connection. If something fails, fix it in Connections." />
      <div className="vstack scroll" style={{ padding: "8px 32px" }}><DebugChecklist pid={pid} /></div>
      <Foot>
        <Btn kind="borderless" onClick={() => nav("/setup/project")}>Back</Btn>
        <span className="spacer" />
        <Btn onClick={() => finish(`/p/${pid}/connections`)}>Edit connection…</Btn>
        <Btn kind="prominent" size="lg" onClick={() => finish(`/p/${pid}/models`)}>Open project</Btn>
      </Foot>
    </SetupWindow>
  );
}
