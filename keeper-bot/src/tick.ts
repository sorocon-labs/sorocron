/**
 * One polling pass: bring the job index up to date, take the jobs that may
 * be due, and execute them in batches (#33).
 *
 * Each batch of up to `batchSize` jobs is simulated first with
 * `execute_batch`, which reports exactly which jobs would run (resolvers,
 * dependencies and assigned keeper windows included) and what the
 * transaction costs. Batches where nothing would run, or that would cost
 * more than they earn, are not sent. Batches go out in parallel, one per
 * free channel account (see channels.ts).
 *
 * Typed against narrow interfaces rather than the SDK client so it can be
 * tested with fakes.
 */
import type { Prepared } from "@sorocron/sdk";
import { isSequenceError, type ChannelPool } from "./channels.js";
import { isFeeRelated } from "./fees.js";
import type { Logger } from "./logger.js";

export interface BatchClient {
  inclusionFee?: number;
  prepareExecuteBatch(jobIds: bigint[], keeper?: string): Promise<Prepared<boolean[]>>;
}

export interface DueSource {
  sync(): Promise<void>;
  due(now: bigint): { id: bigint; feePerRun: bigint }[];
}

export interface FeeBidder {
  current(): number;
  escalate(): void;
  reset(): void;
}

export interface TickDeps {
  index: DueSource;
  channels: ChannelPool<BatchClient>;
  fees: FeeBidder;
  /** The staked keeper that gets paid. */
  keeper: string;
  log: Logger;
  batchSize: number;
  /** Minimum earnings minus network cost, in stroops, to send a batch. */
  minProfitStroops?: bigint;
  /** Profit is only checked when job fees are paid in XLM, like the network fee. */
  feeIsNative?: boolean;
  /** Base URL for transaction links in logs. */
  explorer?: string;
}

/** What one tick did, for metrics. Every due job lands in exactly one bucket. */
export interface TickSummary {
  /** Jobs the index considered due before simulation. */
  due: number;
  batches: number;
  executed: number;
  /** Not runnable on simulation (resolver, window, dependency, already run). */
  skipped: number;
  unprofitable: number;
  /** Runnable but the transaction failed. */
  failed: number;
  /** Fees earned by executed jobs, in stroops (before the protocol fee). */
  earnedStroops: bigint;
}

const firstLine = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0];

export async function tick(deps: TickDeps, now: bigint): Promise<TickSummary> {
  await deps.index.sync();
  const due = deps.index.due(now);
  const summary: TickSummary = {
    due: due.length,
    batches: 0,
    executed: 0,
    skipped: 0,
    unprofitable: 0,
    failed: 0,
    earnedStroops: 0n,
  };

  const batches: { id: bigint; feePerRun: bigint }[][] = [];
  for (let i = 0; i < due.length; i += deps.batchSize) batches.push(due.slice(i, i + deps.batchSize));

  await Promise.all(
    batches.map((batch) =>
      deps.channels.run(async (client) => {
        const ids = batch.map((j) => j.id);
        const label = `jobs ${ids.join(",")}`;
        client.inclusionFee = deps.fees.current();

        let prepared: Prepared<boolean[]>;
        try {
          prepared = await client.prepareExecuteBatch(ids, deps.keeper);
        } catch (err) {
          deps.log(`${label}: skipped (${firstLine(err)})`);
          summary.skipped += batch.length;
          return;
        }
        const runnable = batch.filter((_, i) => prepared.result[i]);
        summary.skipped += batch.length - runnable.length;
        if (runnable.length === 0) return;

        const earned = runnable.reduce((sum, j) => sum + j.feePerRun, 0n);
        if (deps.feeIsNative) {
          const cost = prepared.resourceFee + BigInt(client.inclusionFee ?? 0);
          if (earned - cost < (deps.minProfitStroops ?? 0n)) {
            deps.log(`${label}: unprofitable (earns ${earned}, costs ~${cost} stroops)`);
            summary.unprofitable += runnable.length;
            return;
          }
        }

        summary.batches += 1;
        try {
          // A stale sequence number (the account was used elsewhere) gets one
          // fresh attempt, rebuilt and re-simulated.
          const sent = await prepared
            .send()
            .catch(async (err) =>
              isSequenceError(err) ? (await client.prepareExecuteBatch(ids, deps.keeper)).send() : Promise.reject(err),
            );
          deps.fees.reset();
          summary.executed += runnable.length;
          summary.earnedStroops += earned;
          const link = sent.hash && deps.explorer ? ` ${deps.explorer}/tx/${sent.hash}` : "";
          deps.log(`executed ${runnable.map((j) => j.id).join(",")}${link}`);
        } catch (err) {
          if (isFeeRelated(err)) deps.fees.escalate();
          // Another keeper may have run them first; that's expected.
          deps.log(`${label}: send failed (${firstLine(err)})`);
          summary.failed += runnable.length;
        }
      }),
    ),
  );
  return summary;
}
