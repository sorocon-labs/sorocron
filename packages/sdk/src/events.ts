/**
 * Reading the registry's events from Soroban RPC: job lifecycle for
 * indexers and keepers, execution receipts for dashboards and leaderboards.
 *
 * Contract events carry their name and `#[topic]` fields as topics and the
 * rest as a map, e.g. `JobExecuted` is
 * `topics: ["job_executed", job_id, keeper]`, `value: { success, fee, ... }`.
 *
 * RPC servers keep events for a limited window (about a week on testnet).
 * `fetchEvents` clamps the start ledger to what the server still has instead
 * of failing, so callers can always ask for "everything since X".
 */
import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

export interface RegistryEvent {
  /** Event name in snake_case, e.g. `job_executed`. */
  name: string;
  /** Topic values after the name, decoded. */
  topics: unknown[];
  /** Decoded event data (an object for map-shaped events). */
  data: Record<string, unknown>;
  ledger: number;
  closedAt: string;
  txHash: string;
  /** Opaque, ordered id; pass the last one as `cursor` to continue. */
  id: string;
}

export interface EventPage {
  events: RegistryEvent[];
  latestLedger: number;
  /** Continue from here on the next call. */
  cursor?: string;
}

export interface FetchEventsOptions {
  /** First ledger to read. Clamped to the server's retention window. */
  startLedger?: number;
  /** Continue after a previous page instead of from `startLedger`. */
  cursor?: string;
  /** Keep only these event names. */
  names?: string[];
  /** Page size (RPC maximum 10,000). */
  limit?: number;
}

const decode = (v: xdr.ScVal | string): unknown =>
  scValToNative(typeof v === "string" ? xdr.ScVal.fromXDR(v, "base64") : v);

/** Earliest ledger the server still has, parsed from its range error. */
function retentionStart(err: unknown): number | undefined {
  // RPC errors arrive as Error instances or as plain `{ code, message }` objects.
  const text =
    err instanceof Error
      ? err.message
      : err && typeof err === "object" && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err);
  // e.g. "startLedger must be within the ledger range: 4954218 - 5075177"
  // (older servers: "between 4954218 and 5075177").
  const match = /(\d+)\s*(?:-|and)\s*(\d+)/.exec(text);
  return match ? Number(match[1]) : undefined;
}

export async function fetchEvents(server: rpc.Server, contractId: string, options: FetchEventsOptions = {}): Promise<EventPage> {
  const filters = [{ type: "contract" as const, contractIds: [contractId] }];
  const limit = options.limit ?? 1_000;
  let response: rpc.Api.GetEventsResponse;
  if (options.cursor) {
    response = await server.getEvents({ filters, cursor: options.cursor, limit });
  } else {
    let startLedger = options.startLedger;
    if (startLedger === undefined) {
      const latest = await server.getLatestLedger();
      startLedger = Math.max(1, latest.sequence - 17_280); // about a day
    }
    try {
      response = await server.getEvents({ filters, startLedger, limit });
    } catch (err) {
      const earliest = retentionStart(err);
      if (earliest === undefined || earliest <= startLedger) throw err;
      response = await server.getEvents({ filters, startLedger: earliest, limit });
    }
  }

  const events: RegistryEvent[] = [];
  for (const e of response.events) {
    const [nameVal, ...rest] = e.topic;
    const name = nameVal ? String(decode(nameVal)) : "";
    if (options.names && !options.names.includes(name)) continue;
    const value = decode(e.value);
    events.push({
      name,
      topics: rest.map(decode),
      data: value && typeof value === "object" ? (value as Record<string, unknown>) : { value },
      ledger: e.ledger,
      closedAt: e.ledgerClosedAt,
      txHash: e.txHash,
      id: e.id,
    });
  }
  return { events, latestLedger: response.latestLedger, cursor: response.cursor ?? events.at(-1)?.id };
}

/** A decoded `JobExecuted` receipt. */
export interface Execution {
  jobId: bigint;
  keeper: string;
  success: boolean;
  fee: bigint;
  protocolFee: bigint;
  run: number;
  nextRun: bigint;
  lateness: bigint;
  failures: number;
  ledger: number;
  closedAt: string;
  txHash: string;
}

export function toExecution(e: RegistryEvent): Execution | undefined {
  if (e.name !== "job_executed") return undefined;
  const d = e.data;
  return {
    jobId: BigInt(e.topics[0] as bigint),
    keeper: String(e.topics[1]),
    success: Boolean(d.success),
    fee: BigInt((d.fee as bigint) ?? 0n),
    protocolFee: BigInt((d.protocol_fee as bigint) ?? 0n),
    run: Number(d.run ?? 0),
    nextRun: BigInt((d.next_run as bigint) ?? 0n),
    lateness: BigInt((d.lateness as bigint) ?? 0n),
    failures: Number(d.failures ?? 0),
    ledger: e.ledger,
    closedAt: e.closedAt,
    txHash: e.txHash,
  };
}

export interface LeaderboardRow {
  keeper: string;
  runs: number;
  failedRuns: number;
  earned: bigint;
  averageLateness: bigint;
}

/** Ranks keepers by runs executed, then by fees earned. */
export function leaderboard(executions: Execution[]): LeaderboardRow[] {
  const rows = new Map<string, LeaderboardRow & { totalLateness: bigint }>();
  for (const x of executions) {
    const row = rows.get(x.keeper) ?? {
      keeper: x.keeper,
      runs: 0,
      failedRuns: 0,
      earned: 0n,
      averageLateness: 0n,
      totalLateness: 0n,
    };
    row.runs += 1;
    if (!x.success) row.failedRuns += 1;
    row.earned += x.fee - x.protocolFee;
    row.totalLateness += x.lateness;
    rows.set(x.keeper, row);
  }
  return [...rows.values()]
    .map(({ totalLateness, ...row }) => ({ ...row, averageLateness: totalLateness / BigInt(row.runs) }))
    .sort((a, b) => b.runs - a.runs || (b.earned > a.earned ? 1 : b.earned < a.earned ? -1 : 0));
}
