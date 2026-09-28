import { useState, type ReactNode } from "react";
import { formatDuration, type JobStatus } from "@sorocron/sdk";
import { NETWORK } from "./useRegistry";

const STATUS_LABEL: Record<JobStatus, string> = {
  due: "Due now",
  scheduled: "Scheduled",
  underfunded: "Needs funds",
  paused: "Paused",
  expired: "Expired",
  completed: "Completed",
};

export function StatusPill({ status }: { status: JobStatus }) {
  return <span className={`pill pill-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function short(address: string): string {
  return address.length > 12 ? `${address.slice(0, 5)}…${address.slice(-4)}` : address;
}

/** Shortened address linking to the explorer, with a copy button. */
export function Addr({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const kind = value.startsWith("C") ? "contract" : "account";
  return (
    <span className="addr">
      <a href={`${NETWORK.explorer}/${kind}/${value}`} target="_blank" rel="noreferrer" title={value}>
        {label ?? short(value)}
      </a>
      <button
        type="button"
        className="copy"
        aria-label="Copy address"
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1_200);
        }}
      >
        {copied ? "✓" : "⧉"}
      </button>
    </span>
  );
}

/** "in 4m 10s" / "12m ago" relative to `now` (unix seconds). */
export function relative(at: bigint, now: bigint): string {
  if (at === now) return "now";
  return at > now ? `in ${formatDuration(at - now)}` : `${formatDuration(now - at)} ago`;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export interface Toast {
  id: number;
  kind: "ok" | "err" | "info";
  text: string;
  hash?: string;
}

export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <span>{t.text}</span>
          {t.hash && (
            <a href={`${NETWORK.explorer}/tx/${t.hash}`} target="_blank" rel="noreferrer">
              View transaction
            </a>
          )}
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
