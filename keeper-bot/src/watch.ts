/**
 * `sorocron jobs watch <id>` (#133): follows the registry's events and
 * prints one line per thing that happens to a job: runs with their fee and
 * lateness, funding, withdrawals, pausing, updates, handovers and
 * cancellation. Typed against a narrow event source so it can be tested
 * with fakes.
 */
import { formatAmount, formatDuration, type EventPage, type FetchEventsOptions, type RegistryEvent } from "@sorocron/sdk";

export interface EventSource {
  events(options: FetchEventsOptions): Promise<EventPage>;
  latestLedger(): Promise<number>;
}

const xlm = (v: unknown) => `${formatAmount(BigInt(v as bigint))} XLM`;
const short = (address: unknown) => {
  const s = String(address);
  return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
};
const iso = (seconds: unknown) => new Date(Number(seconds) * 1000).toISOString();

/** Whether an event concerns `jobId`: job events carry it as their first topic. */
export function isJobEvent(e: RegistryEvent, jobId: bigint): boolean {
  if (e.name === "keeper_missed_window") return BigInt((e.data.job_id as bigint) ?? -1n) === jobId;
  return e.name.startsWith("job_") && e.topics.length > 0 && BigInt(e.topics[0] as bigint) === jobId;
}

/** One human-readable line for a job event, without the timestamp. */
export function describeJobEvent(e: RegistryEvent): string {
  const d = e.data;
  switch (e.name) {
    case "job_executed": {
      const late = BigInt((d.lateness as bigint) ?? 0n);
      return (
        `run ${d.run} ${d.success ? "succeeded" : `failed (${d.failures} in a row)`} by ${short(e.topics[1])}` +
        `, fee ${xlm(d.fee)}${late > 0n ? `, ${formatDuration(late)} late` : ", on time"}, next run ${iso(d.next_run)}`
      );
    }
    case "job_created":
      return `created by ${short(d.owner)} with ${xlm(d.deposit)}, ${xlm(d.fee_per_run)} per run`;
    case "job_funded":
      return `funded ${xlm(d.amount)} by ${short(d.from)}, balance ${xlm(d.balance)}`;
    case "job_withdrawn":
      return `owner withdrew ${xlm(d.amount)}, balance ${xlm(d.balance)}`;
    case "job_active_set":
      return d.active ? "resumed by its owner" : "paused by its owner";
    case "job_deactivated":
      return `paused itself after ${d.failures} failed runs in a row`;
    case "job_exhausted":
      return `ran out of balance (${xlm(d.balance)} left); fund it to keep it running`;
    case "job_updated":
      return `updated: fee ${xlm(d.fee_per_run)}${d.interval ? `, every ${formatDuration(BigInt(d.interval as bigint))}` : ""}`;
    case "job_owner_proposed":
      return `handover offered to ${short(d.proposed)}`;
    case "job_owner_changed":
      return `now owned by ${short(d.new_owner)}`;
    case "job_cancelled":
      return `cancelled, ${xlm(d.refund)} refunded`;
    case "keeper_missed_window":
      return `keeper ${short(e.topics[0])} missed its window; ${short(d.ran_by)} ran it`;
    default:
      return e.name.replace(/_/g, " ");
  }
}

/** The JSON line `--json` prints for an event. */
export function jobEventJson(e: RegistryEvent) {
  return { event: e.name, ledger: e.ledger, closed_at: e.closedAt, tx_hash: e.txHash, topics: e.topics, ...e.data };
}

export interface WatchOptions {
  /** First ledger to replay from; the latest ledger when unset. */
  fromLedger?: number;
  pollMs: number;
  print(e: RegistryEvent): void;
  /** Resolves after `ms`, or sooner once `stopped()` turns true. */
  sleep(ms: number): Promise<void>;
  stopped(): boolean;
}

/**
 * Prints the job's events as they land until stopped, or until the job is
 * cancelled. Returns how many events it printed.
 */
export async function watchJob(source: EventSource, jobId: bigint, o: WatchOptions): Promise<number> {
  let start = o.fromLedger ?? (await source.latestLedger());
  let cursor: string | undefined;
  let printed = 0;
  while (!o.stopped()) {
    const page = await source.events(cursor ? { cursor } : { startLedger: start });
    for (const e of page.events) {
      if (!isJobEvent(e, jobId)) continue;
      o.print(e);
      printed += 1;
      if (e.name === "job_cancelled") return printed;
    }
    cursor = page.cursor ?? cursor;
    // With no events yet and no cursor, move the start up to what's been read.
    if (!cursor) start = Math.max(start, page.latestLedger);
    await o.sleep(o.pollMs);
  }
  return printed;
}
