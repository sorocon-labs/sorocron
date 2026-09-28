import { useCallback, useEffect, useState } from "react";
import { formatAmount, jobStatus, type Sent } from "@sorocron/sdk";
import { CreateJobView } from "./CreateJobView";
import { JobsView } from "./JobsView";
import { KeeperView } from "./KeeperView";
import { Addr, Stat, Toasts, short, type Toast } from "./ui";
import { NETWORK, describe, useNow, useRegistry } from "./useRegistry";
import { connectFreighter } from "./wallet";

/** Sends a transaction with toasts and a refresh; resolves true on success. */
export type Run = (label: string, send: () => Promise<Sent<unknown>>) => Promise<boolean>;

type Tab = "jobs" | "schedule" | "keeper";
const TABS: [Tab, string][] = [
  ["jobs", "Jobs"],
  ["schedule", "Schedule"],
  ["keeper", "Keepers"],
];

function tabFromHash(): Tab {
  const hash = window.location.hash.slice(1);
  return TABS.some(([t]) => t === hash) ? (hash as Tab) : "jobs";
}

export default function App() {
  const [account, setAccount] = useState<string>();
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busy, setBusy] = useState(false);
  const registry = useRegistry(account);
  const now = useNow();

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const toast = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((all) => [...all.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), t.kind === "err" ? 12_000 : 8_000);
  }, []);

  const connect = useCallback(async () => {
    try {
      setAccount(await connectFreighter(NETWORK.networkPassphrase));
    } catch (err) {
      toast({ kind: "err", text: describe(err) });
    }
  }, [toast]);

  const run: Run = useCallback(
    async (label, send) => {
      setBusy(true);
      toast({ kind: "info", text: "Confirm in Freighter…" });
      try {
        const { hash } = await send();
        toast({ kind: "ok", text: label, hash });
        await registry.refresh();
        return true;
      } catch (err) {
        toast({ kind: "err", text: describe(err) });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [registry, toast],
  );

  const { jobs, config } = registry;
  const due = jobs.filter((j) => jobStatus(j, now) === "due").length;
  const escrow = jobs.reduce((sum, j) => sum + j.balance, 0n);

  return (
    <div className={`app ${busy ? "busy" : ""}`}>
      <header className="top">
        <a className="brand" href="#jobs">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <circle cx="16" cy="16" r="13" />
            <path d="M16 9v7l5 3" />
          </svg>
          SoroCron
        </a>
        <nav className="tabs">
          {TABS.map(([value, label]) => (
            <a key={value} href={`#${value}`} className={tab === value ? "active" : ""} aria-current={tab === value ? "page" : undefined}>
              {label}
            </a>
          ))}
        </nav>
        <div className="wallet">
          <span className="network">Testnet</span>
          {account ? (
            <span className="account" title={account}>
              {short(account)}
            </span>
          ) : (
            <button type="button" className="btn btn-primary" onClick={connect}>
              Connect
            </button>
          )}
        </div>
      </header>

      <main>
        <section className="hero">
          <div>
            <h1>Cron for Soroban contracts</h1>
            <p>
              Schedule any contract call, prepay a fee per run, and staked keepers execute it on time. No servers to run,
              no single point of failure.
            </p>
          </div>
          <div className="stats">
            <Stat label="Live jobs" value={registry.loading ? "…" : jobs.length} />
            <Stat label="Due now" value={registry.loading ? "…" : due} />
            <Stat label="Escrowed" value={registry.loading ? "…" : `${formatAmount(escrow)} XLM`} />
            <Stat
              label="Registry"
              value={config ? (config.paused ? "Paused" : "Running") : "…"}
              hint={
                <>
                  <Addr value={registry.cron?.contractId ?? NETWORK.contracts.registry} />
                  {registry.version ? ` · v${registry.version}` : ""}
                </>
              }
            />
          </div>
        </section>

        {registry.error && (
          <div className="banner" role="alert">
            Couldn't reach the registry: {registry.error}{" "}
            <button type="button" className="link" onClick={() => void registry.refresh()}>
              Retry
            </button>
          </div>
        )}

        {tab === "jobs" && (
          <JobsView jobs={jobs} now={now} account={account} cron={registry.cron} run={run} loading={registry.loading} />
        )}
        {tab === "schedule" && (
          <CreateJobView cron={registry.cron} config={config} account={account} connect={connect} run={run} />
        )}
        {tab === "keeper" && (
          <KeeperView
            cron={registry.cron}
            config={config}
            keeper={registry.keeper}
            jobs={jobs}
            now={now}
            account={account}
            connect={connect}
            run={run}
          />
        )}
      </main>

      <footer className="foot">
        <span>Open source, MIT licensed.</span>
        <a href="https://github.com/sorocon-labs/sorocron" target="_blank" rel="noreferrer">
          GitHub
        </a>
        <a href="https://github.com/sorocon-labs/sorocron/blob/main/docs/security.md" target="_blank" rel="noreferrer">
          Security model
        </a>
        <a href="https://github.com/sorocon-labs/sorocron/tree/main/packages/sdk" target="_blank" rel="noreferrer">
          TypeScript SDK
        </a>
        {registry.updatedAt && <span className="muted">Updated {new Date(registry.updatedAt).toLocaleTimeString()}</span>}
      </footer>

      <Toasts toasts={toasts} dismiss={(id) => setToasts((all) => all.filter((t) => t.id !== id))} />
    </div>
  );
}
