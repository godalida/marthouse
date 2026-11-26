import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { type IconName } from "../icons";
import { useHello, useSaveSettings, useSettings } from "../store";
import { Btn, Field, Radio, Seg, Select, Sheet, Spinner, Status, Switch, errText, useToast } from "../ui";
import { DltSection } from "../components/DltTools";
import { Page, SideItem } from "../components/Page";
import { InstallProgress, InstallSheetBody, type Install } from "./Setup";

const TABS: { id: string; label: string; icon: IconName }[] = [
  { id: "general", label: "General", icon: "gear" },
  { id: "tools", label: "Tools", icon: "tools" },
  { id: "editor", label: "Editor", icon: "code" },
  { id: "updates", label: "Updates", icon: "download" },
];

export function SettingsWindow() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const tab = params.get("tab") ?? "general";
  const settings = useSettings();
  const s0 = settings.data ?? {};
  const save = useSaveSettings();
  const toast = useToast();
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && nav(s0.last_project ? `/p/${s0.last_project}` : "/projects");
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [nav, s0.last_project]);
  const s = settings.data ?? {};
  const set = async (v: Record<string, unknown>) => {
    try { await save(v); } catch (e) { toast(errText(e), "error"); }
  };
  const hosted = useHello().data?.mode === "hosted";
  const current = TABS.find((t) => t.id === (tab === "dbt" ? "tools" : tab));
  return (
    <Page title={current?.label ?? "Settings"} subtitle="Settings"
      sidebar={<div className="sb-section">
        <div className="sb-header">Settings</div>
        {TABS.map((t) => <SideItem key={t.id} icon={t.icon} label={t.label} on={current?.id === t.id} onClick={() => setParams({ tab: t.id }, { replace: true })} />)}
        {hosted && <SideItem to="/workspace" icon="users" label="Workspace" />}
      </div>}>
          <div className="vstack" style={{ padding: "20px 28px 32px", gap: 4, maxWidth: 780, width: "100%" }}>
            {!settings.data ? <Spinner /> : tab === "general" ? (
              <div className="group">
                <div className="form-row"><span className="lead">Appearance</span><Seg label="Appearance" value={s.appearance} onChange={(v) => set({ appearance: v })} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "auto", label: "Auto" }]} /></div>
                <div className="form-row"><span className="lead">On launch</span><Select label="On launch" value={s.on_launch} onChange={(v) => set({ on_launch: v })} options={[{ value: "last", label: "Reopen last project" }, { value: "projects", label: "Show projects" }]} /></div>
                <div className="form-row"><span className="lead">Show the dbt command on runs<small>See and copy exactly what Marthouse ran</small></span><Switch on={!!s.show_command} onChange={(v) => set({ show_command: v })} label="Show dbt command" /></div>
                <div className="form-row"><span className="lead">Open terminal in</span><Select label="Terminal app" value={s.terminal_app} onChange={(v) => set({ terminal_app: v })} options={["Terminal", "iTerm", "Warp", "Ghostty"].map((x) => ({ value: x, label: x }))} /></div>
              </div>
            ) : tab === "tools" || tab === "dbt" ? <><DbtTab s={s} set={set} /><DltSection /></> : tab === "editor" ? (
              <div className="group">
                <div className="form-row"><span className="lead">Font size</span><Select label="Font size" value={Number(s.font_size)} onChange={(v) => set({ font_size: v })} options={[11, 12, 13, 14, 16].map((n) => ({ value: n, label: `${n} pt` }))} /></div>
                <div className="form-row"><span className="lead">Compile on save<small>Keeps the Compiled view and the graph current</small></span><Switch on={!!s.compile_on_save} onChange={(v) => set({ compile_on_save: v })} label="Compile on save" /></div>
                <div className="form-row"><span className="lead">Preview row limit</span><Select label="Preview limit" value={Number(s.preview_limit)} onChange={(v) => set({ preview_limit: v })} options={[100, 500, 1000, 5000].map((n) => ({ value: n, label: String(n) }))} /></div>
                <div className="form-row"><span className="lead">Format SQL with<small>{s.formatter === "sqlfmt" ? "Runs sqlfmt with uv the first time; needs internet once" : "No formatter"}</small></span><Select label="Formatter" value={s.formatter} onChange={(v) => set({ formatter: v })} options={[{ value: "none", label: "None" }, { value: "sqlfmt", label: "sqlfmt" }]} /></div>
              </div>
            ) : <UpdatesTab s={s} set={set} />}
          </div>
    </Page>
  );
}

