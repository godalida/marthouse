import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { api } from "./api";
import { AppMark, Chev, I, typeIcon, type IconName } from "./icons";
import { useHello, useProject, useTarget, type Project } from "./store";
import { Alert, Banner, Btn, errText, MenuItem, Popover, Spinner, useToast } from "./ui";

export type Dirty = { files: string[]; saveAll: () => Promise<void> } | null;

export type ShellCtx = {
  project: Project;
  pid: string;
  target: string;
  setTarget: (t: string) => void;
  runJob: (kind: string, params?: Record<string, unknown>, opts?: { stay?: boolean }) => Promise<string | null>;
  setDirty: (d: Dirty) => void;
  refresh: () => void;
  openPalette: () => void;
};

export const useShell = () => useOutletContext<ShellCtx>();

const DBT_SCREENS = new Set(["models", "build", "lineage", "runs", "tests", "catalog", "sources", "connections"]);

function NoDbt() {
  return (
    <div className="empty">
      <I n="model" size={40} className="c3" />
      <b className="t-title3">This folder has no dbt project</b>
      <p className="c2 t-callout" style={{ maxWidth: 360, lineHeight: "17px" }}>Pipelines load data without dbt. To transform it with models and tests, open a folder that has a dbt_project.yml or create a dbt project from the Projects window.</p>
    </div>
  );
}

export function Shell() {
  const { pid = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const project = useProject(pid);
  const [target, setTarget] = useTarget(pid);
  const dirty = useRef<Dirty>(null);
  const [askSave, setAskSave] = useState<null | ((choice: "save" | "skip" | "cancel") => void)>(null);
  const [palette, setPalette] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [sbOpen, setSbOpen] = useState(false);
  const loc = useLocation();

  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    addEventListener("online", on);
    addEventListener("offline", off);
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    addEventListener("keydown", k);
    return () => { removeEventListener("online", on); removeEventListener("offline", off); removeEventListener("keydown", k); };
  }, []);

  const runJob = useCallback(async (kind: string, params: Record<string, unknown> = {}, opts: { stay?: boolean } = {}) => {
    if (dirty.current && dirty.current.files.length && ["run", "build", "test", "seed", "snapshot", "docs", "compile", "parse"].includes(kind)) {
      const choice = await new Promise<"save" | "skip" | "cancel">((res) => setAskSave(() => res));
      setAskSave(null);
      if (choice === "cancel") return null;
      if (choice === "save") await dirty.current?.saveAll();
    }
    try {
      const j = await api(`/api/projects/${pid}/jobs`, { body: { kind, target: target || undefined, ...params } });
      qc.invalidateQueries({ queryKey: ["jobs", pid] });
      if (!opts.stay) nav(`/p/${pid}/runs/${j.id}`);
      return j.id as string;
    } catch (e) {
      toast(errText(e), "error");
      return null;
    }
  }, [pid, target, nav, qc, toast]);

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["project", pid] });
    qc.invalidateQueries({ queryKey: ["graph", pid] });
    qc.invalidateQueries({ queryKey: ["tests", pid] });
    qc.invalidateQueries({ queryKey: ["fresh", pid] });
    qc.invalidateQueries({ queryKey: ["docs", pid] });
  }, [qc, pid]);

  if (project.isLoading) return <div className="app" style={{ alignItems: "center", justifyContent: "center" }}><Spinner /></div>;
  if (project.error || !project.data) {
    return (
      <div className="app" style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12 }}>
        <b className="t-title3">This project isn't available</b>
        <span className="c2">{project.error ? errText(project.error) : ""}</span>
        <Btn kind="prominent" onClick={() => nav("/projects")}>Show projects</Btn>
      </div>
    );
  }
  const p = project.data;
  const ctx: ShellCtx = { project: p, pid, target, setTarget, runJob, setDirty: (d) => (dirty.current = d), refresh, openPalette: () => setPalette(true) };
  const stale = (p.stale ?? []).filter((f) => f !== "(never parsed)");

  return (
    <div className={`app ${sbOpen ? "sb-open" : ""}`}>
      <Sidebar project={p} target={target} setTarget={setTarget} onNavigate={() => setSbOpen(false)} />
      <main className="pane" onClick={() => sbOpen && setSbOpen(false)}>
        {!p.exists && <Banner tone="error">The folder {p.path} is gone. Move it back or remove this project from the list.</Banner>}
        {p.dbt_missing && p.exists && (
          <Banner tone="warn" action={<Btn size="sm" onClick={() => nav("/settings?tab=tools")}>Fix…</Btn>}>
            <b>{p.dbt_error ?? "dbt isn't available."}</b> {p.venv_exists && !p.venv_has_dbt ? "The project's .venv no longer has dbt; it may have been rebuilt." : ""}
          </Banner>
        )}
        {!online && <Banner tone="neutral" icon="wifiOff">Offline. Editing and docs still work; runs need the warehouse.</Banner>}
        {stale.length > 0 && p.has_manifest && (
          <Banner tone="accent" action={<Btn size="sm" onClick={async () => { try { await api(`/api/projects/${pid}/parse`, { body: {} }); refresh(); } catch (e) { toast(errText(e), "error"); } }}>Parse</Btn>}>
            The graph is older than your edits to {stale.length === 1 ? stale[0] : `${stale.length} files`}.
          </Banner>
        )}
        {p.info?.has_dbt === false && DBT_SCREENS.has(loc.pathname.split("/")[3] ?? "") ? <NoDbt /> : <Outlet context={ctx} />}
      </main>
      <button className="glass tb-btn sb-toggle" aria-label="Show sidebar" onClick={() => setSbOpen(true)} style={{ position: "fixed", left: 10, bottom: 10, display: "none" }}><I n="sidebar" /></button>
      {palette && <Palette ctx={ctx} onClose={() => setPalette(false)} />}
      <Alert open={!!askSave} title={`Save changes to ${dirty.current?.files.length === 1 ? dirty.current.files[0].split("/").pop() : `${dirty.current?.files.length} files`} before running?`}
        message="dbt runs the files on disk, not the ones open here."
        actions={[{ label: "Save and run", preferred: true, onClick: () => askSave?.("save") }, { label: "Run without saving", onClick: () => askSave?.("skip") }, { label: "Cancel", onClick: () => askSave?.("cancel") }]} />
    </div>
  );
}

