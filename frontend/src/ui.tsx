import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Chev, I, type IconName } from "./icons";

type BtnKind = "prominent" | "tinted" | "borderless" | "destructive" | undefined;

export function Btn({ kind, size, icon, children, busy, disabled, onClick, title, type = "button", className = "", style }: {
  kind?: BtnKind; size?: "sm" | "lg" | "xl"; icon?: IconName; children?: ReactNode; busy?: boolean; disabled?: boolean;
  onClick?: (e: React.MouseEvent) => void; title?: string; type?: "button" | "submit"; className?: string; style?: React.CSSProperties;
}) {
  return (
    <button type={type} title={title} className={`btn ${kind ?? ""} ${size ?? ""} ${disabled || busy ? "disabled" : ""} ${className}`} style={style}
      disabled={disabled || busy} onClick={onClick}>
      {busy ? <Spinner /> : icon ? <I n={icon} /> : null}
      {children}
    </button>
  );
}

export function TbBtn({ icon, label, onClick, prominent, busy, disabled, title, children }: {
  icon?: IconName; label?: string; onClick?: () => void; prominent?: boolean; busy?: boolean; disabled?: boolean; title?: string; children?: ReactNode;
}) {
  if (!label && !children) {
    return (
      <button className="glass tb-btn" aria-label={title} title={title} onClick={onClick} disabled={disabled} style={disabled ? { opacity: 0.4 } : undefined}>
        {icon && <I n={icon} />}
      </button>
    );
  }
  return (
    <button className={`tb-text ${prominent ? "prominent" : "glass"}`} onClick={onClick} disabled={disabled || busy} title={title}
      style={disabled ? { opacity: 0.45 } : undefined}>
      {busy ? <Spinner light={prominent} /> : icon ? <I n={icon} /> : null}
      {label}
      {children}
    </button>
  );
}

export function Spinner({ light }: { light?: boolean }) {
  return <span className={`spin ${light ? "light" : ""}`} aria-label="Working" />;
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? "on" : ""} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Select<T extends string | number>({ value, options, onChange, label, width, disabled }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label?: string; width?: number | string; disabled?: boolean;
}) {
  return (
    <span className="popup select-wrap" style={{ width, opacity: disabled ? 0.5 : 1 }}>
      <select aria-label={label} value={String(value)} disabled={disabled}
        onChange={(e) => {
          const o = options.find((x) => String(x.value) === e.target.value);
          if (o) onChange(o.value);
        }}>
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
        ))}
      </select>
      <span className="trunc">{options.find((o) => o.value === value)?.label ?? String(value)}</span>
      <Chev />
    </span>
  );
}

export function Field({ value, onChange, placeholder, mono, width, type = "text", invalid, label, onEnter, autoFocus, xl, icon, readOnly, name }: {
  value: string | number; onChange?: (v: string) => void; placeholder?: string; mono?: boolean; width?: number | string; type?: string;
  invalid?: boolean; label?: string; onEnter?: () => void; autoFocus?: boolean; xl?: boolean; icon?: IconName; readOnly?: boolean; name?: string;
}) {
  return (
    <span className={`field ${xl ? "xl" : ""} ${invalid ? "error" : ""}`} style={{ width }}>
      {icon && <I n={icon} className="c2" />}
      <input aria-label={label ?? placeholder} value={value} type={type} placeholder={placeholder} autoFocus={autoFocus} readOnly={readOnly} name={name}
        className={mono ? "mono" : ""} style={mono ? { fontSize: 12 } : undefined} spellCheck={false}
        onChange={(e) => onChange?.(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onEnter?.()} />
    </span>
  );
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button className={`switch ${on ? "on" : ""}`} role="switch" aria-checked={on} aria-label={label} disabled={disabled} style={disabled ? { opacity: 0.4 } : undefined} onClick={() => onChange(!on)} />;
}

export function Check({ on, onChange, label }: { on: boolean; onChange?: (v: boolean) => void; label?: string }) {
  return (
    <span className={`check ${on ? "on" : ""}`} role="checkbox" aria-checked={on} aria-label={label} tabIndex={onChange ? 0 : -1}
      onClick={(e) => { e.stopPropagation(); onChange?.(!on); }} onKeyDown={(e) => e.key === " " && onChange?.(!on)}>
      {on && <I n="check" />}
    </span>
  );
}

export function Radio({ on }: { on: boolean }) {
  return <span className={`radio ${on ? "on" : ""}`} role="radio" aria-checked={on} />;
}

export function Row({ label, hint, children, htmlFor }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; htmlFor?: string }) {
  return (
    <div className="form-row">
      <label className="lead" htmlFor={htmlFor}>
        {label}
        {hint && <small>{hint}</small>}
      </label>
      {children}
    </div>
  );
}