function DbtTab({ s, set }: { s: Record<string, any>; set: (v: Record<string, unknown>) => Promise<void> }) {
  const hello = useHello();
  const hosted = hello.data?.mode === "hosted";
  const qc = useQueryClient();
  const toast = useToast();
  const installs = useQuery<Install[]>({ queryKey: ["installs"], queryFn: () => api("/api/dbt/scan") });
  const [sheet, setSheet] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [allowed, setAllowed] = useState(s.allowed_versions);
  const [index, setIndex] = useState(s.index_url);
  const [showHidden, setShowHidden] = useState(false);
  const list = (installs.data ?? []).filter((i) => showHidden || !i.hidden);
  const nHidden = (installs.data ?? []).filter((i) => i.hidden).length;

  const makeDefault = async (i: Install) => {
    if (i.status !== "ok") return;
    try { await api("/api/dbt/default", { body: { path: i.path } }); qc.invalidateQueries({ queryKey: ["installs"] }); qc.invalidateQueries({ queryKey: ["settings"] }); qc.invalidateQueries({ queryKey: ["project"] }); }
    catch (e) { toast(errText(e), "error"); }
  };
  const hide = async (i: Install) => { await api("/api/dbt/hide", { body: { path: i.path, hidden: !i.hidden } }); installs.refetch(); };
  const pickFolder = async () => { try { const r = await api("/api/system/choose-folder", { body: {} }); if (r.path) set({ offline_folder: r.path }); } catch (e) { toast(errText(e), "error"); } };
  return (
    <>
      <div className="hstack" style={{ padding: "0 12px 8px", gap: 8 }}>
        <span className="vstack grow"><b style={{ fontSize: 13 }}>{hosted ? "dbt installed for this workspace" : "dbt on this computer"}</b><span className="t-subhead c2">Builds, tests and documents models. Used by Transform.</span></span>
        <Btn size="sm" busy={installs.isFetching} onClick={() => installs.refetch()}>Look again</Btn>
        <Btn size="sm" kind="tinted" onClick={() => { setJobId(null); setSheet(true); }}>Install another version…</Btn>
      </div>
      <div className="group" style={{ padding: 0 }} role="radiogroup" aria-label="Default dbt">
        {installs.isLoading && <div className="form-row" style={{ padding: "12px 14px" }}><Spinner /><span className="c2">Looking…</span></div>}
        {list.length === 0 && !installs.isLoading && <div className="form-row" style={{ padding: "12px 14px" }}><span className="c2">No dbt found. Install one to start.</span></div>}
        {list.map((i, n) => (
          <div key={i.path} className="hstack" style={{ gap: 12, padding: "12px 14px", borderBottom: n < list.length - 1 ? "1px solid var(--hairline)" : 0, opacity: i.hidden ? 0.5 : 1 }}>
            <button onClick={() => makeDefault(i)} disabled={i.status !== "ok"} aria-label="Use as default" style={i.status !== "ok" ? { opacity: 0.4 } : undefined}><Radio on={!!i.default} /></button>
            <span className="vstack grow" style={{ gap: 2, minWidth: 0 }}>
              <span className="hstack" style={{ gap: 8 }}><b className={i.status === "ok" ? "" : "c2"}>{i.core ? `dbt-core ${i.core}` : "dbt"}</b>{i.default && <span className="t-subhead c2">Default</span>}{i.status === "ok" && !i.allowed && <span className="t-subhead c2">Outside allowed versions</span>}</span>
              <span className="t-subhead c2 trunc" title={i.path}>{i.path.replace(/^\/Users\/[^/]+/, "~")}</span>
              <span className="t-subhead c2">{i.label}{i.project ? ` · for ${i.project.split(/[\\/]/).pop()}` : ""} · {i.status === "ok" ? Object.entries(i.adapters).map(([k, v]) => `${k} ${v}`).join(", ") : i.note}</span>
            </span>
            {i.status === "ok" ? <Status s="works" /> : i.status === "too_old" ? <Status s="warn" label="Too old" /> : i.status === "fusion" ? <Status s="skipped" label="Fusion" /> : i.status === "no_adapter" ? <Status s="warn" label="No adapter" /> : <Status s="error" label="Broken" />}
            {!hosted && <Btn size="sm" onClick={() => api("/api/system/reveal", { body: { path: i.path } })}>Reveal</Btn>}
            {!i.default && <Btn size="sm" onClick={() => hide(i)}>{i.hidden ? "Show" : "Hide"}</Btn>}
          </div>
        ))}
      </div>
      {nHidden > 0 && <Btn kind="borderless" size="sm" onClick={() => setShowHidden(!showHidden)} style={{ alignSelf: "flex-start", marginTop: 6 }}>{showHidden ? "Hide" : "Show"} {nHidden} hidden</Btn>}
      <div className="group-title">Updates</div>
      <div className="group">
        <div className="form-row"><span className="lead">Check for new dbt versions<small>Weekly. Only Marthouse's private copies are updated, and only when you agree.</small></span><Switch on={!!s.check_updates} onChange={(v) => set({ check_updates: v })} label="Check for new dbt versions" /></div>
        <div className="form-row"><span className="lead">Allowed versions<small>A pip-style range, e.g. &gt;=1.8,&lt;2</small></span><span className="hstack" style={{ gap: 6 }}><Field value={allowed} onChange={setAllowed} mono width={170} onEnter={() => set({ allowed_versions: allowed })} />{allowed !== s.allowed_versions && <Btn size="sm" onClick={() => set({ allowed_versions: allowed })}>Save</Btn>}</span></div>
      </div>
      <div className="group-title">Network</div>
      <div className="group">
        <div className="form-row"><span className="lead">Package index<small>For company mirrors or proxies. Leave empty for PyPI.</small></span><span className="hstack" style={{ gap: 6 }}><Field value={index} onChange={setIndex} placeholder="https://pypi.example.com/simple" width={260} onEnter={() => set({ index_url: index })} />{index !== s.index_url && <Btn size="sm" onClick={() => set({ index_url: index })}>Save</Btn>}</span></div>
        {!hosted && <div className="form-row"><span className="lead">Install without internet<small>{s.offline_folder || "Use wheel files from a folder"}</small></span>{s.offline_folder ? <Btn size="sm" onClick={() => set({ offline_folder: "" })}>Stop using folder</Btn> : <Btn size="sm" onClick={pickFolder}>Choose folder…</Btn>}</div>}
      </div>
      <Sheet open={sheet} onClose={() => !jobId && setSheet(false)} label="Install dbt" width={660}>
        {jobId ? (
          <div className="vstack" style={{ gap: 14, minHeight: 380 }}>
            <InstallProgress jobId={jobId} onDone={() => { setSheet(false); installs.refetch(); qc.invalidateQueries({ queryKey: ["settings"] }); }} onRetry={() => setJobId(null)} />
            <div className="acts"><Btn onClick={() => setSheet(false)}>Close</Btn></div>
          </div>
        ) : <InstallSheetBody onCancel={() => setSheet(false)} onStarted={setJobId} />}
      </Sheet>
    </>
  );
}

