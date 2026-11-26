import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, setWorkspaceId } from "../api";
import { I } from "../icons";
import { Page, SideItem } from "../components/Page";
import { useHello } from "../store";
import { Alert, Btn, Field, Select, Sheet, Spinner, TbBtn, errText, useToast } from "../ui";

const ROLES = [{ value: "viewer", label: "Viewer" }, { value: "member", label: "Member" }, { value: "admin", label: "Admin" }, { value: "owner", label: "Owner" }];

export function WorkspacePage() {
  const toast = useToast();
  const qc = useQueryClient();
  const hello = useHello();
  const ws = useQuery<any>({ queryKey: ["workspace"], queryFn: () => api("/api/workspace") });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [newWs, setNewWs] = useState<string | null>(null);
  const [remove, setRemove] = useState<any>(null);
  const [name, setName] = useState<string | null>(null);
  const w = ws.data;
  const admin = w && ["admin", "owner"].includes(w.role);
  const run = async (f: () => Promise<unknown>, ok?: string) => {
    try { await f(); if (ok) toast(ok); ws.refetch(); qc.invalidateQueries({ queryKey: ["hello"] }); } catch (e) { toast(errText(e), "error"); }
  };
  return (
    <Page title="Workspace" subtitle={w?.name}
      actions={<>
        {(hello.data?.workspaces?.length ?? 0) > 1 && (
          <Select label="Workspace" value={w?.id ?? ""} onChange={(id) => { setWorkspaceId(id); location.href = "/projects"; }} options={(hello.data?.workspaces ?? []).map((x) => ({ value: x.id, label: x.name }))} />
        )}
        <TbBtn icon="plus" label="New workspace" onClick={() => setNewWs("")} />
      </>}
      sidebar={<div className="sb-section">
        <div className="sb-header">Settings</div>
        <SideItem to="/settings?tab=general" icon="gear" label="General" />
        <SideItem to="/settings?tab=tools" icon="tools" label="Tools" />
        <SideItem icon="users" label="Workspace" on />
      </div>}>
      <div className="vstack" style={{ width: 860, maxWidth: "100%", gap: 4, padding: "18px 22px 32px" }}>
        {!w ? <Spinner /> : (
          <>
            <div className="hstack" style={{ gap: 10, alignItems: "baseline" }}>
              {name === null ? <h1 className="t-title1">{w.name}</h1> : <Field value={name} onChange={setName} xl width={320} autoFocus onEnter={() => run(() => api("/api/workspace", { method: "PATCH", body: { name } }), "Renamed").then(() => setName(null))} />}
              {admin && name === null && <Btn kind="borderless" size="sm" onClick={() => setName(w.name)}>Rename</Btn>}
            </div>
            <div className="group-title">Members</div>
            <div className="group" style={{ padding: 0 }}>
              {w.members.map((m: any) => (
                <div key={m.id} className="hstack" style={{ gap: 12, padding: "10px 14px", borderBottom: "1px solid var(--hairline)" }}>
                  <span style={{ width: 30, height: 30, borderRadius: "50%", background: "var(--accent-soft)", color: "var(--accent-text)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}><I n="user" /></span>
                  <span className="vstack grow"><b>{m.name || m.email}{m.you && <span className="c2" style={{ fontWeight: 400 }}> (you)</span>}</b><span className="t-subhead c2">{m.email}</span></span>
                  {admin && !m.you ? <Select label="Role" value={m.role} onChange={(r) => run(() => api(`/api/workspace/members/${m.id}`, { method: "PATCH", body: { role: r } }), "Role changed")} options={ROLES} /> : <span className="t-callout c2">{m.role[0].toUpperCase() + m.role.slice(1)}</span>}
                  {admin && !m.you && <Btn size="sm" kind="destructive" onClick={() => setRemove(m)}>Remove</Btn>}
                </div>
              ))}
              {admin && (
                <div className="hstack" style={{ gap: 8, padding: "10px 14px" }}>
                  <Field value={email} onChange={setEmail} placeholder="teammate@company.com" type="email" width={280} />
                  <Select label="Role" value={role} onChange={setRole} options={ROLES.filter((r) => r.value !== "owner" || w.role === "owner")} />
                  <Btn kind="tinted" disabled={!email} onClick={() => run(() => api("/api/workspace/members", { body: { email, role } }), `Added ${email}`).then(() => setEmail(""))}>Add member</Btn>
                </div>
              )}
            </div>
            <p className="t-subhead c2" style={{ padding: "8px 12px", lineHeight: "15px" }}>Viewers can browse and read docs. Members can edit and run. Admins manage connections, dbt installs and members. Owners can also add or remove owners.</p>
          </>
        )}
      </div>
      <Sheet open={newWs !== null} onClose={() => setNewWs(null)} label="New workspace" width={420}>
        <b className="t-title3">New workspace</b>
        <Field value={newWs ?? ""} onChange={setNewWs} placeholder="Name" autoFocus />
        <div className="acts"><Btn onClick={() => setNewWs(null)}>Cancel</Btn><Btn kind="prominent" disabled={!newWs} onClick={async () => { try { const r = await api("/api/workspaces", { body: { name: newWs } }); setWorkspaceId(r.id); location.href = "/projects"; } catch (e) { toast(errText(e), "error"); } }}>Create</Btn></div>
      </Sheet>
      <Alert open={!!remove} icon="users" title={`Remove ${remove?.email}?`} message="They lose access to this workspace's projects right away."
        actions={[{ label: "Remove", destructive: true, onClick: () => { const m = remove; setRemove(null); run(() => api(`/api/workspace/members/${m.id}`, { method: "DELETE" }), "Removed"); } }, { label: "Cancel", preferred: true, onClick: () => setRemove(null) }]} />
    </Page>
  );
}
