/**
 * Pure helpers for reasoning about a job's schedule and funding. They mirror
 * the registry's `ensure_due` checks, except the resolver, which only the
 * chain can evaluate (use `isDue` for the authoritative answer).
 */
import type { Job } from "./types.js";

export type JobStatus =
  | "paused"
  | "completed"
  | "expired"
  | "underfunded"
  | "scheduled"
  | "due";

/** Status in the same order the registry checks it. `now` is unix seconds. */
export function jobStatus(job: Job, now: bigint): JobStatus {
  if (!job.active) return "paused";
  if (job.max_runs !== 0 && job.runs >= job.max_runs) return "completed";
  if (job.end_at !== 0n && now >= job.end_at) return "expired";
  if (job.balance < job.fee_per_run) return "underfunded";
  if (now < job.next_run) return "scheduled";
  return "due";
}

/** How many more runs the current balance pays for, capped by `max_runs`. */
export function runsRemaining(job: Job): bigint {
  const funded = job.fee_per_run > 0n ? job.balance / job.fee_per_run : 0n;
  if (job.max_runs === 0) return funded;
  const left = BigInt(Math.max(job.max_runs - job.runs, 0));
  return funded < left ? funded : left;
}

/** Deposit needed for `runs` runs at `feePerRun`. */
export function depositFor(runs: number | bigint, feePerRun: bigint): bigint {
  return BigInt(runs) * feePerRun;
}

/** Formats seconds compactly: `90` → `1m 30s`, `86400` → `1d`. */
export function formatDuration(seconds: bigint | number): string {
  let s = Number(seconds);
  if (s <= 0) return "0s";
  const parts: string[] = [];
  for (const [unit, size] of [
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
    ["s", 1],
  ] as const) {
    if (s >= size) {
      parts.push(`${Math.floor(s / size)}${unit}`);
      s %= size;
    }
  }
  return parts.slice(0, 2).join(" ");
}

/** Token amount with `decimals` (7 for XLM and most Stellar assets) as a decimal string. */
export function formatAmount(amount: bigint, decimals = 7): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Parses a decimal string such as `"1.5"` into base units. Throws on bad input. */
export function parseAmount(text: string, decimals = 7): bigint {
  const match = /^\s*(\d+)(?:\.(\d*))?\s*$/.exec(text);
  if (!match) throw new Error(`Not an amount: "${text}"`);
  const frac = match[2] ?? "";
  if (frac.length > decimals) throw new Error(`At most ${decimals} decimal places`);
  return BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}