const ST: Record<string, { cls: string; icon: IconName; label: string }> = {
  success: { cls: "pass", icon: "check", label: "OK" },
  pass: { cls: "pass", icon: "check", label: "Pass" },
  fresh: { cls: "pass", icon: "check", label: "Fresh" },
  works: { cls: "pass", icon: "check", label: "Works" },
  error: { cls: "error", icon: "x", label: "Error" },
  "runtime error": { cls: "error", icon: "x", label: "Error" },
  fail: { cls: "error", icon: "x", label: "Fail" },
  warn: { cls: "warn", icon: "warn", label: "Warn" },
  skipped: { cls: "skip", icon: "minus", label: "Skipped" },
  "no-op": { cls: "skip", icon: "minus", label: "No-op" },
  none: { cls: "skip", icon: "minus", label: "No check" },
  cancelled: { cls: "skip", icon: "minus", label: "Stopped" },
  running: { cls: "run", icon: "play", label: "Running" },
  started: { cls: "run", icon: "play", label: "Running" },
  executing: { cls: "run", icon: "play", label: "Running" },
  compiling: { cls: "run", icon: "play", label: "Compiling" },
  queued: { cls: "queued", icon: "clock", label: "Queued" },
};

export function Status({ s, label }: { s?: string | null; label?: string }) {
  const m = ST[s ?? ""] ?? { cls: "skip", icon: "minus" as IconName, label: s ? s : "Not run" };
  return (
    <span className={`st ${m.cls}`}>
      {m.cls === "run" ? <Spinner /> : <I n={m.icon} />}
      {label ?? m.label}
    </span>
  );
}

export function dotClass(s?: string | null): string {
  const m = ST[s ?? ""];
  if (!m) return "idle";
  return m.cls === "skip" || m.cls === "queued" ? "idle" : m.cls;
}

