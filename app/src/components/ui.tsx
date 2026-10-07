import { createContext, useCallback, useContext, useId, useState, type ReactNode } from "react";
import { formatDuration, type JobStatus } from "@sorocron/sdk";
import { NETWORK } from "../state/registry";
import { Icon, type IconName } from "./Icon";

// ---------------------------------------------------------------- buttons

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  size,
  icon,
  children,
  className,
  ...props
}: {
  variant?: ButtonVariant;
  size?: "sm";
  icon?: IconName;
  children?: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`btn btn-${variant} ${size ? `btn-${size}` : ""} ${className ?? ""}`}
      {...props}
    >
      {icon && <Icon name={icon} size={16} />}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- fields

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className={`field ${error ? "has-error" : ""}`}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? <span className="field-error">{error}</span> : hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

export function TextInput({
  value,
  onChange,
  mono,
  suffix,
  id,
  ...props
}: {
  value: string;
  onChange: (value: string) => void;
  mono?: boolean;
  suffix?: string;
  id?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value">) {
  const fallback = useId();
  return (
    <div className={`input-wrap ${suffix ? "has-suffix" : ""}`}>
      <input
        id={id ?? fallback}
        className={`input ${mono ? "mono" : ""}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        {...props}
      />
      {suffix && <span className="input-suffix">{suffix}</span>}
    </div>
  );
}

/** Tabs-like single choice, replacing radio buttons. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; count?: number; disabled?: boolean }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          disabled={o.disabled}
          className={value === o.value ? "active" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count !== undefined && <span className="count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Accessible on/off switch, replacing the checkbox. */
export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="switch-row" onClick={() => onChange(!checked)}>
      <span className={`switch ${checked ? "on" : ""}`} aria-hidden="true">
        <span />
      </span>
      {label}
    </button>
  );
}

/** Expandable section, replacing <details>. */
export function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className={`disclosure ${open ? "open" : ""}`}>
      <button type="button" className="disclosure-head" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <Icon name={open ? "minus" : "plus"} size={16} />
        {title}
      </button>
      {open && (
        <div className="disclosure-body" id={id}>
          {children}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- display

const STATUS: Record<JobStatus, { label: string; tone: string }> = {
  due: { label: "Due", tone: "green" },
  scheduled: { label: "Scheduled", tone: "blue" },
  underfunded: { label: "Needs funds", tone: "yellow" },
  paused: { label: "Paused", tone: "gray" },
  failing: { label: "Failing", tone: "red" },
  expired: { label: "Expired", tone: "red" },
  completed: { label: "Completed", tone: "gray" },
};

export function StatusBadge({ status }: { status: JobStatus }) {
  const s = STATUS[status];
  return <span className={`badge badge-${s.tone}`}>{s.label}</span>;
}

export function Badge({ tone, children }: { tone: "green" | "blue" | "yellow" | "red" | "gray"; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function short(address: string, head = 4, tail = 4): string {
  return address.length > head + tail + 1 ? `${address.slice(0, head)}…${address.slice(-tail)}` : address;
}

/** Shortened address linking to the explorer, with a copy button. */
export function Address({ value, full = false }: { value: string; full?: boolean }) {
  const [copied, setCopied] = useState(false);
  const kind = value.startsWith("C") ? "contract" : "account";
  return (
    <span className="address">
      <a href={`${NETWORK.explorer}/${kind}/${value}`} target="_blank" rel="noreferrer">
        {full ? value : short(value, 6, 6)}
      </a>
      <button
        type="button"
        className="icon-btn icon-btn-xs"
        aria-label={copied ? "Copied" : "Copy address"}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1_400);
          });
        }}
      >
        <Icon name={copied ? "check" : "copy"} size={13} />
      </button>
    </span>
  );
}

/** "in 4m 10s" / "12m ago" relative to `now` (unix seconds). */
export function relative(at: bigint, now: bigint): string {
  if (at === now) return "now";
  return at > now ? `in ${formatDuration(at - now)}` : `${formatDuration(now - at)} ago`;
}

export function Stat({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: ReactNode; icon?: IconName }) {
  return (
    <div className="stat">
      <div className="stat-label">
        {icon && <Icon name={icon} size={15} />}
        {label}
      </div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Card({ title, action, children, className }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ""}`}>
      {(title || action) && (
        <header className="card-head">
          {title && <h3>{title}</h3>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <span style={{ transform: `scaleX(${pct / 100})` }} />
    </div>
  );
}

export function Empty({ icon = "jobs", title, children, action }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={20} />
      </span>
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
      {action}
    </div>
  );
}

export function Skeleton({ rows = 3, height = 52 }: { rows?: number; height?: number }) {
  return (
    <div className="skeleton-list" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height }} />
      ))}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  hideActionsOnMobile = false,
}: {
  eyebrow?: ReactNode;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** For actions that phones reach another way (tab bar, sticky action bar). */
  hideActionsOnMobile?: boolean;
}) {
  return (
    <header className="page-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className={`page-actions ${hideActionsOnMobile ? "desktop-only" : ""}`}>{actions}</div>}
    </header>
  );
}

// ---------------------------------------------------------------- toasts

interface Toast {
  id: number;
  tone: "ok" | "err";
  text: string;
}

const ToastContext = createContext<(tone: Toast["tone"], text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast["tone"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((all) => [...all.slice(-2), { id, tone, text }]);
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), 5_000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <Icon name={t.tone === "ok" ? "check" : "alert"} size={16} />
            <span>{t.text}</span>
            <button type="button" className="icon-btn icon-btn-xs" aria-label="Dismiss" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
              <Icon name="close" size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
