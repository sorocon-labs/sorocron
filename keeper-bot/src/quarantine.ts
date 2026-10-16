/**
 * Jobs set aside after failing on their own.
 *
 * A job whose target or resolver exhausts the compute budget, that asks for
 * the keeper's authorization, or that needs a restore the keeper won't pay
 * for makes the whole `execute_batch` simulation fail, which would block
 * every job sharing its batch, tick after tick. The keeper splits such
 * batches until the job is alone, then sets it aside here for a while so it
 * stops costing simulations. It gets another chance afterwards, in case the
 * cause was temporary.
 */
export class Quarantine {
  private until = new Map<bigint, number>();
  private ticks = 0;

  /** `length`: ticks a job sits out. */
  constructor(private readonly length = 30) {}

  /** Advances one tick and releases jobs whose time is up. */
  next(): void {
    this.ticks += 1;
    for (const [id, until] of this.until) if (until <= this.ticks) this.until.delete(id);
  }

  has(id: bigint): boolean {
    return this.until.has(id);
  }

  add(id: bigint): void {
    this.until.set(id, this.ticks + this.length);
  }

  get size(): number {
    return this.until.size;
  }
}
