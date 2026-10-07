import { useCallback, useEffect, useRef, useState } from "react";
import {
  describeSchedule,
  formatDuration,
  jobStatus,
  type Config,
  type Job,
  type JobStatus,
  type Keeper,
  type KeeperStats,
} from "@sorocron/sdk";
import { useSoroCron, type SoroCronClient } from "./context.js";

export interface Polled<T> {
  /** Latest value; `undefined` until the first load. */
  data: T | undefined;
  error: Error | undefined;
  /** True until the first load finishes. */
  loading: boolean;
  /** Reload now (e.g. after sending a transaction). */
  refresh: () => void;
}

/**
 * Loads `fetch(client)` and reloads it every `refreshMs`. Skips while the
 * client is connecting or `fetch` is null. Keeps the last good value when a
 * reload fails.
 */
export function usePolled<T>(
  fetch: ((client: SoroCronClient) => Promise<T>) | null,
  deps: readonly unknown[],
  refreshMs?: number,
): Polled<T> {
  const { client, error: connectError, refreshMs: defaultMs } = useSoroCron();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;

  useEffect(() => {
    if (!client || !fetchRef.current) return;
    let cancelled = false;
    const load = () =>
      fetchRef.current!(client)
        .then((value) => {
          if (cancelled) return;
          setData(value);
          setError(undefined);
        })
        .catch((err) => !cancelled && setError(err instanceof Error ? err : new Error(String(err))))
        .finally(() => !cancelled && setLoading(false));
    void load();
    const timer = setInterval(load, refreshMs ?? defaultMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, refreshMs, defaultMs, tick, fetch === null, ...deps]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data, error: error ?? connectError, loading: loading && !connectError, refresh };
}

/**
 * One job, kept fresh.
 *
 * ```tsx
 * const { data: job } = useJob(7n);
 * ```
 */
export function useJob(jobId: bigint | undefined, refreshMs?: number): Polled<Job | null> {
  return usePolled(
    jobId === undefined ? null : async (c) => (await c.getJob(jobId)) ?? null,
    [jobId?.toString()],
    refreshMs,
  );
}

/** Every live job in the registry. */
export function useJobs(refreshMs?: number): Polled<Job[]> {
  return usePolled((c) => c.allJobs(), [], refreshMs);
}

/** The jobs an account owns, oldest first. */
export function useJobsByOwner(owner: string | undefined, refreshMs?: number): Polled<Job[]> {
  return usePolled(
    owner === undefined
      ? null
      : async (c) => {
          const ids = await c.jobsByOwner(owner);
          const jobs = await Promise.all(ids.map((id) => c.getJob(id)));
          return jobs.filter((j): j is Job => j !== undefined);
        },
    [owner],
    refreshMs,
  );
}

export interface KeeperStatus {
  keeper: Keeper | null;
  stats: KeeperStats | null;
  /** Can execute jobs right now. */
  eligible: boolean;
  /** Unix seconds when an unbonding keeper's stake becomes withdrawable. */
  withdrawableAt?: bigint;
}

/** A keeper's stake, eligibility and reputation. `null` fields if not a keeper. */
export function useKeeperStatus(keeper: string | undefined, refreshMs?: number): Polled<KeeperStatus> {
  return usePolled(
    keeper === undefined
      ? null
      : async (c) => {
          const [info, stats] = await Promise.all([c.getKeeper(keeper), c.keeperStats(keeper).catch(() => undefined)]);
          return {
            keeper: info ?? null,
            stats: stats ?? null,
            eligible: Boolean(stats?.eligible),
            withdrawableAt: info?.unbonding_at ?? undefined,
          };
        },
    [keeper],
    refreshMs,
  );
}

/** The registry's configuration. */
export function useRegistryConfig(refreshMs?: number): Polled<Config> {
  return usePolled((c) => c.config(), [], refreshMs ?? 60_000);
}

/** Unix seconds, updated every second. */
export function useNow(): bigint {
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)));
  useEffect(() => {
    const timer = setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 1_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export interface NextRun {
  status: JobStatus;
  /** Seconds until the next run; negative when overdue; undefined if not running. */
  secondsUntil: bigint | undefined;
  /** "in 4m 10s", "due 2m ago" or a reason it isn't running. */
  label: string;
  /** "every 1h", "daily at 12:00 UTC", ... */
  schedule: string;
}

/** Live countdown to a job's next run. */
export function useNextRun(job: Job | null | undefined): NextRun | undefined {
  const now = useNow();
  if (!job) return undefined;
  const status = jobStatus(job, now);
  const running = status === "due" || status === "scheduled";
  const secondsUntil = running ? job.next_run - now : undefined;
  const label =
    secondsUntil === undefined
      ? status
      : secondsUntil > 0n
        ? `in ${formatDuration(secondsUntil)}`
        : `due ${formatDuration(-secondsUntil)} ago`;
  return { status, secondsUntil, label, schedule: describeSchedule(job) };
}
