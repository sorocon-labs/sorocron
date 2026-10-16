import { describe, expect, it } from "vitest";
import type { EventPage, FetchEventsOptions, RegistryEvent } from "@sorocron/sdk";
import { describeJobEvent, isJobEvent, jobEventJson, watchJob, type EventSource } from "./watch.js";

const KEEPER = "GA3MGO7TF2Y4KIUEMD7CHD4KMHLVOF5WF7R2UBI4LTPVAG7KSDNVNF53";

let nextId = 0;
const event = (name: string, topics: unknown[], data: Record<string, unknown>, ledger = 100): RegistryEvent => ({
  name,
  topics,
  data,
  ledger,
  closedAt: "2026-10-16T05:00:00Z",
  txHash: `tx${nextId}`,
  id: `id${nextId++}`,
});

const executed = (job: bigint, run: number, lateness = 0n) =>
  event("job_executed", [job, KEEPER], {
    success: true,
    fee: 1_000_000n,
    protocol_fee: 0n,
    run,
    next_run: 1_800_000_000n,
    lateness,
    failures: 0,
  });

/** Serves `pages` in order, then empty pages; records each request. */
function source(pages: RegistryEvent[][], latest = 500): EventSource & { requests: FetchEventsOptions[] } {
  const requests: FetchEventsOptions[] = [];
  let i = 0;
  return {
    requests,
    latestLedger: async () => latest,
    async events(options): Promise<EventPage> {
      requests.push(options);
      const events = pages[i++] ?? [];
      return { events, latestLedger: latest, cursor: events.at(-1)?.id ?? options.cursor };
    },
  };
}

describe("jobs watch (#133)", () => {
  it("describes runs, funding, pausing and cancellation", () => {
    expect(describeJobEvent(executed(7n, 4, 95n))).toBe(
      "run 4 succeeded by GA3M…NF53, fee 0.1 XLM, 1m 35s late, next run 2027-01-15T08:00:00.000Z",
    );
    expect(describeJobEvent(executed(7n, 5))).toContain("on time");
    expect(describeJobEvent(event("job_funded", [7n], { from: KEEPER, amount: 50_000_000n, balance: 80_000_000n }))).toBe(
      "funded 5 XLM by GA3M…NF53, balance 8 XLM",
    );
    expect(describeJobEvent(event("job_deactivated", [7n], { failures: 3 }))).toBe("paused itself after 3 failed runs in a row");
    expect(describeJobEvent(event("job_active_set", [7n], { active: false }))).toBe("paused by its owner");
    expect(describeJobEvent(event("job_cancelled", [7n], { refund: 20_000_000n }))).toBe("cancelled, 2 XLM refunded");
  });

  it("picks out one job's events, including missed windows", () => {
    expect(isJobEvent(executed(7n, 1), 7n)).toBe(true);
    expect(isJobEvent(executed(8n, 1), 7n)).toBe(false);
    expect(isJobEvent(event("keeper_staked", [KEEPER], { amount: 1n, total: 1n }), 7n)).toBe(false);
    expect(isJobEvent(event("keeper_missed_window", [KEEPER], { job_id: 7n, ran_by: KEEPER }), 7n)).toBe(true);
  });

  it("starts at the latest ledger, follows the cursor and prints only the job's events", async () => {
    const src = source([[executed(8n, 1), executed(7n, 1)], [], [executed(7n, 2)]]);
    const seen: RegistryEvent[] = [];
    let polls = 0;
    const printed = await watchJob(src, 7n, {
      pollMs: 5_000,
      print: (e) => seen.push(e),
      sleep: async () => {
        polls++;
      },
      stopped: () => polls >= 3,
    });
    expect(printed).toBe(2);
    expect(seen.map((e) => e.data.run)).toEqual([1, 2]);
    expect(src.requests[0]).toEqual({ startLedger: 500 });
    expect(src.requests[1]).toEqual({ cursor: seen[0].id });
  });

  it("replays from --from-ledger and stops once the job is cancelled", async () => {
    const src = source([[executed(7n, 1), event("job_cancelled", [7n], { refund: 0n }), executed(7n, 2)]]);
    const seen: string[] = [];
    const printed = await watchJob(src, 7n, {
      fromLedger: 42,
      pollMs: 1,
      print: (e) => seen.push(e.name),
      sleep: async () => {},
      stopped: () => false,
    });
    expect(src.requests[0]).toEqual({ startLedger: 42 });
    expect(printed).toBe(2);
    expect(seen).toEqual(["job_executed", "job_cancelled"]);
  });

  it("prints JSON lines with the event's data", () => {
    expect(jobEventJson(executed(7n, 3))).toMatchObject({ event: "job_executed", ledger: 100, run: 3, success: true, fee: 1_000_000n });
  });
});
