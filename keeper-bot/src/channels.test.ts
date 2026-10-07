import { describe, expect, it } from "vitest";
import { ChannelPool, isSequenceError, withSequenceRetry } from "./channels.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ChannelPool", () => {
  it("runs as many tasks at once as there are channels, never two on one channel", async () => {
    const pool = new ChannelPool(["a", "b", "c"]);
    const inFlight = new Map<string, number>();
    let peak = 0;
    const used: string[] = [];

    await Promise.all(
      Array.from({ length: 9 }, () =>
        pool.run(async (channel) => {
          inFlight.set(channel, (inFlight.get(channel) ?? 0) + 1);
          expect(inFlight.get(channel)).toBe(1);
          peak = Math.max(peak, [...inFlight.values()].reduce((a, b) => a + b, 0));
          used.push(channel);
          await sleep(5);
          inFlight.set(channel, inFlight.get(channel)! - 1);
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(used).toHaveLength(9);
    expect(new Set(used)).toEqual(new Set(["a", "b", "c"]));
    expect(pool.available).toBe(3);
  });

  it("releases the channel when a task throws", async () => {
    const pool = new ChannelPool(["only"]);
    await expect(pool.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await pool.run(async (c) => c)).toBe("only");
  });

  it("rejects an empty pool", () => {
    expect(() => new ChannelPool([])).toThrow();
  });
});

describe("sequence recovery", () => {
  it("retries once on a stale sequence number", async () => {
    let attempts = 0;
    const result = await withSequenceRetry(async () => {
      attempts++;
      if (attempts === 1) throw new Error("txBadSeq");
      return "sent";
    });
    expect([result, attempts]).toEqual(["sent", 2]);
  });

  it("does not retry other errors", async () => {
    let attempts = 0;
    await expect(
      withSequenceRetry(async () => {
        attempts++;
        throw new Error("Error(Contract, #7)");
      }),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
    expect(isSequenceError(new Error("tx_bad_seq"))).toBe(true);
  });
});
