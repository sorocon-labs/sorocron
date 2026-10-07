import { describe, expect, it } from "vitest";
import type { Prepared } from "@sorocron/sdk";
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
  opts: { resourceFee?: bigint; send?: () => Promise<{ hash: string }>; log?: bigint[][] } = {},
): BatchClient {
  return {
    async prepareExecuteBatch(ids) {
      opts.log?.push(ids);
      const result = ids.map(runnable);
      const prepared: Prepared<boolean[]> = {
        result,
        resourceFee: opts.resourceFee ?? 100_000n,
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
});
