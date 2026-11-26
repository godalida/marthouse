import type { ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { AppMark, I, type IconName } from "../icons";
import { useProject, useSettings } from "../store";

/** App-level pages (Projects, Settings, Workspace, first-run setup) use the same sidebar + pane
 *  layout as a project, so they read as part of the app rather than a pop-up window. */
export function Page({ sidebar, title, subtitle, actions, children, back = true, footer }: {
  sidebar: ReactNode; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; back?: boolean; footer?: ReactNode;
}) {
  const nav = useNavigate();
  const settings = useSettings();
  const last = settings.data?.last_project;
  const lastProject = useProject(last || undefined);
  const home = last && lastProject.data ? `/p/${last}` : "/projects";
  return (
    <div className="app">
      <nav className="sidebar" aria-label="Sections">
        <div className="sidebar-top" style={{ paddingLeft: 16 }}>
          <span className="hstack" style={{ gap: 8, marginRight: "auto" }}><AppMark size={22} /><b style={{ fontSize: 13 }}>Marthouse</b></span>
        </div>
        {back && (
          <div style={{ padding: "0 14px 10px" }}>
            <button className="sb-item" style={{ width: "100%", paddingLeft: 8 }} onClick={() => nav(home)}>
              <I n="back" /><span className="trunc">{lastProject.data ? `Back to ${lastProject.data.name}` : "All projects"}</span>
            </button>
          </div>
        )}
        <div className="sidebar-list scroll">{sidebar}</div>
        {footer && <div className="sb-foot">{footer}</div>}
      </nav>
      <main className="pane">
        <header className="toolbar solo">
          <div className="title"><b>{title}</b>{subtitle && <small>{subtitle}</small>}</div>
          <div className="spacer" />
          {actions}
        </header>
        <div className="scroll fill" style={{ position: "relative" }}>{children}</div>
      </main>
    </div>
  );
}

export function SideItem({ to, icon, label, on, onClick, detail }: { to?: string; icon: IconName; label: string; on?: boolean; onClick?: () => void; detail?: ReactNode }) {
  const inner = <><I n={icon} /><span className="trunc">{label}</span>{detail ? <span className="detail">{detail}</span> : null}</>;
  if (to) return <NavLink to={to} className={({ isActive }) => `sb-item ${isActive || on ? "on" : ""}`}>{inner}</NavLink>;
  return <button className={`sb-item ${on ? "on" : ""}`} style={{ width: "100%" }} onClick={onClick}>{inner}</button>;
}
