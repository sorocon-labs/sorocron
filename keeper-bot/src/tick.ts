/**
 * One polling pass: bring the job index up to date, take the jobs that may
 * be due, and execute them in batches (#33).
 *
 * Each batch of up to `batchSize` jobs is simulated first with
 * `execute_batch`, which reports exactly which jobs would run (resolvers,
 * dependencies and assigned keeper windows included) and what the
 * transaction costs. Batches where nothing would run are not sent, and
 * batches that would cost more than they earn are split so an expensive job
 * doesn't hold back cheap ones. Batches go out in parallel, one per free
 * channel account (see channels.ts).
 *
 * With `dryRun` nothing is restored, signed or sent: the tick logs what it
 * would execute, with expected earnings and costs (#113).
 *
 * Typed against narrow interfaces rather than the SDK client so it can be
 * tested with fakes.
 */
import { SoroCronError, isRestoreRequired, isUnexpectedAuth, type Prepared } from "@sorocron/sdk";
import { isSequenceError, type ChannelPool } from "./channels.js";
import { isFeeRelated } from "./fees.js";
import type { Logger } from "./logger.js";
import type { Quarantine } from "./quarantine.js";

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
  /**
   * Restore archived state a batch needs when the restore's resource fee is
   * at most this, in stroops. 0 or unset never restores (#111).
   */
  maxRestoreFee?: bigint;
  /**
   * When jobs pay in a token other than XLM, the profit check can't compare
   * fees with the network cost, so batches costing more than this per job,
   * in stroops, aren't sent. 0 or unset sends any batch.
   */
  maxCostPerJob?: bigint;
  /** Jobs set aside after failing on their own; see quarantine.ts. */
  quarantine?: Quarantine;
  /** Simulate only: log what would run and never restore, sign or send. */
  dryRun?: boolean;
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
  /** Archived-state restores sent, and their resource fees in stroops. */
  restores: number;
  restoreFeeStroops: bigint;
  /** Due jobs set aside this tick or still sitting out (counted in `skipped` too). */
  quarantined: number;
  /** Runnable and worth sending, but not sent because of `dryRun`. */
  dryRun: number;
}

/** A failure that belongs to one job in the batch, not to the registry or network. */
class JobProblem extends Error {}

/**
 * Whether a failed batch should be split to find the job causing it:
 * simulation failures (a job exhausting the budget), a job asking for the
 * keeper's authorization, or a restore the keeper won't pay for. Registry
 * errors (paused, keeper not staked) and network errors affect every job,
 * so splitting wouldn't help.
 */
function isJobSpecific(err: unknown): boolean {
  if (err instanceof SoroCronError) return false;
  if (err instanceof JobProblem || isUnexpectedAuth(err)) return true;
  return /simulation failed/i.test(err instanceof Error ? err.message : String(err));
}

const firstLine = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0];

