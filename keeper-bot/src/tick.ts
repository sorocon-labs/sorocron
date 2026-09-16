/**
 * One polling pass: find every due job and execute it. Kept separate from
 * keeper.ts (the CLI entrypoint) and typed against a narrow interface,
 * rather than the concrete generated contract client, so it can be unit
 * tested with a fake registry instead of a live network.
 */
import { EXPLORER } from "./config.js";
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
}

export async function tick(
  registry: RegistryLike,
  keeper: string,
  log: Logger,
  options: TickOptions = {},
): Promise<void> {
  const minProfitStroops = options.minProfitStroops ?? 0n;

  // job_count/is_due are read-only simulations: safe to retry blindly on
  // whatever transient RPC error comes back (timeouts, 5xx, network blips).
  const count: bigint = (await withRetry(() => registry.job_count())).result;
  const feeToken = options.nativeFeeTokenId
    ? (await withRetry(() => registry.config())).result.fee_token
    : undefined;

  for (let jobId = 0n; jobId < count; jobId++) {
    let due = false;
    try {
      due = (await withRetry(() => registry.is_due({ job_id: jobId }))).result;
    } catch {
      continue;
    }
    if (!due) continue;

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
