/**
 * Local index of the registry's jobs, kept current from events (#21).
 *
 * Scanning every job id each tick costs one RPC call per job. Instead the
 * index loads all jobs once (50 per call), then follows registry events:
 * each tick costs one `getEvents` call plus simulations for jobs that are
 * actually due by the index's own bookkeeping. Resolvers, dependencies and
 * keeper windows are still checked by simulating before sending.
 *
 * If the event cursor falls out of the RPC server's retention window (the
 * keeper was offline longer than the server keeps events), or after
 * `resyncEveryTicks`, the index reloads everything from scratch.
 */
import type { EventPage, FetchEventsOptions, Job, RegistryEvent } from "@sorocron/sdk";
import type { Logger } from "./logger.js";

/** What the keeper tracks per job: enough to decide if it might be due. */
export interface IndexedJob {
  id: bigint;
  nextRun: bigint;
  active: boolean;
  balance: bigint;
  feePerRun: bigint;
  maxRuns: number;
  runs: number;
  endAt: bigint;
}

/** The parts of the SDK client the index uses. */
export interface IndexSource {
  jobCount(): Promise<bigint>;
  getJobs(start: bigint, limit?: number): Promise<Job[]>;
  getJob(jobId: bigint): Promise<Job | undefined>;
  events(options?: FetchEventsOptions): Promise<EventPage>;
  latestLedger(): Promise<number>;
}

export function toIndexed(job: Job): IndexedJob {
  return {
    id: job.id,
    nextRun: job.next_run,
    active: job.active,
    balance: job.balance,
    feePerRun: job.fee_per_run,
    maxRuns: job.max_runs,
    runs: job.runs,
    endAt: job.end_at,
  };
}

/** Same gate order as the registry's `ensure_due`, minus what needs the chain. */
export function mightBeDue(job: IndexedJob, now: bigint): boolean {
  return (
    job.active &&
    (job.maxRuns === 0 || job.runs < job.maxRuns) &&
    (job.endAt === 0n || now < job.endAt) &&
    job.balance >= job.feePerRun &&
    now >= job.nextRun
  );
}

const PAGE = 50;

export class JobIndex {
  private jobs = new Map<bigint, IndexedJob>();
  private cursor?: string;
  private syncs = 0;
  /** RPC calls made by the last `sync`, for metrics and tests. */
  lastSyncCalls = 0;

  constructor(
    private readonly source: IndexSource,
    private readonly log: Logger,
    private readonly resyncEvery = 360,
  ) {}

  get size(): number {
    return this.jobs.size;
  }

  get(id: bigint): IndexedJob | undefined {
    return this.jobs.get(id);
  }

  /** Loads every live job and starts following events from the current ledger. */
  async load(): Promise<void> {
    let calls = 0;
    const latest = await this.source.latestLedger();
    const count = await this.source.jobCount();
    calls += 2;
    const jobs = new Map<bigint, IndexedJob>();
    for (let start = 0n; start < count; start += BigInt(PAGE)) {
      for (const job of await this.source.getJobs(start, PAGE)) jobs.set(job.id, toIndexed(job));
      calls += 1;
    }
    this.jobs = jobs;
    // Begin just after the snapshot; replaying a ledger twice is harmless.
    const page = await this.source.events({ startLedger: latest, limit: 1 });
    calls += 1;
    this.cursor = page.cursor;
    this.pendingStart = this.cursor ? undefined : latest;
    this.lastSyncCalls = calls;
    this.log(`indexed ${jobs.size} jobs`);
  }

  /** Set when the server returned no cursor yet: resume from this ledger. */
  private pendingStart?: number;

  /** Applies registry events since the last call. */
  async sync(): Promise<void> {
    this.syncs += 1;
    if (this.syncs % this.resyncEvery === 0) return this.load();
    let calls = 0;
    try {
      for (;;) {
        const page = await this.source.events(
          this.cursor ? { cursor: this.cursor, limit: 500 } : { startLedger: this.pendingStart, limit: 500 },
        );
        calls += 1;
        for (const event of page.events) calls += await this.apply(event);
        if (page.cursor) {
          this.cursor = page.cursor;
          this.pendingStart = undefined;
        }
        if (page.events.length < 500) break;
      }
      this.lastSyncCalls = calls;
    } catch (err) {
      // Most likely the cursor aged out of the server's retention window.
      this.log(`event sync failed (${err instanceof Error ? err.message : err}); reloading all jobs`);
      await this.load();
    }
  }

  /** Updates the index for one event; returns how many RPC calls it made. */
  private async apply(event: RegistryEvent): Promise<number> {
    const id = event.topics[0] as bigint;
    const d = event.data;
    const job = typeof id === "bigint" ? this.jobs.get(id) : undefined;
    switch (event.name) {
      case "job_created":
      case "job_updated": {
        const fresh = await this.source.getJob(id);
        if (fresh) this.jobs.set(id, toIndexed(fresh));
        return 1;
      }
      case "job_cancelled":
        this.jobs.delete(id);
        return 0;
      case "job_executed":
        if (job) {
          job.nextRun = BigInt(d.next_run as bigint);
          job.runs = Number(d.run);
          job.balance -= BigInt(d.fee as bigint);
        }
        return 0;
      case "job_funded":
      case "job_withdrawn":
      case "job_exhausted":
        if (job) job.balance = BigInt(d.balance as bigint);
        return 0;
      case "job_active_set":
        if (job) job.active = Boolean(d.active);
        return 0;
      case "job_deactivated":
        if (job) job.active = false;
        return 0;
      default:
        return 0;
    }
  }

  /** Jobs that might be due at `now`, earliest first. */
  due(now: bigint): IndexedJob[] {
    return [...this.jobs.values()].filter((j) => mightBeDue(j, now)).sort((a, b) => Number(a.nextRun - b.nextRun));
  }
}
