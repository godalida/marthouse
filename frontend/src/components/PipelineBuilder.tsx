import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { I, type IconName } from "../icons";
import { useShell } from "../Shell";
import { useSettings, useTheme } from "../store";
import { Btn, Check, Field, Seg, Select, Sheet, Spinner, errText, useToast } from "../ui";
import { Editor } from "./Editor";

export type Spec = Record<string, any>;
type Kind = "rest_api" | "sql_database" | "filesystem";

export const KIND_LABEL: Record<string, string> = { rest_api: "REST API", sql_database: "SQL database", filesystem: "Files", verified: "Verified source" };
export const KIND_ICON: Record<string, IconName> = { rest_api: "api", sql_database: "db", filesystem: "file", verified: "box" };

const PAGINATORS: { value: string; label: string; fields: [string, string][] }[] = [
  { value: "auto", label: "Detect automatically", fields: [] },
  { value: "json_link", label: "Next URL in the response", fields: [["next_url_path", "Path to the next URL"]] },
  { value: "header_link", label: "Link header", fields: [] },
  { value: "page_number", label: "Page number", fields: [["page_param", "Page parameter"], ["base_page", "First page"], ["total_path", "Path to total pages"]] },
  { value: "offset", label: "Offset and limit", fields: [["limit", "Page size"], ["offset_param", "Offset parameter"], ["limit_param", "Limit parameter"], ["total_path", "Path to total"]] },
  { value: "cursor", label: "Cursor", fields: [["cursor_path", "Path to next cursor"], ["cursor_param", "Cursor parameter"]] },
  { value: "single_page", label: "No pagination", fields: [] },
];

function blank(kind: Kind): Spec {
  if (kind === "rest_api") return { kind, write_disposition: "merge", rest_api: { base_url: "https://", auth: { type: "none" }, paginator: { type: "auto" }, resources: [{ name: "", path: "", data_selector: "", primary_key: "id" }] } };
  if (kind === "sql_database") return { kind, write_disposition: "merge", sql_database: { dialect: "postgresql", host: "", port: 5432, database: "", username: "", schema: "", tables: [{ name: "", incremental_column: "", primary_key: "" }] } };
  return { kind, write_disposition: "replace", filesystem: { bucket_url: "data", tables: [{ name: "", glob: "*.csv", format: "csv", incremental: false }] } };
}

