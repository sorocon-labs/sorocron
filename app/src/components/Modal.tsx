import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Sent } from "@sorocron/sdk";
import { describe, NETWORK, useRegistry } from "../state/registry";
import { Icon } from "./Icon";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Dialog with a focus trap, Escape to close, scroll lock and focus
 * restoration. `locked` prevents dismissal while a transaction is in flight.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  locked = false,
  size = "md",
  sheet = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  locked?: boolean;
  size?: "sm" | "md" | "lg";
  /** Always presented as a bottom sheet (used for phone-only menus). */
  sheet?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    const focusFirst = () => {
      // Focus the field marked for it, or else the dialog itself, so a close
      // button doesn't open with a focus ring.
      const first = panel.current?.querySelector<HTMLElement>("[data-autofocus]");
      (first ?? panel.current)?.focus();
    };
    requestAnimationFrame(focusFirst);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !lockedRef.current) {
        e.stopPropagation();
        closeRef.current();
      }
      if (e.key === "Tab" && panel.current) {
        const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className={`modal-root ${sheet ? "is-sheet" : ""}`}>
      <div className="modal-scrim" onClick={() => !locked && onClose()} />
      <div
        ref={panel}
        className={`modal modal-${size} ${sheet ? "modal-sheet" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
      >
        <header className="modal-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && (
              <p id={descId} className="modal-desc">
                {description}
              </p>
            )}
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose} disabled={locked}>
            <Icon name="close" />
          </button>
        </header>
        {children && <div className="modal-body">{children}</div>}
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export type TxPhase = "idle" | "pending" | "done" | "error";

export interface Tx {
  phase: TxPhase;
  hash?: string;
  error?: string;
  run: (send: () => Promise<Sent<unknown>>) => Promise<boolean>;
  reset: () => void;
}

/** Tracks one transaction from wallet prompt to confirmation, then refreshes the registry. */
export function useTx(): Tx {
  const { refresh } = useRegistry();
  const [phase, setPhase] = useState<TxPhase>("idle");
  const [hash, setHash] = useState<string>();
  const [error, setError] = useState<string>();

  const run = useCallback(
    async (send: () => Promise<Sent<unknown>>) => {
      setPhase("pending");
      setError(undefined);
      try {
        const sent = await send();
        setHash(sent.hash);
        setPhase("done");
        void refresh();
        return true;
      } catch (err) {
        setError(describe(err));
        setPhase("error");
        return false;
      }
    },
    [refresh],
  );
  const reset = useCallback(() => {
    setPhase("idle");
    setHash(undefined);
    setError(undefined);
  }, []);
  return { phase, hash, error, run, reset };
}

/** Inline status for a transaction inside a modal. */
export function TxStatus({ tx, success }: { tx: Tx; success: string }) {
  if (tx.phase === "pending") {
    return (
      <div className="tx-status tx-pending" role="status">
        <span className="spinner" aria-hidden="true" />
        <div>
          <strong>Waiting for confirmation</strong>
          <span>Approve the request in Freighter. Submitting takes a few seconds.</span>
        </div>
      </div>
    );
  }
  if (tx.phase === "done") {
    return (
      <div className="tx-status tx-done" role="status">
        <Icon name="check" />
        <div>
          <strong>{success}</strong>
          {tx.hash && (
            <a href={`${NETWORK.explorer}/tx/${tx.hash}`} target="_blank" rel="noreferrer">
              View transaction <Icon name="external" size={13} />
            </a>
          )}
        </div>
      </div>
    );
  }
  if (tx.phase === "error") {
    return (
      <div className="tx-status tx-error" role="alert">
        <Icon name="alert" />
        <div>
          <strong>Transaction not sent</strong>
          <span>{tx.error}</span>
        </div>
      </div>
    );
  }
  return null;
}
