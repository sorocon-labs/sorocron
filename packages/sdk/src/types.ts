/**
 * TypeScript mirrors of the registry's contract types
 * (contracts/registry/src/types.rs). u64 and i128 map to bigint, u32 to
 * number, Address to its strkey string, Option<T> to `T | undefined`.
 */
import type { xdr } from "@stellar/stellar-sdk";

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
}

export interface JobParams {
  target: string;
  function: string;
  /** Already-encoded arguments; build them with the helpers in `args.ts`. */
  args: xdr.ScVal[];
  /** Seconds between runs. */
  interval: bigint;
  /** Unix seconds of the first run; `0n` means now. */
  start_at: bigint;
  fee_per_run: bigint;
  /** `0` means unlimited. */
  max_runs: number;
  /** Unix seconds after which the job stops; `0n` means never. */
  end_at: bigint;
  resolver?: string | null;
}

export interface JobUpdate {
  function: string;
  args: xdr.ScVal[];
  interval: bigint;
  fee_per_run: bigint;
  max_runs: number;
  end_at: bigint;
  resolver?: string | null;
}

export interface Job {
  id: bigint;
  owner: string;
  target: string;
  function: string;
  /** Decoded to native JS values by the contract client. */
  args: unknown[];
  interval: bigint;
  next_run: bigint;
  fee_per_run: bigint;
  balance: bigint;
  max_runs: number;
  runs: number;
  end_at: bigint;
  resolver?: string | null;
  active: boolean;
}

export interface Keeper {
  stake: bigint;
  unbonding_at?: bigint | null;
  executions: number;
}
