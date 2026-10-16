import { describe, expect, it } from "vitest";
import { Networks, nativeToScVal, type rpc } from "@stellar/stellar-sdk";
import { FeeEstimateError, REGISTRY_OVERHEAD_STROOPS, suggestFee, type FeeRpc } from "./fees.js";

const COUNTER = "CBYUUVNSCHQ7Q4X5XCPOP76UBDEXA6LO54F27LLXAZH5VMNXIN73MB7W";
const call = { target: COUNTER, function: "increment", args: [nativeToScVal(1, { type: "u32" })] };

/** An RPC whose simulation costs `minResourceFee` (or fails) and whose p90 inclusion fee is `p90`. */
function fakeRpc(sim: { minResourceFee: string } | { error: string }, p90 = "100") {
  const seen: { ops: number; type: string }[] = [];
  const server = {
    async simulateTransaction(tx: { operations: { type: string }[] }) {
      seen.push({ ops: tx.operations.length, type: tx.operations[0].type });
      return { id: "1", latestLedger: 1, _parsed: true, ...sim } as unknown as rpc.Api.SimulateTransactionResponse;
    },
    async getFeeStats() {
      return { sorobanInclusionFee: { p90 } } as rpc.Api.GetFeeStatsResponse;
    },
  };
  return { server: server as unknown as FeeRpc, seen };
}

describe("suggestFee (#138)", () => {
  it("adds the call's cost, the registry's overhead and the inclusion fee, plus a margin", async () => {
    const { server, seen } = fakeRpc({ minResourceFee: "7609" }, "250");
    const s = await suggestFee(server, Networks.TESTNET, call);
    expect(seen).toEqual([{ ops: 1, type: "invokeHostFunction" }]);
    expect(s).toEqual({
      targetStroops: 7_609n,
      overheadStroops: REGISTRY_OVERHEAD_STROOPS,
      inclusionStroops: 250n,
      breakEvenStroops: 7_609n + REGISTRY_OVERHEAD_STROOPS + 250n,
      // 20,359 × 1.5 = 30,538.5, rounded up to 0.001 XLM.
      suggestedStroops: 40_000n,
    });
  });

  it("takes a margin and overhead of your own, and rounds up to 0.001 XLM", async () => {
    const { server } = fakeRpc({ minResourceFee: "20000" });
    const exact = await suggestFee(server, Networks.TESTNET, call, { marginBps: 0, overheadStroops: 0n });
    expect(exact.breakEvenStroops).toBe(20_100n);
    expect(exact.suggestedStroops).toBe(30_000n);
    const generous = await suggestFee(server, Networks.TESTNET, call, { marginBps: 30_000, overheadStroops: 9_900n });
    expect(generous.suggestedStroops).toBe(120_000n);
  });

  it("explains a call that can't be simulated", async () => {
    const { server } = fakeRpc({ error: "HostError: Error(WasmVm, MissingValue)\nmore detail" });
    const err = await suggestFee(server, Networks.TESTNET, call).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeeEstimateError);
    expect((err as FeeEstimateError).message).toBe("Couldn't estimate what the call costs: HostError: Error(WasmVm, MissingValue)");
  });
});
