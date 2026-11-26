import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { I, typeIcon } from "../icons";
import { useShell } from "../Shell";
import { Btn, Empty, Spinner, Status, Switch, TbBtn, dotClass, errText, useToast } from "../ui";

type GNode = { id: string; name: string; type: string; materialized: string; path: string; package: string; tags: string[]; description: string; status: string | null; tests: number; tests_failing: number; tests_warning: number; folder: string };
type Graph = { nodes: GNode[]; edges: { source: string; target: string }[]; selected: string[] | null; project: string; generated_at: string };

const W = 196, H = 76, GX = 64, GY = 18;

function layout(nodes: GNode[], edges: Graph["edges"]) {
  const ids = new Set(nodes.map((n) => n.id));
  const parents: Record<string, string[]> = {}, children: Record<string, string[]> = {};
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    (parents[e.target] ??= []).push(e.source);
    (children[e.source] ??= []).push(e.target);
  }
  const layer: Record<string, number> = {};
  const visit = (id: string, stack = new Set<string>()): number => {
    if (layer[id] !== undefined) return layer[id];
    if (stack.has(id)) return 0;
    stack.add(id);
    const l = Math.max(-1, ...(parents[id] ?? []).map((p) => visit(p, stack))) + 1;
    stack.delete(id);
    return (layer[id] = l);
  };
  nodes.forEach((n) => visit(n.id));
  // pull exposures and leaf nodes to the right
  const maxL = Math.max(0, ...Object.values(layer));
  for (const n of nodes) if (n.type === "exposure") layer[n.id] = Math.max(layer[n.id], maxL);
  const cols: string[][] = [];
  for (const n of nodes) (cols[layer[n.id]] ??= []).push(n.id);
  const order: Record<string, number> = {};
  cols.forEach((c) => c?.sort().forEach((id, i) => (order[id] = i)));
  for (let pass = 0; pass < 6; pass++) {
    const forward = pass % 2 === 0;
    const seq = forward ? cols : [...cols].reverse();
    for (const c of seq) {
      if (!c) continue;
      const bary = (id: string) => {
        const nb = forward ? parents[id] ?? [] : children[id] ?? [];
        return nb.length ? nb.reduce((a, p) => a + order[p], 0) / nb.length : order[id];
      };
      c.sort((a, b) => bary(a) - bary(b));
      c.forEach((id, i) => (order[id] = i));
    }
  }
  const tallest = Math.max(1, ...cols.map((c) => c?.length ?? 0));
  const pos: Record<string, { x: number; y: number }> = {};
  cols.forEach((c, li) => c?.forEach((id, i) => {
    const offset = ((tallest - c.length) * (H + GY)) / 2;
    pos[id] = { x: 40 + li * (W + GX), y: 40 + offset + i * (H + GY) };
  }));
  return { pos, parents, children, width: 80 + cols.length * (W + GX), height: 80 + tallest * (H + GY) };
}

function walk(start: string, adj: Record<string, string[]>) {
  const seen = new Set<string>();
  const q = [start];
  while (q.length) {
    const c = q.pop()!;
    for (const n of adj[c] ?? []) if (!seen.has(n)) { seen.add(n); q.push(n); }
  }
  return seen;
}

