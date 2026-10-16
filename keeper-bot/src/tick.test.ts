import { describe, expect, it } from "vitest";
import { RestoreRequiredError, SoroCronError, UnexpectedAuthError, type Prepared } from "@sorocron/sdk";
import { Quarantine } from "./quarantine.js";
import { ChannelPool } from "./channels.js";
import { tick, type BatchClient, type DueSource, type FeeBidder, type TickDeps } from "./tick.js";

const due = (...ids: number[]) => ids.map((id) => ({ id: BigInt(id), feePerRun: 1_000_000n }));

function index(jobs: { id: bigint; feePerRun: bigint }[]): DueSource & { synced: number } {
  return {
    synced: 0,
    async sync() {
      this.synced++;
    },
    due: () => jobs,
  };
}

function fees(): FeeBidder & { escalations: number; resets: number } {
  return {
    escalations: 0,
    resets: 0,
    current: () => 200,
    escalate() {
      this.escalations++;
    },
    reset() {
      this.resets++;
    },
  };
}

/** A channel whose simulation runs every job in `runnable`. */
function channel(
  runnable: (id: bigint) => boolean,
  opts: {
    resourceFee?: bigint | ((ids: bigint[]) => bigint);
    send?: () => Promise<{ hash: string }>;
    log?: bigint[][];
  } = {},
): BatchClient {
  return {
    async prepareExecuteBatch(ids) {
      opts.log?.push(ids);
      const result = ids.map(runnable);
      const prepared: Prepared<boolean[]> = {
        result,
        resourceFee: typeof opts.resourceFee === "function" ? opts.resourceFee(ids) : (opts.resourceFee ?? 100_000n),
        send: async () => ({ hash: "h", result, ...(opts.send ? await opts.send() : {}) }),
      };
      return prepared;
    },
  };
}

function deps(over: Partial<TickDeps> & Pick<TickDeps, "index" | "channels">): TickDeps & { lines: string[] } {
  const lines: string[] = [];
  return { fees: fees(), keeper: "GKEEPER", log: (m) => lines.push(m), batchSize: 2, feeIsNative: true, lines, ...over };
}

