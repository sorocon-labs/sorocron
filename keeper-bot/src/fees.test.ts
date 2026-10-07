import { describe, expect, it } from "vitest";
import { FeeStrategy, MIN_FEE, isFeeRelated, type FeeDistribution } from "./fees.js";

function stats(overrides: Partial<FeeDistribution> = {}): { sorobanInclusionFee: FeeDistribution } {
  const d = {
    min: "100",
    max: "50000",
    mode: "100",
    p10: "100",
    p20: "100",
    p30: "100",
    p40: "120",
    p50: "150",
    p60: "200",
    p70: "300",
    p80: "500",
    p90: "1000",
    p95: "2500",
    p99: "10000",
    ...overrides,
  };
  return { sorobanInclusionFee: d };
}

describe("FeeStrategy", () => {
  it("bids the configured percentile of recent fees", async () => {
    const fees = new FeeStrategy({ getFeeStats: async () => stats() }, { percentile: "p70" });
    expect(fees.current()).toBe(MIN_FEE); // before any stats
    await fees.refresh();
    expect(fees.current()).toBe(300);
  });

  it("escalates step by step after failures, capped by maxFee, and resets on success", async () => {
    const fees = new FeeStrategy({ getFeeStats: async () => stats() }, { percentile: "p70", maxFee: 20_000 });
    await fees.refresh();
    const bids = [fees.current()];
    for (let i = 0; i < 5; i++) {
      fees.escalate();
      bids.push(fees.current());
    }
    expect(bids).toEqual([300, 1_000, 2_500, 10_000, 20_000, 20_000]);
    fees.reset();
    expect(fees.current()).toBe(300);
  });

  it("follows the network as fees rise and fall", async () => {
    let current = stats();
    const fees = new FeeStrategy({ getFeeStats: async () => current }, { percentile: "p50" });
    await fees.refresh();
    expect(fees.current()).toBe(150);
    current = stats({ p50: "4000" }); // congestion
    await fees.refresh();
    expect(fees.current()).toBe(4_000);
    current = stats({ p50: "100" });
    await fees.refresh();
    expect(fees.current()).toBe(100);
  });

  it("keeps the last known stats when the RPC call fails", async () => {
    let fail = false;
    const fees = new FeeStrategy({
      getFeeStats: async () => {
        if (fail) throw new Error("rpc down");
        return stats();
      },
    });
    await fees.refresh();
    fail = true;
    await fees.refresh();
    expect(fees.current()).toBe(300);
  });

  it("never bids below the network minimum", async () => {
    const fees = new FeeStrategy({ getFeeStats: async () => stats({ p70: "3" }) });
    await fees.refresh();
    expect(fees.current()).toBe(MIN_FEE);
  });

  it("recognises fee-related failures", () => {
    expect(isFeeRelated(new Error("txInsufficientFee"))).toBe(true);
    expect(isFeeRelated(new Error("transaction timed out"))).toBe(true);
    expect(isFeeRelated(new Error("Error(Contract, #7)"))).toBe(false);
  });
});
