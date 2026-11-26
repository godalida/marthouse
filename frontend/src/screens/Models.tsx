import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, fmt } from "../api";
import { DataGrid } from "../components/DataGrid";
import { Editor } from "../components/Editor";
import { I, typeIcon } from "../icons";
import { useShell } from "../Shell";
import { useSettings, useTheme } from "../store";
import { Alert, Btn, Callout, Empty, Field, Seg, Sheet, Spinner, Status, TbBtn, errText, useToast } from "../ui";

type TreeNode = { name: string; path: string; dir: boolean; children?: TreeNode[] };
type Buf = { content: string; saved: string; node: string | null; compiled?: string | null; compileErr?: string[]; visual?: { edited: boolean } | null };

const OPEN_KEY = (pid: string) => `marthouse.open.${pid}`;

export function Models() {
  const { project, pid, runJob, setDirty, refresh } = useShell();
  const settings = useSettings();
  const theme = useTheme(settings.data?.appearance);
  const toast = useToast();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tree = useQuery<TreeNode[]>({ queryKey: ["tree", pid], queryFn: () => api(`/api/projects/${pid}/tree`) });
  const [open, setOpen] = useState<string[]>(() => JSON.parse(localStorage.getItem(OPEN_KEY(pid)) ?? "[]"));
  const [active, setActive] = useState<string>(() => params.get("file") ?? open[0] ?? "");
  const [bufs, setBufs] = useState<Record<string, Buf>>({});
  const [view, setView] = useState<"source" | "compiled">("source");
  const [filter, setFilter] = useState("");
  const [preview, setPreview] = useState<{ rows: any[]; columns: string[]; status: string; errors: string[]; ms: number } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [newFile, setNewFile] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const bufsRef = useRef(bufs);
  bufsRef.current = bufs;

  // open file from ?file= (and ?view=compiled / ?preview=1, used by Learn mode)
  const pendingPreview = useRef(false);
  useEffect(() => {
    const f = params.get("file");
    if (!f && !params.get("view") && !params.get("preview")) return;
    if (f) openFile(f);
    if (params.get("view") === "compiled") setView("compiled");
    if (params.get("preview")) pendingPreview.current = true;
    params.delete("file");
    params.delete("view");
    params.delete("preview");
    setParams(params, { replace: true });
  }, [params]); // eslint-disable-line

  // after a parse, files that weren't models yet may be now
  useEffect(() => {
    const h = async () => {
      for (const [path, b] of Object.entries(bufsRef.current)) {
        if (b.node || !path.endsWith(".sql")) continue;
        try {
          const f = await api(`/api/projects/${pid}/file`, { query: { path } });
          if (f.node) setBufs((x) => (x[path] ? { ...x, [path]: { ...x[path], node: f.node } } : x));
        } catch {}
      }
    };
    addEventListener("lineage:parsed", h);
    return () => removeEventListener("lineage:parsed", h);
  }, [pid]);

  // a lesson's Show me rewrote a file: reload it unless there are unsaved edits
  useEffect(() => {
    const h = (e: Event) => {
      const path = (e as CustomEvent).detail as string;
      const b = bufsRef.current[path];
      if (b && b.content === b.saved) load(path);
    };
    addEventListener("lineage:file-changed", h);
    return () => removeEventListener("lineage:file-changed", h);
  }, []); // eslint-disable-line

  // pick a sensible first file
  useEffect(() => {
    if (active || !tree.data) return;
    const first = findFirst(tree.data, (n) => n.path.endsWith(".sql") && n.path.startsWith(project.info?.model_paths?.[0] ?? "models"));
    if (first) openFile(first.path);
  }, [tree.data]); // eslint-disable-line

  useEffect(() => localStorage.setItem(OPEN_KEY(pid), JSON.stringify(open)), [open, pid]);

  const load = useCallback(async (path: string) => {
    try {
      const f = await api(`/api/projects/${pid}/file`, { query: { path } });
      setBufs((b) => ({ ...b, [path]: { content: f.content, saved: f.content, node: f.node, visual: f.visual } }));
    } catch (e) {
      toast(errText(e), "error");
      setOpen((o) => o.filter((x) => x !== path));
    }
  }, [pid, toast]);

  const openFile = (path: string) => {
    setOpen((o) => (o.includes(path) ? o : [...o, path]));
    setActive(path);
    if (!bufsRef.current[path]) load(path);
  };
  useEffect(() => { open.forEach((p) => !bufsRef.current[p] && load(p)); }, []); // eslint-disable-line

  const close = (path: string) => {
    const b = bufs[path];
    if (b && b.content !== b.saved && !confirm(`Close ${path.split("/").pop()} without saving?`)) return;
    const rest = open.filter((x) => x !== path);
    setOpen(rest);
    if (active === path) setActive(rest[rest.length - 1] ?? "");
    setBufs(({ [path]: _, ...r }) => r);
  };

  const buf = bufs[active];
  const dirtyFiles = Object.entries(bufs).filter(([, b]) => b.content !== b.saved).map(([p]) => p);

  const compile = useCallback(async (path: string) => {
    if (!path.endsWith(".sql")) return;
    setCompiling(true);
    try {
      const r = await api(`/api/projects/${pid}/compile`, { body: { path } });
      setBufs((b) => (b[path] ? { ...b, [path]: { ...b[path], compiled: r.compiled, compileErr: r.status === "success" ? [] : r.errors, node: r.node || b[path].node } } : b));
      qc.invalidateQueries({ queryKey: ["node", pid] });
    } catch (e) {
      setBufs((b) => (b[path] ? { ...b, [path]: { ...b[path], compileErr: [errText(e)] } } : b));
    } finally {
      setCompiling(false);
    }
  }, [pid, qc]);

  const save = useCallback(async (path = active) => {
    const b = bufsRef.current[path];
    if (!b) return;
    try {
      const content = b.content;
      await api(`/api/projects/${pid}/file`, { method: "PUT", body: { path, content } });
      setBufs((x) => ({ ...x, [path]: { ...x[path], saved: content } }));
      qc.invalidateQueries({ queryKey: ["project", pid] });
      window.dispatchEvent(new CustomEvent("lineage:saved", { detail: path }));
      if (settings.data?.compile_on_save && path.endsWith(".sql")) compile(path);
    } catch (e) {
      toast(errText(e), "error");
    }
  }, [active, pid, qc, settings.data, compile, toast]);

  const saveAll = useCallback(async () => {
    for (const [p, b] of Object.entries(bufsRef.current)) if (b.content !== b.saved) await save(p);
  }, [save]);

  useEffect(() => {
    setDirty(dirtyFiles.length ? { files: dirtyFiles, saveAll } : null);
    return () => setDirty(null);
  }, [dirtyFiles.join("|"), saveAll]); // eslint-disable-line

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirtyFiles.length) { e.preventDefault(); } };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [dirtyFiles.length]);

  useEffect(() => {
    if (view === "compiled" && buf && buf.compiled === undefined && active.endsWith(".sql")) compile(active);
  }, [view, active, buf?.compiled]); // eslint-disable-line

  // preview rows belong to the file they came from
  useEffect(() => { setPreview(null); setDrawer(false); }, [active]);

  const nodeId = buf?.node ?? null;
  const node = useQuery({ queryKey: ["node", pid, nodeId], queryFn: () => api(`/api/projects/${pid}/node`, { query: { id: nodeId! } }), enabled: !!nodeId, retry: false });
  const name = node.data?.name ?? active.split("/").pop()?.replace(/\.sql$/, "");
  const runnable = !!nodeId && ["model", "seed", "snapshot"].includes(nodeId.split(".")[0]);

  const doPreview = useCallback(async () => {
    if (!active.endsWith(".sql")) return;
    setDrawer(true);
    setPreviewing(true);
    const t0 = performance.now();
    try {
      if (bufsRef.current[active]?.content !== bufsRef.current[active]?.saved) await save(active);
      const r = await api(`/api/projects/${pid}/show`, { body: nodeId ? { node: nodeId } : { path: active } });
      setPreview({ ...r, ms: performance.now() - t0 });
    } catch (e) {
      setPreview({ rows: [], columns: [], status: "error", errors: [errText(e)], ms: 0 });
    } finally {
      setPreviewing(false);
    }
  }, [active, nodeId, pid, save]);

  useEffect(() => {
    if (pendingPreview.current && buf && active.endsWith(".sql")) {
      pendingPreview.current = false;
      doPreview();
    }
  }, [buf, active, doPreview]);

  const build = useCallback((upstream: boolean) => {
    if (!name) return;
    runJob("build", { select: upstream ? `+${name}` : name });
  }, [name, runJob]);

  const format = async () => {
    if (!buf) return;
    try {
      const r = await api("/api/format", { body: { sql: buf.content } });
      setBufs((b) => ({ ...b, [active]: { ...b[active], content: r.sql } }));
    } catch (e) {
      toast(errText(e), "error");
    }
  };

  const createFile = async () => {
    if (!newFile) return;
    // the box starts with "models/"; people often type the full path anyway
    const path = newFile.replace(/^\/+/, "").replace(/^([^/]+)\/\1\//, "$1/");
    try {
      await api(`/api/projects/${pid}/file`, { method: "PUT", body: { path, content: path.endsWith(".sql") ? "select\n    1 as id\n" : "" } });
      setNewFile(null);
      qc.invalidateQueries({ queryKey: ["tree", pid] });
      openFile(path);
      window.dispatchEvent(new CustomEvent("lineage:saved", { detail: path }));
    } catch (e) {
      toast(errText(e), "error");
    }
  };
  const deleteFile = async () => {
    setConfirmDel(false);
    try {
      await api(`/api/projects/${pid}/file`, { method: "DELETE", query: { path: active } });
      setBufs(({ [active]: _, ...r }) => r);
      const rest = open.filter((x) => x !== active);
      setOpen(rest);
      setActive(rest[0] ?? "");
      qc.invalidateQueries({ queryKey: ["tree", pid] });
    } catch (e) {
      toast(errText(e), "error");
    }
  };

  const visibleTree = useMemo(() => (filter ? filterTree(tree.data ?? [], filter.toLowerCase()) : tree.data ?? []), [tree.data, filter]);

  return (
    <>
      <header className="toolbar">
        <div className="title"><b>{name || "Models"}</b><small >{active || project.name}</small></div>
        <div className="spacer" />
        {active.endsWith(".sql") && <Seg label="View" value={view} onChange={setView} options={[{ value: "source", label: "Source" }, { value: "compiled", label: "Compiled" }]} />}
        {settings.data?.formatter === "sqlfmt" && active.endsWith(".sql") && <TbBtn icon="code" title="Format SQL" onClick={format} />}
        <TbBtn icon="save" title="Save (⌘S)" onClick={() => save()} disabled={!buf || buf.content === buf.saved} />
        <TbBtn icon="table" label="Preview" title="Preview rows (⌘↩)" onClick={doPreview} busy={previewing} disabled={!active.endsWith(".sql")} />
        <TbBtn icon="play" label={runnable ? "Build" : "Build project"} prominent title={runnable ? `dbt build --select ${name} (⌘R)` : "dbt build"} onClick={() => (runnable ? build(false) : runJob("build"))} />
      </header>
      <div className="hstack fill" style={{ alignItems: "stretch" }}>
        <nav className="vstack" style={{ width: 240, flex: "none", borderRight: "1px solid var(--sep)", background: "var(--inspector-bg)" }} aria-label="Files">
          <div className="hstack" style={{ gap: 6, padding: "10px 10px 6px" }}>
            <label className="search grow"><I n="search" size={14} /><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files" aria-label="Filter files" /></label>
            <button className="btn sm" title="New file" onClick={() => setNewFile((project.info?.model_paths?.[0] ?? "models") + "/")}><I n="plus" size={14} /></button>
          </div>
          <div className="scroll fill" style={{ padding: "0 6px 12px" }}>
            {tree.isLoading ? <Spinner /> : <Tree nodes={visibleTree} depth={0} active={active} onOpen={openFile} collapsed={collapsed} setCollapsed={setCollapsed} forceOpen={!!filter} />}
          </div>
        </nav>
        <section className="vstack fill">
          <div className="tabs" role="tablist">
            {open.map((p) => {
              const b = bufs[p];
              const d = b && b.content !== b.saved;
              return (
                <div key={p} className={`tab ${p === active ? "on" : ""}`} role="tab" aria-selected={p === active} onClick={() => setActive(p)} style={{ cursor: "pointer" }}>
                  <I n={p.endsWith(".yml") || p.endsWith(".yaml") ? "file" : "cube"} />
                  <span >{p.split("/").pop()}</span>
                  {d && <i className="dot run" title="Not saved" />}
                  <button className="x" aria-label={`Close ${p}`} onClick={(e) => { e.stopPropagation(); close(p); }}><I n="x" size={14} /></button>
                </div>
              );
            })}
          </div>
          {buf?.compileErr && buf.compileErr.length > 0 && (
            <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--hairline)" }}>
              <Callout tone="error" title="dbt couldn't compile this file." action={<Btn size="sm" onClick={() => setBufs((b) => ({ ...b, [active]: { ...b[active], compileErr: [] } }))}>Dismiss</Btn>}>
                <span >{buf.compileErr.slice(0, 4).join(" ")}</span>
              </Callout>
            </div>
          )}
          {buf?.visual && !buf.visual.edited && buf.content === buf.saved && (
            <div className="banner accent">
              <I n="table" size={14} /><span className="grow">Made in the model builder. Editing the SQL here hands the model over to the code editor for good.</span>
              <Btn size="sm" onClick={() => nav(`/p/${pid}/build?path=${encodeURIComponent(active)}`)}>Open in the builder</Btn>
            </div>
          )}
          {!active && (
            <Empty icon="model" title={project.n_models ? "Choose a file" : "No models yet"} actions={!project.n_models ? <><Btn onClick={() => nav(`/p/${pid}/sources`)}>Add a source</Btn><Btn kind="prominent" onClick={() => setNewFile("models/staging/stg_new.sql")}>New model</Btn></> : undefined}>
              {project.n_models ? "Pick a model on the left to edit it." : "Models are .sql files in models/. Start from one of your sources."}
            </Empty>
          )}
          {active && !buf && <div className="empty"><Spinner /></div>}
          {active && buf && (view === "source" || !active.endsWith(".sql") ? (
            <Editor key={active} path={active} value={buf.content} theme={theme} fontSize={settings.data?.font_size ?? 12}
              onChange={(v) => setBufs((b) => ({ ...b, [active]: { ...b[active], content: v } }))}
              onSave={() => save()} onRun={(up) => runnable && build(up)} onPreview={doPreview} />
          ) : compiling && !buf.compiled ? (
            <div className="empty"><Spinner /><span className="c2">Compiling with dbt…</span></div>
          ) : (
            <Editor key={active + ":c"} path={active} value={buf.compiled ?? "-- Nothing compiled yet. Save the file or press Compile."} theme={theme} readOnly fontSize={settings.data?.font_size ?? 12} />
          ))}
          {drawer && (
            <div className="vstack" style={{ height: 260, flex: "none", borderTop: "1px solid var(--sep)", background: "var(--inspector-bg)" }}>
              <div className="hstack" style={{ height: 34, padding: "0 10px 0 14px", gap: 10, borderBottom: "1px solid var(--hairline)" }}>
                <span className="upper">Preview</span>
                {previewing ? <span className="hstack t-subhead c2" style={{ gap: 6 }}><Spinner />dbt show --select {name}</span>
                  : preview && <span className="t-subhead c2">{preview.status === "success" ? `${preview.rows.length} rows · ${fmt.dur(preview.ms / 1000)} · limit ${settings.data?.preview_limit ?? 500}` : "Failed"}</span>}
                <span className="spacer" />
                <Btn size="sm" onClick={doPreview} disabled={previewing}>Run again</Btn>
                <button className="btn sm borderless" aria-label="Close preview" onClick={() => setDrawer(false)}><I n="x" size={14} /></button>
              </div>
              <div className="scroll fill">
                {preview?.errors?.length ? <div className="console" style={{ color: "var(--red)", whiteSpace: "pre-wrap" }}>{preview.errors.join("\n")}</div>
                  : preview && preview.rows.length === 0 && !previewing ? <div className="c2 t-callout" style={{ padding: 14 }}>The query returned no rows.</div>
                  : preview && <DataGrid rows={preview.rows} columns={preview.columns} />}
              </div>
            </div>
          )}
        </section>
        <Inspector node={node.data} loading={node.isLoading && !!nodeId} active={active} onBuild={build} onTest={() => name && runJob("test", { select: name })} onPreview={doPreview}
          onCompile={() => compile(active)} compiling={compiling} onDelete={() => setConfirmDel(true)} refresh={refresh} />
      </div>
      <Sheet open={newFile !== null} onClose={() => setNewFile(null)} label="New file" width={460}>
        <b className="t-title3">New file</b>
        <p className="c2 t-callout">Path inside the project. Models go in {project.info?.model_paths?.[0] ?? "models"}/ and end in .sql.</p>
        <Field value={newFile ?? ""} onChange={setNewFile} mono autoFocus onEnter={createFile} />
        <div className="acts">
          <Btn kind="borderless" icon="table" onClick={() => { setNewFile(null); nav(`/p/${pid}/build`); }} style={{ marginRight: "auto" }}>Use the model builder instead</Btn>
          <Btn onClick={() => setNewFile(null)}>Cancel</Btn><Btn kind="prominent" disabled={!newFile || newFile.endsWith("/")} onClick={createFile}>Create</Btn>
        </div>
      </Sheet>
      <Alert open={confirmDel} icon="trash" title={`Delete ${active.split("/").pop()}?`} message="The file is removed from the project folder. Git can bring it back if it was committed."
        actions={[{ label: "Delete", destructive: true, onClick: deleteFile }, { label: "Cancel", preferred: true, onClick: () => setConfirmDel(false) }]} />
    </>
  );
}

