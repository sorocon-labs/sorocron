/**
 * TypeScript mirrors of the registry's contract types
 * (contracts/registry/src/types.rs, interface v4). u64 and i128 map to
 * bigint, u32 to number, Address to its strkey string, Option<T> to
 * `T | null | undefined`, and contract enums to `{ tag, values }`.
 */
import type { xdr } from "@stellar/stellar-sdk";

/** When a job runs. Build values with the `schedule` helpers. */
export type Schedule =
  | { tag: "Interval"; values?: undefined }
  | { tag: "Daily"; values: readonly [hour: number, minute: number] }
  | { tag: "Weekly"; values: readonly [weekday: number, hour: number, minute: number] };

export interface Config {
  admin: string;
  fee_token: string;
  stake_token: string;
  min_stake: bigint;
  unbonding_period: bigint;
  paused: boolean;
  executor?: string | null;
  min_interval: bigint;
  max_args: number;
  protocol_fee_bps: number;
  treasury?: string | null;
  max_failures: number;
  grace_period: bigint;
  slash_bps: number;
  unbonding_epoch: bigint;
}

export interface JobParams {
  target: string;
  function: string;
  /** Already-encoded arguments; build them with the helpers in `args.ts`. */
  args: xdr.ScVal[];
  /** Seconds between runs for `Interval` schedules; `0n` for calendar schedules. */
  interval: bigint;
  schedule: Schedule;
  /** Unix seconds of the first run; `0n` means now. */
  start_at: bigint;
  fee_per_run: bigint;
  /** `0n` for a flat fee; otherwise the fee rises to this as a run gets later. */
  max_fee_per_run: bigint;
  /** `0` means unlimited. */
  max_runs: number;
  /** Unix seconds after which the job stops; `0n` means never. */
  end_at: bigint;
  resolver?: string | null;
  /** Keepers allowed to run the job (at most 10). Omit to allow any. */
  keepers?: string[] | null;
  /** Job id this job follows: it runs once per new run of that job. */
  after?: bigint | null;
}

export type JobUpdate = Omit<JobParams, "target" | "start_at">;

export interface Job {
  id: bigint;
  owner: string;
  target: string;
  function: string;
  /** Decoded to native JS values by the contract client. */
  args: unknown[];
  interval: bigint;
  schedule: Schedule;
  next_run: bigint;
  fee_per_run: bigint;
  max_fee_per_run: bigint;
  balance: bigint;
  max_runs: number;
  runs: number;
  end_at: bigint;
  resolver?: string | null;
  keepers?: string[] | null;
  after?: bigint | null;
  active: boolean;
  /** Consecutive failed runs; reset by a success. */
  failures: number;
}

/** The small per-run part of a job (`get_job_state`). */
export interface JobState {
  next_run: bigint;
  balance: bigint;
  runs: number;
  failures: number;
  active: boolean;
  leader_runs: number;
}

export interface Keeper {
  stake: bigint;
  unbonding_at?: bigint | null;
  executions: number;
  total_lateness: bigint;
  missed: number;
  slashed: bigint;
}

/** A registry code upgrade announced with `propose_upgrade` (v5+). */
export interface PendingUpgrade {
  wasm_hash: Uint8Array;
  proposed_at: bigint;
  /** Unix time from which `apply_upgrade` can install it. Only ever moves later. */
  available_at: bigint;
}

export interface KeeperStats {
  stake: bigint;
  executions: number;
  average_lateness: bigint;
  missed: number;
  slashed: bigint;
  eligible: boolean;
  /** Lateness averaged over roughly the last eight runs (v5+). */
  recent_lateness?: bigint;
  /** Share of recent runs and missed windows that were misses, in basis points (v5+). */
  recent_miss_bps?: number;
}
