import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ApiError } from "./api";
import { AppMark } from "./icons";
import { Shell, useShell } from "./Shell";
import { Login, Signup } from "./screens/Auth";
import { Catalog } from "./screens/Catalog";
import { Connections } from "./screens/Connections";
import { LineageGraph } from "./screens/Lineage";
import { Models } from "./screens/Models";
import { Builder } from "./screens/Builder";
import { Pipelines } from "./screens/Pipelines";
import { Projects } from "./screens/Projects";
import { Schedules } from "./screens/Schedules";
import { Sql } from "./screens/Sql";
import { RunDetail, Runs } from "./screens/Runs";
import { SettingsWindow } from "./screens/Settings";
import { Setup } from "./screens/Setup";
import { Sources } from "./screens/Sources";
import { Tests } from "./screens/Tests";
import { WorkspacePage } from "./screens/Workspace";
import { useHello, useSettings, useSystem, useTheme } from "./store";
import { Spinner } from "./ui";

export default function App() {
  const hello = useHello();
  const hosted = hello.data?.mode === "hosted";
  const authed = !!hello.data && (!hosted || hello.data.signed_in);
  const system = useSystem(authed);
  const settings = useSettings(authed);
  const theme = useTheme(settings.data?.appearance);
  const loc = useLocation();

  if (hello.isLoading || (authed && (system.isLoading || settings.isLoading))) {
    return <div className="mac app" data-theme={theme} style={{ alignItems: "center", justifyContent: "center" }}><Spinner /></div>;
  }
  if (hello.error) return <Blocked title="Marthouse isn't running" text="Start it again with the marthouse command, then reload this page." theme={theme} />;
  if (system.error instanceof ApiError && system.error.status === 401 && !hosted) {
    return <Blocked title="Open Marthouse from its link" text="For safety, Marthouse only answers the browser tab it opened. Run marthouse in Terminal and use the link it prints." theme={theme} />;
  }

  if (hosted && !hello.data!.signed_in) {
    return (
      <div className="mac" data-theme={theme}>
        <Routes>
          <Route path="/signup" element={<Signup />} />
          <Route path="*" element={<Login />} />
        </Routes>
      </div>
    );
  }

  const sys = system.data!;
  const home = !hosted && !sys.setup_done ? "/setup" : settings.data?.on_launch !== "projects" && settings.data?.last_project ? `/p/${settings.data.last_project}/models` : "/projects";

  return (
    <div className="mac" data-theme={theme}>
      <Routes>
        <Route path="/" element={<Navigate to={home} replace />} />
        <Route path="/setup/*" element={hosted ? <Navigate to="/projects" replace /> : <Setup />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/settings" element={<SettingsWindow />} />
        <Route path="/workspace" element={hosted ? <WorkspacePage /> : <Navigate to="/settings" replace />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/signup" element={<Navigate to="/" replace />} />
        <Route path="/p/:pid" element={<Shell />}>
          <Route index element={<ProjectHome />} />
          <Route path="models" element={<Models />} />
          <Route path="lineage" element={<LineageGraph />} />
          <Route path="runs" element={<Runs />} />
          <Route path="runs/:jid" element={<RunDetail />} />
          <Route path="tests" element={<Tests />} />
          <Route path="catalog" element={<Catalog />} />
          <Route path="sources" element={<Sources />} />
          <Route path="connections" element={<Connections />} />
          <Route path="pipelines" element={<Pipelines />} />
          <Route path="pipelines/:name" element={<Pipelines />} />
          <Route path="sql" element={<Sql />} />
          <Route path="build" element={<Builder />} />
          <Route path="schedules" element={<Schedules />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace state={{ from: loc.pathname }} />} />
      </Routes>
    </div>
  );
}

function ProjectHome() {
  const { project } = useShell();
  return <Navigate to={project.info?.has_dbt === false ? "pipelines" : "models"} replace />;
}

function Blocked({ title, text, theme }: { title: string; text: string; theme: string }) {
  return (
    <div className="mac auth" data-theme={theme}>
      <div className="auth-card" style={{ alignItems: "center", textAlign: "center" }}>
        <AppMark size={56} />
        <b className="t-title2">{title}</b>
        <p className="c2" style={{ lineHeight: "18px" }}>{text}</p>
        <pre className="console" style={{ borderRadius: 8, width: "100%", textAlign: "left" }}>marthouse</pre>
      </div>
    </div>
  );
}
