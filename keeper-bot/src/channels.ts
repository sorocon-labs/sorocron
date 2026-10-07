/**
 * Parallel submission through channel accounts (#72).
 *
 * A Stellar account's transactions are strictly sequenced, so one keeper
 * account can have only one transaction in flight; building two at once
 * gives both the same sequence number and one fails. Channel accounts are
 * separate funded accounts that act as transaction sources (paying the
 * network fee and providing the sequence number) while the staked keeper
 * only signs its authorization. With N channels, N batches go out at once.
 *
 * `ChannelPool.run` hands a free channel to each task and queues tasks when
 * all are busy, so no channel ever has two transactions in flight. If a
 * sequence error still happens (another process used the account), the
 * task can rebuild the transaction once with `withSequenceRetry`.
 */

export class ChannelPool<C> {
  private free: C[];
  private waiting: ((c: C) => void)[] = [];

  constructor(channels: C[]) {
    if (channels.length === 0) throw new Error("ChannelPool needs at least one channel");
    this.free = [...channels];
    this.size = channels.length;
  }

  readonly size: number;

  /** Channels not currently running a task. */
  get available(): number {
    return this.free.length;
  }

  /** Runs `task` on a free channel, waiting for one if all are busy. */
  async run<T>(task: (channel: C) => Promise<T>): Promise<T> {
    const channel = await this.acquire();
    try {
      return await task(channel);
    } finally {
      this.release(channel);
    }
  }

  private acquire(): Promise<C> {
    const channel = this.free.pop();
    if (channel !== undefined) return Promise.resolve(channel);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(channel: C): void {
    const next = this.waiting.shift();
    if (next) next(channel);
    else this.free.push(channel);
  }
}

export function isSequenceError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /txBadSeq|tx_bad_seq|bad sequence/i.test(text);
}

/** Retries `fn` once if it failed on a stale sequence number. */
export async function withSequenceRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isSequenceError(err)) throw err;
    return fn();
  }
}
