import { TESTNET, schedule, type Job, type JobStatus } from "@sorocron/sdk";

/** Fixed "now" for the tests, in Unix seconds. */
export const NOW = 1_800_000_000n;
export const OWNER = "GA3MGO7TF2Y4KIUEMD7CHD4KMHLVOF5WF7R2UBI4LTPVAG7KSDNVNF53";
export const TARGET = TESTNET.contracts.registry;
const FEE = 1_000_000n;

export function job(id: number, overrides: Partial<Job> = {}): Job {
  return {
    id: BigInt(id),
    owner: OWNER,
    target: TARGET,
    function: `job${id}`,
    args: [],
    interval: 3_600n,
    schedule: schedule.interval(),
    next_run: NOW - 10n,
    fee_per_run: FEE,
    max_fee_per_run: 0n,
    balance: 10n * FEE,
    max_runs: 0,
    runs: 0,
    end_at: 0n,
    resolver: undefined,
    keepers: undefined,
    after: undefined,
    active: true,
    failures: 0,
    ...overrides,
  } as Job;
}

/** One job in every status `jobStatus` can report. */
export const BY_STATUS: Record<JobStatus, Job> = {
  due: job(1),
  scheduled: job(2, { next_run: NOW + 600n }),
  underfunded: job(3, { balance: 0n }),
  paused: job(4, { active: false }),
  failing: job(5, { active: false, failures: 3 }),
  expired: job(6, { end_at: NOW - 1n }),
  completed: job(7, { max_runs: 5, runs: 5 }),
};

/** The label each status is shown with. */
export const LABEL: Record<JobStatus, string> = {
  due: "Due",
  scheduled: "Scheduled",
  underfunded: "Needs funds",
  paused: "Paused",
  failing: "Failing",
  expired: "Expired",
  completed: "Completed",
};
