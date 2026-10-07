/**
 * Inclusion fee bidding (#71).
 *
 * Soroban transactions pay a resource fee (set by simulation) plus an
 * inclusion fee that orders them when ledgers are full. A fixed minimum bid
 * stalls the keeper during congestion. The strategy bids a configurable
 * percentile of recent Soroban inclusion fees (from RPC `getFeeStats`) and
 * escalates one step after each failed or timed-out submission (p70 → p90 →
 * p95 → p99 → max seen), never above `maxFee`. A success drops back to the
 * base percentile.
 */

export const PERCENTILES = ["p10", "p20", "p30", "p40", "p50", "p60", "p70", "p80", "p90", "p95", "p99"] as const;
export type Percentile = (typeof PERCENTILES)[number];

/** The shape of `sorobanInclusionFee` in RPC `getFeeStats`. */
export type FeeDistribution = Record<Percentile | "max" | "min" | "mode", string>;

export interface FeeStatsSource {
  getFeeStats(): Promise<{ sorobanInclusionFee: FeeDistribution }>;
}

/** Stellar's minimum inclusion fee per operation. */
export const MIN_FEE = 100;

export class FeeStrategy {
  private distribution?: FeeDistribution;
  private steps: (Percentile | "max")[];
  private level = 0;

  constructor(
    private readonly source: FeeStatsSource,
    private readonly options: { percentile?: string; maxFee?: number } = {},
  ) {
    const base = (PERCENTILES as readonly string[]).includes(options.percentile ?? "")
      ? (options.percentile as Percentile)
      : "p70";
    const escalation: Percentile[] = ["p90", "p95", "p99"];
    const higher = escalation.filter((p) => PERCENTILES.indexOf(p) > PERCENTILES.indexOf(base));
    this.steps = [base, ...higher, "max"];
  }

  /** Fetches fresh fee stats. Keeps the previous ones if the call fails. */
  async refresh(): Promise<void> {
    try {
      this.distribution = (await this.source.getFeeStats()).sorobanInclusionFee;
    } catch {
      // Bid from the last known distribution, or the minimum.
    }
  }

  /** The inclusion fee to bid now, in stroops. */
  current(): number {
    const step = this.steps[Math.min(this.level, this.steps.length - 1)];
    const raw = Number(this.distribution?.[step] ?? MIN_FEE);
    const bid = Number.isFinite(raw) ? Math.max(MIN_FEE, Math.ceil(raw)) : MIN_FEE;
    return Math.min(bid, this.options.maxFee ?? Number.MAX_SAFE_INTEGER);
  }

  /** After a failed or timed-out submission: bid higher next time. */
  escalate(): void {
    this.level = Math.min(this.level + 1, this.steps.length - 1);
  }

  /** After a success: back to the base percentile. */
  reset(): void {
    this.level = 0;
  }

  get escalation(): number {
    return this.level;
  }
}

/** Submission errors that a higher inclusion fee may fix. */
export function isFeeRelated(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /insufficient.?fee|txInsufficientFee|tx_insufficient_fee|timeout|timed out|TRY_AGAIN_LATER/i.test(text);
}