describe("tick", () => {
  it("splits due jobs into batches and executes what simulation says will run", async () => {
    const log: bigint[][] = [];
    const d = deps({
      index: index(due(1, 2, 3, 4, 5)),
      channels: new ChannelPool([channel((id) => id !== 4n, { log })]),
    });
    const summary = await tick(d, 1_000n);

    expect(log).toEqual([[1n, 2n], [3n, 4n], [5n]]);
    expect(summary).toMatchObject({ due: 5, batches: 3, executed: 4, skipped: 1, failed: 0, earnedStroops: 4_000_000n });
  });

  it("does not send a batch where nothing would run", async () => {
    let sends = 0;
    const d = deps({
      index: index(due(1, 2)),
      channels: new ChannelPool([channel(() => false, { send: async () => (sends++, { hash: "" }) })]),
    });
    const summary = await tick(d, 1_000n);
    expect(sends).toBe(0);
    expect(summary).toMatchObject({ batches: 0, skipped: 2, executed: 0 });
  });

  it("skips batches that cost more than they earn", async () => {
    const d = deps({
      index: index(due(1)),
      channels: new ChannelPool([channel(() => true, { resourceFee: 5_000_000n })]),
      minProfitStroops: 0n,
    });
    const summary = await tick(d, 1_000n);
    expect(summary).toMatchObject({ unprofitable: 1, executed: 0 });
    expect(d.lines[0]).toContain("unprofitable");
  });

  it("escalates the fee bid when a send fails for fee reasons, resets on success", async () => {
    const bidder = fees();
    let attempt = 0;
    const flaky = channel(() => true, {
      send: async () => {
        attempt++;
        if (attempt === 1) throw new Error("txInsufficientFee");
        return { hash: "ok" };
      },
    });
    const d = deps({ index: index(due(1)), channels: new ChannelPool([flaky]), fees: bidder, batchSize: 1 });
    const first = await tick(d, 1_000n);
    expect(first).toMatchObject({ failed: 1, executed: 0 });
    expect(bidder.escalations).toBe(1);

    const second = await tick(d, 1_000n);
    expect(second).toMatchObject({ executed: 1 });
    expect(bidder.resets).toBe(1);
  });

  it("rebuilds and resends once after a stale sequence number", async () => {
    let attempt = 0;
    const d = deps({
      index: index(due(1)),
      channels: new ChannelPool([
        channel(() => true, {
          send: async () => {
            attempt++;
            if (attempt === 1) throw new Error("txBadSeq");
            return { hash: "ok" };
          },
        }),
      ]),
    });
    const summary = await tick(d, 1_000n);
    expect(summary).toMatchObject({ executed: 1, failed: 0 });
    expect(attempt).toBe(2);
  });

  it("runs batches in parallel across channels", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = () =>
      channel(() => true, {
        send: async () => {
          peak = Math.max(peak, ++inFlight);
          await new Promise((r) => setTimeout(r, 10));
          inFlight--;
          return { hash: "h" };
        },
      });
    const d = deps({ index: index(due(1, 2, 3, 4, 5, 6)), channels: new ChannelPool([slow(), slow(), slow()]) });
    const summary = await tick(d, 1_000n);
    expect(summary.executed).toBe(6);
    expect(peak).toBe(3);
  });

  it("a simulation error skips the batch without stopping the tick", async () => {
    const broken: BatchClient = {
      prepareExecuteBatch: async () => Promise.reject(new Error("Error(Contract, #12)")),
    };
    const d = deps({ index: index(due(1, 2)), channels: new ChannelPool([broken]) });
    const summary = await tick(d, 1_000n);
    expect(summary).toMatchObject({ skipped: 2, executed: 0 });
  });

  describe("archived state (#111)", () => {
    /** A channel whose first simulation needs a restore costing `fee`. */
    function archived(fee: bigint, restore: () => Promise<{ hash: string }>) {
      const inner = channel(() => true);
      let restored = false;
      const calls = { restores: 0 };
      const client: BatchClient = {
        async prepareExecuteBatch(ids, keeper) {
          if (!restored) {
            throw new RestoreRequiredError(fee, async () => {
              calls.restores++;
              const r = await restore();
              restored = true;
              return r;
            });
          }
          return inner.prepareExecuteBatch(ids, keeper);
        },
      };
      return { client, calls };
    }

    it("doesn't restore unless MAX_RESTORE_FEE_STROOPS allows it", async () => {
      const { client, calls } = archived(5_000n, async () => ({ hash: "r" }));
      const d = deps({ index: index(due(1)), channels: new ChannelPool([client]) });
      const summary = await tick(d, 0n);
      expect(calls.restores).toBe(0);
      expect(summary).toMatchObject({ skipped: 1, executed: 0, restores: 0 });
      expect(d.lines.join(" | ")).toMatch(/set MAX_RESTORE_FEE_STROOPS/);
    });

    it("restores within the limit and runs the job in the same tick", async () => {
      const { client, calls } = archived(5_000n, async () => ({ hash: "r" }));
      const d = deps({ index: index(due(1)), channels: new ChannelPool([client]), maxRestoreFee: 5_000n });
      const summary = await tick(d, 0n);
      expect(calls.restores).toBe(1);
      expect(summary).toMatchObject({ executed: 1, skipped: 0, restores: 1, restoreFeeStroops: 5_000n });
      expect(d.lines[0]).toMatch(/restored archived state for ~5000 stroops/);
    });

    it("never pays more than the limit for a restore", async () => {
      const { client, calls } = archived(5_001n, async () => ({ hash: "r" }));
      const d = deps({ index: index(due(1)), channels: new ChannelPool([client]), maxRestoreFee: 5_000n });
      const summary = await tick(d, 0n);
      expect(calls.restores).toBe(0);
      expect(summary).toMatchObject({ skipped: 1, restores: 0 });
      expect(d.lines.join(" | ")).toMatch(/above MAX_RESTORE_FEE_STROOPS \(5000\)/);
    });

    it("skips the batch when the restore itself fails", async () => {
      const { client } = archived(5_000n, async () => {
        throw new Error("Restore transaction failed");
      });
      const d = deps({ index: index(due(1)), channels: new ChannelPool([client]), maxRestoreFee: 10_000n });
      const summary = await tick(d, 0n);
      expect(summary).toMatchObject({ skipped: 1, executed: 0, restores: 0 });
      expect(d.lines.join(" | ")).toMatch(/Restore transaction failed/);
    });

    it("never restores in a dry run", async () => {
      const { client, calls } = archived(5_000n, async () => ({ hash: "r" }));
      const d = deps({ index: index(due(1)), channels: new ChannelPool([client]), maxRestoreFee: 10_000n, dryRun: true });
      const summary = await tick(d, 0n);
      expect(calls.restores).toBe(0);
      expect(summary).toMatchObject({ skipped: 1, restores: 0, dryRun: 0 });
      expect(d.lines.join(" | ")).toMatch(/would restore archived state first \(~5000 stroops\)/);
    });
  });

  describe("one bad job", () => {
    const BUDGET = "Transaction simulation failed: HostError: Error(Budget, ExceededLimit)";

    /** A channel whose simulation fails as a whole whenever `bad` is in the batch. */
    function poisoned(bad: bigint, error: () => Error, calls: bigint[][] = []): BatchClient {
      const inner = channel(() => true);
      return {
        async prepareExecuteBatch(ids, keeper) {
          calls.push(ids);
          if (ids.includes(bad)) throw error();
          return inner.prepareExecuteBatch(ids, keeper);
        },
      };
    }

    it("isolates a job that exhausts the budget, runs the rest and sets it aside", async () => {
      const calls: bigint[][] = [];
      const quarantine = new Quarantine(30);
      const d = deps({
        index: index(due(1, 2, 3, 4)),
        channels: new ChannelPool([poisoned(3n, () => new Error(BUDGET), calls)]),
        batchSize: 4,
        quarantine,
      });
      const first = await tick(d, 0n);
      expect(first).toMatchObject({ due: 4, executed: 3, skipped: 1, quarantined: 1 });
      expect(quarantine.has(3n)).toBe(true);

      // Next tick the bad job isn't simulated at all.
      calls.length = 0;
      const second = await tick(d, 0n);
      expect(calls.flat()).not.toContain(3n);
      expect(second).toMatchObject({ executed: 3, skipped: 1, quarantined: 1 });
    });

    it("never sends a job that asks for the keeper's authorization", async () => {
      const quarantine = new Quarantine(30);
      const sent: bigint[][] = [];
      const inner = channel(() => true);
      const client: BatchClient = {
        async prepareExecuteBatch(ids, keeper) {
          if (ids.includes(2n)) throw new UnexpectedAuthError("transfer on CTOKEN inside the execute_batch call");
          const prepared = await inner.prepareExecuteBatch(ids, keeper);
          return { ...prepared, send: async () => (sent.push(ids), prepared.send()) };
        },
      };
      const d = deps({ index: index(due(1, 2, 3)), channels: new ChannelPool([client]), batchSize: 3, quarantine });
      const summary = await tick(d, 0n);
      expect(sent.flat()).not.toContain(2n);
      expect(summary).toMatchObject({ executed: 2, quarantined: 1 });
      expect(d.lines.join(" | ")).toMatch(/job 2: set aside \(Refusing to sign/);
    });

    it("doesn't split or quarantine on registry-wide errors", async () => {
      const calls: bigint[][] = [];
      const quarantine = new Quarantine(30);
      const client: BatchClient = {
        async prepareExecuteBatch(ids) {
          calls.push(ids);
          throw new SoroCronError(1, "Paused", "The registry is paused by its admin.");
        },
      };
      const d = deps({ index: index(due(1, 2, 3, 4)), channels: new ChannelPool([client]), batchSize: 4, quarantine });
      const summary = await tick(d, 0n);
      expect(calls).toHaveLength(1);
      expect(summary).toMatchObject({ skipped: 4, quarantined: 0 });
      expect(quarantine.size).toBe(0);
    });

    it("caps the network cost per job when fees aren't paid in XLM", async () => {
      const d = deps({
        index: index(due(1, 2)),
        channels: new ChannelPool([channel(() => true, { resourceFee: 50_000_000n })]),
        feeIsNative: false,
        maxCostPerJob: 10_000_000n,
      });
      const summary = await tick(d, 0n);
      expect(summary).toMatchObject({ unprofitable: 2, executed: 0 });
      expect(d.lines[0]).toMatch(/too costly/);
    });

    it("lets a quarantined job try again later", () => {
      const q = new Quarantine(2);
      q.add(7n);
      q.next();
      expect(q.has(7n)).toBe(true);
      q.next();
      expect(q.has(7n)).toBe(false);
    });
  });

  describe("expensive jobs", () => {
    // Job 3 costs 30 XLM to run; the others 0.01 XLM. Each pays 0.1 XLM.
    const costs = (ids: bigint[]) => ids.reduce((sum, id) => sum + (id === 3n ? 300_000_000n : 100_000n), 0n);

    it("runs the jobs that pay for themselves when one makes the batch unprofitable", async () => {
      const sims: bigint[][] = [];
      const d = deps({
        index: index(due(1, 2, 3, 4)),
        channels: new ChannelPool([channel(() => true, { resourceFee: costs, log: sims })]),
        batchSize: 4,
      });
      const summary = await tick(d, 0n);
      expect(sims).toEqual([[1n, 2n, 3n, 4n], [1n, 2n], [3n, 4n], [3n], [4n]]);
      expect(summary).toMatchObject({ due: 4, batches: 2, executed: 3, unprofitable: 1, skipped: 0 });
      expect(d.lines).toContain("jobs 3: unprofitable (earns 1000000, costs ~300000200 stroops)");
    });

    it("splits only the jobs simulation says would run", async () => {
      const sims: bigint[][] = [];
      const d = deps({
        index: index(due(1, 2, 3)),
        channels: new ChannelPool([channel((id) => id !== 1n, { resourceFee: costs, log: sims })]),
        batchSize: 3,
      });
      const summary = await tick(d, 0n);
      expect(sims).toEqual([[1n, 2n, 3n], [2n], [3n]]);
      expect(summary).toMatchObject({ executed: 1, unprofitable: 1, skipped: 1 });
    });
  });

  describe("dry run (#113)", () => {
    it("simulates and logs what would run, and never sends", async () => {
      let sends = 0;
      const d = deps({
        index: index(due(1, 2, 3)),
        channels: new ChannelPool([
          channel((id) => id !== 2n, { resourceFee: 250_000n, send: async () => (sends++, { hash: "x" }) }),
        ]),
        batchSize: 3,
        dryRun: true,
      });
      const summary = await tick(d, 0n);
      expect(sends).toBe(0);
      expect(summary).toMatchObject({ due: 3, batches: 0, executed: 0, skipped: 1, dryRun: 2, earnedStroops: 0n });
      expect(d.lines).toEqual(["jobs 1,3: would execute (earns 2000000, costs ~250200 stroops)"]);
    });

    it("still reports jobs that wouldn't pay", async () => {
      const d = deps({
        index: index(due(1)),
        channels: new ChannelPool([channel(() => true, { resourceFee: 5_000_000n })]),
        dryRun: true,
      });
      const summary = await tick(d, 0n);
      expect(summary).toMatchObject({ unprofitable: 1, dryRun: 0 });
    });
  });
});
