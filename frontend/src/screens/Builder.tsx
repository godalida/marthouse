import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { DataGrid } from "../components/DataGrid";
import { Editor } from "../components/Editor";
import { I, type IconName } from "../icons";
import { useShell } from "../Shell";
import { useSettings, useTheme } from "../store";
import { Btn, Callout, Check, Empty, Field, MenuItem, Popover, Seg, Select, Sheet, Spinner, TbBtn, errText, useToast } from "../ui";

type Step = Record<string, any> & { type: string };
type Spec = { steps: Step[]; materialized: string };
type Preview = { rows: any[]; columns: string[]; errors: string[]; sql: string };

const KINDS: { type: string; label: string; icon: IconName; blank: () => Step }[] = [
  { type: "filter", label: "Keep rows where…", icon: "search", blank: () => ({ type: "filter", match: "all", conditions: [{ column: "", op: "eq", value: "" }] }) },
  { type: "columns", label: "Choose and rename columns", icon: "table", blank: () => ({ type: "columns", keep: [] }) },
  { type: "join", label: "Join another model", icon: "link", blank: () => ({ type: "join", how: "left", with: {}, on: [{ left: "", right: "" }], columns: [] }) },
  { type: "formula", label: "Add a calculated column", icon: "plus", blank: () => ({ type: "formula", name: "", expression: "" }) },
  { type: "group", label: "Group and summarise", icon: "chart", blank: () => ({ type: "group", by: [], aggs: [{ fn: "count", column: "", as: "row_count" }] }) },
  { type: "sort", label: "Sort and limit", icon: "chevronDown", blank: () => ({ type: "sort", by: [{ column: "", desc: false }], limit: "" }) },
  { type: "distinct", label: "Remove duplicate rows", icon: "minus", blank: () => ({ type: "distinct" }) },
];
const OPS = [
  { value: "eq", label: "is" }, { value: "ne", label: "is not" }, { value: "gt", label: "is greater than" }, { value: "ge", label: "is at least" },
  { value: "lt", label: "is less than" }, { value: "le", label: "is at most" }, { value: "contains", label: "contains" }, { value: "starts", label: "starts with" },
  { value: "ends", label: "ends with" }, { value: "in", label: "is one of" }, { value: "not_in", label: "is none of" }, { value: "empty", label: "is empty" }, { value: "not_empty", label: "is not empty" },
];
const AGGS = [{ value: "count", label: "Count" }, { value: "count_distinct", label: "Count distinct" }, { value: "sum", label: "Sum" }, { value: "avg", label: "Average" }, { value: "min", label: "Minimum" }, { value: "max", label: "Maximum" }];

const relName = (r: any) => (r?.ref ? r.ref : r?.source ? `${r.source}.${r.table}` : "");

function summary(s: Step): string {
  switch (s.type) {
    case "source": return relName(s) ? `Start from ${relName(s)}` : "Choose where to start";
    case "filter": {
      const c = (s.conditions ?? []).filter((x: any) => x.column);
      if (!c.length) return "Keep rows where…";
      const t = (x: any) => `${x.column} ${OPS.find((o) => o.value === x.op)?.label ?? x.op}${["empty", "not_empty"].includes(x.op) ? "" : ` ${x.value}`}`;
      return `Keep rows where ${c.map(t).join(s.match === "any" ? " or " : " and ")}`;
    }
    case "columns": return `Keep ${(s.keep ?? []).length} columns`;
    case "join": return relName(s.with) ? `${s.how === "inner" ? "Join" : "Look up"} ${relName(s.with)}` : "Join another model";
    case "formula": return s.name ? `Add column ${s.name}` : "Add a calculated column";
    case "group": return (s.by ?? []).length ? `Group by ${s.by.join(", ")}` : "Summarise all rows";
    case "sort": { const b = (s.by ?? []).filter((x: any) => x.column); return b.length ? `Sort by ${b.map((x: any) => x.column + (x.desc ? " (high to low)" : "")).join(", ")}${s.limit ? `, first ${s.limit}` : ""}` : "Sort and limit"; }
    case "distinct": return "Remove duplicate rows";
  }
  return s.type;
}
const stepIcon = (t: string): IconName => (t === "source" ? "db" : KINDS.find((k) => k.type === t)?.icon ?? "cube");

