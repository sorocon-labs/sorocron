import { useEffect, useState, type ReactNode } from "react";
import { formatAmount, parseAmount, type Sent } from "@sorocron/sdk";
import { StrKey } from "@stellar/stellar-sdk";
import { Modal, TxStatus, useTx } from "../components/Modal";
import { Icon } from "../components/Icon";
import { Button, Field, TextInput } from "../components/ui";
import { describe } from "../state/registry";
import { useWallet } from "../state/wallet";

// ---------------------------------------------------------------- connect

export function ConnectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { connect } = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (open) setError(undefined);
  }, [open]);

  const missing = error?.includes("isn't installed");
  return (
    <Modal
      open={open}
      onClose={onClose}
      locked={busy}
      size="sm"
      title="Connect a wallet"
      description="SoroCron uses Freighter to sign transactions. Your keys never leave the extension."
      footer={
        missing ? (
          <a className="btn btn-primary" href="https://www.freighter.app" target="_blank" rel="noreferrer">
            Install Freighter <Icon name="external" size={14} />
          </a>
        ) : (
          <Button
            variant="primary"
            data-autofocus
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(undefined);
              try {
                await connect();
                onClose();
              } catch (err) {
                setError(describe(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Waiting for Freighter…" : "Connect Freighter"}
          </Button>
        )
      }
    >
      <ol className="steps-list">
        <li>Open Freighter and switch the network to <strong>Testnet</strong>.</li>
        <li>Fund the account with test XLM from Friendbot if it's new.</li>
        <li>Approve the connection request.</li>
      </ol>
      {error && (
        <div className="tx-status tx-error" role="alert">
          <Icon name="alert" />
          <div>
            <strong>{missing ? "Freighter not found" : "Couldn't connect"}</strong>
            <span>{missing ? "Install the extension, then reload this page." : error}</span>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- amount

/** Enter an XLM amount and send one transaction with it. */
export function AmountModal({
  open,
  onClose,
  title,
  description,
  action,
  success,
  max,
  maxLabel = "Available",
  send,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  action: string;
  success: string;
  /** Upper bound in base units, shown with a "Max" shortcut. */
  max?: bigint;
  maxLabel?: string;
  send: (amount: bigint) => Promise<Sent<unknown>>;
  children?: ReactNode;
}) {
  const tx = useTx();
  const [text, setText] = useState("");

  useEffect(() => {
    if (open) {
      setText("");
      tx.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  let amount: bigint | undefined;
  let error: string | undefined;
  if (text.trim()) {
    try {
      amount = parseAmount(text);
      if (amount <= 0n) error = "Enter an amount above zero.";
      else if (max !== undefined && amount > max) error = `That's more than the ${formatAmount(max)} XLM available.`;
    } catch (err) {
      error = (err as Error).message;
    }
  }
  const pending = tx.phase === "pending";
  const done = tx.phase === "done";

  return (
    <Modal
      open={open}
      onClose={onClose}
      locked={pending}
      size="sm"
      title={title}
      description={description}
      footer={
        done ? (
          <Button variant="primary" onClick={onClose} data-autofocus>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!amount || !!error || pending} onClick={() => tx.run(() => send(amount!))}>
              {pending ? "Confirming…" : action}
            </Button>
          </>
        )
      }
    >
      {!done && (
        <Field
          label="Amount"
          error={error}
          hint={
            max !== undefined ? (
              <span className="hint-row">
                {maxLabel}: {formatAmount(max)} XLM
                <button type="button" className="link-btn" onClick={() => setText(formatAmount(max))}>
                  Max
                </button>
              </span>
            ) : undefined
          }
        >
          <TextInput value={text} onChange={setText} inputMode="decimal" placeholder="0.0" suffix="XLM" data-autofocus disabled={pending} />
        </Field>
      )}
      {children}
      <TxStatus tx={tx} success={success} />
    </Modal>
  );
}

// ---------------------------------------------------------------- transfer

/**
 * Offer a job to another account (v5 two-step handover). Nothing changes
 * hands until that account accepts, and the owner can withdraw the offer.
 */
export function TransferModal({
  open,
  onClose,
  jobId,
  balance,
  owner,
  send,
}: {
  open: boolean;
  onClose: () => void;
  jobId: bigint;
  balance: bigint;
  owner: string;
  send: (to: string) => Promise<Sent<unknown>>;
}) {
  const tx = useTx();
  const [to, setTo] = useState("");
  useEffect(() => {
    if (open) {
      setTo("");
      tx.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const address = to.trim();
  const error = !address
    ? undefined
    : !StrKey.isValidEd25519PublicKey(address) && !StrKey.isValidContract(address)
      ? "Enter an account (G…) or contract (C…) address."
      : address === owner
        ? "That's the current owner."
        : undefined;
  const pending = tx.phase === "pending";
  const done = tx.phase === "done";

  return (
    <Modal
      open={open}
      onClose={onClose}
      locked={pending}
      size="sm"
      title={`Transfer job #${jobId}`}
      description={`The new owner gets the job's ${formatAmount(balance)} XLM balance and history once they accept. Until then it stays yours and you can withdraw the offer.`}
      footer={
        done ? (
          <Button variant="primary" onClick={onClose} data-autofocus>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!address || !!error || pending} onClick={() => tx.run(() => send(address))}>
              {pending ? "Confirming…" : "Offer job"}
            </Button>
          </>
        )
      }
    >
      {!done && (
        <Field label="New owner" error={error} hint="They accept from this job's page, or with `sorocron jobs accept`." htmlFor="new-owner">
          <TextInput id="new-owner" mono value={to} onChange={setTo} placeholder="G… or C…" data-autofocus disabled={pending} />
        </Field>
      )}
      <TxStatus tx={tx} success="Offer sent. The job moves once they accept." />
    </Modal>
  );
}

// ---------------------------------------------------------------- confirm

/** Confirm and send a transaction that needs no input. */
export function ConfirmModal({
  open,
  onClose,
  title,
  description,
  action,
  success,
  danger = false,
  send,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  action: string;
  success: string;
  danger?: boolean;
  send: () => Promise<Sent<unknown>>;
  children?: ReactNode;
}) {
  const tx = useTx();
  useEffect(() => {
    if (open) tx.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const pending = tx.phase === "pending";
  const done = tx.phase === "done";

  return (
    <Modal
      open={open}
      onClose={onClose}
      locked={pending}
      size="sm"
      title={title}
      description={description}
      footer={
        done ? (
          <Button variant="primary" onClick={onClose} data-autofocus>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={pending} data-autofocus>
              Cancel
            </Button>
            <Button variant={danger ? "danger" : "primary"} disabled={pending} onClick={() => tx.run(send)}>
              {pending ? "Confirming…" : action}
            </Button>
          </>
        )
      }
    >
      {children}
      <TxStatus tx={tx} success={success} />
    </Modal>
  );
}