function findFirst(nodes: TreeNode[], pred: (n: TreeNode) => boolean): TreeNode | null {
  for (const n of nodes) {
    if (!n.dir && pred(n)) return n;
    if (n.children) {
      const f = findFirst(n.children, pred);
      if (f) return f;
    }
  }
  return null;
}

function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of nodes) {
    if (n.dir) {
      const c = filterTree(n.children ?? [], q);
      if (c.length) out.push({ ...n, children: c });
    } else if (n.path.toLowerCase().includes(q)) out.push(n);
  }
  return out;
}

function Tree({ nodes, depth, active, onOpen, collapsed, setCollapsed, forceOpen }: {
  nodes: TreeNode[]; depth: number; active: string; onOpen: (p: string) => void; collapsed: Record<string, boolean>; setCollapsed: (f: (c: Record<string, boolean>) => Record<string, boolean>) => void; forceOpen: boolean;
}) {
  return (
    <>
      {nodes.map((n) => {
        const isOpen = forceOpen || !(collapsed[n.path] ?? (depth > 0 && !active.startsWith(n.path + "/") && !["models", "staging", "marts"].includes(n.name)));
        return (
          <div key={n.path}>
            <button className={`tree-row ${n.path === active ? "on" : ""}`} style={{ paddingLeft: 6 + depth * 14 }}
              onClick={() => (n.dir ? setCollapsed((c) => ({ ...c, [n.path]: isOpen })) : onOpen(n.path))}>
              {n.dir ? <I n={isOpen ? "chevronDown" : "chevron"} className="c2" style={{ width: 10, height: 10 }} /> : <span style={{ width: 10 }} />}
              <I n={n.dir ? "folder" : n.name.endsWith(".sql") ? "cube" : "file"} className={n.dir || !n.name.endsWith(".sql") ? "c2" : ""} />
              <span className={`trunc ${n.dir ? "" : "mono"}`} style={n.dir ? undefined : { fontSize: 12 }}>{n.name}</span>
            </button>
            {n.dir && isOpen && n.children && <Tree nodes={n.children} depth={depth + 1} active={active} onOpen={onOpen} collapsed={collapsed} setCollapsed={setCollapsed} forceOpen={forceOpen} />}
          </div>
        );
      })}
    </>
  );
}