export function Builder() {
  const { pid, runJob, refresh } = useShell();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const settings = useSettings();
  const theme = useTheme(settings.data?.appearance);
  const openPath = params.get("path");
  const [spec, setSpec] = useState<Spec>({ materialized: "view", steps: [{ type: "source" }] });
  const [path, setPath] = useState<string | null>(openPath);
  const [sel, setSel] = useState(0);
  const [mode, setMode] = useState<"steps" | "sql">("steps");
  const [addOpen, setAddOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("models/marts/new_model.sql");
  const [loadErr, setLoadErr] = useState("");
  const [dirty, setDirty] = useState(false);
  const graph = useQuery<any>({ queryKey: ["graph", pid, ""], queryFn: () => api(`/api/projects/${pid}/graph`), retry: false });
  const rels = useMemo(() => (graph.data?.nodes ?? []).filter((n: any) => ["model", "seed", "snapshot", "source"].includes(n.type) && (n.package === graph.data?.project || n.type === "source"))
    .map((n: any) => ({ value: n.type === "source" ? `source:${n.name}` : `ref:${n.name}`, label: n.name, type: n.type })), [graph.data]);

  useEffect(() => {
    if (!openPath) return;
    api(`/api/projects/${pid}/visual/load`, { query: { path: openPath } }).then((r) => {
      if (r.edited) setLoadErr("This model was changed by hand after the builder saved it, so it opens in the code editor. The builder only edits models it fully understands.");
      setSpec({ materialized: r.spec.materialized ?? "view", steps: r.spec.steps });
      setSel(r.spec.steps.length - 1);
      setPath(openPath);
    }).catch((e) => setLoadErr(errText(e)));
  }, [openPath, pid]);

  // previews, cached by the steps they depend on
  const cache = useRef(new Map<string, Promise<Preview>>());
  const preview = (upto: number, limit = 100): Promise<Preview> => {
    const key = JSON.stringify([spec.steps.slice(0, upto + 1), limit]);
    if (!cache.current.has(key)) {
      const p = api(`/api/projects/${pid}/visual/preview`, { body: { spec, upto, limit } }).catch((e) => ({ rows: [], columns: [], errors: [errText(e)], sql: "" }));
      cache.current.set(key, p);
    }
    return cache.current.get(key)!;
  };
  const [out, setOut] = useState<Preview | null>(null);
  const [inCols, setInCols] = useState<string[]>([]);
  const [inErr, setInErr] = useState("");
  const [busy, setBusy] = useState(false);
  const stepReady = (s: Step) => s.type !== "source" || !!relName(s);
  useEffect(() => {
    let live = true;
    if (!stepReady(spec.steps[0])) { setOut(null); setInCols([]); return; }
    setBusy(true);
    const h = setTimeout(async () => {
      const [o, i] = await Promise.all([preview(sel), sel > 0 ? preview(sel - 1) : Promise.resolve(null)]);
      if (!live) return;
      setOut(o);
      setInCols(i?.columns ?? o.columns);
      setInErr(i?.errors?.length ? i.errors[0] : "");
      if (i?.errors?.length) cache.current.delete(JSON.stringify([spec.steps.slice(0, sel), 100]));
      setBusy(false);
    }, 500);
    return () => { live = false; clearTimeout(h); };
  }, [JSON.stringify(spec.steps.slice(0, sel + 1)), sel]); // eslint-disable-line

  const sqlQ = useQuery<{ sql: string }>({ queryKey: ["visual-sql", pid, spec], queryFn: () => api(`/api/projects/${pid}/visual/sql`, { body: { spec } }), enabled: mode === "sql", retry: false });

  // always build on the latest steps, so quick successive edits don't overwrite each other
  const setStep = (i: number, patch: Partial<Step>) => { setDirty(true); setSpec((sp) => ({ ...sp, steps: sp.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) })); };
  const addStep = (k: (typeof KINDS)[number]) => {
    setAddOpen(false);
    setSpec((sp) => ({ ...sp, steps: [...sp.steps.slice(0, sel + 1), k.blank(), ...sp.steps.slice(sel + 1)] }));
    setSel(sel + 1);
    setDirty(true);
  };
  const removeStep = (i: number) => {
    if (i === 0) return;
    setSpec((sp) => ({ ...sp, steps: sp.steps.filter((_, j) => j !== i) }));
    setSel(Math.max(0, i - 1));
    setDirty(true);
  };
  const save = async (target: string, overwrite: boolean) => {
    try {
      await api(`/api/projects/${pid}/visual/save`, { body: { spec, path: target, overwrite } });
      setPath(target);
      setDirty(false);
      setSaveOpen(false);
      qc.invalidateQueries({ queryKey: ["tree", pid] });
      await api(`/api/projects/${pid}/parse`, { body: {} }).catch(() => {});
      refresh();
      toast(`Saved ${target}`);
      nav(`/p/${pid}/build?path=${encodeURIComponent(target)}`, { replace: true });
    } catch (e) { toast(errText(e), "error"); }
  };
  const modelName = path ? path.split("/").pop()!.replace(/\.sql$/, "") : "New model";
  const step = spec.steps[sel];

  if (loadErr) {
    return (<><header className="toolbar"><div className="title"><b>{modelName}</b></div></header>
      <Empty icon="code" title="Open it in the code editor" actions={<Btn kind="prominent" onClick={() => nav(`/p/${pid}/models?file=${encodeURIComponent(openPath ?? "")}`)}>Open in Models</Btn>}>{loadErr}</Empty></>);
  }

  return (
    <>
      <header className="toolbar">
        <div className="title"><b>{modelName}{dirty && path ? " ·" : ""}</b><small>{path ?? "Not saved yet"} · {spec.steps.length} {spec.steps.length === 1 ? "step" : "steps"}</small></div>
        <div className="spacer" />
        <Seg label="View" value={mode} onChange={setMode} options={[{ value: "steps", label: "Steps" }, { value: "sql", label: "SQL" }]} />
        <Select label="Store as" value={spec.materialized} onChange={(m) => { setDirty(true); setSpec((sp) => ({ ...sp, materialized: m })); }} options={[{ value: "view", label: "Save as a view" }, { value: "table", label: "Save as a table" }, { value: "ephemeral", label: "Ephemeral (not saved)" }]} />
        {path && !dirty && <TbBtn icon="play" label="Build" onClick={() => runJob("build", { select: modelName })} />}
        <TbBtn icon="save" label={path ? "Save" : "Save…"} prominent disabled={!stepReady(spec.steps[0]) || (!!path && !dirty)} onClick={() => (path ? save(path, true) : setSaveOpen(true))} />
      </header>
      {mode === "sql" ? (
        <div className="vstack fill">
          <div className="t-callout c2" style={{ padding: "10px 16px", borderBottom: "1px solid var(--hairline)" }}>This is the dbt model the steps produce. You can open the saved file in Models and edit it there, but then the builder hands it over to the code editor.</div>
          {sqlQ.error ? <div className="console" style={{ color: "var(--red)" }}>{errText(sqlQ.error)}</div> : <Editor path="model.sql" value={sqlQ.data?.sql ?? ""} readOnly theme={theme} />}
        </div>
      ) : (
        <div className="hstack fill" style={{ alignItems: "stretch" }}>
          <nav className="vstack" style={{ width: 290, flex: "none", borderRight: "1px solid var(--sep)", background: "var(--inspector-bg)" }} aria-label="Steps">
            <div className="scroll fill" style={{ padding: "10px 8px" }}>
              {spec.steps.map((s, i) => (
                <div key={i} className={`sb-item ${i === sel ? "on" : ""}`} style={{ height: "auto", padding: "8px 8px 8px 10px", alignItems: "flex-start" }} onClick={() => setSel(i)} role="button" aria-pressed={i === sel}>
                  <span className="t-subhead c2 cell-num" style={{ width: 14, paddingTop: 2 }}>{i + 1}</span>
                  <I n={stepIcon(s.type)} />
                  <span className="grow" style={{ lineHeight: "16px", minWidth: 0, wordBreak: "break-word" }}>{summary(s)}</span>
                  {i > 0 && i === sel && <button className="btn sm borderless" aria-label="Remove step" onClick={(e) => { e.stopPropagation(); removeStep(i); }}><I n="x" size={14} /></button>}
                </div>
              ))}
              <div style={{ position: "relative", padding: "8px 6px" }}>
                <Btn icon="plus" disabled={!stepReady(spec.steps[0])} onClick={() => setAddOpen(!addOpen)}>Add a step</Btn>
                <Popover open={addOpen} onClose={() => setAddOpen(false)} width={260}>
                  <div className="menu-head">After step {sel + 1}</div>
                  {KINDS.map((k) => <MenuItem key={k.type} icon={k.icon} onClick={() => addStep(k)}>{k.label}</MenuItem>)}
                </Popover>
              </div>
            </div>
          </nav>
          <section className="vstack fill">
            <div className="scroll" style={{ padding: "16px 20px", maxHeight: "48%", borderBottom: "1px solid var(--sep)", flex: "none" }}>
              <b className="t-title3" style={{ display: "block", marginBottom: 10 }}>{sel + 1}. {step.type === "source" ? "Start from" : KINDS.find((k) => k.type === step.type)?.label}</b>
              <StepForm key={sel} step={step} i={sel} cols={inCols} inputError={inErr} rels={rels} set={(p) => setStep(sel, p)} fetchCols={async (r) => (await api(`/api/projects/${pid}/visual/preview`, { body: { spec: { steps: [{ type: "source", ...r }] }, upto: 0, limit: 1 } })).columns} />
            </div>
            <div className="hstack" style={{ height: 34, padding: "0 14px", gap: 10, borderBottom: "1px solid var(--hairline)", background: "var(--inspector-bg)", flex: "none" }}>
              <span className="upper">Rows after step {sel + 1}</span>
              {busy ? <span className="hstack t-subhead c2" style={{ gap: 6 }}><Spinner />Running with dbt show…</span> : out && !out.errors.length && <span className="t-subhead c2">{out.rows.length === 100 ? "First 100 rows" : `${out.rows.length} rows`} · {out.columns.length} columns</span>}
            </div>
            <div className="scroll fill">
              {!stepReady(spec.steps[0]) && <div className="empty"><span className="c2 t-callout">Choose a model or source to start from.</span></div>}
              {out?.errors.length ? <div style={{ padding: 14 }}><Callout tone="error" title="This step doesn't run yet.">{out.errors.slice(0, 3).join(" ")}</Callout></div> : null}
              {out && !out.errors.length && out.rows.length === 0 && <div className="c2 t-callout" style={{ padding: 14 }}>No rows match. Columns: {out.columns.join(", ")}</div>}
              {out && out.rows.length > 0 && !busy && <DataGrid rows={out.rows} columns={out.columns} />}
            </div>
          </section>
        </div>
      )}
      <Sheet open={saveOpen} onClose={() => setSaveOpen(false)} label="Save model" width={480}>
        <b className="t-title3">Save the model</b>
        <p className="c2 t-callout" style={{ lineHeight: "17px" }}>The steps become a normal dbt model you can build, test and document. The file name becomes the model name.</p>
        <Field value={saveName} onChange={setSaveName} mono autoFocus onEnter={() => save(saveName, false)} />
        <div className="acts"><Btn onClick={() => setSaveOpen(false)}>Cancel</Btn><Btn kind="prominent" disabled={!/^models\/[A-Za-z0-9_./-]+\.sql$/.test(saveName)} onClick={() => save(saveName, false)}>Save</Btn></div>
      </Sheet>
    </>
  );
}

