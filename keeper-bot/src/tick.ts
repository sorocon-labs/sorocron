/**
 * One polling pass: find every due job and execute it. Kept separate from
 * keeper.ts (the CLI entrypoint) and typed against a narrow interface,
 * rather than the concrete generated contract client, so it can be unit
 * tested with a fake registry instead of a live network.
 *
 * Runs in two phases (see tick() below): checking is_due for up to
 * `maxConcurrency` jobs at once, then building, simulating and sending each
 * due job's transaction one at a time.
 *
 * Only the is_due phase is parallelized. An earlier version of this
 * function also built+simulated execute() concurrently, on the theory that
 * simulation doesn't touch the chain so it should be safe -- it isn't:
 * building a transaction bakes in the source account's sequence number at
 * build time, so building several for the same account back to back hands
 * out the same sequence number to all of them, and only the first one
 * actually submitted succeeds; the rest fail as if they'd raced. Confirmed
 * against testnet (four due jobs, three came back "Sending the transaction
 * to the network failed!") before landing on this design. Real parallel
 * submission needs a separate channel account per in-flight transaction;
 * that's a bigger change and not done here.
 */
import { EXPLORER } from "./config.js";
import { mapWithConcurrency } from "./pool.js";
import { withRetry } from "./retry.js";

export interface SentLike {
  sendTransactionResponse?: { hash?: string };
}

export interface ExecuteResultLike {
  isErr?: () => boolean;
  unwrapErr?: () => { message: string };
}

export interface AssembledExecuteTx {
  result: ExecuteResultLike | undefined;
  signAndSend(): Promise<SentLike>;
  /** Present once simulated; carries the resource fee the network will charge. */
  simulationData?: { transactionData: { resourceFee: bigint } };
}

/** The subset of the generated registry client that tick() depends on. */
export interface RegistryLike {
  job_count(): Promise<{ result: bigint }>;
  is_due(args: { job_id: bigint }): Promise<{ result: boolean }>;
  execute(args: { keeper: string; job_id: bigint }): Promise<AssembledExecuteTx>;
  get_job(args: { job_id: bigint }): Promise<{ result: { fee_per_run: bigint } | undefined }>;
  config(): Promise<{ result: { fee_token: string } }>;
}

export type Logger = (message: string) => void;

export interface TickOptions {
  /**
   * Only checked when the job's fee_per_run is paid in this token (normally
   * the native XLM SAC), since the network fee is always paid in XLM and
   * comparing it to a job's fee in some other token needs a price feed --
   * left for later. Omit to skip the profitability check entirely.
   */
  nativeFeeTokenId?: string;
  /** Minimum fee_per_run - resource_fee, in stroops, to bother executing. Default 0 (must not be a net loss). */
  minProfitStroops?: bigint;
  /** is_due checks to run in parallel. Default 1 (fully sequential, the previous behavior). */
  maxConcurrency?: number;
}

export async function tick(
  registry: RegistryLike,
  keeper: string,
  log: Logger,
  options: TickOptions = {},
): Promise<void> {
  const minProfitStroops = options.minProfitStroops ?? 0n;
  const maxConcurrency = options.maxConcurrency ?? 1;

  // job_count/is_due are read-only simulations: safe to retry blindly on
  // whatever transient RPC error comes back (timeouts, 5xx, network blips).
  const count: bigint = (await withRetry(() => registry.job_count())).result;
  const feeToken = options.nativeFeeTokenId
    ? (await withRetry(() => registry.config())).result.fee_token
    : undefined;

  const jobIds = Array.from({ length: Number(count) }, (_, i) => BigInt(i));

  // Phase 1: which jobs are due, checked up to maxConcurrency at a time.
  // Nothing here builds a transaction against the keeper's account, so
  // there's no sequence number to collide over -- this is the phase that
  // matters most once there are many jobs, most of which aren't due on any
  // given tick.
  const dueFlags = await mapWithConcurrency(jobIds, maxConcurrency, async (jobId) => {
    try {
      return (await withRetry(() => registry.is_due({ job_id: jobId }))).result;
    } catch {
      return false;
    }
  });
  const dueJobIds = jobIds.filter((_, i) => dueFlags[i]);

  // Phase 2: build, simulate and send each due job's transaction, one at a
  // time (see the module doc comment for why this can't be parallelized).
  for (const jobId of dueJobIds) {
    try {
      const tx = await registry.execute({ keeper, job_id: jobId });
      const simulated = tx.result;
      if (simulated && typeof simulated.isErr === "function" && simulated.isErr()) {
        log(`job ${jobId}: skipped (${simulated.unwrapErr!().message})`);
        continue;
      }

      if (options.nativeFeeTokenId && feeToken === options.nativeFeeTokenId) {
        const job = (await registry.get_job({ job_id: jobId })).result;
        const resourceFee = tx.simulationData?.transactionData.resourceFee ?? 0n;
        const profit = (job?.fee_per_run ?? 0n) - resourceFee;
        if (profit < minProfitStroops) {
          log(
            `job ${jobId}: skipped (unprofitable: fee ${job?.fee_per_run ?? 0n} stroops, ` +
              `resource cost ~${resourceFee} stroops)`,
          );
          continue;
        }
      }

      const sent = await tx.signAndSend();
      const hash = sent.sendTransactionResponse?.hash;
      log(`job ${jobId}: executed${hash ? ` ${EXPLORER}/tx/${hash}` : ""}`);
    } catch (err) {
      // Another keeper may have executed it first; that's expected.
      log(`job ${jobId}: execution failed (${err instanceof Error ? err.message.split("\n")[0] : err})`);
    }
  }
}