export async function tick(deps: TickDeps, now: bigint): Promise<TickSummary> {
  await deps.index.sync();
  deps.quarantine?.next();
  const allDue = deps.index.due(now);
  const due = allDue.filter((j) => !deps.quarantine?.has(j.id));
  const summary: TickSummary = {
    due: allDue.length,
    batches: 0,
    executed: 0,
    skipped: allDue.length - due.length,
    unprofitable: 0,
    failed: 0,
    earnedStroops: 0n,
    restores: 0,
    restoreFeeStroops: 0n,
    quarantined: allDue.length - due.length,
    dryRun: 0,
  };
  const link = (hash: string) => (hash && deps.explorer ? ` ${deps.explorer}/tx/${hash}` : "");

  /**
   * Simulates a batch. When a target's state was archived, restores it
   * first if that costs no more than `maxRestoreFee`, then simulates again.
   */
  const prepare = async (client: BatchClient, ids: bigint[], label: string): Promise<Prepared<boolean[]>> => {
    try {
      return await client.prepareExecuteBatch(ids, deps.keeper);
    } catch (err) {
      if (!isRestoreRequired(err)) throw err;
      const max = deps.maxRestoreFee ?? 0n;
      if (max === 0n) throw new JobProblem(`archived state needs a restore (~${err.fee} stroops); set MAX_RESTORE_FEE_STROOPS to allow it`);
      if (err.fee > max) throw new JobProblem(`archived state needs a restore (~${err.fee} stroops), above MAX_RESTORE_FEE_STROOPS (${max})`);
      if (deps.dryRun) throw new Error(`would restore archived state first (~${err.fee} stroops)`);
      const { hash } = await err.restore();
      summary.restores += 1;
      summary.restoreFeeStroops += err.fee;
      deps.log(`${label}: restored archived state for ~${err.fee} stroops${link(hash)}`);
      return client.prepareExecuteBatch(ids, deps.keeper);
    }
  };

  const batches: { id: bigint; feePerRun: bigint }[][] = [];
  for (let i = 0; i < due.length; i += deps.batchSize) batches.push(due.slice(i, i + deps.batchSize));

  /**
   * Simulates and sends one batch. A batch that fails because of one of its
   * jobs is split in half until that job is alone, so it can't hold up the
   * others; the job is then quarantined. An unprofitable batch is split the
   * same way, so jobs that pay for themselves still run.
   */
  const runBatch = async (client: BatchClient, batch: { id: bigint; feePerRun: bigint }[]): Promise<void> => {
    const ids = batch.map((j) => j.id);
    const label = `jobs ${ids.join(",")}`;
    client.inclusionFee = deps.fees.current();

    let prepared: Prepared<boolean[]>;
    try {
      prepared = await prepare(client, ids, label);
    } catch (err) {
      if (isJobSpecific(err) && batch.length > 1) {
        const half = Math.ceil(batch.length / 2);
        await runBatch(client, batch.slice(0, half));
        await runBatch(client, batch.slice(half));
        return;
      }
      if (isJobSpecific(err) && deps.quarantine) {
        deps.quarantine.add(batch[0].id);
        summary.quarantined += 1;
        deps.log(`job ${batch[0].id}: set aside (${firstLine(err)})`);
      } else {
        deps.log(`${label}: skipped (${firstLine(err)})`);
      }
      summary.skipped += batch.length;
      return;
    }
    const runnable = batch.filter((_, i) => prepared.result[i]);
    summary.skipped += batch.length - runnable.length;
    if (runnable.length === 0) return;

    const earned = runnable.reduce((sum, j) => sum + j.feePerRun, 0n);
    const cost = prepared.resourceFee + BigInt(client.inclusionFee ?? 0);
    const runLabel = `jobs ${runnable.map((j) => j.id).join(",")}`;
    let refusal: string | undefined;
    if (deps.feeIsNative) {
      if (earned - cost < (deps.minProfitStroops ?? 0n)) refusal = `unprofitable (earns ${earned}, costs ~${cost} stroops)`;
    } else if (deps.maxCostPerJob && cost > deps.maxCostPerJob * BigInt(runnable.length)) {
      refusal = `too costly (~${cost} stroops for ${runnable.length} job(s), above MAX_COST_PER_JOB_STROOPS)`;
    }
    if (refusal) {
      // One expensive job can sink a batch of cheap ones: try them in halves.
      if (runnable.length > 1) {
        const half = Math.ceil(runnable.length / 2);
        await runBatch(client, runnable.slice(0, half));
        await runBatch(client, runnable.slice(half));
        return;
      }
      deps.log(`${runLabel}: ${refusal}`);
      summary.unprofitable += 1;
      return;
    }

    if (deps.dryRun) {
      deps.log(`${runLabel}: would execute (earns ${earned}, costs ~${cost} stroops)`);
      summary.dryRun += runnable.length;
      return;
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
      deps.log(`executed ${runnable.map((j) => j.id).join(",")}${link(sent.hash)}`);
    } catch (err) {
      if (isFeeRelated(err)) deps.fees.escalate();
      // Another keeper may have run them first; that's expected.
      deps.log(`${label}: send failed (${firstLine(err)})`);
      summary.failed += runnable.length;
    }
  };

  await Promise.all(batches.map((batch) => deps.channels.run((client) => runBatch(client, batch))));
  return summary;
}