export function Sheet({ open, onClose, children, width = 560, label }: { open: boolean; onClose: () => void; children: ReactNode; width?: number; label: string }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="mac overlay-root" data-theme={document.documentElement.dataset.theme}>
      <div className="dim" style={{ position: "fixed" }} onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label} style={{ width, maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100vh - 48px)", overflow: "auto" }}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Alert({ open, icon = "warn", title, message, actions }: {
  open: boolean; icon?: IconName; title: string; message?: ReactNode;
  actions: { label: string; onClick: () => void; preferred?: boolean; destructive?: boolean }[];
}) {
  if (!open) return null;
  return createPortal(
    <div className="mac overlay-root" data-theme={document.documentElement.dataset.theme}>
      <div className="dim" style={{ position: "fixed" }} />
      <div className="glass-lg alert" role="alertdialog" aria-label={title}>
        <div className="msg">
          <I n={icon} size={40} className="c2" />
          <b>{title}</b>
          {message && <span className="c2 t-callout" style={{ lineHeight: "17px" }}>{message}</span>}
        </div>
        <div className={`acts ${actions.length > 2 ? "stack" : ""}`}>
          {actions.map((a) => (
            <button key={a.label} className={a.preferred ? "preferred" : ""} style={a.destructive ? { color: "var(--red)" } : undefined} onClick={a.onClick}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function Banner({ tone = "accent", icon, children, action }: { tone?: "accent" | "warn" | "error" | "neutral"; icon?: IconName; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`banner ${tone}`} role="status">
      <I n={icon ?? (tone === "warn" ? "warn" : tone === "error" ? "x" : "info")} size={14} />
      <span className="grow">{children}</span>
      {action}
    </div>
  );
}

export function Callout({ tone = "warn", icon, title, children, action }: { tone?: "warn" | "error" | "accent"; icon?: IconName; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={`callout ${tone}`} role="status">
      <span className={`st ${tone === "accent" ? "run" : tone}`}><I n={icon ?? (tone === "error" ? "x" : tone === "accent" ? "info" : "warn")} size={18} /></span>
      <span className="grow t-callout" style={{ lineHeight: "17px" }}><b>{title}</b> {children && <span className="c2">{children}</span>}</span>
      {action}
    </div>
  );
}

export function Empty({ icon, title, children, actions, height }: { icon: IconName; title: string; children?: ReactNode; actions?: ReactNode; height?: number | string }) {
  return (
    <div className="empty" style={{ height }}>
      <I n={icon} size={40} className="c3" />
      <b className="t-title3">{title}</b>
      {children && <p className="c2 t-callout" style={{ maxWidth: 320, lineHeight: "17px" }}>{children}</p>}
      {actions && <div className="hstack" style={{ gap: 8, marginTop: 4 }}>{actions}</div>}
    </div>
  );
}

export function Console({ lines, style, follow = true, empty }: { lines: { text: string; level: string }[]; style?: React.CSSProperties; follow?: boolean; empty?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (el && follow && stuck) el.scrollTop = el.scrollHeight;
  }, [lines.length, follow, stuck]);
  const cls: Record<string, string> = { err: "err", wrn: "wrn", ok: "ok", hi: "hi" };
  return (
    <div ref={ref} className="console" style={style} onScroll={(e) => {
      const el = e.currentTarget;
      setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
    }}>
      {lines.length === 0 && <span className="c3">{empty ?? "No output yet."}</span>}
      {lines.map((l, i) => (
        <div key={i} className={cls[l.level] ?? ""}>{l.text || " "}</div>
      ))}
    </div>
  );
}

export function Steps({ steps }: { steps: { label: string; state: "done" | "now" | "todo" | "error"; detail?: ReactNode }[] }) {
  return (
    <div className="steps">
      {steps.map((s, i) => (
        <div key={i} className={`step ${s.state === "done" ? "done" : s.state === "now" ? "now" : ""}`} style={s.state === "error" ? { color: "var(--red)" } : undefined}>
          <span className="ring" style={s.state === "error" ? { background: "var(--red)", boxShadow: "none", color: "#fff" } : undefined}>
            {s.state === "done" && <I n="check" />}
            {s.state === "error" && <I n="x" />}
            {s.state === "now" && <Spinner />}
          </span>
          <span className="grow">{s.label}</span>
          {s.detail && <span className="t-subhead c2">{s.detail}</span>}
        </div>
      ))}
    </div>
  );
}

export function Popover({ open, onClose, children, align = "left", width, style }: { open: boolean; onClose: () => void; children: ReactNode; align?: "left" | "right"; width?: number; style?: React.CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    setTimeout(() => document.addEventListener("mousedown", h));
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} className="menu popmenu" style={{ [align]: 0, width, ...style }} role="menu">
      {children}
    </div>
  );
}

export function MenuItem({ icon, children, onClick, keys, sel, disabled }: { icon?: IconName; children: ReactNode; onClick?: () => void; keys?: string; sel?: boolean; disabled?: boolean }) {
  return (
    <button className={`menu-item ${sel ? "sel" : ""} ${disabled ? "dis" : ""}`} role="menuitem" onClick={disabled ? undefined : onClick} style={{ width: "100%" }}>
      {icon && <I n={icon} size={14} />}
      <span className="grow trunc" style={{ textAlign: "left" }}>{children}</span>
      {keys && <span className="key">{keys}</span>}
    </button>
  );
}

// ---------- toasts ----------
type Toast = { id: number; text: string; tone: "info" | "error" };
const ToastCtx = createContext<(text: string, tone?: "info" | "error") => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: "info" | "error" = "info") => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === "error" ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast glass-lg ${t.tone}`}>
            <I n={t.tone === "error" ? "warn" : "check"} size={14} />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

export function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const d = /^duckdb_mismatch:([^:]+):(.+)$/.exec(m);
  if (d) return `dbt uses DuckDB ${d[1]} and dlt uses DuckDB ${d[2]}, so they can't share the same database file. Open the pipeline to match them.`;
  return m;
}