function UpdatesTab({ s, set }: { s: Record<string, any>; set: (v: Record<string, unknown>) => Promise<void> }) {
  const u = useQuery<any>({ queryKey: ["updates"], queryFn: () => api("/api/updates"), staleTime: 300_000 });
  const nav = useNavigate();
  return (
    <>
      <div className="group">
        <div className="form-row">
          <span className="lead">Marthouse {u.data?.app.current}<small>{u.isLoading ? "Checking…" : u.data?.app.error ?? (u.data?.app.available ? `Version ${u.data.app.latest} is available` : u.data?.app.configured ? "You're up to date" : "No update server is set for this build")}</small></span>
          {u.data?.app.available && u.data.app.url ? <a className="btn prominent" href={u.data.app.url} target="_blank" rel="noreferrer">Download</a> : <Btn size="sm" busy={u.isFetching} onClick={() => u.refetch()}>Check now</Btn>}
        </div>
        <div className="form-row"><span className="lead">Download updates automatically</span><Switch on={!!s.auto_update} onChange={(v) => set({ auto_update: v })} label="Download updates automatically" /></div>
      </div>
      <div className="group-title">dbt</div>
      <div className="group">
        <div className="form-row">
          <span className="lead">{u.data?.dbt.current ? `dbt-core ${u.data.dbt.current}` : "No default dbt"}<small>{u.isLoading ? "Checking PyPI…" : !u.data?.dbt.online ? "Couldn't reach the package index" : u.data?.dbt.newer ? `dbt-core ${u.data.dbt.newer} is available within your allowed versions` : `Latest allowed: ${u.data?.dbt.latest ?? "—"}`}</small></span>
          {u.data?.dbt.newer && <Btn size="sm" kind="tinted" onClick={() => nav("/settings?tab=tools")}>Install {u.data.dbt.newer}…</Btn>}
        </div>
      </div>
    </>
  );
}
