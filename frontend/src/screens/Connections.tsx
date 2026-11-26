import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { Editor } from "../components/Editor";
import { I } from "../icons";
import { useShell } from "../Shell";
import { useSettings, useTheme } from "../store";
import { Alert, Btn, Empty, Field, Select, Sheet, Spinner, Switch, TbBtn, dotClass, errText, useToast } from "../ui";
import { DebugChecklist } from "./Setup";

type FieldDef = { key: string; label: string; group: string; type?: string; default?: any; hint?: string; secret?: boolean; options?: string[] };
type Summary = { path: string; exists: boolean; active: string; secret_store: string; adapters: Record<string, FieldDef[]>; profiles: { name: string; default_target: string; targets: { name: string; type: string; host: string; default: boolean; env_missing: string[] }[] }[] };

export function Connections() {
  const { pid, project } = useShell();
  const qc = useQueryClient();
  const sum = useQuery<Summary>({ queryKey: ["conns", pid], queryFn: () => api(`/api/projects/${pid}/connections`) });
  const [sel, setSel] = useState<{ profile: string; target: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("dev");
  const [newType, setNewType] = useState("postgres");
  const [draft, setDraft] = useState<{ profile: string; target: string; type: string } | null>(null);

  const active = sum.data?.profiles.find((p) => p.name === sum.data?.active);
  useEffect(() => {
    if (!sel && sum.data && active?.targets.length) setSel({ profile: active.name, target: active.default_target || active.targets[0].name });
  }, [sum.data]); // eslint-disable-line
  const reload = () => qc.invalidateQueries({ queryKey: ["conns", pid] });
  const others = sum.data?.profiles.filter((p) => p.name !== sum.data?.active) ?? [];

  return (
    <>
      <header className="toolbar">
        <div className="title"><b>Connections</b><small >{sum.data ? `${sum.data.path.replace(/^\/Users\/[^/]+/, "~")} · profile ${sum.data.active}` : ""}</small></div>
        <div className="spacer" />
        <TbBtn icon="plus" label="Add target" onClick={() => setAdding(true)} />
      </header>
      {sum.isLoading ? <div className="empty"><Spinner /></div> : (
        <div className="hstack fill" style={{ alignItems: "stretch" }}>
          <nav className="vstack scroll" style={{ width: 240, flex: "none", borderRight: "1px solid var(--sep)", background: "var(--inspector-bg)", padding: "10px 8px", gap: 2 }} aria-label="Targets">
            <div className="sb-header" style={{ paddingLeft: 10 }}>{sum.data?.active}</div>
            {!active?.targets.length && <span className="t-callout c2" style={{ padding: "6px 10px" }}>No targets yet.</span>}
            {active?.targets.map((t) => (
              <button key={t.name} className={`sb-item ${sel?.target === t.name && sel.profile === active.name ? "on" : ""}`} style={{ height: "auto", padding: "8px 10px", width: "100%" }} onClick={() => { setDraft(null); setSel({ profile: active.name, target: t.name }); }}>
                <i className={`dot ${t.env_missing.length ? "error" : dotClass(null)}`} />
                <span className="vstack grow" style={{ gap: 1, textAlign: "left", minWidth: 0 }}>
                  <b>{t.name}</b>
                  <span className="t-subhead c2 trunc">{t.env_missing.length ? `env var ${t.env_missing[0]} missing` : `${t.type}${t.host ? " · " + t.host : ""}${t.default ? " · default" : ""}`}</span>
                </span>
              </button>
            ))}
            {others.length > 0 && <div className="sb-header" style={{ paddingLeft: 10, marginTop: 12 }}>Other profiles in this file</div>}
            {others.map((p) => (
              <div key={p.name} className="sb-item dim-item" style={{ height: "auto", padding: "8px 10px", cursor: "default" }}>
                <i className="dot idle" />
                <span className="vstack grow" style={{ gap: 1 }}><span>{p.name}</span><span className="t-subhead c2">{p.targets[0]?.type ?? ""} · {p.targets.length} {p.targets.length === 1 ? "target" : "targets"}</span></span>
              </div>
            ))}
          </nav>
          {draft ? (
            <TargetForm key={`new-${draft.target}`} summary={sum.data!} profile={draft.profile} target={draft.target} isNew type={draft.type} onSaved={(t) => { setDraft(null); reload(); setSel({ profile: draft.profile, target: t }); }} />
          ) : sel ? (
            <TargetForm key={`${sel.profile}.${sel.target}`} summary={sum.data!} profile={sel.profile} target={sel.target} onSaved={(t) => { reload(); setSel({ ...sel, target: t }); }} onDeleted={() => { setSel(null); reload(); }} />
          ) : (
            <Empty icon="plug" title={sum.data?.exists ? `No targets for ${sum.data.active}` : "No profiles.yml yet"} actions={<Btn kind="prominent" onClick={() => setAdding(true)}>Add a target</Btn>}>
              A target tells dbt which warehouse, database and schema to build into. Marthouse writes it to profiles.yml and keeps passwords {sum.data?.secret_store === "keychain" ? "in the macOS Keychain" : "encrypted"}.
            </Empty>
          )}
        </div>
      )}
      <Sheet open={adding} onClose={() => setAdding(false)} label="Add target" width={440}>
        <b className="t-title3">Add a target to {sum.data?.active}</b>
        <div className="group">
          <div className="form-row"><span className="lead">Name<small>dev, prod, ci…</small></span><Field value={newName} onChange={(v) => setNewName(v.replace(/[^A-Za-z0-9_-]/g, ""))} mono width={160} autoFocus /></div>
          <div className="form-row"><span className="lead">Warehouse</span><Select label="Adapter" value={newType} onChange={setNewType} options={Object.keys(sum.data?.adapters ?? {}).map((k) => ({ value: k, label: k }))} /></div>
        </div>
        <div className="acts"><Btn onClick={() => setAdding(false)}>Cancel</Btn><Btn kind="prominent" disabled={!newName || !!active?.targets.find((t) => t.name === newName)} onClick={() => {
          setAdding(false); setSel(null); setDraft({ profile: sum.data!.active || project.profile || project.name, target: newName, type: newType });
        }}>Continue</Btn></div>
      </Sheet>
    </>
  );
}

function TargetForm({ summary, profile, target, isNew, type, onSaved, onDeleted }: { summary: Summary; profile: string; target: string; isNew?: boolean; type?: string; onSaved: (t: string) => void; onDeleted?: () => void }) {
  const { pid } = useShell();
  const toast = useToast();
  const settings = useSettings();
  const theme = useTheme(settings.data?.appearance);
  const t = useQuery<any>({ queryKey: ["target", pid, profile, target], queryFn: () => api(`/api/projects/${pid}/connections/target`, { query: { profile, target } }), enabled: !isNew });
  const [fields, setFields] = useState<Record<string, any> | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [editSecret, setEditSecret] = useState<Record<string, boolean>>({});
  const [name, setName] = useState(target);
  const [makeDefault, setMakeDefault] = useState(false);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [testKey, setTestKey] = useState(0);
  const [confirmDel, setConfirmDel] = useState(false);
  const adapter = (fields?.type as string) ?? type ?? t.data?.type ?? "";
  const schema: FieldDef[] = summary.adapters[adapter] ?? t.data?.schema ?? [];

  useEffect(() => {
    if (isNew) {
      const f: Record<string, any> = { type, threads: 4 };
      for (const d of summary.adapters[type!] ?? []) if (d.default !== undefined) f[d.key] = d.default;
      setFields(f);
      setMakeDefault(!summary.profiles.find((p) => p.name === profile)?.targets.length);
    } else if (t.data) {
      setFields(t.data.fields);
      setMakeDefault(t.data.default);
      setPreview(t.data.block);
    }
  }, [t.data, isNew]); // eslint-disable-line

  const body = useMemo(() => fields && ({ profile, target, fields, secrets, make_default: makeDefault, rename_to: name !== target ? name : undefined }), [fields, secrets, makeDefault, name, profile, target]);
  useEffect(() => {
    if (!body) return;
    const h = setTimeout(() => api(`/api/projects/${pid}/connections/preview`, { body }).then((r) => setPreview(r.block)).catch(() => {}), 250);
    return () => clearTimeout(h);
  }, [body, pid]);

  if (!fields) return <div className="empty"><Spinner /></div>;
  const set = (k: string, v: any) => setFields({ ...fields, [k]: v });
  const groups = [...new Set(schema.map((s) => s.group))];
  const known = new Set(["type", "threads", ...schema.map((s) => s.key)]);
  const extra = Object.keys(fields).filter((k) => !known.has(k));

  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/projects/${pid}/connections/target`, { method: "PUT", body });
      setSecrets({});
      setEditSecret({});
      toast(`Saved ${name} to profiles.yml`);
      onSaved(name);
      setTestKey((k) => k + 1);
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    setConfirmDel(false);
    try { await api(`/api/projects/${pid}/connections/target`, { method: "DELETE", query: { profile, target } }); onDeleted?.(); } catch (e) { toast(errText(e), "error"); }
  };

  const renderField = (d: FieldDef) => {
    if (d.secret) {
      const info = t.data?.secrets?.[d.key];
      const stored = info?.stored && !editSecret[d.key];
      return (
        <div key={d.key} className="form-row">
          <span className="lead">{d.label}<small>{info?.where === "env" ? `Read from ${info.env}` : info?.where === "file" ? "Written in profiles.yml as plain text. Saving moves it to the " + (summary.secret_store === "keychain" ? "Keychain." : "encrypted store.") : summary.secret_store === "keychain" ? "Stored in the macOS Keychain" : "Stored encrypted by Marthouse"}</small></span>
          {stored ? <span className="hstack" style={{ gap: 8 }}><span className="hstack t-callout c2" style={{ gap: 5 }}><I n="key" size={14} />{info.where === "keychain" ? "In Keychain" : info.where === "encrypted" ? "Stored" : info.where === "env" ? "Env var" : "In file"}</span><Btn size="sm" onClick={() => setEditSecret({ ...editSecret, [d.key]: true })}>Change…</Btn></span>
            : <Field type="password" value={secrets[d.key] ?? ""} onChange={(v) => setSecrets({ ...secrets, [d.key]: v })} width={220} label={d.label} />}
        </div>
      );
    }
    return (
      <div key={d.key} className="form-row">
        <span className="lead">{d.label}{d.hint && <small>{d.hint}</small>}</span>
        {d.options ? <Select label={d.label} value={String(fields[d.key] ?? d.default ?? d.options[0])} onChange={(v) => set(d.key, v)} options={d.options.map((o) => ({ value: o, label: o }))} />
          : <Field value={fields[d.key] ?? ""} onChange={(v) => set(d.key, d.type === "int" ? (v === "" ? "" : Number(v.replace(/\D/g, ""))) : v)} width={d.type === "int" ? 100 : 240} mono={["schema", "dbname", "database", "dataset", "path", "http_path", "catalog"].includes(d.key)} label={d.label} />}
      </div>
    );
  };

  return (
    <>
      <section className="vstack scroll" style={{ flex: "1 1 400px", minWidth: 0, padding: "18px 22px", gap: 4 }}>
        <div className="group-title" style={{ paddingTop: 0 }}>Target</div>
        <div className="group">
          <div className="form-row"><span className="lead">Name</span><Field value={name} onChange={(v) => setName(v.replace(/[^A-Za-z0-9_-]/g, ""))} mono width={160} /></div>
          <div className="form-row"><span className="lead">Adapter</span><span className="t-callout">{adapter}</span></div>
          <div className="form-row"><span className="lead">Default target<small>Used when no target is chosen</small></span><Switch on={makeDefault} onChange={setMakeDefault} label="Default target" /></div>
        </div>
        {groups.map((g) => (
          <div key={g}>
            <div className="group-title">{g}</div>
            <div className="group">{schema.filter((s) => s.group === g).map(renderField)}</div>
          </div>
        ))}
        <div className="group-title">Run</div>
        <div className="group">
          <div className="form-row"><span className="lead">Threads<small>How many models dbt builds at once</small></span><Select label="Threads" value={Number(fields.threads ?? 4)} onChange={(v) => set("threads", v)} options={[1, 2, 4, 8, 16, 32].map((n) => ({ value: n, label: String(n) }))} /></div>
          {extra.map((k) => <div key={k} className="form-row"><span className="lead mono">{k}</span><Field value={typeof fields[k] === "object" ? JSON.stringify(fields[k]) : fields[k] ?? ""} onChange={(v) => set(k, v)} width={240} mono /></div>)}
        </div>
        <div className="hstack" style={{ gap: 8, marginTop: 16 }}>
          {!isNew && <Btn kind="destructive" onClick={() => setConfirmDel(true)}>Delete target</Btn>}
          <span className="spacer" />
          <Btn kind="prominent" busy={busy} onClick={save}>Save</Btn>
        </div>
        {!isNew && <div style={{ marginTop: 20 }}><DebugChecklist key={testKey} pid={pid} target={target} auto={false} /></div>}
      </section>
      <aside className="vstack" style={{ flex: "1 1 300px", maxWidth: 420, borderLeft: "1px solid var(--sep)", background: "var(--inspector-bg)" }} aria-label="profiles.yml preview">
        <div className="hstack" style={{ height: 34, padding: "0 14px", gap: 8, borderBottom: "1px solid var(--hairline)" }}><span className="upper grow">profiles.yml · what Save writes</span></div>
        <div className="vstack fill" style={{ minHeight: 200 }}><Editor path="profiles.yml" value={preview} readOnly theme={theme} fontSize={11.5} /></div>
        <p className="t-subhead c2" style={{ padding: "10px 16px 16px", lineHeight: "15px" }}>Marthouse keeps comments and other targets as they are, and saves a .bak copy first. Secret lines read an environment variable that Marthouse sets from {summary.secret_store === "keychain" ? "your Keychain" : "its encrypted store"} when it runs dbt.</p>
      </aside>
      <Alert open={confirmDel} icon="trash" title={`Delete the ${target} target?`} message="It's removed from profiles.yml. A .bak copy of the file is kept."
        actions={[{ label: "Delete", destructive: true, onClick: del }, { label: "Cancel", preferred: true, onClick: () => setConfirmDel(false) }]} />
    </>
  );
}
