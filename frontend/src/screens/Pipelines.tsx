import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, fmt, useJob } from "../api";
import { DataGrid } from "../components/DataGrid";
import { DltInstallSheet, useDlt } from "../components/DltTools";
import { Editor } from "../components/Editor";
import { KIND_ICON, KIND_LABEL, PipelineBuilder, type Spec } from "../components/PipelineBuilder";
import { StagingGenerator } from "../components/StagingGenerator";
import { I } from "../icons";
import { useShell } from "../Shell";
import { useSettings, useTheme } from "../store";
import { Alert, Btn, Callout, Console, Empty, Field, MenuItem, Popover, Seg, Select, Sheet, Spinner, Status, TbBtn, dotClass, errText, useToast } from "../ui";
import { InstallProgress } from "./Setup";

type Row = { name: string; kind: string; dataset: string; destination: any; error?: string; tables: number; rows: number; last_job: any; loaded_at: string | null; next_run: string | null };

export function Pipelines() {
  const { pid, project } = useShell();
  const { name } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const dlt = useDlt();
  const list = useQuery<Row[]>({ queryKey: ["pipelines", pid], queryFn: () => api(`/api/projects/${pid}/pipelines`), refetchInterval: 8000 });
  const [builder, setBuilder] = useState<{ open: boolean; spec: Spec | null }>({ open: false, spec: null });
  const [install, setInstall] = useState(false);
  const [verified, setVerified] = useState(false);
  const current = name ?? list.data?.[0]?.name;
  const hasDlt = (dlt.data?.installs ?? []).some((i) => i.status === "ok");
  const conns = useQuery<any>({ queryKey: ["conns", pid], queryFn: () => api(`/api/projects/${pid}/connections`), enabled: !!project.info?.has_dbt, retry: false });
  const adapter = (conns.data?.profiles ?? []).find((p: any) => p.name === conns.data?.active)?.targets?.find((t: any) => t.default)?.type;
  const initialDest = adapter === "sqlserver" ? ["mssql"] : adapter && ["duckdb", "postgres", "snowflake", "bigquery", "redshift", "databricks"].includes(adapter) ? [adapter] : ["duckdb"];

  return (
    <>
      <header className="toolbar">
        <div className="title"><b>Pipelines</b><small>{hasDlt ? `dlt ${dlt.data?.installs.find((i) => i.default)?.version ?? ""} · ${list.data?.length ?? 0} pipelines` : "Load data with dlt"}</small></div>
        <div className="spacer" />
        {hasDlt && <TbBtn icon="box" label="Add a verified source…" onClick={() => setVerified(true)} />}
        <TbBtn icon="plus" label="New pipeline" prominent disabled={!hasDlt} onClick={() => setBuilder({ open: true, spec: null })} />
      </header>
      {dlt.isLoading || list.isLoading ? <div className="empty"><Spinner /></div> : !hasDlt ? (
        <Empty icon="pipeline" title="Load data with dlt" actions={<Btn kind="prominent" onClick={() => setInstall(true)}>Install dlt…</Btn>}>
          dlt (the data load tool by dltHub) copies data from APIs, databases and files into your warehouse, keeps the schema up to date and only loads what's new. Marthouse installs it in its own folder.
        </Empty>
      ) : !list.data?.length ? (
        <Empty icon="pipeline" title="No pipelines yet" actions={<><Btn onClick={() => setVerified(true)}>Add a verified source…</Btn><Btn kind="prominent" onClick={() => setBuilder({ open: true, spec: null })}>New pipeline</Btn></>}>
          A pipeline loads one source, such as a REST API, a database or a folder of files, into a dataset in your warehouse. {project.info?.has_dbt ? "Its tables then show up as dbt sources." : ""}
        </Empty>
      ) : (
        <div className="hstack fill" style={{ alignItems: "stretch" }}>
          <nav className="vstack scroll" style={{ width: 270, flex: "none", borderRight: "1px solid var(--sep)", background: "var(--inspector-bg)", padding: 8 }} aria-label="Pipelines">
            {list.data.map((p) => {
              const st = p.last_job?.status;
              return (
                <button key={p.name} className={`sb-item ${p.name === current ? "on" : ""}`} style={{ height: "auto", padding: "9px 10px", alignItems: "flex-start" }} onClick={() => nav(`/p/${pid}/pipelines/${p.name}`)}>
                  <I n={KIND_ICON[p.kind] ?? "pipeline"} />
                  <span className="vstack grow" style={{ gap: 2, minWidth: 0 }}>
                    <span className="hstack" style={{ gap: 6 }}><b className="trunc">{p.name}</b><i className={`dot ${st === "running" || st === "queued" ? "run" : dotClass(st)}`} /></span>
                    <span className="t-subhead c2 trunc">{KIND_LABEL[p.kind] ?? p.kind} → {p.dataset}</span>
                    <span className="t-subhead c2">{p.loaded_at ? `${p.rows.toLocaleString()} rows · ${fmt.ago(p.loaded_at)}` : "Not loaded yet"}</span>
                  </span>
                </button>
              );
            })}
          </nav>
          {current && <Detail key={current} name={current} onEdit={(spec) => setBuilder({ open: true, spec })} />}
        </div>
      )}
      <PipelineBuilder open={builder.open} initial={builder.spec} onClose={() => setBuilder({ open: false, spec: null })}
        onSaved={(n) => { setBuilder({ open: false, spec: null }); qc.invalidateQueries({ queryKey: ["pipelines", pid] }); qc.invalidateQueries({ queryKey: ["pipeline", pid, n] }); nav(`/p/${pid}/pipelines/${n}`); }} />
      <DltInstallSheet open={install} onClose={() => { setInstall(false); dlt.refetch(); }} initial={initialDest} />
      <VerifiedSheet open={verified} onClose={() => setVerified(false)} />
    </>
  );
}