function Inspector({ node, loading, active, onBuild, onTest, onPreview, onCompile, compiling, onDelete, refresh }: {
  node: any; loading: boolean; active: string; onBuild: (up: boolean) => void; onTest: () => void; onPreview: () => void;
  onCompile: () => void; compiling: boolean; onDelete: () => void; refresh: () => void;
}) {
  const { project } = useShell();
  return (
    <aside className="inspector scroll models-insp" aria-label="Inspector">
      {loading && <div className="insp-sec"><Spinner /></div>}
      {!node && !loading && (
        <div className="insp-sec">
          <span className="upper">File</span>
          <span className="t-callout trunc">{active || "—"}</span>
          {active.endsWith(".sql") && (
            <span className="c2 t-callout" style={{ lineHeight: "17px" }}>
              {project.has_manifest ? "This file isn't in the last parse yet." : "Parse the project to see refs, tests and lineage."}
            </span>
          )}
          {active.endsWith(".sql") && <Btn size="sm" onClick={async () => { await api(`/api/projects/${project.id}/parse`, { body: {} }).catch(() => {}); refresh(); }}>Run dbt parse</Btn>}
          {active && <Btn size="sm" kind="destructive" onClick={onDelete} style={{ alignSelf: "flex-start" }}>Delete file…</Btn>}
        </div>
      )}
      {node && (
        <>
          <div className="insp-sec">
            <div className="hstack" style={{ gap: 8 }}>
              <span className="rtype"><I n={typeIcon[node.type] ?? "cube"} />{node.type}{node.materialized ? ` · ${node.materialized}` : ""}</span>
              {node.contract && <span className="t-subhead c2">· contract enforced</span>}
            </div>
            {node.description ? <p className="t-callout" style={{ lineHeight: "17px" }}>{node.description}</p> : <p className="t-callout c3">No description</p>}
            {node.relation && <div className="kv"><span>Relation</span><span className="trunc" style={{ fontSize: 11 }}>{node.relation}</span></div>}
            {node.owner && <div className="kv"><span>Owner</span><span>{node.owner}</span></div>}
            {node.tags?.length > 0 && <div className="kv"><span>Tags</span><span className="hstack" style={{ gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>{node.tags.join(", ")}</span></div>}
            <div className="kv"><span>Last run</span><span>{node.last ? <Status s={node.last.status} label={`${node.last.status} · ${fmt.dur(node.last.time)}`} /> : "never"}</span></div>
          </div>
          <div className="insp-sec">
            <span className="upper">Run</span>
            <div className="vstack" style={{ gap: 6 }}>
              <Btn kind="tinted" icon="play" onClick={() => onBuild(false)}>Build {node.name}</Btn>
              <Btn icon="play" onClick={() => onBuild(true)}>Build with upstream</Btn>
              <div className="hstack" style={{ gap: 6 }}>
                <Btn onClick={onTest} style={{ flex: 1 }}>Test</Btn>
                <Btn onClick={onPreview} style={{ flex: 1 }}>Preview</Btn>
                <Btn onClick={onCompile} busy={compiling} style={{ flex: 1 }}>Compile</Btn>
              </div>
            </div>
          </div>
          <div className="insp-sec">
            <span className="upper">Depends on</span>
            {node.parents.length === 0 && <span className="c3 t-callout">Nothing</span>}
            {node.parents.map((p: any) => <Chip key={p.id} n={p} />)}
          </div>
          <div className="insp-sec">
            <span className="upper">Used by</span>
            {node.children.length === 0 && <span className="c3 t-callout">Nothing yet</span>}
            {node.children.map((p: any) => <Chip key={p.id} n={p} />)}
            {node.impact?.downstream > 0 && <span className="t-subhead c2">{node.impact.downstream} nodes downstream{node.impact.exposures.length ? `, including ${node.impact.exposures.join(", ")}` : ""}.</span>}
          </div>
          <div className="insp-sec">
            <span className="upper">Tests</span>
            {node.model_tests.length + node.columns.reduce((a: number, c: any) => a + c.tests.length, 0) === 0 && <span className="c3 t-callout">No tests. Add unique and not_null to the primary key.</span>}
            {node.columns.filter((c: any) => c.tests.length).map((c: any) => (
              <div key={c.name} className="vstack" style={{ gap: 3 }}>
                <span className="t-callout">{c.name}</span>
                {c.tests.map((t: any) => <div key={t.id} className="kv"><span>{t.name}</span><Status s={t.status ?? null} /></div>)}
              </div>
            ))}
            {node.model_tests.map((t: any) => <div key={t.id} className="kv"><span>{t.name}</span><Status s={t.status ?? null} /></div>)}
          </div>
          <div className="insp-sec"><Btn size="sm" kind="destructive" onClick={onDelete} style={{ alignSelf: "flex-start" }}>Delete file…</Btn></div>
        </>
      )}
    </aside>
  );
}

function Chip({ n }: { n: { id: string; name: string; type: string } }) {
  const { pid } = useShell();
  const nav = useNavigate();
  const graph = useQueryClient().getQueryData<any>(["graph", pid, ""]);
  const path = graph?.nodes?.find((x: any) => x.id === n.id)?.path;
  return (
    <button className="hstack list-row click" style={{ gap: 8, padding: "4px 6px", borderRadius: 6, minHeight: 24 }}
      onClick={() => (n.type === "model" || n.type === "seed" || n.type === "snapshot") && path ? nav(`/p/${pid}/models?file=${encodeURIComponent(path)}`) : nav(`/p/${pid}/catalog?node=${encodeURIComponent(n.id)}`)}>
      <I n={typeIcon[n.type] ?? "cube"} size={14} className="ca" />
      <span className="trunc">{n.name}</span>
      <span className="t-subhead c2" style={{ marginLeft: "auto" }}>{n.type}</span>
    </button>
  );
}
