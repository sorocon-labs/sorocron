import { useCallback, useEffect, useRef, useState } from "react";
import { SoroCron, TESTNET, type Config, type Job, type Keeper } from "@sorocron/sdk";
import { signTransaction } from "./wallet";

export const NETWORK = TESTNET;
const REFRESH_MS = 15_000;

export interface RegistryState {
  cron?: SoroCron;
  config?: Config;
  version?: number;
  jobs: Job[];
  keeper?: Keeper | null;
  loading: boolean;
  error?: string;
  updatedAt?: number;
  refresh: () => Promise<void>;
}

/**
 * Connects to the registry (read-only, or signing as `publicKey`) and keeps
 * config, jobs and the connected keeper's record fresh.
 */
export function useRegistry(publicKey?: string): RegistryState {
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
    SoroCron.connect({ network: NETWORK, publicKey, signTransaction: publicKey ? signTransaction : undefined })
      .then((client) => !cancelled && setCron(client))
      .catch((err) => !cancelled && setError(describe(err)));
    return () => {
      cancelled = true;
    };
  }, [publicKey]);

  const refresh = useCallback(async () => {
    if (!cron || inFlight.current) return;
    inFlight.current = true;
    try {
      const [nextConfig, nextJobs, nextVersion, nextKeeper] = await Promise.all([
        cron.config(),
        cron.allJobs(),
        cron.version(),
        publicKey ? cron.getKeeper(publicKey) : Promise.resolve(undefined),
      ]);
      setConfig(nextConfig);
      setJobs(nextJobs);
      setVersion(nextVersion);
      setKeeper(publicKey ? (nextKeeper ?? null) : undefined);
      setError(undefined);
      setUpdatedAt(Date.now());
    } catch (err) {
      setError(describe(err));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [cron, publicKey]);

  useEffect(() => {
    if (!cron) return;
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [cron, refresh]);

  return { cron, config, version, jobs, keeper, loading, error, updatedAt, refresh };
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
