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
}

/** The subset of the generated registry client that tick() depends on. */
export interface RegistryLike {
  job_count(): Promise<{ result: bigint }>;
  is_due(args: { job_id: bigint }): Promise<{ result: boolean }>;
  execute(args: { keeper: string; job_id: bigint }): Promise<AssembledExecuteTx>;
}

export type Logger = (message: string) => void;

export async function tick(registry: RegistryLike, keeper: string, log: Logger): Promise<void> {
  // job_count/is_due are read-only simulations: safe to retry blindly on
  // whatever transient RPC error comes back (timeouts, 5xx, network blips).
  const count: bigint = (await withRetry(() => registry.job_count())).result;

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
      const sent = await tx.signAndSend();
      const hash = sent.sendTransactionResponse?.hash;
      log(`job ${jobId}: executed${hash ? ` ${EXPLORER}/tx/${hash}` : ""}`);
    } catch (err) {
      // Another keeper may have executed it first; that's expected.
      log(`job ${jobId}: execution failed (${err instanceof Error ? err.message.split("\n")[0] : err})`);
    }
  }
}