function Sidebar({ project: p, target, setTarget, onNavigate }: { project: Project; target: string; setTarget: (t: string) => void; onNavigate: () => void }) {
  const hello = useHello();
  const nav = useNavigate();
  const tests = useQuery({ queryKey: ["tests", p.id], queryFn: () => api(`/api/projects/${p.id}/tests`), retry: false, enabled: !!p.has_manifest });
  const fresh = useQuery({ queryKey: ["fresh", p.id], queryFn: () => api(`/api/projects/${p.id}/freshness`), retry: false, enabled: !!p.has_manifest });
  const conns = useQuery({ queryKey: ["conns", p.id], queryFn: () => api(`/api/projects/${p.id}/connections`), retry: false });
  const running = useQuery({ queryKey: ["jobs", p.id, "running"], queryFn: () => api(`/api/jobs`, { query: { project_id: p.id, limit: 5 } }), refetchInterval: 4000 });
  const installs = useQuery({ queryKey: ["dbt-default", p.dbt], queryFn: () => api("/api/dbt/inspect", { body: { path: p.dbt } }), enabled: !!p.dbt && hello.data?.mode !== "hosted", staleTime: 300_000, retry: false });
  const pipes = useQuery<any[]>({ queryKey: ["pipelines", p.id], queryFn: () => api(`/api/projects/${p.id}/pipelines`), retry: false });
  const scheds = useQuery<any[]>({ queryKey: ["schedules", p.id], queryFn: () => api(`/api/projects/${p.id}/schedules`), retry: false });
  const nPipes = pipes.data?.length ?? 0;
  const nScheds = (scheds.data ?? []).filter((s) => s.enabled).length;
  const [tOpen, setTOpen] = useState(false);
  const [acct, setAcct] = useState(false);

  const failing = (tests.data?.counts?.fail ?? 0) + (tests.data?.counts?.error ?? 0);
  const staleN = (fresh.data?.rows ?? []).filter((r: any) => r.status === "warn" || r.status === "error").length;
  const nRunning = (running.data ?? []).filter((j: any) => j.status === "running" || j.status === "queued").length;
  const profile = (conns.data?.profiles ?? []).find((x: any) => x.name === conns.data?.active);
  const targets: { name: string; default: boolean }[] = profile?.targets ?? [];
  const current = target || profile?.default_target || "";
  const inst = installs.data;

  const item = (to: string, icon: IconName, label: string, detail?: string | number | null) => (
    <NavLink to={`/p/${p.id}/${to}`} className={({ isActive }) => `sb-item ${isActive ? "on" : ""}`} onClick={onNavigate}>
      <I n={icon} />
      <span className="trunc">{label}</span>
      {detail ? <span className="detail">{detail}</span> : null}
    </NavLink>
  );

  return (
    <nav className="sidebar" aria-label="Sections">
      <div className="sidebar-top" style={{ paddingLeft: 16 }}>
        <span className="hstack" style={{ gap: 8, marginRight: "auto" }}><AppMark size={22} /><b style={{ fontSize: 13 }}>Marthouse</b></span>
        <button className="glass tb-btn" aria-label="Command palette (⌘K)" title="Command palette (⌘K)" onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}><I n="search" /></button>
      </div>
      <div style={{ padding: "0 14px 12px" }}>
        <button onClick={() => nav("/projects")} className="hstack" style={{ gap: 10, padding: "8px 10px", borderRadius: 10, background: "var(--fill3)", width: "100%", textAlign: "left" }} title="Switch project">
          <span style={{ width: 28, height: 28, borderRadius: 7, background: "var(--accent-soft)", color: "var(--accent-text)", display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none" }}><I n="folder" /></span>
          <span className="vstack grow" style={{ gap: 1 }}>
            <b className="trunc">{p.name}</b>
            <span className="t-subhead c2 hstack trunc" style={{ gap: 4 }}>
              {p.branch && p.branch !== "HEAD" ? <><I n="branch" style={{ width: 11, height: 11 }} />{p.branch}</> : p.profile ? `profile ${p.profile}` : "dbt project"}
            </span>
          </span>
          <Chev />
        </button>
      </div>
      <div className="sidebar-list scroll">
        <div className="sb-section">
          <div className="sb-header">Load</div>
          {item("pipelines", "pipeline", "Pipelines", nPipes || null)}
        </div>
        <div className="sb-section">
          <div className="sb-header">Transform</div>
          {item("models", "model", "Models", p.n_models)}
          {item("build", "table", "Model builder")}
          {item("lineage", "lineage", "Lineage")}
          {item("runs", "play", "Runs", nRunning ? `${nRunning} running` : null)}
          {item("tests", "tests", "Tests", failing ? `${failing} failing` : null)}
        </div>
        <div className="sb-section">
          <div className="sb-header">Explore</div>
          {item("sql", "sql", "SQL")}
          {item("catalog", "book", "Docs and catalog")}
          {item("sources", "db", "Sources", staleN ? `${staleN} stale` : null)}
        </div>
        <div className="sb-section">
          <div className="sb-header">Environment</div>
          {item("connections", "plug", "Connections")}
          {item("schedules", "calendar", "Schedules", nScheds || null)}
          <NavLink to="/settings?tab=tools" className="sb-item"><I n="tools" /><span>Tools</span></NavLink>
          <NavLink to="/settings" className="sb-item"><I n="gear" /><span>Settings</span></NavLink>
          {hello.data?.mode === "hosted" && <NavLink to="/workspace" className="sb-item"><I n="users" /><span>Workspace</span></NavLink>}
        </div>

      </div>
      <div className="sb-foot vstack" style={{ gap: 6 }}>
        {p.dbt_missing && (
          <button className="sb-item" style={{ paddingLeft: 8 }} onClick={() => nav("/settings?tab=tools")}>
            <I n="warn" style={{ color: "var(--yellow)" }} /><span>dbt isn't available</span>
          </button>
        )}
        <div className="hstack" style={{ gap: 8, position: "relative" }}>
          <span className="t-subhead c2">Target</span>
          <button className="popup" onClick={() => setTOpen(!tOpen)} disabled={!targets.length} aria-label="Target">
            <span className="trunc" style={{ maxWidth: 110 }}>{current || "none"}</span><Chev />
          </button>
          <Popover open={tOpen} onClose={() => setTOpen(false)} style={{ top: "auto", bottom: "calc(100% + 6px)", width: 220 }}>
            <div className="menu-head">Run against</div>
            {targets.map((t) => (
              <MenuItem key={t.name} sel={t.name === current} onClick={() => { setTarget(t.name === profile?.default_target ? "" : t.name); setTOpen(false); }} keys={t.default ? "default" : undefined}>{t.name}</MenuItem>
            ))}
            <div className="menu-sep" />
            <MenuItem icon="plug" onClick={() => { setTOpen(false); nav(`/p/${p.id}/connections`); }}>Edit connections…</MenuItem>
          </Popover>
          <span className="spacer" />
          {!p.dbt_missing && inst?.core && (
            <button className="t-subhead c2 cell-num" onClick={() => nav("/settings?tab=tools")}
              title={`dbt-core ${inst.core} with ${Object.entries(inst.adapters ?? {}).map(([k, v]) => `${k} ${v}`).join(", ") || "no adapter"}\n${inst.label}\n${p.dbt ?? ""}`}>
              dbt {inst.core}
            </button>
          )}
        </div>
        {hello.data?.mode === "hosted" && hello.data.user && (
          <div style={{ position: "relative" }}>
            <button className="hstack t-subhead c2" style={{ gap: 6, width: "100%", paddingTop: 4 }} onClick={() => setAcct(!acct)}>
              <I n="user" size={14} /><span className="trunc grow" style={{ textAlign: "left" }}>{hello.data.user.email}</span><Chev />
            </button>
            <Popover open={acct} onClose={() => setAcct(false)} style={{ top: "auto", bottom: "calc(100% + 6px)", width: "100%" }}>
              <MenuItem icon="users" onClick={() => nav("/workspace")}>Workspace</MenuItem>
              <MenuItem icon="logout" onClick={async () => { await api("/api/auth/logout", { body: {} }); location.href = "/"; }}>Sign out</MenuItem>
            </Popover>
          </div>
        )}
      </div>
    </nav>
  );
}

type PItem = { id: string; group: string; icon: IconName; label: React.ReactNode; text: string; sub?: string; keys?: string; cmd?: string; run: () => void };

function Palette({ ctx, onClose }: { ctx: ShellCtx; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const graph = useQuery({ queryKey: ["graph", ctx.pid, ""], queryFn: () => api(`/api/projects/${ctx.pid}/graph`), retry: false, enabled: !!ctx.project.has_manifest });

  const items = useMemo<PItem[]>(() => {
    const nodes: any[] = (graph.data?.nodes ?? []).filter((n: any) => n.package === graph.data?.project || n.type === "source");
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const verb = words[0] && ["build", "run", "test", "seed", "compile"].find((v) => v.startsWith(words[0]) && words[0].length >= 2);
    const term = (verb ? words.slice(1) : words).join(" ");
    const match = (s: string) => !term || s.toLowerCase().includes(term);
    const out: PItem[] = [];
    const rank = (n: any) => (n.name.toLowerCase() === term ? 0 : n.name.toLowerCase().startsWith(term) ? 1 : 2);
    const runnable = nodes.filter((n) => ["model", "seed", "snapshot"].includes(n.type) && match(n.name)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    const verbs = verb ? [verb] : term ? ["build"] : [];
    for (const v of verbs) {
      for (const n of runnable.slice(0, 4)) {
        out.push({ id: `${v}-${n.id}`, group: "Run", icon: "play", text: `${v} ${n.name}`, label: <>{v[0].toUpperCase() + v.slice(1)} <span >{n.name}</span></>, keys: v === "build" ? "⌘R" : undefined, cmd: `dbt ${v} --select ${n.name}`, run: () => ctx.runJob(v, { select: n.name }) });
        if (v === "build" || v === "run") out.push({ id: `${v}+-${n.id}`, group: "Run", icon: "play", text: `${v} +${n.name}`, label: <>{v[0].toUpperCase() + v.slice(1)} <span >+{n.name}</span> with upstream</>, keys: "⇧⌘R", cmd: `dbt ${v} --select +${n.name}`, run: () => ctx.runJob(v, { select: `+${n.name}` }) });
      }
    }
    if (!term) {
      for (const [k, label] of [["build", "Build the whole project"], ["run", "Run all models"], ["test", "Run all tests"], ["seed", "Load seeds"], ["freshness", "Check source freshness"], ["docs", "Generate docs"], ["deps", "Install packages (dbt deps)"]] as const)
        if (!verb || k === verb) out.push({ id: `all-${k}`, group: "Run", icon: "play", text: label, label, cmd: `dbt ${k === "docs" ? "docs generate" : k === "freshness" ? "source freshness" : k}`, run: () => ctx.runJob(k) });
    }
    if (!verb) {
      for (const n of nodes.filter((n) => match(n.name)).sort((a, b) => rank(a) - rank(b)).slice(0, 8)) {
        out.push({ id: `go-${n.id}`, group: "Go to", icon: typeIcon[n.type] ?? "cube", text: n.name, label: <span >{n.name}</span>, sub: n.folder || n.type, keys: undefined,
          run: () => n.type === "source" || n.type === "exposure" ? nav(`/p/${ctx.pid}/catalog?node=${encodeURIComponent(n.id)}`) : nav(`/p/${ctx.pid}/models?file=${encodeURIComponent(n.path)}`) });
      }
      const pages: [string, IconName, string][] = [["models", "model", "Models"], ["lineage", "lineage", "Lineage"], ["runs", "play", "Runs"], ["tests", "tests", "Tests"], ["catalog", "book", "Docs and catalog"], ["sources", "db", "Sources"], ["connections", "plug", "Connections"]];
      for (const [to, icon, label] of pages) if (match(label)) out.push({ id: `page-${to}`, group: "Pages", icon, text: label, label, run: () => nav(`/p/${ctx.pid}/${to}`) });
      if (match("settings")) out.push({ id: "settings", group: "Pages", icon: "gear", text: "Settings", label: "Settings", keys: "⌘,", run: () => nav("/settings") });
      if (match("projects")) out.push({ id: "projects", group: "Pages", icon: "folder", text: "Projects", label: "Switch project", run: () => nav("/projects") });
    }
    return out.slice(0, 30);
  }, [q, graph.data, ctx, nav]);

  useEffect(() => setSel(0), [q]);
  const go = (it: PItem | undefined, show = false) => {
    if (!it) return;
    if (show && it.cmd) {
      navigator.clipboard?.writeText(it.cmd);
      toast(`Copied: ${it.cmd}`);
      return;
    }
    onClose();
    it.run();
  };
  let lastGroup = "";
  return (
    <div className="palette-root mac" data-theme={document.documentElement.dataset.theme} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="glass-lg palette" role="dialog" aria-label="Command palette">
        <label className="hstack" style={{ gap: 10, height: 40, padding: "0 10px", borderBottom: "1px solid var(--sep)" }}>
          <I n="search" size={18} className="c2" />
          <input autoFocus value={q} placeholder="Run a command or go to a model" aria-label="Command" onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
              else if (e.key === "Enter") { e.preventDefault(); go(items[sel], e.altKey); }
            }} />
        </label>
        <div className="list" style={{ paddingTop: 4 }}>
          {items.length === 0 && <div className="c2 t-callout" style={{ padding: "14px 10px" }}>{graph.isLoading ? "Loading…" : "Nothing matches."}</div>}
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? <div className="menu-head">{it.group}</div> : null;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {head}
                <button className={`menu-item ${i === sel ? "sel" : ""}`} style={{ height: 32, width: "100%" }} onMouseEnter={() => setSel(i)} onClick={() => go(it)}>
                  <I n={it.icon} size={14} className={i === sel ? "" : "ca"} />
                  <span className="hstack" style={{ gap: 8, minWidth: 0 }}>{it.label}{it.sub && <span className={`t-subhead ${i === sel ? "" : "c2"}`}>{it.sub}</span>}</span>
                  {it.keys && <span className="key">{it.keys}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="hstack t-subhead c2" style={{ gap: 12, padding: "8px 10px 4px", borderTop: "1px solid var(--sep)", marginTop: 4 }}>
          <span className="hstack" style={{ gap: 4 }}><span className="kbd">↑↓</span>move</span>
          <span className="hstack" style={{ gap: 4 }}><span className="kbd">↩</span>run</span>
          <span className="hstack" style={{ gap: 4 }}><span className="kbd">⌥↩</span>copy command</span>
        </div>
      </div>
    </div>
  );
}
