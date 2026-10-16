/**
 * Suggests a `fee_per_run` from current network costs (#138).
 *
 * A keeper pays the network for every run: the resources of the job's own
 * call, the registry's bookkeeping around it, and an inclusion fee. A job
 * whose fee doesn't cover that is skipped as unprofitable; one that pays far
 * more drains its deposit sooner than it needs to. `suggestFee` simulates
 * the job's call on its own, adds the registry's overhead and a recent
 * inclusion fee, and puts a margin on top.
 */
import { Account, Contract, Keypair, TransactionBuilder, rpc, type xdr } from "@stellar/stellar-sdk";

/**
 * Resource fee the registry adds to a run beyond the job's own call:
 * reading the job and keeper, paying the fee, updating the schedule and
 * stats, and the executor hop. Measured on testnet in October 2026: running
 * `counter.increment(1)` through `execute_batch` cost 19,829 stroops against
 * 7,609 for the call alone. Daily TTL extensions of the registry can cost a
 * run more than this; the margin is there for that.
 */
export const REGISTRY_OVERHEAD_STROOPS = 12_500n;

/** Default margin over break-even, in basis points (50%). */
export const DEFAULT_FEE_MARGIN_BPS = 5_000;

/** Suggestions round up to this, 0.001 XLM, so they read cleanly. */
const ROUND_TO = 10_000n;

export interface FeeSuggestion {
  /** Resource fee of the job's own call, simulated on its own. */
  targetStroops: bigint;
  /** The registry's own work per run (`REGISTRY_OVERHEAD_STROOPS` unless overridden). */
  overheadStroops: bigint;
  /** Recent 90th-percentile Soroban inclusion fee. */
  inclusionStroops: bigint;
  /** What a keeper pays to run the job once in a transaction of its own. */
  breakEvenStroops: bigint;
  /** Break-even plus the margin, rounded up to 0.001 XLM. */
  suggestedStroops: bigint;
}

export interface SuggestFeeOptions {
  /** Margin over break-even in basis points; default 5000 (50%). */
  marginBps?: number;
  overheadStroops?: bigint;
}

export interface JobCall {
  target: string;
  function: string;
  args: xdr.ScVal[];
}

/** The two RPC calls `suggestFee` makes, so tests can fake them. */
export type FeeRpc = Pick<rpc.Server, "simulateTransaction" | "getFeeStats">;

/** The job's call could not be simulated, so its cost is unknown. */
export class FeeEstimateError extends Error {
  constructor(readonly reason: string) {
    super(`Couldn't estimate what the call costs: ${reason}`);
    this.name = "FeeEstimateError";
  }
}

export async function suggestFee(
  server: FeeRpc,
  networkPassphrase: string,
  call: JobCall,
  options: SuggestFeeOptions = {},
): Promise<FeeSuggestion> {
  // Simulation needs a source account but never checks that it exists.
  const source = new Account(Keypair.random().publicKey(), "0");
  const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase })
    .addOperation(new Contract(call.target).call(call.function, ...call.args))
    .setTimeout(30)
    .build();
  const [simulation, stats] = await Promise.all([server.simulateTransaction(tx), server.getFeeStats()]);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new FeeEstimateError(simulation.error.split("\n")[0]);
  }

  const targetStroops = BigInt(simulation.minResourceFee);
  const overheadStroops = options.overheadStroops ?? REGISTRY_OVERHEAD_STROOPS;
  const inclusionStroops = BigInt(stats.sorobanInclusionFee.p90);
  const breakEvenStroops = targetStroops + overheadStroops + inclusionStroops;
  const margin = BigInt(options.marginBps ?? DEFAULT_FEE_MARGIN_BPS);
  const withMargin = (breakEvenStroops * (10_000n + margin) + 9_999n) / 10_000n;
  const suggestedStroops = ((withMargin + ROUND_TO - 1n) / ROUND_TO) * ROUND_TO;
  return { targetStroops, overheadStroops, inclusionStroops, breakEvenStroops, suggestedStroops };
}
