/**
 * `sorocron jobs monitor` (#136): alerts a job's owner before the job
 * stalls. Keeper alerts are for operators; this watches an owner's jobs and
 * raises one alert when a job's balance drops below a number of runs, when
 * it pauses itself after failing, and when it's about to reach its end
 * time. Each fires once when its condition starts and again only after the
 * condition has cleared (the owner funded or resumed the job, say).
 */
import { formatAmount, formatDuration, jobStatus, type Job } from "@sorocron/sdk";
import type { Alert } from "./alerts.js";

export interface OwnerAlertOptions {
  /** Alert when the balance pays for fewer runs than this. */
  minRuns: bigint;
  /** Alert when the job's end time is within this many seconds. */
  endsWithin: bigint;
}

/** Runs the balance pays for, and whether that's fewer than the job has left to run. */
function fundedRuns(job: Job): { funded: bigint; short: boolean } {
  const funded = job.fee_per_run > 0n ? job.balance / job.fee_per_run : 0n;
  const left = job.max_runs === 0 ? undefined : BigInt(Math.max(job.max_runs - job.runs, 0));
  return { funded, short: left === undefined || funded < left };
}

/** The alerts whose conditions hold for `job` right now, keyed by `kind:id`. */
export function jobConditions(job: Job, now: bigint, o: OwnerAlertOptions): Map<string, Alert> {
  const found = new Map<string, Alert>();
  const status = jobStatus(job, now);
  const id = job.id;
  const running = status === "due" || status === "scheduled" || status === "underfunded";

  const { funded, short } = fundedRuns(job);
  if (running && short && funded < o.minRuns) {
    found.set(`job_low_balance:${id}`, {
      kind: "job_low_balance",
      severity: funded === 0n ? "critical" : "warning",
      message:
        funded === 0n
          ? `job #${id} can't pay for its next run; fund it or it stops`
          : `job #${id} has ${formatAmount(job.balance)} XLM left, enough for ${funded} more run(s)`,
      details: { job: id, balance: job.balance, feePerRun: job.fee_per_run, runsFunded: funded },
    });
  }
  if (status === "failing") {
    found.set(`job_paused:${id}`, {
      kind: "job_paused",
      severity: "critical",
      message: `job #${id} paused itself after ${job.failures} failed runs in a row; fix the target, then resume it`,
      details: { job: id, failures: job.failures, target: job.target, function: job.function },
    });
  }
  if (running && job.end_at !== 0n && job.end_at > now && job.end_at - now <= o.endsWithin) {
    found.set(`job_ending:${id}`, {
      kind: "job_ending",
      severity: "warning",
      message: `job #${id} stops running in ${formatDuration(job.end_at - now)}`,
      details: { job: id, endAt: new Date(Number(job.end_at) * 1000).toISOString() },
    });
  }
  return found;
}

export class OwnerWatch {
  /** Conditions already alerted on and still holding. */
  private active = new Set<string>();

  constructor(private readonly options: OwnerAlertOptions) {}

  /** The alerts to send for this check: conditions that just started. */
  check(jobs: Job[], now: bigint): { key: string; alert: Alert }[] {
    const current = new Map<string, Alert>();
    for (const job of jobs) for (const [key, alert] of jobConditions(job, now, this.options)) current.set(key, alert);
    const fresh = [...current].filter(([key]) => !this.active.has(key)).map(([key, alert]) => ({ key, alert }));
    // Forget conditions that cleared (or whose job is gone) so they can alert again.
    this.active = new Set(current.keys());
    return fresh;
  }
}