function ColSelect({ value, cols, onChange, label, allowNone }: { value: string; cols: string[]; onChange: (v: string) => void; label: string; allowNone?: string }) {
  const opts = [...(allowNone ? [{ value: "", label: allowNone }] : value ? [] : [{ value: "", label: "Choose a column" }]), ...cols.map((c) => ({ value: c, label: c }))];
  if (value && !cols.includes(value)) opts.push({ value, label: `${value} (missing)` });
  return <Select label={label} value={value} onChange={onChange} options={opts} width={190} />;
}

function StepForm({ step, i, cols, inputError, rels, set, fetchCols }: { step: Step; i: number; cols: string[]; inputError?: string; rels: { value: string; label: string; type: string }[]; set: (p: Partial<Step>) => void; fetchCols: (r: any) => Promise<string[]> }) {
  // `step` comes from the latest render; edits in one event handler are applied one at a time by setStep
  const [joinCols, setJoinCols] = useState<string[]>([]);
  const toRel = (v: string) => (v.startsWith("ref:") ? { ref: v.slice(4) } : { source: v.slice(7).split(".")[0], table: v.slice(7).split(".").slice(1).join(".") });
  const fromRel = (r: any) => (r?.ref ? `ref:${r.ref}` : r?.source ? `source:${r.source}.${r.table}` : "");
  useEffect(() => { if (step.type === "join" && relName(step.with)) fetchCols(step.with).then(setJoinCols).catch(() => setJoinCols([])); }, [step.type, JSON.stringify(step.with)]); // eslint-disable-line
  // a new "choose columns" step starts with every column ticked
  useEffect(() => { if (step.type === "columns" && !step.keep?.length && cols.length) set({ keep: cols.map((c) => ({ name: c, as: c })) }); }, [step.type, cols.join()]); // eslint-disable-line
  const relOptions = [{ value: "", label: "Choose…" }, ...rels.map((r) => ({ value: r.value, label: `${r.label} (${r.type})` }))];

  if (step.type === "source") {
    return (
      <div className="group">
        <div className="form-row"><span className="lead">Model or source<small>The rows this model starts from</small></span>
          <Select label="Start from" width={300} value={fromRel(step)} onChange={(v) => set({ ref: undefined, source: undefined, table: undefined, ...toRel(v) })} options={relOptions} />
        </div>
      </div>
    );
  }
  if (!cols.length && inputError) return <Callout tone="error" title={`Step ${i} doesn't run, so this step has no columns to work with.`}>{inputError}</Callout>;
  if (!cols.length) return <span className="hstack c2 t-callout" style={{ gap: 8 }}><Spinner />Reading the columns from step {i}…</span>;
  if (step.type === "filter") {
    const conds: any[] = step.conditions ?? [];
    const upd = (k: number, p: any) => set({ conditions: conds.map((c, j) => (j === k ? { ...c, ...p } : c)) });
    return (
      <div className="vstack" style={{ gap: 8 }}>
        <div className="hstack" style={{ gap: 8 }}><span className="t-callout">Keep rows that match</span><Seg label="Match" value={step.match ?? "all"} onChange={(m) => set({ match: m })} options={[{ value: "all", label: "all of these" }, { value: "any", label: "any of these" }]} /></div>
        <div className="group">
          {conds.map((c, k) => (
            <div key={k} className="form-row" style={{ gap: 8 }}>
              <ColSelect label="Column" value={c.column} cols={cols} onChange={(v) => upd(k, { column: v })} />
              <Select label="Comparison" value={c.op} onChange={(v) => upd(k, { op: v })} options={OPS} width={160} />
              {!["empty", "not_empty"].includes(c.op) && <Field value={c.value ?? ""} onChange={(v) => upd(k, { value: v })} placeholder={["in", "not_in"].includes(c.op) ? "a, b, c" : "value"} width={180} />}
              <span className="spacer" />
              {conds.length > 1 && <button className="btn sm borderless" aria-label="Remove condition" onClick={() => set({ conditions: conds.filter((_, j) => j !== k) })}><I n="x" size={14} /></button>}
            </div>
          ))}
        </div>
        <Btn icon="plus" style={{ alignSelf: "flex-start" }} onClick={() => set({ conditions: [...conds, { column: "", op: "eq", value: "" }] })}>Add a condition</Btn>
      </div>
    );
  }
  if (step.type === "columns") {
    const keep: any[] = step.keep?.length ? step.keep : [];
    const on = (c: string) => keep.find((k) => k.name === c);
    const all = keep.length ? keep : [];
    return (
      <div className="tbl" style={{ maxWidth: 620 }}>
        <div className="table-head"><span style={{ width: 28 }} /><span style={{ width: 220 }}>Column</span><span className="grow">Name in the result</span></div>
        {cols.map((c) => {
          const k = on(c);
          return (
            <div key={c} className="list-row" style={{ opacity: k ? 1 : 0.55 }}>
              <span style={{ width: 28 }}><Check on={!!k} onChange={(v) => set({ keep: v ? [...all, { name: c, as: c }] : all.filter((x) => x.name !== c) })} label={`Keep ${c}`} /></span>
              <span style={{ width: 220 }} className="trunc">{c}</span>
              <span className="grow">{k && <Field value={k.as ?? c} onChange={(v) => set({ keep: all.map((x) => (x.name === c ? { ...x, as: v.replace(/[^A-Za-z0-9_]/g, "_") } : x)) })} width={220} />}</span>
            </div>
          );
        })}
      </div>
    );
  }
  if (step.type === "join") {
    const on: any[] = step.on ?? [];
    const picked: any[] = step.columns ?? [];
    return (
      <div className="vstack" style={{ gap: 10 }}>
        <div className="group">
          <div className="form-row"><span className="lead">Join</span><Select label="Model" width={280} value={fromRel(step.with)} onChange={(v) => set({ with: toRel(v), columns: [] })} options={relOptions} /></div>
          <div className="form-row"><span className="lead">Keep<small>{step.how === "inner" ? "Only rows that have a match" : "Every row, even without a match"}</small></span><Seg label="Join type" value={step.how ?? "left"} onChange={(h) => set({ how: h })} options={[{ value: "left", label: "All rows" }, { value: "inner", label: "Only matches" }]} /></div>
          {on.map((p, k) => (
            <div key={k} className="form-row" style={{ gap: 8 }}>
              <span className="lead">{k === 0 ? "Where" : "and"}</span>
              <ColSelect label="This column" value={p.left} cols={cols} onChange={(v) => set({ on: on.map((x, j) => (j === k ? { ...x, left: v } : x)) })} />
              <span className="c2">equals</span>
              <ColSelect label="Their column" value={p.right} cols={joinCols} onChange={(v) => set({ on: on.map((x, j) => (j === k ? { ...x, right: v } : x)) })} />
            </div>
          ))}
        </div>
        {joinCols.length > 0 && (
          <>
            <span className="t-headline">Columns to bring in from {relName(step.with)}</span>
            <div className="hstack" style={{ gap: 10, flexWrap: "wrap" }}>
              {joinCols.map((c) => {
                const k = picked.find((x) => x.name === c);
                const clash = cols.includes(c);
                return (
                  <label key={c} className="hstack t-callout" style={{ gap: 6 }}>
                    <Check on={!!k} onChange={(v) => set({ columns: v ? [...picked, { name: c, as: clash ? `${relName(step.with).split(".").pop()}_${c}` : c }] : picked.filter((x) => x.name !== c) })} label={c} />
                    {c}{k && k.as !== c && <span className="c2">as {k.as}</span>}
                  </label>
                );
              })}
            </div>
          </>
        )}
      </div>
    );
  }
  if (step.type === "formula") {
    return (
      <div className="group">
        <div className="form-row"><span className="lead">New column name</span><Field value={step.name ?? ""} onChange={(v) => set({ name: v.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} width={220} placeholder="order_size" /></div>
        <div className="form-row"><span className="lead">Formula<small>Any SQL expression over the columns: {cols.slice(0, 6).join(", ")}{cols.length > 6 ? "…" : ""}</small></span>
          <Field value={step.expression ?? ""} onChange={(v) => set({ expression: v })} mono width={320} placeholder="case when amount > 50 then 'large' else 'small' end" /></div>
      </div>
    );
  }
  if (step.type === "group") {
    const by: string[] = step.by ?? [];
    const aggs: any[] = step.aggs ?? [];
    return (
      <div className="vstack" style={{ gap: 10 }}>
        <span className="t-headline">One row for each</span>
        <div className="hstack" style={{ gap: 10, flexWrap: "wrap" }}>
          {cols.map((c) => <label key={c} className="hstack t-callout" style={{ gap: 6 }}><Check on={by.includes(c)} onChange={(v) => set({ by: v ? [...by, c] : by.filter((x) => x !== c) })} label={c} />{c}</label>)}
        </div>
        <span className="t-subhead c2">{by.length ? "" : "Nothing ticked: summarise all rows into one."}</span>
        <span className="t-headline">With these totals</span>
        <div className="group">
          {aggs.map((a, k) => (
            <div key={k} className="form-row" style={{ gap: 8 }}>
              <Select label="Function" value={a.fn} onChange={(v) => set({ aggs: aggs.map((x, j) => (j === k ? { ...x, fn: v } : x)) })} options={AGGS} width={150} />
              {a.fn === "count" ? <ColSelect label="Of" value={a.column ?? ""} cols={cols} allowNone="rows" onChange={(v) => set({ aggs: aggs.map((x, j) => (j === k ? { ...x, column: v } : x)) })} />
                : <ColSelect label="Of" value={a.column ?? ""} cols={cols} onChange={(v) => set({ aggs: aggs.map((x, j) => (j === k ? { ...x, column: v, as: x.as && x.as !== "row_count" ? x.as : `${x.fn}_${v}` } : x)) })} />}
              <span className="c2">as</span>
              <Field value={a.as ?? ""} onChange={(v) => set({ aggs: aggs.map((x, j) => (j === k ? { ...x, as: v.replace(/[^A-Za-z0-9_]/g, "_") } : x)) })} width={160} />
              <span className="spacer" />
              <button className="btn sm borderless" aria-label="Remove total" onClick={() => set({ aggs: aggs.filter((_, j) => j !== k) })}><I n="x" size={14} /></button>
            </div>
          ))}
        </div>
        <Btn icon="plus" style={{ alignSelf: "flex-start" }} onClick={() => set({ aggs: [...aggs, { fn: "sum", column: "", as: "" }] })}>Add a total</Btn>
      </div>
    );
  }
  if (step.type === "sort") {
    const by: any[] = step.by ?? [];
    return (
      <div className="group">
        {by.map((b, k) => (
          <div key={k} className="form-row" style={{ gap: 8 }}>
            <span className="lead">{k === 0 ? "Sort by" : "then by"}</span>
            <ColSelect label="Column" value={b.column} cols={cols} onChange={(v) => set({ by: by.map((x, j) => (j === k ? { ...x, column: v } : x)) })} />
            <Seg label="Direction" value={b.desc ? "desc" : "asc"} onChange={(d) => set({ by: by.map((x, j) => (j === k ? { ...x, desc: d === "desc" } : x)) })} options={[{ value: "asc", label: "Low to high" }, { value: "desc", label: "High to low" }]} />
          </div>
        ))}
        <div className="form-row"><button className="btn sm" onClick={() => set({ by: [...by, { column: "", desc: false }] })}><I n="plus" size={14} />Add a sort column</button></div>
        <div className="form-row"><span className="lead">Keep only the first<small>Leave empty to keep every row</small></span><Field value={step.limit ?? ""} onChange={(v) => set({ limit: v.replace(/\D/g, "") })} width={90} placeholder="rows" /></div>
      </div>
    );
  }
  return <span className="c2 t-callout">This step has no settings.</span>;
}
