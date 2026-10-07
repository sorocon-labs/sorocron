import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { SoroCron, TESTNET, type Config, type Job, type Keeper } from "@sorocron/sdk";
import { signTransaction } from "@stellar/freighter-api";

export const NETWORK = TESTNET;
export const REPO_URL = "https://github.com/sorocon-labs/sorocron";
/** The documentation site, published with the app by .github/workflows/pages.yml. */
export const DOCS_URL = "https://sorocon-labs.github.io/sorocron/docs/";
const REFRESH_MS = 15_000;

export interface RegistryState {
  cron?: SoroCron;
  config?: Config;
  version?: number;
  jobs: Job[];
  /** `undefined` while unknown or without a wallet, `null` when not a keeper. */
  keeper?: Keeper | null;
  loading: boolean;
  error?: string;
  updatedAt?: number;
  refresh: () => Promise<void>;
}

const RegistryContext = createContext<RegistryState | null>(null);

/**
 * One connection and one polling loop for the whole app, so every page sees
 * the same snapshot and refreshes together after a transaction.
 */
export function RegistryProvider({ account, children }: { account?: string; children: ReactNode }) {
  const [cron, setCron] = useState<SoroCron>();
  const [config, setConfig] = useState<Config>();
  const [version, setVersion] = useState<number>();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [keeper, setKeeper] = useState<Keeper | null>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [updatedAt, setUpdatedAt] = useState<number>();
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    SoroCron.connect({ network: NETWORK, publicKey: account, signTransaction: account ? signTransaction : undefined })
      .then((client) => !cancelled && setCron(client))
      .catch((err) => {
        if (cancelled) return;
        setError(describe(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [account]);

  const refresh = useCallback(async () => {
    if (!cron || inFlight.current) return;
    inFlight.current = true;
    try {
      const [nextConfig, nextJobs, nextVersion, nextKeeper] = await Promise.all([
        cron.config(),
        cron.allJobs(),
        cron.version(),
        account ? cron.getKeeper(account) : Promise.resolve(undefined),
      ]);
      setConfig(nextConfig);
      setJobs(nextJobs);
      setVersion(nextVersion);
      setKeeper(account ? (nextKeeper ?? null) : undefined);
      setError(undefined);
      setUpdatedAt(Date.now());
    } catch (err) {
      setError(describe(err));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [cron, account]);

  useEffect(() => {
    if (!cron) return;
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [cron, refresh]);

  return (
    <RegistryContext.Provider value={{ cron, config, version, jobs, keeper, loading, error, updatedAt, refresh }}>
      {children}
    </RegistryContext.Provider>
  );
}

export function useRegistry(): RegistryState {
  const ctx = useContext(RegistryContext);
  if (!ctx) throw new Error("useRegistry outside RegistryProvider");
  return ctx;
}

/** Unix seconds, ticking once a second, for countdowns. */
export function useNow(): bigint {
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)));
  useEffect(() => {
    const timer = setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 1_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function describe(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0];
  return String(err);
}
