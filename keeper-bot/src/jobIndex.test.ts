import { describe, expect, it } from "vitest";
import { schedule, type EventPage, type Job, type RegistryEvent } from "@sorocron/sdk";
import { JobIndex, mightBeDue, toIndexed, type IndexSource } from "./jobIndex.js";

function job(id: bigint, overrides: Partial<Job> = {}): Job {
  return {
    id,
    owner: "GOWNER",
    target: "CTARGET",
    function: "bump",
    args: [],
    interval: 60n,
    schedule: schedule.interval(),
    next_run: 1_000n,
    fee_per_run: 10n,
    max_fee_per_run: 0n,
    balance: 100n,
    max_runs: 0,
    runs: 0,
    end_at: 0n,
    active: true,
    failures: 0,
    ...overrides,
  };
}

const ev = (name: string, id: bigint, data: Record<string, unknown> = {}): RegistryEvent => ({
  name,
  topics: [id],
  data,
  ledger: 10,
  closedAt: "",
  txHash: "",
  id: `${name}-${id}`,
});

/** A fake registry with a call counter and a queue of event pages. */
function fakeSource(initial: Job[]) {
  const jobs = new Map(initial.map((j) => [j.id, j]));
  const pages: (EventPage | Error)[] = [];
  const calls = { getJob: 0, getJobs: 0, events: 0 };
  const source: IndexSource = {
    jobCount: async () => BigInt(Math.max(-1, ...[...jobs.keys()].map(Number)) + 1),
    getJobs: async (start, limit = 50) => {
      calls.getJobs++;
      return [...jobs.values()].filter((j) => j.id >= start && j.id < start + BigInt(limit));
    },
    getJob: async (id) => {
      calls.getJob++;
      return jobs.get(id);
    },
    events: async () => {
      calls.events++;
      const next = pages.shift() ?? { events: [], latestLedger: 10, cursor: "c" };
      if (next instanceof Error) throw next;
      return next;
    },
    latestLedger: async () => 10,
  };
  return { source, jobs, pages, calls };
}

const noLog = () => {};

describe("JobIndex", () => {
  it("loads every job a page at a time", async () => {
    const all = Array.from({ length: 120 }, (_, i) => job(BigInt(i)));
    const f = fakeSource(all);
    const index = new JobIndex(f.source, noLog);
    await index.load();
    expect(index.size).toBe(120);
    expect(f.calls.getJobs).toBe(3);
  });

  it("follows events: created, executed, funded, paused, cancelled", async () => {
    const f = fakeSource([job(0n), job(1n)]);
    const index = new JobIndex(f.source, noLog);
    await index.load();

    f.jobs.set(2n, job(2n, { next_run: 500n }));
    f.pages.push({
      events: [
        ev("job_created", 2n),
        ev("job_executed", 0n, { next_run: 1_060n, run: 1, fee: 10n }),
        ev("job_funded", 1n, { balance: 999n }),
        ev("job_active_set", 1n, { active: false }),
        ev("job_cancelled", 2n),
      ],
      latestLedger: 11,
      cursor: "next",
    });
    await index.sync();

    expect(index.get(0n)).toMatchObject({ nextRun: 1_060n, runs: 1, balance: 90n });
    expect(index.get(1n)).toMatchObject({ balance: 999n, active: false });
    expect(index.get(2n)).toBeUndefined();
  });

  it("costs one call per tick plus one per created or updated job, not per job", async () => {
    const all = Array.from({ length: 500 }, (_, i) => job(BigInt(i)));
    const f = fakeSource(all);
    const index = new JobIndex(f.source, noLog);
    await index.load();

    f.pages.push({ events: [ev("job_executed", 7n, { next_run: 2_000n, run: 1, fee: 10n })], latestLedger: 11, cursor: "x" });
    await index.sync();
    expect(index.lastSyncCalls).toBe(1);

    f.pages.push({ events: [ev("job_updated", 9n)], latestLedger: 12, cursor: "y" });
    await index.sync();
    expect(index.lastSyncCalls).toBe(2);
  });

  it("reloads everything when the event cursor has expired", async () => {
    const f = fakeSource([job(0n)]);
    const logs: string[] = [];
    const index = new JobIndex(f.source, (m) => logs.push(m));
    await index.load();

    f.jobs.set(1n, job(1n));
    f.pages.push(new Error("cursor is older than the retention window"));
    await index.sync();

    expect(index.size).toBe(2);
    expect(logs.some((l) => l.includes("reloading all jobs"))).toBe(true);
  });

  it("deactivated jobs drop out of the due list", async () => {
    const f = fakeSource([job(0n)]);
    const index = new JobIndex(f.source, noLog);
    await index.load();
    expect(index.due(1_000n).map((j) => j.id)).toEqual([0n]);
    f.pages.push({ events: [ev("job_deactivated", 0n, { failures: 3 })], latestLedger: 11, cursor: "z" });
    await index.sync();
    expect(index.due(1_000n)).toEqual([]);
  });
});

describe("mightBeDue", () => {
  const base = toIndexed(job(0n));
  it("mirrors the registry's own checks", () => {
    expect(mightBeDue(base, 1_000n)).toBe(true);
    expect(mightBeDue(base, 999n)).toBe(false);
    expect(mightBeDue({ ...base, active: false }, 1_000n)).toBe(false);
    expect(mightBeDue({ ...base, balance: 9n }, 1_000n)).toBe(false);
    expect(mightBeDue({ ...base, maxRuns: 2, runs: 2 }, 1_000n)).toBe(false);
    expect(mightBeDue({ ...base, endAt: 1_000n }, 1_000n)).toBe(false);
  });
});
