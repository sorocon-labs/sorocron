/**
 * RPC endpoint failover (#112).
 *
 * With several endpoints configured (STELLAR_RPC_URLS), the keeper probes
 * each one every tick with `getLatestLedger` and reports how its own ticks
 * went. It uses the first endpoint, in configured order, that is healthy:
 * answering probes, not failing ticks, and no more than `maxLag` ledgers
 * behind the furthest-ahead endpoint. So it moves off a failing or lagging
 * endpoint at once, and back to the preferred one after it has answered
 * `recoverAfter` probes in a row.
 */

export interface EndpointStatus {
  url: string;
  /** Whether the last probe answered. */
  up: boolean;
  /** Ticks in a row that failed while this endpoint was active. */
  failures: number;
  /** Probes in a row that answered. */
  okProbes: number;
  /** Latest ledger from the last probe that answered. */
  ledger?: number;
  latencyMs?: number;
}

export interface EndpointOptions {
  /** Failed ticks before the keeper moves to another endpoint. */
  maxFailures: number;
  /** Ledgers an endpoint may trail the furthest-ahead one by. */
  maxLag: number;
  /** Answered probes in a row before a failed endpoint is used again. */
  recoverAfter: number;
}

const DEFAULTS: EndpointOptions = { maxFailures: 3, maxLag: 10, recoverAfter: 5 };

export class Endpoints {
  private readonly endpoints: EndpointStatus[];
  private readonly options: EndpointOptions;
  private activeIndex = 0;

  constructor(urls: string[], options: Partial<EndpointOptions> = {}) {
    const unique = [...new Set(urls)];
    if (unique.length === 0) throw new Error("No RPC endpoints configured.");
    this.endpoints = unique.map((url) => ({ url, up: true, failures: 0, okProbes: 0 }));
    this.options = { ...DEFAULTS, ...options };
  }

  get active(): string {
    return this.endpoints[this.activeIndex].url;
  }

  get all(): readonly EndpointStatus[] {
    return this.endpoints;
  }

  /** A probe answered at `ledger`, or failed when `ledger` is undefined. */
  recordProbe(url: string, ledger: number | undefined, latencyMs?: number): void {
    const e = this.find(url);
    if (ledger === undefined) {
      e.up = false;
      e.okProbes = 0;
      return;
    }
    e.up = true;
    e.ledger = ledger;
    e.latencyMs = latencyMs;
    e.okProbes += 1;
    // Probes are the only signal from endpoints the keeper isn't using, so
    // enough of them in a row clear a failed endpoint's record.
    if (url !== this.active && e.okProbes >= this.options.recoverAfter) e.failures = 0;
  }

  /** A tick using `url` failed. */
  recordFailure(url: string): void {
    const e = this.find(url);
    e.failures += 1;
    e.okProbes = 0;
  }

  /** A tick using `url` succeeded. */
  recordSuccess(url: string): void {
    this.find(url).failures = 0;
  }

  healthy(e: EndpointStatus): boolean {
    if (!e.up || e.failures >= this.options.maxFailures) return false;
    const ahead = Math.max(...this.endpoints.filter((x) => x.up && x.ledger !== undefined).map((x) => x.ledger!));
    return e.ledger === undefined || !Number.isFinite(ahead) || ahead - e.ledger <= this.options.maxLag;
  }

  anyHealthy(): boolean {
    return this.endpoints.some((e) => this.healthy(e));
  }

  /**
   * Makes the first healthy endpoint active. Keeps the current one when none
   * is healthy. Returns true when the active endpoint changed.
   */
  choose(): boolean {
    const index = this.endpoints.findIndex((e) => this.healthy(e));
    if (index === -1 || index === this.activeIndex) return false;
    this.activeIndex = index;
    return true;
  }

  private find(url: string): EndpointStatus {
    const e = this.endpoints.find((x) => x.url === url);
    if (!e) throw new Error(`Unknown RPC endpoint ${endpointLabel(url)}`);
    return e;
  }
}

/**
 * How an endpoint appears in logs, metrics and alerts: its host only, since
 * providers often put an API key in the URL's path or query.
 */
export function endpointLabel(url: string): string {
  try {
    return new URL(url).host || "unknown-host";
  } catch {
    return "invalid-url";
  }
}

/** STELLAR_RPC_URLS (comma-separated), or `fallback` when it is unset. */
export function rpcUrlsFrom(list: string | undefined, fallback: string): string[] {
  const urls = (list ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return urls.length ? urls : fallback ? [fallback] : [];
}
