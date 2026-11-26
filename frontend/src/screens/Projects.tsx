import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, fmt } from "../api";
import { I } from "../icons";
import { Page, SideItem } from "../components/Page";
import { useHello, useSystem, type Project } from "../store";
import { Btn, Empty, Field, Seg, Sheet, Spinner, TbBtn, errText, useToast } from "../ui";
import { OpenProjectBody } from "./Setup";

export function Projects() {
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const hello = useHello();
  const sys = useSystem();
  const hosted = hello.data?.mode === "hosted";
  const list = useQuery<Project[]>({ queryKey: ["projects"], queryFn: () => api("/api/projects") });
  const [sheet, setSheet] = useState<"" | "open" | "new" | "clone">("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"dbt" | "pipelines">("dbt");
  const [parent, setParent] = useState("~/code");
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [token, setToken] = useState("");
  const [subdir, setSubdir] = useState("");
  const [busy, setBusy] = useState(false);
  const opened = (id: string) => { qc.invalidateQueries({ queryKey: ["projects"] }); nav(`/p/${id}/models`); };

  const create = async () => {
    setBusy(true);
    try { opened((await api("/api/projects/new", { body: { name, parent, kind } })).id); } catch (e) { toast(errText(e), "error"); } finally { setBusy(false); }
  };
  const clone = async () => {
    setBusy(true);
    try { opened((await api("/api/projects/clone", { body: { url, branch, token, parent, subdir } })).id); } catch (e) { toast(errText(e), "error"); } finally { setBusy(false); }
  };
  const forget = async (p: Project) => {
    try {
      await api(`/api/projects/${p.id}`, { method: "DELETE" });
      qc.invalidateQueries({ queryKey: ["projects"] });
      toast(hosted ? `${p.name} was deleted.` : `${p.name} was removed from the list. Its files are untouched.`);
    } catch (e) { toast(errText(e), "error"); }
  };
  const wsName = hello.data?.workspaces?.find((w) => w.id === sys.data?.workspace)?.name;

  return (
    <Page back={false} title="Projects" subtitle={wsName ? `${wsName} · Marthouse ${hello.data?.version}` : `Marthouse ${hello.data?.version}`}
      actions={<>
        {!hosted && <TbBtn icon="folder" label="Open…" onClick={() => setSheet("open")} />}
        <TbBtn icon="branch" label="Clone…" onClick={() => setSheet("clone")} />
        <TbBtn icon="plus" label="New project" prominent onClick={() => setSheet("new")} />
      </>}
      sidebar={<>
        <div className="sb-section">
          <div className="sb-header">Marthouse</div>
          <SideItem icon="folder" label="Projects" on detail={list.data?.length || null} />
        </div>
        <div className="sb-section">
          <div className="sb-header">Environment</div>
          <SideItem to="/settings?tab=tools" icon="tools" label="Tools" />
          <SideItem to="/settings" icon="gear" label="Settings" />
          {hosted && <SideItem to="/workspace" icon="users" label="Workspace" />}
        </div>
      </>}>
      <div className="vstack" style={{ padding: "18px 22px 28px", gap: 12, maxWidth: 1100 }}>
        {list.isLoading && <Spinner />}
        {list.data?.length === 0 && (
          <Empty icon="folder" title="No projects yet" actions={<>{!hosted && sys.data?.example && <Btn onClick={() => setSheet("open")}>Open the example</Btn>}<Btn kind="prominent" onClick={() => setSheet("new")}>New project</Btn></>}>
            {hosted ? "Clone a dbt project from GitHub, GitLab or any Git host, or start a new one." : "Open a folder that has a dbt project or dlt pipelines, or start a new one."}
          </Empty>
        )}
        {!!list.data?.length && (
          <div className="tbl">
            <div className="table-head"><span className="grow">Name</span><span style={{ width: 300 }}>Location</span><span style={{ width: 90 }}>Models</span><span style={{ width: 130 }}>Branch</span><span style={{ width: 100 }}>Opened</span><span style={{ width: 28 }} /></div>
            <div className="zebra">
              {list.data.map((p) => (
                <div key={p.id} className="list-row click" style={{ cursor: "pointer", minHeight: 40 }} onClick={() => p.exists && !p.error ? nav(`/p/${p.id}`) : toast(p.error ?? "The folder is missing.", "error")}>
                  <span className="grow hstack" style={{ gap: 8, minWidth: 0 }}><I n="folder" className="ca" /><b className="trunc">{p.name}</b></span>
                  <span style={{ width: 300 }} className="t-callout c2 trunc" title={p.path || p.git_url}>{!p.exists ? <span style={{ color: "var(--red)" }}>Folder missing</span> : p.error ? <span style={{ color: "var(--red)" }}>{p.error}</span> : (p.path ? p.path.replace(/^\/Users\/[^/]+/, "~") : p.git_url)}</span>
                  <span style={{ width: 90 }} className="t-callout c2 cell-num">{p.n_models ?? "—"}</span>
                  <span style={{ width: 130 }} className="t-callout c2 trunc">{p.branch && p.branch !== "HEAD" ? p.branch : "—"}</span>
                  <span style={{ width: 100 }} className="t-callout c2">{fmt.ago(p.last_opened)}</span>
                  <span style={{ width: 28 }}><button className="btn sm borderless" title={hosted ? "Delete" : "Remove from list (files stay)"} aria-label={hosted ? `Delete ${p.name}` : `Remove ${p.name} from the list`} onClick={(e) => { e.stopPropagation(); forget(p); }}><I n="x" size={14} /></button></span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <Sheet open={sheet === "open"} onClose={() => setSheet("")} label="Open a project" width={600}>
        <b className="t-title2">Open a project</b>
        <OpenProjectBody onOpened={opened} />
        <div className="acts"><Btn onClick={() => setSheet("")}>Cancel</Btn></div>
      </Sheet>

      <Sheet open={sheet === "new"} onClose={() => setSheet("")} label="New project" width={500}>
        <b className="t-title2">New project</b>
        <Seg label="Kind" value={kind} onChange={setKind} options={[{ value: "dbt", label: "Load and transform (dlt + dbt)" }, { value: "pipelines", label: "Load only (dlt)" }]} />
        <p className="c2 t-callout" style={{ lineHeight: "17px" }}>{kind === "dbt" ? "Marthouse creates the folders dbt expects (models/staging, models/marts, seeds, macros, tests, snapshots) and a pipelines folder for dlt." : "A folder for dlt pipelines only. You can add a dbt project to it later."}</p>
        <div className="group">
          <div className="form-row"><span className="lead">Name<small>Lowercase letters, numbers and _</small></span><Field value={name} onChange={(v) => setName(v.toLowerCase().replace(/[^a-z0-9_]/g, "_"))} placeholder="analytics" mono width={220} autoFocus /></div>
          {!hosted && <div className="form-row"><span className="lead">Location</span><Field value={parent} onChange={setParent} mono width={220} /></div>}
        </div>
        <div className="acts"><Btn onClick={() => setSheet("")}>Cancel</Btn><Btn kind="prominent" disabled={!name} busy={busy} onClick={create}>Create</Btn></div>
      </Sheet>

      <Sheet open={sheet === "clone"} onClose={() => setSheet("")} label="Clone from Git" width={540}>
        <b className="t-title2">Clone from Git</b>
        <div className="group">
          <div className="form-row"><span className="lead">Repository URL</span><Field value={url} onChange={setUrl} placeholder="https://github.com/acme/analytics.git" mono width={300} autoFocus /></div>
          <div className="form-row"><span className="lead">Branch<small>Leave empty for the default branch</small></span><Field value={branch} onChange={setBranch} placeholder="main" mono width={180} /></div>
          <div className="form-row"><span className="lead">Folder in the repo<small>Only if dbt_project.yml isn't at the top</small></span><Field value={subdir} onChange={setSubdir} placeholder="transform" mono width={180} /></div>
          <div className="form-row"><span className="lead">Access token<small>For private repositories. {hosted ? "Stored encrypted." : "Stored in the Keychain."}</small></span><Field value={token} onChange={setToken} type="password" width={220} /></div>
          {!hosted && <div className="form-row"><span className="lead">Clone into</span><Field value={parent} onChange={setParent} mono width={220} /></div>}
        </div>
        <div className="acts"><Btn onClick={() => setSheet("")}>Cancel</Btn><Btn kind="prominent" disabled={!url} busy={busy} onClick={clone}>Clone</Btn></div>
      </Sheet>
    </Page>
  );
}
