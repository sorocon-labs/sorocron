import { describe, expect, it } from "vitest";
import type { Job } from "@sorocron/sdk";
import { OwnerWatch, jobConditions } from "./ownerAlerts.js";

const DAY = 86_400n;
const NOW = 1_800_000_000n;

const job = (over: Partial<Job> = {}): Job => ({
  id: 3n,
  owner: "GOWNER",
  target: "CTARGET",
  function: "harvest",
  args: [],
  interval: 3_600n,
  schedule: { tag: "Interval" },
  next_run: NOW + 600n,
  fee_per_run: 1_000_000n,
  max_fee_per_run: 0n,
  balance: 10_000_000n,
  max_runs: 0,
  runs: 0,
  end_at: 0n,
  active: true,
  failures: 0,
  ...over,
});

const options = { minRuns: 3n, endsWithin: DAY };
const kinds = (j: Job) => [...jobConditions(j, NOW, options).values()].map((a) => a.kind);

describe("owner alerts (#136)", () => {
  it("flags a balance below the configured number of runs", () => {
    expect(kinds(job())).toEqual([]);
    expect(kinds(job({ balance: 2_500_000n }))).toEqual(["job_low_balance"]);
    const empty = jobConditions(job({ balance: 0n }), NOW, options).get("job_low_balance:3");
    expect(empty).toMatchObject({ severity: "critical", message: "job #3 can't pay for its next run; fund it or it stops" });
  });

  it("doesn't flag a low balance that covers every run the job has left", () => {
    expect(kinds(job({ balance: 2_000_000n, max_runs: 10, runs: 8 }))).toEqual([]);
    expect(kinds(job({ balance: 2_000_000n, max_runs: 10, runs: 10 }))).toEqual([]);
  });

  it("flags a job that paused itself after failures, not one its owner paused", () => {
    expect(kinds(job({ active: false, failures: 3 }))).toEqual(["job_paused"]);
    expect(kinds(job({ active: false, failures: 0, balance: 0n }))).toEqual([]);
  });

  it("flags a job about to reach its end time", () => {
    expect(kinds(job({ end_at: NOW + DAY / 2n }))).toEqual(["job_ending"]);
    expect(kinds(job({ end_at: NOW + 2n * DAY }))).toEqual([]);
    expect(kinds(job({ end_at: NOW - 1n }))).toEqual([]);
  });

  it("alerts exactly once per condition, and again only after it cleared", () => {
    const watch = new OwnerWatch(options);
    const low = job({ balance: 2_000_000n });
    expect(watch.check([low], NOW).map((a) => a.key)).toEqual(["job_low_balance:3"]);
    expect(watch.check([low], NOW + 60n)).toEqual([]);
    expect(watch.check([job({ balance: 2_000_000n, active: false, failures: 3 })], NOW + 120n).map((a) => a.key)).toEqual([
      "job_paused:3",
    ]);
    // Funded and resumed: both clear.
    expect(watch.check([job()], NOW + 180n)).toEqual([]);
    // Low again later: a new alert.
    expect(watch.check([low], NOW + 240n).map((a) => a.key)).toEqual(["job_low_balance:3"]);
  });

  it("forgets jobs that disappear", () => {
    const watch = new OwnerWatch(options);
    watch.check([job({ balance: 0n })], NOW);
    expect(watch.check([], NOW)).toEqual([]);
    expect(watch.check([job({ balance: 0n })], NOW)).toHaveLength(1);
  });
});
