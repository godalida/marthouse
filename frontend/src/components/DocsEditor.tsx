import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { I } from "../icons";
import { useShell } from "../Shell";
import { useSettings, useTheme } from "../store";
import { Btn, Check, Field, Select, Sheet, Spinner, errText, useToast } from "../ui";
import { Editor } from "./Editor";

type Test = { type: string; values?: string[]; to?: string; field?: string; severity?: string };
type Col = { description: string; tests: Test[] };

/** Edit a model's description, column descriptions and tests; writes the .yml for you. */
export function DocsEditor({ node, onDone }: { node: any; onDone: () => void }) {
  const { pid, refresh } = useShell();
  const toast = useToast();
  const qc = useQueryClient();
  const settings = useSettings();
  const theme = useTheme(settings.data?.appearance);
  const yml = useQuery<any>({ queryKey: ["docs-yml", pid, node.id], queryFn: () => api(`/api/projects/${pid}/docs/yml`, { query: { id: node.id } }) });
  const graph = useQuery<any>({ queryKey: ["graph", pid, ""], queryFn: () => api(`/api/projects/${pid}/graph`), retry: false });
  const [desc, setDesc] = useState(node.description ?? "");
  const [cols, setCols] = useState<Record<string, Col>>({});
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<string | null>(null);
  useEffect(() => {
    if (!yml.data) return;
    const out: Record<string, Col> = {};
    for (const c of node.columns) out[c.name] = { description: c.description ?? "", tests: yml.data.columns?.[c.name]?.tests ?? yml.data.columns?.[c.name.toLowerCase()]?.tests ?? [] };
    setCols(out);
  }, [yml.data, node]);
  const models: string[] = useMemo(() => (graph.data?.nodes ?? []).filter((n: any) => ["model", "seed", "snapshot"].includes(n.type) && n.package === graph.data?.project).map((n: any) => n.name).sort(), [graph.data]);
  const has = (c: string, t: string) => (cols[c]?.tests ?? []).some((x) => x.type === t);
  const toggle = (c: string, t: Test, on: boolean) => setCols({ ...cols, [c]: { ...cols[c], tests: on ? [...cols[c].tests.filter((x) => x.type !== t.type), t] : cols[c].tests.filter((x) => x.type !== t.type) } });
  const patchTest = (c: string, type: string, patch: Partial<Test>) => setCols({ ...cols, [c]: { ...cols[c], tests: cols[c].tests.map((x) => (x.type === type ? { ...x, ...patch } : x)) } });
  const body = (dry: boolean) => ({ id: node.id, description: desc, dry_run: dry, columns: Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, { description: v.description, tests: v.tests.filter((t) => ["unique", "not_null", "accepted_values", "relationships"].includes(t.type)) }])) });
  const save = async () => {
    setBusy(true);
    try {
      const r = await api(`/api/projects/${pid}/docs/yml`, { body: body(false) });
      await api(`/api/projects/${pid}/parse`, { body: {} });
      refresh();
      qc.invalidateQueries({ queryKey: ["node", pid] });
      qc.invalidateQueries({ queryKey: ["docs-yml", pid, node.id] });
      toast(`Saved to ${r.path}`);
      onDone();
    } catch (e) { toast(errText(e), "error"); } finally { setBusy(false); }
  };
  if (yml.isLoading) return <Spinner />;
  return (
    <div className="vstack" style={{ gap: 14, maxWidth: 1040 }}>
      <label className="vstack" style={{ gap: 6 }}>
        <span className="t-headline">Description</span>
        <textarea className="field" style={{ height: 70, padding: 8, lineHeight: "18px", fontSize: 13 }} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What is one row? Who uses it?" />
      </label>
      <div className="tbl">
        <div style={{ minWidth: 820 }}>
          <div className="table-head"><span style={{ width: 170 }}>Column</span><span className="grow">Description</span><span style={{ width: 70, textAlign: "center" }}>Unique</span><span style={{ width: 70, textAlign: "center" }}>Not null</span><span style={{ width: 260 }}>More tests</span></div>
          {node.columns.map((c: any) => {
            const col = cols[c.name] ?? { description: "", tests: [] };
            const av = col.tests.find((t) => t.type === "accepted_values");
            const rel = col.tests.find((t) => t.type === "relationships");
            const other = col.tests.filter((t) => !["unique", "not_null", "accepted_values", "relationships"].includes(t.type));
            return (
              <div key={c.name} className="list-row" style={{ alignItems: "flex-start", padding: "8px 12px" }}>
                <span style={{ width: 170 }} className="vstack"><span className="mono bold trunc">{c.name}</span><span className="t-subhead c2 mono">{c.type}</span></span>
                <span className="grow"><Field value={col.description} onChange={(v) => setCols({ ...cols, [c.name]: { ...col, description: v } })} width="100%" placeholder="Describe this column" /></span>
                <span style={{ width: 70, display: "flex", justifyContent: "center", paddingTop: 4 }}><Check on={has(c.name, "unique")} onChange={(v) => toggle(c.name, { type: "unique" }, v)} label={`unique on ${c.name}`} /></span>
                <span style={{ width: 70, display: "flex", justifyContent: "center", paddingTop: 4 }}><Check on={has(c.name, "not_null")} onChange={(v) => toggle(c.name, { type: "not_null" }, v)} label={`not_null on ${c.name}`} /></span>
                <span style={{ width: 260 }} className="vstack">
                  <span className="hstack" style={{ gap: 6 }}><Check on={!!av} onChange={(v) => toggle(c.name, { type: "accepted_values", values: [] }, v)} label="accepted values" /><span className="t-callout">Only these values</span></span>
                  {av && <span style={{ paddingLeft: 20, paddingTop: 4 }}><Field value={(av.values ?? []).join(", ")} onChange={(v) => patchTest(c.name, "accepted_values", { values: v.split(",").map((x) => x.trim()).filter(Boolean) })} placeholder="placed, shipped, completed" width="100%" mono /></span>}
                  <span className="hstack" style={{ gap: 6, marginTop: 4 }}><Check on={!!rel} onChange={(v) => toggle(c.name, { type: "relationships", to: models[0], field: c.name }, v)} label="relationship" /><span className="t-callout">Must exist in another model</span></span>
                  {rel && <span className="hstack" style={{ gap: 6, paddingLeft: 20, paddingTop: 4 }}><Select label="Model" value={rel.to ?? ""} onChange={(v) => patchTest(c.name, "relationships", { to: v })} options={models.map((m) => ({ value: m, label: m }))} /><Field value={rel.field ?? ""} onChange={(v) => patchTest(c.name, "relationships", { field: v })} mono width={100} placeholder="column" /></span>}
                  {other.length > 0 && <span className="t-subhead c2" style={{ marginTop: 4 }}>Kept as written: {other.map((t) => t.type).join(", ")}</span>}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="hstack" style={{ gap: 8 }}>
        <span className="t-subhead c2 grow">Saved to <span className="mono">{yml.data?.path}</span>. Comments and other settings in that file are kept.</span>
        <Btn onClick={async () => { try { setView((await api(`/api/projects/${pid}/docs/yml`, { body: body(true) })).text); } catch (e) { toast(errText(e), "error"); } }}><I n="code" size={14} />View YAML</Btn>
        <Btn onClick={onDone}>Cancel</Btn>
        <Btn kind="prominent" busy={busy} onClick={save}>Save</Btn>
      </div>
      <Sheet open={view !== null} onClose={() => setView(null)} label="YAML" width={700}>
        <b className="t-title3">{yml.data?.path}, after saving</b>
        <div className="vstack" style={{ height: 420, borderRadius: 10, overflow: "hidden", boxShadow: "0 0 0 1px var(--sep)" }}><Editor path="x.yml" value={view ?? ""} readOnly theme={theme} /></div>
        <div className="acts"><Btn onClick={() => setView(null)}>Close</Btn></div>
      </Sheet>
    </div>
  );
}
