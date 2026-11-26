// Small fetch wrapper. Every state-changing call carries X-Marthouse: 1 (the server rejects
// requests without it, which blocks cross-site form posts). Hosted mode adds the workspace.
import { useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function workspaceId(): string | null {
  return localStorage.getItem("marthouse.ws");
}
export function setWorkspaceId(id: string | null) {
  if (id) localStorage.setItem("marthouse.ws", id);
  else localStorage.removeItem("marthouse.ws");
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; query?: Record<string, string | number | undefined | null> } = {}): Promise<T> {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { "X-Marthouse": "1" };
  const ws = workspaceId();
  if (ws) headers["X-Workspace"] = ws;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(url, { method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, credentials: "same-origin" });
  if (!r.ok) {
    let msg = r.statusText;
    try {
      const j = await r.json();
      msg = typeof j.detail === "string" ? j.detail : Array.isArray(j.detail) ? j.detail.map((d: any) => d.msg).join(", ") : msg;
    } catch {}
    throw new ApiError(r.status, msg);
  }
  const ct = r.headers.get("content-type") ?? "";
  return (ct.includes("json") ? r.json() : r.text()) as Promise<T>;
}

export type JobEvent =
  | { type: "line"; text: string; level: string }
  | { type: "node"; id: string; node: NodeRun }
  | { type: "step"; index: number; state: string; label?: string }
  | { type: "status"; status: string; result?: any; nodes?: Record<string, NodeRun> };

export type NodeRun = { name?: string; type?: string; status?: string; started?: string; finished?: string | null; time?: number; message?: string; failures?: number };

export type JobState = {
  status: string;
  lines: { text: string; level: string }[];
  nodes: Record<string, NodeRun>;
  steps: Record<number, string>;
  result?: any;
};

/** Follows a job over its WebSocket and keeps the full state (works for finished jobs too). */
export function useJob(jobId: string | null | undefined, onDone?: (s: JobState) => void): JobState | null {
  const [state, setState] = useState<JobState | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!jobId) {
      setState(null);
      return;
    }
    let cur: JobState = { status: "queued", lines: [], nodes: {}, steps: {} };
    setState(cur);
    let closed = false;
    let timer: number | undefined;
    const flush = () => {
      timer = undefined;
      if (!closed) setState({ ...cur, lines: cur.lines.slice(), nodes: { ...cur.nodes } });
    };
    const schedule = () => {
      if (timer === undefined) timer = window.setTimeout(flush, 60);
    };
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = new WebSocket(`${proto}://${location.host}/api/jobs/${jobId}/ws`);
    sock.onmessage = (m) => {
      const ev = JSON.parse(m.data) as JobEvent & { replay?: boolean };
      if (ev.type === "line") cur.lines.push({ text: ev.text, level: ev.level });
      else if (ev.type === "node") cur.nodes[ev.id] = ev.node;
      else if (ev.type === "step") cur.steps[ev.index] = ev.state;
      else if (ev.type === "status") {
        cur.status = ev.status;
        if (ev.nodes) cur.nodes = { ...ev.nodes };
        if (ev.result) cur.result = ev.result;
        if (["success", "error", "cancelled"].includes(ev.status)) {
          const finish = async () => {
            if ((ev as any).replay || cur.lines.length === 0) {
              try {
                const j = await api(`/api/jobs/${jobId}`);
                cur.lines = j.log;
                cur.nodes = j.nodes ?? cur.nodes;
                cur.result = j.result;
                j.steps.forEach((_: unknown, i: number) => (cur.steps[i] = cur.steps[i] ?? (ev.status === "success" ? "done" : "error")));
              } catch {}
            }
            flush();
            done.current?.(cur);
          };
          finish();
          return;
        }
      }
      schedule();
    };
    sock.onerror = async () => {
      try {
        const j = await api(`/api/jobs/${jobId}`);
        cur = { status: j.status, lines: j.log, nodes: j.nodes ?? {}, steps: {}, result: j.result };
        flush();
      } catch {}
    };
    return () => {
      closed = true;
      sock.close();
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);
  return state;
}

/** Timestamps from the API may lack a zone (SQLite); they are UTC. */
export function ts(iso?: string | null): number {
  if (!iso) return NaN;
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z");
}

export const fmt = {
  ago(iso?: string | null): string {
    if (!iso) return "never";
    const t = ts(iso);
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 45) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  },
  time(iso?: string | null): string {
    if (!iso) return "—";
    const d = new Date(ts(iso));
    const today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  },
  dur(s?: number | null): string {
    if (s === undefined || s === null) return "—";
    if (s < 1) return `${Math.round(s * 1000)} ms`;
    if (s < 60) return `${s.toFixed(1)} s`;
    return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  },
  age(s?: number | null): string {
    if (s === undefined || s === null) return "—";
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} minutes`;
    if (s < 172800) return `${+(s / 3600).toFixed(s < 36000 ? 1 : 0)} hours`;
    return `${(s / 86400).toFixed(1)} days`;
  },
};
