import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError, fmt } from "../api";
import { DocsEditor } from "../components/DocsEditor";
import { Editor } from "../components/Editor";
import { StagingGenerator } from "../components/StagingGenerator";
import { I, typeIcon } from "../icons";
import { useShell } from "../Shell";
import { useSettings, useTheme } from "../store";
import { Btn, Empty, Seg, Spinner, Status, TbBtn } from "../ui";

export function Catalog() {
  const { pid, runJob, project } = useShell();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const settings = useSettings();
  const theme = useTheme(settings.data?.appearance);
  const idx = useQuery<any>({ queryKey: ["docs", pid], queryFn: () => api(`/api/projects/${pid}/docs`), retry: false });
  const [filter, setFilter] = useState("");
  const [tab, setTab] = useState<"columns" | "description" | "code">("columns");
  const [editing, setEditing] = useState(false);
  const [staging, setStaging] = useState<string | null>(null);
  const first = idx.data?.groups?.find((g: any) => g.name !== "Sources" && g.name !== "Exposures")?.items?.[0]?.id;
  const sel = params.get("node") ?? first;
  useEffect(() => { setTab("columns"); setEditing(false); }, [sel]);
  const node = useQuery<any>({ queryKey: ["node", pid, sel], queryFn: () => api(`/api/projects/${pid}/node`, { query: { id: sel } }), enabled: !!sel, retry: false });
  const n = node.data;

  if (idx.error instanceof ApiError && idx.error.status === 409) {
    return (
      <>
        <header className="toolbar"><div className="title"><b>Docs and catalog</b></div></header>
        <Empty icon="book" title="No docs yet" actions={<Btn kind="prominent" onClick={() => runJob("docs")}>Generate docs</Btn>}>dbt docs generate reads column types from the warehouse and writes catalog.json. Lineage shows it here.</Empty>
      </>
    );
  }
  return (
    <>
      <header className="toolbar">
        <div className="title"><b>Docs and catalog</b><small>{idx.data ? (idx.data.catalog_at ? `catalog.json from ${fmt.time(idx.data.catalog_at)}` : "No catalog yet: column types appear after Generate docs") : ""}</small></div>
        <div className="spacer" />
        {idx.data?.catalog_at && <a className="glass tb-text" href={`/api/projects/${project.id}/docs/export`}><I n="download" />Export site</a>}
        <TbBtn icon="refresh" label="Generate docs" prominent onClick={() => runJob("docs")} />
      </header>
      <div className="hstack fill" style={{ alignItems: "stretch" }}>
        <nav className="vstack" style={{ width: 240, flex: "none", borderRight: "1px solid var(--sep)", background: "var(--inspector-bg)" }} aria-label="Documented nodes">
          <div style={{ padding: "10px 10px 4px" }}><label className="search"><I n="search" size={14} /><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" aria-label="Filter" /></label></div>
          <div className="scroll fill" style={{ padding: "4px 8px 12px" }}>
            {idx.isLoading && <Spinner />}
            {idx.data?.groups.map((g: any) => {
              const items = g.items.filter((i: any) => !filter || i.name.toLowerCase().includes(filter.toLowerCase()));
              if (!items.length) return null;
              return (
                <div key={g.name} style={{ marginBottom: 10 }}>
                  <div className="sb-header" style={{ paddingLeft: 10 }}>{g.name}</div>
                  {items.map((i: any) => (
                    <button key={i.id} className={`sb-item ${i.id === sel ? "on" : ""}`} style={{ height: 28, width: "100%" }} onClick={() => setParams({ node: i.id })}>
                      <I n={typeIcon[i.type] ?? "cube"} size={14} />
                      <span className="trunc">{i.name}</span>
                      <span className="detail" style={{ color: i.documented < 50 ? "var(--yellow)" : undefined }}>{i.documented}%</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </nav>
        <article className="vstack scroll fill" style={{ padding: "28px 36px 32px", gap: 22 }}>
          {node.isLoading && <Spinner />}
          {!sel && !idx.isLoading && <Empty icon="book" title="Nothing documented yet" />}
          {n && (
            <>
              <div className="vstack" style={{ gap: 10, maxWidth: 980 }}>
                <div className="hstack" style={{ gap: 8, flexWrap: "wrap" }}>
                  <span className="rtype"><I n={typeIcon[n.type] ?? "cube"} />{n.type}{n.materialized ? ` · ${n.materialized}` : ""}</span>
                  {n.tags.length > 0 && <span className="t-subhead c2">Tags: {n.tags.join(", ")}</span>}
                  {n.owner && <span className="t-subhead c2">Owner: {n.owner}</span>}
                  {n.contract && <span className="t-subhead c2">Contract enforced</span>}
                </div>
                <h1  style={{ fontSize: 26, lineHeight: "32px", fontWeight: 600 }}>{n.name}</h1>
                {n.description ? <p style={{ fontSize: 14, lineHeight: "22px", maxWidth: 680 }}>{n.description}</p> : <p className="c3" style={{ fontSize: 14 }}>No description. Add one in the model's .yml file.</p>}
                <div className="hstack c2 t-callout" style={{ gap: 18, flexWrap: "wrap" }}>
                  {n.relation && <span><span className="c3">Relation</span> <span >{n.relation.replace(/"/g, "")}</span></span>}
                  {n.stats?.row_count !== undefined && <span><span className="c3">Rows</span> {Number(n.stats.row_count).toLocaleString()}</span>}
                  {n.stats?.bytes !== undefined && <span><span className="c3">Size</span> {(Number(n.stats.bytes) / 1024).toFixed(0)} KB</span>}
                  {n.catalog_type && <span><span className="c3">Type</span> {n.catalog_type}</span>}
                  {n.last && <span><span className="c3">Last run</span> <Status s={n.last.status} /></span>}
                  {n.loaded_at_field && <span><span className="c3">Loaded at</span> <span >{n.loaded_at_field}</span></span>}
                  {n.url && <a className="ca" href={n.url} target="_blank" rel="noreferrer">Open link</a>}
                </div>
              </div>
              <div className="hstack" style={{ gap: 8 }}>
                <Seg label="Section" value={tab} onChange={setTab} options={[{ value: "columns", label: `Columns ${n.columns.length}` }, { value: "description", label: "Details" }, ...(n.raw_code ? [{ value: "code" as const, label: "Code" }] : [])]} />
                <Btn onClick={() => nav(`/p/${pid}/lineage?node=${encodeURIComponent(n.id)}`)} icon="lineage">Lineage</Btn>
                {n.path && ["model", "seed", "snapshot"].includes(n.type) && <Btn icon="code" onClick={() => nav(`/p/${pid}/models?file=${encodeURIComponent(n.path)}`)}>Open file</Btn>}
                {["model", "seed", "snapshot", "source"].includes(n.type) && !editing && <Btn kind="tinted" icon="pencil" onClick={() => { setTab("columns"); setEditing(true); }}>Edit docs and tests</Btn>}
                {n.type === "source" && <Btn icon="model" onClick={() => setStaging(n.id)}>Staging model…</Btn>}
              </div>
              {tab === "columns" && editing && <DocsEditor node={n} onDone={() => setEditing(false)} />}
              {tab === "columns" && !editing && (
                n.columns.length === 0 ? <p className="c2">No columns are documented and the catalog hasn't been generated.</p> : (
                  <div className="tbl" style={{ maxWidth: 980 }}>
                    <div style={{ minWidth: 640 }}>
                      <div className="table-head"><span style={{ width: 190 }}>Column</span><span style={{ width: 110 }}>Type</span><span className="grow">Description</span><span style={{ width: 170 }}>Tests</span></div>
                      <div className="zebra">
                        {n.columns.map((c: any) => (
                          <div key={c.name} className="list-row" style={{ alignItems: "flex-start" }}>
                            <span style={{ width: 190 }} className="bold trunc">{c.name}</span>
                            <span style={{ width: 110 }} className="c2 t-callout trunc">{c.type || "—"}</span>
                            <span className="grow t-callout" style={{ lineHeight: "17px" }}>{c.description || <span className="c3">No description</span>}</span>
                            <span style={{ width: 170, flexWrap: "wrap", gap: 4 }} className="hstack">
                              {c.tests.length === 0 ? <span className="c3 t-callout">—</span> : c.tests.map((t: any, k: number) => <span key={t.id} className="t-callout" style={t.status === "fail" ? { color: "var(--red)" } : undefined}>{t.name}{k < c.tests.length - 1 ? ", " : ""}</span>)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              {tab === "description" && (
                <div className="group" style={{ maxWidth: 680 }}>
                  <div className="form-row"><span className="lead">Unique ID</span><span className="t-callout">{n.id}</span></div>
                  {n.path && <div className="form-row"><span className="lead">File</span><span className="t-callout">{n.path}</span></div>}
                  {n.database && <div className="form-row"><span className="lead">Database</span><span className="t-callout">{n.database}</span></div>}
                  {n.schema && <div className="form-row"><span className="lead">Schema</span><span className="t-callout">{n.schema}</span></div>}
                  {n.freshness?.warn_after?.count && <div className="form-row"><span className="lead">Freshness</span><span className="t-callout">warn after {n.freshness.warn_after.count} {n.freshness.warn_after.period}s{n.freshness.error_after?.count ? `, error after ${n.freshness.error_after.count} ${n.freshness.error_after.period}s` : ""}</span></div>}
                  {Object.keys(n.meta ?? {}).length > 0 && <div className="form-row"><span className="lead">Meta</span><span className="t-callout">{JSON.stringify(n.meta)}</span></div>}
                </div>
              )}
              {tab === "code" && <div className="vstack" style={{ height: 420, borderRadius: 12, overflow: "hidden", boxShadow: "0 0 0 1px var(--sep)", maxWidth: 980 }}><Editor path="x.sql" value={n.raw_code} readOnly theme={theme} /></div>}
              {(n.children.length > 0 || n.parents.length > 0) && (
                <div className="hstack" style={{ gap: 32, flexWrap: "wrap", alignItems: "flex-start" }}>
                  {[["Depends on", n.parents], ["Used by", n.children]].map(([label, list]: any) => list.length > 0 && (
                    <div key={label} className="vstack" style={{ gap: 8 }}>
                      <span className="t-headline">{label}</span>
                      <div className="hstack" style={{ gap: 8, flexWrap: "wrap" }}>
                        {list.map((p: any) => (
                          <button key={p.id} className="cand" style={{ padding: "8px 12px" }} onClick={() => setParams({ node: p.id })}>
                            <I n={typeIcon[p.type] ?? "cube"} size={14} className="ca" /><span >{p.name}</span><span className="t-subhead c2">{p.type}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </article>
        <StagingGenerator sourceId={staging} onClose={() => setStaging(null)} />
      </div>
    </>
  );
}