function Detail({ name, onEdit }: { name: string; onEdit: (s: Spec) => void }) {
  const { pid, project, refresh } = useShell();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const settings = useSettings();
  const theme = useTheme(settings.data?.appearance);
  const q = useQuery<any>({ queryKey: ["pipeline", pid, name], queryFn: () => api(`/api/projects/${pid}/pipelines/${name}`) });
  const [tab, setTab] = useState<"tables" | "data" | "loads" | "state" | "code">("tables");
  const [jobId, setJobId] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [dataTable, setDataTable] = useState("");
  const [rows, setRows] = useState<any>(null);
  const [loadingRows, setLoadingRows] = useState(false);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [staging, setStaging] = useState<string | null>(null);
  const [makingSources, setMakingSources] = useState(false);
  const [mismatch, setMismatch] = useState<{ dbt: string; dlt: string } | null>(null);
  const [alignJob, setAlignJob] = useState<string | null>(null);
  const job = useJob(jobId, () => { qc.invalidateQueries({ queryKey: ["pipeline", pid, name] }); qc.invalidateQueries({ queryKey: ["pipelines", pid] }); refresh(); });
  const d = q.data;
  const ins = d?.inspect;
  const tables: any[] = ins?.tables ?? [];
  useEffect(() => { if (!dataTable && tables.length) setDataTable(tables[0].name); }, [tables.length]); // eslint-disable-line
  const running = job && ["queued", "running"].includes(job.status);

  const run = async (opts: { refresh?: boolean; then_build?: boolean } = {}) => {
    setMenu(false);
    try {
      const j = await api(`/api/projects/${pid}/pipelines/${name}/run`, { body: opts });
      setJobId(j.id);
      setMismatch(null);
      qc.invalidateQueries({ queryKey: ["jobs", pid] });
    } catch (e) {
      const m = /duckdb_mismatch:([^:]+):(.+)$/.exec(e instanceof Error ? e.message : "");
      if (m) setMismatch({ dbt: m[1], dlt: m[2] });
      else toast(errText(e), "error");
    }
  };
  const loadRows = async (t: string) => {
    setDataTable(t);
    setTab("data");
    setLoadingRows(true);
    try { setRows(await api(`/api/projects/${pid}/pipelines/${name}/data`, { body: { table: t, limit: 200 } })); }
    catch (e) { setRows({ rows: [], columns: [], errors: [errText(e)] }); }
    finally { setLoadingRows(false); }
  };
  const makeSources = async () => {
    setMakingSources(true);
    try {
      const r = await api(`/api/projects/${pid}/pipelines/${name}/dbt-sources`, { body: {} });
      await api(`/api/projects/${pid}/parse`, { body: {} });
      refresh();
      toast(`Wrote ${r.path}: ${r.tables_added} new tables, ${r.columns_added} new columns`);
      qc.invalidateQueries({ queryKey: ["pipeline", pid, name] });
    } catch (e) { toast(errText(e), "error"); } finally { setMakingSources(false); }
  };
  const saveSecrets = async () => {
    try { await api(`/api/projects/${pid}/pipelines/${name}`, { method: "PUT", body: { spec: d.spec, secrets } }); setSecrets({}); toast("Saved"); q.refetch(); }
    catch (e) { toast(errText(e), "error"); }
  };
  const del = async () => {
    setConfirmDel(false);
    try { await api(`/api/projects/${pid}/pipelines/${name}`, { method: "DELETE" }); qc.invalidateQueries({ queryKey: ["pipelines", pid] }); nav(`/p/${pid}/pipelines`); }
    catch (e) { toast(errText(e), "error"); }
  };

  if (q.isLoading || !d) return <div className="empty"><Spinner /></div>;
  const spec = d.spec;
  const missingSecrets = (d.secrets as any[]).filter((s) => !s.stored);
  const lastSteps: any[] = ins?.trace?.steps?.filter((s: any) => s.step !== "run") ?? [];
  const lastRows: Record<string, number> = ins?.trace?.rows ?? {};
  const src = (t: string) => `source.${project.info?.name}.${ins?.dataset ?? spec.dataset}.${t}`;

  return (
    <section className="vstack fill scroll">
      <div className="vstack" style={{ padding: "18px 22px 12px", gap: 10, borderBottom: "1px solid var(--hairline)" }}>
        <div className="hstack" style={{ gap: 10, flexWrap: "wrap" }}>
          <span className="rtype"><I n={KIND_ICON[spec.kind] ?? "pipeline"} />{KIND_LABEL[spec.kind] ?? spec.kind}</span>
          <b className="t-title3">{name}</b>
          <span className="c2 t-callout">→ <span >{spec.dataset}</span> in {spec.destination?.type === "duckdb" ? spec.destination.path : `the dbt ${spec.destination?.target || "default"} connection`}</span>
          <span className="spacer" />
          {spec.kind !== "verified" && <Btn icon="pencil" onClick={() => onEdit(spec)}>Edit</Btn>}
          <div style={{ position: "relative" }}>
            <Btn icon="more" onClick={() => setMenu(!menu)}>More</Btn>
            <Popover open={menu} onClose={() => setMenu(false)} align="right" width={280}>
              {project.info?.has_dbt && <MenuItem icon="play" onClick={() => run({ then_build: true })}>Load, then build what reads it</MenuItem>}
              <MenuItem icon="refresh" onClick={() => run({ refresh: true })}>Full refresh (reload everything)</MenuItem>
              <MenuItem icon="calendar" onClick={() => nav(`/p/${pid}/schedules?pipeline=${name}`)}>Schedule…</MenuItem>
              <div className="menu-sep" />
              <MenuItem icon="trash" onClick={() => { setMenu(false); setConfirmDel(true); }}>Delete pipeline…</MenuItem>
            </Popover>
          </div>
          {running ? <Btn kind="destructive" icon="stop" onClick={() => api(`/api/jobs/${jobId}/cancel`, { body: {} })}>Stop</Btn>
            : <Btn kind="prominent" icon="play" disabled={missingSecrets.length > 0} onClick={() => run()}>Load now</Btn>}
        </div>
        {mismatch && (
          <Callout tone="warn" title={`dbt uses DuckDB ${mismatch.dbt}, dlt uses DuckDB ${mismatch.dlt}.`}
            action={<Btn kind="prominent" onClick={async () => { try { setAlignJob((await api("/api/tools/dlt/align-duckdb", { body: { version: mismatch.dbt } })).job_id); } catch (e) { toast(errText(e), "error"); } }}>Match DuckDB versions</Btn>}>
            A DuckDB file can only be opened by the version that wrote it or a newer one. Marthouse can install DuckDB {mismatch.dbt} into dlt's environment so both tools share the file.
          </Callout>
        )}
        {missingSecrets.length > 0 && (
          <Callout tone="warn" icon="key" title="This pipeline needs credentials." action={<Btn kind="prominent" disabled={!Object.values(secrets).some(Boolean)} onClick={saveSecrets}>Save</Btn>}>
            <span className="hstack" style={{ gap: 8, flexWrap: "wrap", marginTop: 6 }}>{missingSecrets.map((s) => <Field key={s.key} type="password" value={secrets[s.key] ?? ""} onChange={(v) => setSecrets({ ...secrets, [s.key]: v })} placeholder={s.label} width={200} label={s.label} />)}</span>
          </Callout>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
          <div className="tile"><span className="t-subhead c2">Last load</span>{d.summary.last_job ? <Status s={d.summary.last_job.status} label={d.summary.last_job.status === "success" ? fmt.ago(d.summary.last_job.finished_at) : undefined} /> : <span className="c2">Never</span>}</div>
          <div className="tile"><span className="t-subhead c2">Rows last time</span><b className="t-title3 cell-num">{Object.values(lastRows).reduce((a, b) => a + b, 0).toLocaleString()}</b></div>
          <div className="tile"><span className="t-subhead c2">Tables</span><b className="t-title3 cell-num">{tables.length}</b></div>
          <div className="tile"><span className="t-subhead c2">Next scheduled load</span><span className={d.summary.next_run ? "" : "c2"}>{d.summary.next_run ? fmt.time(d.summary.next_run) : "Not scheduled"}</span></div>
        </div>
        {lastSteps.length > 0 && !running && (
          <div className="hstack t-subhead c2" style={{ gap: 14, flexWrap: "wrap" }}>
            {lastSteps.map((s) => <span key={s.step} className="hstack" style={{ gap: 5 }}>{s.error ? <span className="st error"><I n="x" /></span> : <span className="st pass"><I n="check" /></span>}{s.step} {fmt.dur((Date.parse(s.finished_at) - Date.parse(s.started_at)) / 1000)}</span>)}
          </div>
        )}
      </div>
      {job && (
        <div className="vstack" style={{ borderBottom: "1px solid var(--sep)" }}>
          <div className="hstack" style={{ gap: 10, padding: "8px 16px" }}>
            <Status s={job.status === "success" ? "success" : job.status} label={running ? "Loading…" : job.status === "success" ? "Loaded" : undefined} />
            {job.result?.pipelines?.[name]?.rows && <span className="t-callout c2">{Object.entries(job.result.pipelines[name].rows).map(([t, n]) => `${t} ${n}`).join(" · ")}</span>}
            <span className="spacer" />
            <button className="btn sm borderless" onClick={() => setJobId(null)} aria-label="Hide log"><I n="x" size={14} /></button>
          </div>
          <Console lines={job.lines} style={{ height: 180 }} empty="Starting dlt…" />
        </div>
      )}
      <div className="hstack" style={{ gap: 8, padding: "12px 22px 0" }}>
        <Seg label="Section" value={tab} onChange={setTab} options={[{ value: "tables", label: `Tables ${tables.length}` }, { value: "data", label: "Data" }, { value: "loads", label: "Loads" }, { value: "state", label: "State" }, { value: "code", label: "Code" }]} />
      </div>
      <div className="vstack" style={{ padding: "14px 22px 24px", gap: 14 }}>
        {tab === "tables" && (!tables.length ? <span className="c2 t-callout">Load the pipeline once to see its tables. dlt works out the columns and types from the data.</span> : (
          <>
            {project.info?.has_dbt && (
              <Callout tone="accent" icon="model" title="Use these tables in dbt." action={<Btn kind="tinted" busy={makingSources} onClick={makeSources}>Create dbt sources</Btn>}>
                Marthouse writes <span >_{ins?.dataset}__sources.yml</span> with every table and column, keeps your own descriptions and tests on later updates, then you can make a staging model per table.
              </Callout>
            )}
            <div className="tbl">
              <div className="table-head"><span className="grow">Table</span><span style={{ width: 90 }}>Columns</span><span style={{ width: 110 }}>Rows last load</span><span style={{ width: 230 }} /></div>
              {tables.map((t) => (
                <div key={t.name} className="list-row" style={{ paddingLeft: t.parent ? 34 : 12 }}>
                  <span className="grow vstack" style={{ minWidth: 0 }}>
                    <span className="trunc">{t.name}</span>
                    <span className="t-subhead c2 trunc">{t.parent ? `nested in ${t.parent}` : t.columns.filter((c: any) => !c.dlt).slice(0, 6).map((c: any) => c.name).join(", ")}</span>
                  </span>
                  <span style={{ width: 90 }} className="t-callout c2 cell-num">{t.columns.filter((c: any) => !c.dlt).length}</span>
                  <span style={{ width: 110 }} className="t-callout cell-num">{(lastRows[t.name] ?? 0).toLocaleString()}</span>
                  <span style={{ width: 230 }} className="hstack" >
                    <span className="spacer" />
                    <Btn size="sm" onClick={() => loadRows(t.name)} disabled={!project.info?.has_dbt}>Preview</Btn>
                    {project.info?.has_dbt && <Btn size="sm" style={{ marginLeft: 6 }} onClick={() => setStaging(src(t.name))}>Staging model…</Btn>}
                  </span>
                </div>
              ))}
            </div>
          </>
        ))}
        {tab === "data" && (
          <>
            <div className="hstack" style={{ gap: 8 }}>
              <Select label="Table" value={dataTable} onChange={(t) => loadRows(t)} options={tables.map((t) => ({ value: t.name, label: t.name }))} />
              {loadingRows && <Spinner />}
              {rows?.sql && <span className="t-subhead c2">{rows.sql}</span>}
            </div>
            {rows?.errors?.length ? <span className="t-callout" style={{ color: "var(--red)" }}>{rows.errors[0]}</span> : null}
            {rows && rows.rows?.length > 0 && <div className="tbl" style={{ maxHeight: 420 }}><DataGrid rows={rows.rows} columns={rows.columns} /></div>}
            {!rows && <Btn style={{ alignSelf: "flex-start" }} onClick={() => dataTable && loadRows(dataTable)} disabled={!dataTable || !project.info?.has_dbt}>Show rows</Btn>}
          </>
        )}
        {tab === "loads" && (
          <div className="tbl">
            <div className="table-head"><span style={{ width: 200 }}>Load ID</span><span style={{ width: 90 }}>Status</span><span className="grow">Finished</span></div>
            {(ins?.loads ?? []).length === 0 && <div className="list-row c2">{ins?.loads_error ?? "No loads yet."}</div>}
            {(ins?.loads ?? []).map((l: any) => (
              <div key={l.load_id} className="list-row"><span style={{ width: 200 }} className="t-callout">{l.load_id}</span><span style={{ width: 90 }}>{l.status === 0 ? <Status s="success" label="Loaded" /> : <Status s="warn" label={`status ${l.status}`} />}</span><span className="grow t-callout c2">{fmt.time(l.inserted_at)}</span></div>
            ))}
          </div>
        )}
        {tab === "state" && (
          <>
            <span className="t-callout c2" style={{ lineHeight: "17px" }}>What dlt remembers between loads, such as the last value seen for incremental loading. Full refresh (in More) forgets it and reloads everything.</span>
            <pre className="console" style={{ borderRadius: 8, maxHeight: 400 }}>{JSON.stringify(ins?.state ?? {}, null, 2)}</pre>
          </>
        )}
        {tab === "code" && (
          <>
            <span className="t-callout c2">pipelines/{d.script}{spec.kind !== "verified" ? " · generated from the pipeline settings. Edit the pipeline to change it." : " · written by dlt init. Edit it in Models › Files."}</span>
            <div className="vstack" style={{ height: 420, borderRadius: 10, overflow: "hidden", boxShadow: "0 0 0 1px var(--sep)" }}><Editor path="x.py" value={d.code} readOnly theme={theme} fontSize={11.5} /></div>
          </>
        )}
      </div>
      <StagingGenerator sourceId={staging} onClose={() => setStaging(null)} />
      <Sheet open={!!alignJob} onClose={() => setAlignJob(null)} label="Match DuckDB versions" width={620}>
        {alignJob && <InstallProgress jobId={alignJob} onRetry={() => setAlignJob(null)} onDone={() => { setAlignJob(null); setMismatch(null); qc.invalidateQueries({ queryKey: ["dlt-installs"] }); toast("DuckDB versions match now. Load again."); }} />}
      </Sheet>
      <Alert open={confirmDel} icon="trash" title={`Delete ${name}?`} message="The pipeline settings and generated script are removed. Tables already loaded stay in the warehouse."
        actions={[{ label: "Delete", destructive: true, onClick: del }, { label: "Cancel", preferred: true, onClick: () => setConfirmDel(false) }]} />
    </section>
  );
}

function VerifiedSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { pid, project } = useShell();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const srcs = useQuery<{ name: string; description: string }[]>({ queryKey: ["verified", pid], queryFn: () => api(`/api/projects/${pid}/pipelines-verified`), enabled: open, staleTime: 3600_000, retry: false });
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const shown = useMemo(() => (srcs.data ?? []).filter((s) => !q || `${s.name} ${s.description}`.toLowerCase().includes(q.toLowerCase())), [srcs.data, q]);
  useEffect(() => { if (open) { setPick(null); setJobId(null); setQ(""); } }, [open]);
  const start = async () => {
    try {
      const r = await api(`/api/projects/${pid}/pipelines-verified`, { body: { source: pick, name, dataset: `raw_${name}`, destination: { type: project.info?.has_dbt ? "dbt" : "duckdb", path: "warehouse.duckdb" } } });
      setJobId(r.job_id);
    } catch (e) { toast(errText(e), "error"); }
  };
  return (
    <Sheet open={open} onClose={() => !jobId && onClose()} label="Verified source" width={720}>
      <div className="vstack" style={{ gap: 4 }}>
        <b className="t-title2">Add a verified source</b>
        <span className="c2 t-callout">Ready-made dlt sources for common apps, maintained by dltHub. Marthouse runs <span >dlt init</span> to add the source's code to this project.</span>
      </div>
      {jobId ? (
        <div className="vstack" style={{ gap: 12, minHeight: 320 }}>
          <InstallProgress jobId={jobId} onRetry={() => setJobId(null)} onDone={async () => {
            try { await api(`/api/projects/${pid}/pipelines/${name}/verified-refresh`, { body: {} }); } catch {}
            qc.invalidateQueries({ queryKey: ["pipelines", pid] });
            onClose();
            nav(`/p/${pid}/pipelines/${name}`);
          }} />
        </div>
      ) : pick ? (
        <>
          <div className="group">
            <div className="form-row"><span className="lead">Source</span><span >{pick}</span></div>
            <div className="form-row"><span className="lead">Pipeline name</span><Field value={name} onChange={(v) => setName(v.toLowerCase().replace(/[^a-z0-9_]/g, "_"))} mono width={200} /></div>
          </div>
          <div className="acts"><Btn onClick={() => setPick(null)}>Back</Btn><Btn kind="prominent" disabled={!name} onClick={start}>Add source</Btn></div>
        </>
      ) : (
        <>
          <label className="search"><I n="search" size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sources" aria-label="Search sources" autoFocus /></label>
          <div className="vstack scroll" style={{ maxHeight: 380, gap: 4 }}>
            {srcs.isLoading && <span className="hstack c2" style={{ gap: 8 }}><Spinner />Fetching the list from dltHub…</span>}
            {srcs.error && <span className="t-callout" style={{ color: "var(--red)" }}>{errText(srcs.error)}</span>}
            {shown.map((s) => (
              <button key={s.name} className="cand" style={{ textAlign: "left", padding: "9px 12px" }} onClick={() => { setPick(s.name); setName(s.name); }}>
                <I n="box" className="ca" /><span className="vstack grow" style={{ gap: 2 }}><b >{s.name}</b><span className="t-subhead c2">{s.description}</span></span><I n="chevron" size={14} className="c3" />
              </button>
            ))}
          </div>
          <div className="acts"><Btn onClick={onClose}>Cancel</Btn></div>
        </>
      )}
    </Sheet>
  );
}