function L({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <div className="form-row"><span className="lead">{label}{hint && <small>{hint}</small>}</span>{children}</div>;
}

function kv(obj: Record<string, string> | undefined): string {
  return Object.entries(obj ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
}
function parseKv(t: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const line of t.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return o;
}

export function PipelineBuilder({ open, onClose, initial, onSaved }: { open: boolean; onClose: () => void; initial?: Spec | null; onSaved: (name: string) => void }) {
  const { pid, project } = useShell();
  const toast = useToast();
  const settings = useSettings();
  const theme = useTheme(settings.data?.appearance);
  const editing = !!initial?.name;
  const [spec, setSpec] = useState<Spec>(() => initial ?? { name: "", dataset: "", destination: { type: project.info?.has_dbt ? "dbt" : "duckdb", path: "warehouse.duckdb" }, ...blank("rest_api") });
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ code: string; errors: string[]; destination: string; destination_error: string; secrets: { key: string; label: string }[]; env: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState<Record<number, any>>({});
  const [trying, setTrying] = useState<number | null>(null);
  const conns = useQuery<any>({ queryKey: ["conns", pid], queryFn: () => api(`/api/projects/${pid}/connections`), enabled: !!project.info?.has_dbt, retry: false });
  useEffect(() => {
    if (open) {
      setSpec(initial ?? { name: "", dataset: "", destination: { type: project.info?.has_dbt ? "dbt" : "duckdb", path: "warehouse.duckdb" }, ...blank("rest_api") });
      setSecrets({});
      setTried({});
    }
  }, [open, initial]); // eslint-disable-line
  const body = useMemo(() => ({ spec: { ...spec, dataset: spec.dataset || (spec.name ? `raw_${spec.name}` : "") } }), [spec]);
  useEffect(() => {
    if (!open) return;
    const h = setTimeout(() => api(`/api/projects/${pid}/pipelines/preview`, { body }).then(setPreview).catch(() => {}), 300);
    return () => clearTimeout(h);
  }, [body, open, pid]);

  const kind = spec.kind as Kind;
  const r = spec.rest_api ?? {};
  const sq = spec.sql_database ?? {};
  const fs = spec.filesystem ?? {};
  const setR = (patch: any) => setSpec({ ...spec, rest_api: { ...r, ...patch } });
  const setSq = (patch: any) => setSpec({ ...spec, sql_database: { ...sq, ...patch } });
  const setFs = (patch: any) => setSpec({ ...spec, filesystem: { ...fs, ...patch } });
  const setRes = (i: number, patch: any) => setR({ resources: r.resources.map((x: any, j: number) => (j === i ? { ...x, ...patch } : x)) });
  const pg = PAGINATORS.find((x) => x.value === (r.paginator?.type ?? "auto")) ?? PAGINATORS[0];
  const profile = (conns.data?.profiles ?? []).find((x: any) => x.name === conns.data?.active);
  const destValue = spec.destination?.type === "duckdb" ? "duckdb" : `dbt:${spec.destination?.target ?? ""}`;
  const destOptions = [
    ...(project.info?.has_dbt ? [{ value: "dbt:", label: `Same as dbt (${profile?.default_target ?? "default target"})` }, ...(profile?.targets ?? []).map((t: any) => ({ value: `dbt:${t.name}`, label: `dbt connection: ${t.name} (${t.type})` }))] : []),
    { value: "duckdb", label: "A DuckDB file in this project" },
  ];

  const tryRequest = async (i: number) => {
    const res = r.resources[i];
    let path = res.path || res.name;
    const params = { ...(res.params ?? {}) };
    const url = r.base_url.replace(/\/$/, "") + "/" + path.replace(/^\//, "") + (Object.keys(params).length ? "?" + new URLSearchParams(params).toString() : "");
    setTrying(i);
    try {
      const out = await api(`/api/projects/${pid}/pipelines/try-request`, { body: { url, headers: r.headers ?? {}, auth: r.auth ?? {}, secret: secrets[secretKey] ?? "" } });
      setTried({ ...tried, [i]: out });
    } catch (e) {
      setTried({ ...tried, [i]: { error: errText(e) } });
    } finally {
      setTrying(null);
    }
  };
  const secretKey = preview?.secrets?.[0]?.key ?? "";

  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/projects/${pid}/pipelines/${spec.name}`, { method: "PUT", body: { spec: body.spec, secrets } });
      toast(`Saved ${spec.name}`);
      onSaved(spec.name);
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} label="Pipeline" width={1120}>
      <div className="hstack" style={{ gap: 10 }}>
        <b className="t-title2 grow">{editing ? `Edit ${spec.name}` : "New pipeline"}</b>
        {!editing && <Seg label="Source" value={kind} onChange={(k) => setSpec({ name: spec.name, dataset: spec.dataset, destination: spec.destination, ...blank(k) })}
          options={(["rest_api", "sql_database", "filesystem"] as Kind[]).map((k) => ({ value: k, label: <><I n={KIND_ICON[k]} size={14} />{KIND_LABEL[k]}</> }))} />}
      </div>
      <div className="hstack" style={{ gap: 18, alignItems: "stretch", minHeight: 0 }}>
        <div className="vstack" style={{ flex: "1 1 560px", gap: 4, minWidth: 0, maxHeight: "68vh", overflow: "auto", paddingRight: 4 }}>
          <div className="group">
            <L label="Name" hint="Also the dlt pipeline name"><Field value={spec.name ?? ""} onChange={(v) => setSpec({ ...spec, name: v.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} mono width={220} placeholder="github_issues" readOnly={editing} /></L>
            <L label="Dataset" hint="The schema the tables land in"><Field value={spec.dataset ?? ""} onChange={(v) => setSpec({ ...spec, dataset: v.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} mono width={220} placeholder={spec.name ? `raw_${spec.name}` : "raw_github"} /></L>
            <L label="Load into">
              <Select label="Destination" width={300} value={destValue} onChange={(v) => setSpec({ ...spec, destination: v === "duckdb" ? { type: "duckdb", path: spec.destination?.path ?? "warehouse.duckdb" } : { type: "dbt", target: v.slice(4) } })} options={destOptions} />
            </L>
            {spec.destination?.type === "duckdb" && <L label="DuckDB file" hint="Relative to the project folder"><Field value={spec.destination.path ?? ""} onChange={(v) => setSpec({ ...spec, destination: { ...spec.destination, path: v } })} mono width={220} /></L>}
            <L label="When loading again" hint={spec.write_disposition === "merge" ? "Update rows by primary key" : spec.write_disposition === "replace" ? "Replace the tables each run" : "Add new rows"}>
              <Seg label="Write disposition" value={spec.write_disposition ?? "append"} onChange={(v) => setSpec({ ...spec, write_disposition: v })} options={[{ value: "append", label: "Append" }, { value: "merge", label: "Merge" }, { value: "replace", label: "Replace" }]} />
            </L>
          </div>

          {kind === "rest_api" && (
            <>
              <div className="group-title">API</div>
              <div className="group">
                <L label="Base URL"><Field value={r.base_url ?? ""} onChange={(v) => setR({ base_url: v })} mono width={320} placeholder="https://api.example.com/v1" /></L>
                <L label="Sign in">
                  <Select label="Auth" value={r.auth?.type ?? "none"} onChange={(v) => setR({ auth: { ...r.auth, type: v } })} options={[{ value: "none", label: "None" }, { value: "bearer", label: "Bearer token" }, { value: "api_key", label: "API key" }, { value: "http_basic", label: "Username and password" }]} />
                </L>
                {r.auth?.type === "api_key" && <L label="Key name and place"><span className="hstack" style={{ gap: 6 }}><Field value={r.auth.name ?? ""} onChange={(v) => setR({ auth: { ...r.auth, name: v } })} placeholder="X-API-Key" width={150} /><Seg label="Where" value={r.auth.location ?? "header"} onChange={(v) => setR({ auth: { ...r.auth, location: v } })} options={[{ value: "header", label: "Header" }, { value: "query", label: "Query" }]} /></span></L>}
                {r.auth?.type === "http_basic" && <L label="Username"><Field value={r.auth.username ?? ""} onChange={(v) => setR({ auth: { ...r.auth, username: v } })} width={200} /></L>}
                {(preview?.secrets ?? []).map((s) => <L key={s.key} label={s.label} hint="Stored securely; never written to the pipeline file"><Field type="password" value={secrets[s.key] ?? ""} onChange={(v) => setSecrets({ ...secrets, [s.key]: v })} width={220} placeholder={editing ? "Unchanged" : ""} /></L>)}
                <L label="Pages"><Select label="Paginator" width={240} value={pg.value} onChange={(v) => setR({ paginator: { type: v } })} options={PAGINATORS.map((p) => ({ value: p.value, label: p.label }))} /></L>
                {pg.fields.map(([k, label]) => <L key={k} label={label}><Field value={r.paginator?.[k] ?? ""} onChange={(v) => setR({ paginator: { ...r.paginator, [k]: /^\d+$/.test(v) ? Number(v) : v } })} mono width={200} /></L>)}
              </div>
              <div className="hstack" style={{ padding: "18px 12px 8px" }}><b className="grow">Endpoints</b><Btn size="sm" icon="plus" onClick={() => setR({ resources: [...r.resources, { name: "", path: "", primary_key: "id" }] })}>Add endpoint</Btn></div>
              {r.resources.map((res: any, i: number) => (
                <div key={i} className="group" style={{ marginBottom: 10 }}>
                  <L label="Table name"><span className="hstack" style={{ gap: 6 }}><Field value={res.name ?? ""} onChange={(v) => setRes(i, { name: v.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} mono width={170} placeholder="issues" />{r.resources.length > 1 && <button className="btn sm borderless" aria-label="Remove endpoint" onClick={() => setR({ resources: r.resources.filter((_: any, j: number) => j !== i) })}><I n="trash" size={14} /></button>}</span></L>
                  <L label="Path" hint="Added to the base URL"><span className="hstack" style={{ gap: 6 }}><Field value={res.path ?? ""} onChange={(v) => setRes(i, { path: v })} mono width={200} placeholder={res.name || "issues"} /><Btn size="sm" busy={trying === i} onClick={() => tryRequest(i)}>Try request</Btn></span></L>
                  {tried[i] && (
                    <div className="vstack" style={{ gap: 6, padding: "8px 0 10px" }}>
                      {tried[i].error ? <span className="t-callout" style={{ color: "var(--red)" }}>{tried[i].error}</span> : <>
                        <span className="t-subhead c2">HTTP {tried[i].status}. {tried[i].lists?.length ? "Lists found in the response; pick the one with your rows:" : "No list found in the response."}</span>
                        <div className="hstack" style={{ gap: 6, flexWrap: "wrap" }}>
                          {tried[i].lists?.map((l: any) => <button key={l.path} className={`btn sm ${res.data_selector === (l.path === "(root)" ? "" : l.path) ? "tinted" : ""}`} onClick={() => setRes(i, { data_selector: l.path === "(root)" ? "" : l.path })}>{l.path} · {l.count} rows</button>)}
                          {tried[i].paginator && <button className="btn sm tinted" onClick={() => setR({ paginator: tried[i].paginator })}>Use pages: {PAGINATORS.find((p) => p.value === tried[i].paginator.type)?.label}</button>}
                        </div>
                        <pre className="console" style={{ borderRadius: 8, maxHeight: 160, margin: 0, fontSize: 11 }}>{tried[i].preview}</pre>
                      </>}
                    </div>
                  )}
                  <L label="Rows are in" hint="Path to the list in the response; empty if the response is the list"><Field value={res.data_selector ?? ""} onChange={(v) => setRes(i, { data_selector: v })} mono width={170} placeholder="data.items" /></L>
                  <L label="Primary key"><Field value={res.primary_key ?? ""} onChange={(v) => setRes(i, { primary_key: v })} mono width={170} placeholder="id" /></L>
                  <L label="Query parameters" hint="One per line: name=value"><textarea className="field mono" style={{ height: 52, width: 220, padding: 6, fontSize: 12 }} value={kv(res.params)} onChange={(e) => setRes(i, { params: parseKv(e.target.value) })} /></L>
                  <L label="Only load new rows" hint="Field to track, and the parameter that sends it"><span className="hstack" style={{ gap: 6 }}><Field value={res.incremental?.cursor_path ?? ""} onChange={(v) => setRes(i, { incremental: { ...res.incremental, cursor_path: v } })} mono width={110} placeholder="updated_at" /><Field value={res.incremental?.param ?? ""} onChange={(v) => setRes(i, { incremental: { ...res.incremental, param: v } })} mono width={90} placeholder="since" /><Field value={res.incremental?.initial_value ?? ""} onChange={(v) => setRes(i, { incremental: { ...res.incremental, initial_value: v } })} mono width={110} placeholder="start value" /></span></L>
                  {i > 0 && <L label="For each row of" hint="Calls this endpoint once per parent row, e.g. comments for each issue"><span className="hstack" style={{ gap: 6 }}><Select label="Parent" value={res.parent?.resource ?? ""} onChange={(v) => setRes(i, { parent: { ...res.parent, resource: v } })} options={[{ value: "", label: "—" }, ...r.resources.slice(0, i).filter((x: any) => x.name).map((x: any) => ({ value: x.name, label: x.name }))]} /><Field value={res.parent?.field ?? ""} onChange={(v) => setRes(i, { parent: { ...res.parent, field: v } })} mono width={80} placeholder="id" /><Field value={res.parent?.param ?? ""} onChange={(v) => setRes(i, { parent: { ...res.parent, param: v } })} mono width={90} placeholder="{param}" /></span></L>}
                </div>
              ))}
            </>
          )}

          {kind === "sql_database" && (
            <>
              <div className="group-title">Database</div>
              <div className="group">
                <L label="Type"><Select label="Database type" value={sq.dialect} onChange={(v) => setSq({ dialect: v, port: ({ postgresql: 5432, mysql: 3306, mssql: 1433, redshift: 5439, sqlite: "" } as Record<string, number | string>)[v] })} options={[{ value: "postgresql", label: "Postgres" }, { value: "mysql", label: "MySQL" }, { value: "mssql", label: "SQL Server" }, { value: "redshift", label: "Redshift" }, { value: "sqlite", label: "SQLite file" }]} /></L>
                {sq.dialect === "sqlite" ? <L label="File"><Field value={sq.path ?? ""} onChange={(v) => setSq({ path: v })} mono width={300} placeholder="/path/to/app.db" /></L> : <>
                  <L label="Host and port"><span className="hstack" style={{ gap: 6 }}><Field value={sq.host ?? ""} onChange={(v) => setSq({ host: v })} width={200} /><Field value={sq.port ?? ""} onChange={(v) => setSq({ port: Number(v.replace(/\D/g, "")) || "" })} width={70} /></span></L>
                  <L label="Database"><Field value={sq.database ?? ""} onChange={(v) => setSq({ database: v })} mono width={200} /></L>
                  <L label="Schema" hint="Leave empty for the default"><Field value={sq.schema ?? ""} onChange={(v) => setSq({ schema: v })} mono width={200} /></L>
                  <L label="User"><Field value={sq.username ?? ""} onChange={(v) => setSq({ username: v })} width={200} /></L>
                  <L label="Password" hint="Stored securely"><Field type="password" value={secrets.password ?? ""} onChange={(v) => setSecrets({ ...secrets, password: v })} width={200} placeholder={editing ? "Unchanged" : ""} /></L>
                </>}
              </div>
              <div className="hstack" style={{ padding: "18px 12px 8px" }}><b className="grow">Tables</b><Btn size="sm" icon="plus" onClick={() => setSq({ tables: [...sq.tables, { name: "" }] })}>Add table</Btn></div>
              <div className="group">
                <div className="table-head" style={{ padding: 0 }}><span style={{ width: 170 }}>Table</span><span style={{ width: 150 }}>Only new rows, by</span><span className="grow">Primary key</span></div>
                {sq.tables.map((t: any, i: number) => (
                  <div key={i} className="hstack" style={{ gap: 8, padding: "6px 0" }}>
                    <Field value={t.name} onChange={(v) => setSq({ tables: sq.tables.map((x: any, j: number) => (j === i ? { ...x, name: v } : x)) })} mono width={170} placeholder="orders" />
                    <Field value={t.incremental_column ?? ""} onChange={(v) => setSq({ tables: sq.tables.map((x: any, j: number) => (j === i ? { ...x, incremental_column: v } : x)) })} mono width={150} placeholder="updated_at" />
                    <Field value={t.primary_key ?? ""} onChange={(v) => setSq({ tables: sq.tables.map((x: any, j: number) => (j === i ? { ...x, primary_key: v } : x)) })} mono width={110} placeholder="id" />
                    {sq.tables.length > 1 && <button className="btn sm borderless" aria-label="Remove table" onClick={() => setSq({ tables: sq.tables.filter((_: any, j: number) => j !== i) })}><I n="trash" size={14} /></button>}
                  </div>
                ))}
              </div>
            </>
          )}

          {kind === "filesystem" && (
            <>
              <div className="group-title">Files</div>
              <div className="group">
                <L label="Folder or bucket" hint="A folder in the project, an absolute path, or s3:// gs:// az://"><Field value={fs.bucket_url ?? ""} onChange={(v) => setFs({ bucket_url: v })} mono width={300} /></L>
                {(preview?.secrets ?? []).map((s) => <L key={s.key} label={s.label}><Field type="password" value={secrets[s.key] ?? ""} onChange={(v) => setSecrets({ ...secrets, [s.key]: v })} width={220} /></L>)}
              </div>
              <div className="hstack" style={{ padding: "18px 12px 8px" }}><b className="grow">Tables</b><Btn size="sm" icon="plus" onClick={() => setFs({ tables: [...fs.tables, { name: "", glob: "*.csv", format: "csv" }] })}>Add table</Btn></div>
              <div className="group">
                <div className="table-head" style={{ padding: 0 }}><span style={{ width: 150 }}>Table</span><span style={{ width: 170 }}>Files matching</span><span style={{ width: 110 }}>Format</span><span className="grow">Only new files</span></div>
                {fs.tables.map((t: any, i: number) => (
                  <div key={i} className="hstack" style={{ gap: 8, padding: "6px 0" }}>
                    <Field value={t.name} onChange={(v) => setFs({ tables: fs.tables.map((x: any, j: number) => (j === i ? { ...x, name: v.toLowerCase().replace(/[^a-z0-9_]/g, "_") } : x)) })} mono width={150} placeholder="orders" />
                    <Field value={t.glob} onChange={(v) => setFs({ tables: fs.tables.map((x: any, j: number) => (j === i ? { ...x, glob: v } : x)) })} mono width={170} />
                    <Select label="Format" value={t.format} onChange={(v) => setFs({ tables: fs.tables.map((x: any, j: number) => (j === i ? { ...x, format: v } : x)) })} options={[{ value: "csv", label: "CSV" }, { value: "parquet", label: "Parquet" }, { value: "jsonl", label: "JSON lines" }]} />
                    <Check on={!!t.incremental} onChange={(v) => setFs({ tables: fs.tables.map((x: any, j: number) => (j === i ? { ...x, incremental: v } : x)) })} label="Only new files" />
                    {fs.tables.length > 1 && <button className="btn sm borderless" aria-label="Remove table" onClick={() => setFs({ tables: fs.tables.filter((_: any, j: number) => j !== i) })}><I n="trash" size={14} /></button>}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="vstack" style={{ flex: "1 1 420px", minWidth: 0, gap: 8 }}>
          <span className="upper">{spec.name || "pipeline"}.py · what Save writes</span>
          <div className="vstack" style={{ flex: 1, minHeight: 360, maxHeight: "60vh", borderRadius: 10, overflow: "hidden", boxShadow: "0 0 0 1px var(--sep)" }}>
            {!preview ? <div className="empty"><Spinner /></div> : <Editor path="x.py" value={preview.code || "# Fill in the form to see the pipeline code."} readOnly theme={theme} fontSize={11.5} />}
          </div>
          {preview?.errors?.length ? <div className="t-callout" style={{ color: "var(--yellow)", lineHeight: "17px" }}>{preview.errors.join(" ")}</div> : null}
          {preview?.destination_error && <div className="t-callout" style={{ color: "var(--red)" }}>{preview.destination_error}</div>}
          <span className="t-subhead c2" style={{ lineHeight: "15px" }}>dlt pipeline code you can read and run yourself. Passwords and tokens are read from environment variables, which Marthouse fills in when it runs.</span>
        </div>
      </div>
      <div className="acts">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn kind="prominent" busy={busy} disabled={!spec.name || !!preview?.errors?.length || !!preview?.destination_error} onClick={save}>Save pipeline</Btn>
      </div>
    </Sheet>
  );
}
