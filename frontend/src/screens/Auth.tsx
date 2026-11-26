import { useState } from "react";
import { Link } from "react-router-dom";
import { api, setWorkspaceId } from "../api";
import { AppMark } from "../icons";
import { Btn, Field, errText } from "../ui";

function Card({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="auth">
      <form className="auth-card" onSubmit={(e) => e.preventDefault()}>
        <div className="vstack" style={{ alignItems: "center", gap: 10, textAlign: "center", marginBottom: 4 }}>
          <AppMark size={52} />
          <b className="t-title2">{title}</b>
          <span className="c2 t-callout">{sub}</span>
        </div>
        {children}
      </form>
    </div>
  );
}

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setErr("");
    try {
      await api("/api/auth/login", { body: { email, password } });
      setWorkspaceId(null);
      location.href = "/";
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };
  return (
    <Card title="Sign in to Marthouse" sub="Load, transform and explore your data from the browser.">
      <label className="vstack" style={{ gap: 6 }}><span className="t-callout c2">Email</span><Field xl value={email} onChange={setEmail} type="email" name="email" autoFocus /></label>
      <label className="vstack" style={{ gap: 6 }}><span className="t-callout c2">Password</span><Field xl value={password} onChange={setPassword} type="password" name="password" onEnter={go} /></label>
      {err && <span className="t-callout" style={{ color: "var(--red)" }}>{err}</span>}
      <Btn kind="prominent" size="xl" type="submit" busy={busy} disabled={!email || !password} onClick={go}>Sign in</Btn>
      <span className="t-callout c2" style={{ textAlign: "center" }}>New here? <Link to="/signup" className="ca">Create an account</Link></span>
    </Card>
  );
}

export function Signup() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await api("/api/auth/signup", { body: { name, email, password, workspace } });
      setWorkspaceId(r.workspace);
      location.href = "/projects";
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };
  return (
    <Card title="Create your account" sub="Free for one project. No card needed.">
      <label className="vstack" style={{ gap: 6 }}><span className="t-callout c2">Your name</span><Field xl value={name} onChange={setName} name="name" autoFocus /></label>
      <label className="vstack" style={{ gap: 6 }}><span className="t-callout c2">Work email</span><Field xl value={email} onChange={setEmail} type="email" name="email" /></label>
      <label className="vstack" style={{ gap: 6 }}><span className="t-callout c2">Password</span><Field xl value={password} onChange={setPassword} type="password" name="new-password" placeholder="At least 10 characters" /></label>
      <label className="vstack" style={{ gap: 6 }}><span className="t-callout c2">Team or company</span><Field xl value={workspace} onChange={setWorkspace} placeholder="Acme analytics" onEnter={go} /></label>
      {err && <span className="t-callout" style={{ color: "var(--red)" }}>{err}</span>}
      <Btn kind="prominent" size="xl" type="submit" busy={busy} disabled={!email || password.length < 10} onClick={go}>Create account</Btn>
      <span className="t-callout c2" style={{ textAlign: "center" }}>Already have an account? <Link to="/login" className="ca">Sign in</Link></span>
    </Card>
  );
}