export function LineageGraph() {
  const { project, pid, runJob, refresh } = useShell();
  const nav = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [selector, setSelector] = useState(params.get("select") ?? "");
  const [applied, setApplied] = useState(params.get("select") ?? "");
  const [sel, setSel] = useState<string | null>(params.get("node"));
  const [showPkgs, setShowPkgs] = useState(false);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [parsing, setParsing] = useState(false);
  const vp = useRef<HTMLDivElement>(null);
  const g = useQuery<Graph>({ queryKey: ["graph", pid, applied], queryFn: () => api(`/api/projects/${pid}/graph`, { query: { select: applied } }), retry: false, placeholderData: (p) => p });

  const nodes = useMemo(() => (g.data?.nodes ?? []).filter((n) => showPkgs || n.package === g.data?.project || n.type === "source" || n.type === "pipeline"), [g.data, showPkgs]);
  const L = useMemo(() => layout(nodes, g.data?.edges ?? []), [nodes, g.data?.edges]);
  const selected = g.data?.selected ? new Set(g.data.selected) : null;
  const path = useMemo(() => (sel ? new Set([sel, ...walk(sel, L.parents), ...walk(sel, L.children)]) : null), [sel, L]);
  const byId = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n])), [nodes]);

  const fit = () => {
    const el = vp.current;
    if (!el || !nodes.length) return;
    // fit, but never so small that names can't be read; large graphs scroll instead
    const k = Math.min(1.1, Math.max(0.55, Math.min(el.clientWidth / L.width, el.clientHeight / L.height)));
    setView({ k, x: Math.max(0, (el.clientWidth - L.width * k) / 2), y: Math.max(0, (el.clientHeight - L.height * k) / 2) });
  };
  useEffect(() => { fit(); }, [L.width, L.height]); // eslint-disable-line

  // pan with drag, zoom with ctrl/⌘+wheel or pinch, scroll pans
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const onWheel = (e: React.WheelEvent) => {
    const el = vp.current!;
    if (e.ctrlKey || e.metaKey) {
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const k = Math.min(2.5, Math.max(0.15, view.k * Math.exp(-e.deltaY * 0.01)));
      setView({ k, x: mx - ((mx - view.x) * k) / view.k, y: my - ((my - view.y) * k) / view.k });
    } else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
  };
  useEffect(() => {
    const el = vp.current;
    if (!el) return;
    const stop = (e: WheelEvent) => e.preventDefault();
    el.addEventListener("wheel", stop, { passive: false });
    return () => el.removeEventListener("wheel", stop);
  }, [g.data]);
  const zoom = (f: number) => {
    const el = vp.current!;
    const cx = el.clientWidth / 2, cy = el.clientHeight / 2;
    const k = Math.min(2.5, Math.max(0.15, view.k * f));
    setView({ k, x: cx - ((cx - view.x) * k) / view.k, y: cy - ((cy - view.y) * k) / view.k });
  };

  const apply = (v = selector) => {
    setApplied(v.trim());
    const p = new URLSearchParams(params);
    if (v.trim()) p.set("select", v.trim()); else p.delete("select");
    setParams(p, { replace: true });
  };
  const pick = (id: string | null) => {
    setSel(id);
    const p = new URLSearchParams(params);
    if (id) p.set("node", id); else p.delete("node");
    setParams(p, { replace: true });
  };
  const parse = async () => {
    setParsing(true);
    try {
      const r = await api(`/api/projects/${pid}/parse`, { body: {} });
      if (r.status !== "success") toast(r.errors?.[0] ?? "dbt parse failed", "error");
      refresh();
      g.refetch();
    } catch (e) { toast(errText(e), "error"); } finally { setParsing(false); }
  };

  const needsParse = g.error instanceof ApiError && g.error.status === 409;
  const n = sel ? byId[sel] : null;

  return (
    <>
      <header className="toolbar">
        <div className="title"><b>Lineage</b><small>{g.data ? `${nodes.length} nodes · parsed ${new Date(g.data.generated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : project.name}</small></div>
        <div className="spacer" />
        <label className="glass tb-search" style={{ width: 300 }}>
          <I n="search" />
          <input className="mono" style={{ fontSize: 12 }} value={selector} placeholder="+orders  tag:finance  path:models/marts" aria-label="Selector" onChange={(e) => setSelector(e.target.value)} onKeyDown={(e) => e.key === "Enter" && apply()} />
          {applied && <button aria-label="Clear selector" onClick={() => { setSelector(""); apply(""); }}><I n="x" size={14} /></button>}
        </label>
        <TbBtn icon="refresh" title="Parse again" onClick={parse} busy={parsing} />
        <TbBtn icon="play" label={applied ? "Build selection" : "Build all"} prominent onClick={() => runJob("build", applied ? { select: applied } : {})} />
      </header>
      <div className="hstack fill" style={{ alignItems: "stretch" }}>
        <div className="graph fill" style={{ position: "relative" }}>
          {g.isLoading && <div className="empty"><Spinner /></div>}
          {needsParse && (
            <Empty icon="lineage" title="The graph needs one parse" actions={<Btn kind="prominent" busy={parsing} onClick={parse}>Run dbt parse</Btn>}>
              Marthouse draws the graph from dbt's manifest.json. Parsing takes a few seconds and doesn't touch your warehouse.
            </Empty>
          )}
          {g.error && !needsParse && <Empty icon="warn" title="Couldn't read the selector">{errText(g.error)}</Empty>}
          {g.data && (
            <div ref={vp} className={`graph-viewport ${drag.current?.moved ? "panning" : ""}`} onWheel={onWheel}
              onPointerDown={(e) => { if ((e.target as HTMLElement).closest(".node")) return; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; }}
              onPointerMove={(e) => { const d = drag.current; if (!d) return; if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true; setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y })); }}
              onPointerUp={() => { if (drag.current && !drag.current.moved) pick(null); drag.current = null; }}>
              <div className="graph-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, width: L.width, height: L.height }}>
                <svg className="edge-svg" width={L.width} height={L.height}>
                  {(g.data.edges ?? []).filter((e) => L.pos[e.source] && L.pos[e.target]).map((e) => {
                    const a = L.pos[e.source], b = L.pos[e.target];
                    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
                    const hl = path ? path.has(e.source) && path.has(e.target) : selected ? selected.has(e.source) && selected.has(e.target) : false;
                    const dim = (path && !hl) || (selected && !(selected.has(e.source) && selected.has(e.target)));
                    return <path key={e.source + e.target} className={hl ? "hl" : ""} style={dim ? { opacity: 0.25 } : undefined} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} />;
                  })}
                </svg>
                {nodes.map((nd) => {
                  const p = L.pos[nd.id];
                  if (!p) return null;
                  const inPath = path?.has(nd.id);
                  const dim = (path && !inPath) || (selected && !selected.has(nd.id));
                  return (
                    <div key={nd.id} className={`node ${nd.type === "source" ? "source" : ""} ${sel === nd.id ? "sel" : inPath ? "path" : ""} ${dim ? "dimmed" : ""}`}
                      style={{ left: p.x, top: p.y, width: W, height: H }} onClick={(e) => { e.stopPropagation(); pick(nd.id === sel ? null : nd.id); }}
                      onDoubleClick={() => nd.path && ["model", "seed", "snapshot"].includes(nd.type) && nav(`/p/${pid}/models?file=${encodeURIComponent(nd.path)}`)}
                      title={nd.description || nd.name} role="button" aria-pressed={sel === nd.id}>
                      <span className="nt"><I n={typeIcon[nd.type] ?? "cube"} />{nd.type}{nd.materialized && nd.materialized !== nd.type ? ` · ${nd.materialized}` : ""}</span>
                      <span className="nn">{nd.name}</span>
                      <span className="nm">
                        <i className={`dot ${dotClass(nd.status)}`} />
                        {nd.type === "pipeline" ? ((nd as any).loaded_at ? `${((nd as any).rows ?? 0).toLocaleString()} rows` : "not loaded") : nd.status ?? "not run"}
                        {nd.tests > 0 && <span style={{ marginLeft: "auto", color: nd.tests_failing ? "var(--red)" : undefined }}>{nd.tests_failing ? `${nd.tests_failing}/${nd.tests} failing` : `${nd.tests} tests`}</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="legend glass">
                <span className="hstack" style={{ gap: 5 }}><I n="cube" size={14} className="ca" />model</span>
                <span className="hstack" style={{ gap: 5 }}><I n="pipeline" size={14} className="ca" />pipeline</span>
                <span className="hstack" style={{ gap: 5 }}><I n="db" size={14} className="ca" />source</span>
                <span className="hstack" style={{ gap: 5 }}><I n="seed" size={14} className="ca" />seed</span>
                <span className="hstack" style={{ gap: 5 }}><I n="exposure" size={14} className="ca" />exposure</span>
                <span className="hstack" style={{ gap: 5 }}><i className="dot pass" />ok</span>
                <span className="hstack" style={{ gap: 5 }}><i className="dot error" />error</span>
              </div>
              <div className="zoom-ctl">
                <TbBtn icon="zoomIn" title="Zoom in" onClick={() => zoom(1.2)} />
                <TbBtn icon="zoomOut" title="Zoom out" onClick={() => zoom(1 / 1.2)} />
                <TbBtn icon="fit" title="Fit to window" onClick={fit} />
              </div>
            </div>
          )}
        </div>
        <aside className="inspector scroll">
          <div className="insp-sec">
            <div className="hstack" style={{ gap: 8 }}><span className="grow t-callout">Show packages</span><Switch on={showPkgs} onChange={setShowPkgs} label="Show nodes from packages" /></div>
            <span className="t-subhead c2" style={{ lineHeight: "14px" }}>Selector uses dbt's syntax: <span >+name</span>, <span >name+</span>, <span >@name</span>, <span >tag:</span>, <span >path:</span>, <span >source:</span>. Drag to move, ⌘-scroll to zoom.</span>
            {selected && <span className="t-callout">{selected.size} nodes match <span >{applied}</span></span>}
          </div>
          {!n && <div className="insp-sec"><span className="c2 t-callout">Click a node to see what it feeds and what a change would affect.</span></div>}
          {n && <NodePanel n={n} up={walk(n.id, L.parents)} down={walk(n.id, L.children)} byId={byId} onPick={pick} />}
        </aside>
      </div>
    </>
  );
}

function NodePanel({ n, up, down, byId, onPick }: { n: GNode; up: Set<string>; down: Set<string>; byId: Record<string, GNode>; onPick: (id: string) => void }) {
  const { pid, runJob } = useShell();
  const nav = useNavigate();
  const downs = [...down].map((d) => byId[d]).filter(Boolean);
  const tables = downs.filter((d) => ["table", "incremental"].includes(d.materialized)).length;
  const exposures = downs.filter((d) => d.type === "exposure");
  const runnable = ["model", "seed", "snapshot"].includes(n.type);
  if (n.type === "pipeline") {
    return (
      <>
        <div className="insp-sec">
          <span className="rtype" style={{ alignSelf: "flex-start" }}><I n="pipeline" />dlt pipeline · {n.materialized.replace("_", " ")}</span>
          <b className="t-title3">{n.name}</b>
          <span className="t-callout c2">Loads {down.size} downstream {down.size === 1 ? "node" : "nodes"}' data.</span>
        </div>
        <div className="insp-sec"><Btn kind="tinted" icon="pipeline" onClick={() => nav(`/p/${pid}/pipelines/${n.name}`)}>Open pipeline</Btn></div>
      </>
    );
  }
  const sel = n.type === "source" ? `source:${n.name}` : n.name;
  return (
    <>
      <div className="insp-sec">
        <span className="rtype" style={{ alignSelf: "flex-start" }}><I n={typeIcon[n.type] ?? "cube"} />{n.type}{n.materialized ? ` · ${n.materialized}` : ""}</span>
        <b className="t-title3">{n.name}</b>
        {n.description ? <p className="t-callout c2" style={{ lineHeight: "17px" }}>{n.description}</p> : null}
        <div className="kv"><span>Last run</span><Status s={n.status} /></div>
        {n.tests > 0 && <div className="kv"><span>Tests</span><span>{n.tests_failing ? <span style={{ color: "var(--red)" }}>{n.tests_failing} failing</span> : `${n.tests} passing or not run`}</span></div>}
        {n.path && <div className="kv"><span>File</span><span className="trunc" style={{ fontSize: 11 }}>{n.path}</span></div>}
      </div>
      <div className="insp-sec">
        <span className="upper">If {n.name} changes</span>
        <span className="t-callout" style={{ lineHeight: "17px" }}>
          {downs.length === 0 ? "Nothing reads from it." : <>{downs.length} downstream {downs.length === 1 ? "node" : "nodes"}{tables ? `, ${tables} of them tables` : ""}{exposures.length ? `, and ${exposures.length === 1 ? "the" : ""} ${exposures.map((e) => e.name).join(", ")} ${exposures.length === 1 ? "exposure" : "exposures"}` : ""}.</>}
        </span>
        {downs.slice(0, 12).map((d) => (
          <button key={d.id} className="hstack list-row click" style={{ gap: 8, padding: "3px 6px", borderRadius: 6, minHeight: 22 }} onClick={() => onPick(d.id)}>
            <I n={typeIcon[d.type] ?? "cube"} size={14} className="ca" /><span className="trunc">{d.name}</span>
          </button>
        ))}
        {downs.length > 12 && <span className="t-subhead c2">and {downs.length - 12} more</span>}
        <span className="t-subhead c2">{up.size} upstream</span>
      </div>
      <div className="insp-sec">
        {runnable && <Btn kind="tinted" icon="play" onClick={() => runJob("build", { select: n.name })}>Build {n.name}</Btn>}
        {(runnable || n.type === "source") && <Btn icon="play" onClick={() => runJob("build", { select: `${sel}+` })}>Build it and everything downstream</Btn>}
        {runnable && n.path && <Btn icon="code" onClick={() => nav(`/p/${pid}/models?file=${encodeURIComponent(n.path)}`)}>Open {n.path.split("/").pop()}</Btn>}
        <Btn icon="book" onClick={() => nav(`/p/${pid}/catalog?node=${encodeURIComponent(n.id)}`)}>Show docs</Btn>
      </div>
    </>
  );
}
