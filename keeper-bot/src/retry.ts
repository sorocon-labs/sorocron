/** Small retry helper for transient RPC failures (timeouts, 5xx, network blips). */

export interface RetryOptions {
  /** Total attempts, including the first. Default 3. */
  attempts?: number;
  /** Delay before each retry, in ms. The last entry repeats if there are more retries than entries. Default [500, 1000, 2000]. */
  delaysMs?: number[];
  /** Only errors this returns true for are retried; others are thrown immediately. Default: retry everything. */
  shouldRetry?: (err: unknown) => boolean;
  /** Injectable so tests don't have to wait for real timers. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Calls `fn`, retrying on failure up to `attempts` times with the given
 * delays. Re-throws the last error once attempts are exhausted, or
 * immediately if `shouldRetry` rejects a given error (used to skip retrying
 * errors that a retry can't fix, such as a contract's `JobNotDue`).
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const delaysMs = options.delaysMs ?? [500, 1000, 2000];
  const shouldRetry = options.shouldRetry ?? (() => true);
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === attempts || !shouldRetry(err)) throw err;
      await sleep(delaysMs[Math.min(attempt - 1, delaysMs.length - 1)]);
    }
  }
  // Unreachable: the loop always returns or throws.
  throw new Error("unreachable");
}
