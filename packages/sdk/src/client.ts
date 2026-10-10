/**
 * High-level client for the SoroCron registry. Wraps the stellar-sdk
 * contract client (built from the on-chain spec) with typed methods,
 * camelCase names, readable errors and a single send path.
 *
 *   const cron = await SoroCron.connect({ network: TESTNET });
 *   const jobs = await cron.allJobs();
 *
 * Pass `publicKey` and `signTransaction` (Freighter's, or a Keypair) to send
 * transactions; reads work without them.
 */
import { contract, rpc } from "@stellar/stellar-sdk";
import { SoroCronError, parseContractError } from "./errors.js";
import type { NetworkConfig } from "./networks.js";
import { fetchEvents, toExecution, type EventPage, type Execution, type FetchEventsOptions } from "./events.js";
import type { Config, Job, JobParams, JobState, JobUpdate, Keeper, KeeperStats, PendingUpgrade } from "./types.js";

export interface ConnectOptions {
  network: NetworkConfig;
  /** Override the network's registry address. */
  contractId?: string;
  /** Account that signs and pays for transactions. */
  publicKey?: string;
  signTransaction?: contract.ClientOptions["signTransaction"];
  /**
   * Signs Soroban authorization entries for accounts other than the
   * transaction source. Needed when a channel account submits a
   * transaction on behalf of a keeper (see `execute`'s `keeper` argument).
   */
  signAuthEntry?: contract.ClientOptions["signAuthEntry"];
}

export interface Sent<T> {
  hash: string;
  result: T;
}

/** A simulated transaction: what it would return and cost, ready to send. */
export interface Prepared<T> {
  result: T;
  /** Resource fee from simulation, in stroops (excludes the inclusion fee). */
  resourceFee: bigint;
  send(): Promise<Sent<T>>;
}

/** Page size used by `allJobs`; matches the registry's MAX_GET_JOBS_LIMIT. */
export const PAGE_SIZE = 50;

type Method = (args?: Record<string, unknown>) => Promise<contract.AssembledTransaction<unknown>>;

export class SoroCron {
  /**
   * Inclusion fee in stroops for transactions this client sends. Unset uses
   * the network minimum. Keepers raise it when the network is congested.
   */
  inclusionFee?: number;

  private constructor(
    private readonly client: contract.Client & Record<string, Method>,
    readonly contractId: string,
    readonly network: NetworkConfig,
    readonly publicKey?: string,
    private readonly signAuthEntry?: contract.ClientOptions["signAuthEntry"],
  ) {}

  static async connect(options: ConnectOptions): Promise<SoroCron> {
    const contractId = options.contractId ?? options.network.contracts.registry;
    const client = await contract.Client.from({
      contractId,
      rpcUrl: options.network.rpcUrl,
      networkPassphrase: options.network.networkPassphrase,
      publicKey: options.publicKey,
      signTransaction: options.signTransaction,
      signAuthEntry: options.signAuthEntry,
      allowHttp: options.network.rpcUrl.startsWith("http://"),
    });
    if (client.spec && typeof client.spec.errorCases === "function") {
      for (const errorCase of client.spec.errorCases()) {
        if (!errorCase.doc || !errorCase.doc.toString()) {
          const name = errorCase.name?.toString?.() ?? "";
          (errorCase as any).doc = {
            toString: () => name,
          };
        }
      }
    }
    return new SoroCron(
      client as contract.Client & Record<string, Method>,
      contractId,
      options.network,
      options.publicKey,
      options.signAuthEntry,
    );
  }

  // ---------------------------------------------------------------- reads

  private async read<T>(method: string, args?: Record<string, unknown>): Promise<T> {
    const fn = this.client[method];
    if (typeof fn !== "function") {
      throw new Error(`Registry ${this.contractId} has no "${method}" function (older version?)`);
    }
    const tx = await fn.call(this.client, args);
    return unwrapResult<T>(tx.result);
  }

  config(): Promise<Config> {
    return this.read("config");
  }

  /** Interface version, or 2 for registries deployed before `version()` existed. */
  async version(): Promise<number> {
    try {
      return await this.read<number>("version");
    } catch {
      return 2;
    }
  }

  jobCount(): Promise<bigint> {
    return this.read("job_count");
  }

  getJob(jobId: bigint): Promise<Job | undefined> {
    return this.read("get_job", { job_id: jobId });
  }

  getJobs(start: bigint, limit = PAGE_SIZE): Promise<Job[]> {
    return this.read("get_jobs", { start, limit });
  }

  /**
   * Every live job, fetched a page at a time. Falls back to one `get_job`
   * per id on registries deployed before `get_jobs` existed.
   */
  async allJobs(): Promise<Job[]> {
    const count = await this.jobCount();
    if (typeof this.client["get_jobs"] !== "function") {
      const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i));
      const jobs = await Promise.all(ids.map((id) => this.getJob(id)));
      return jobs.filter((job): job is Job => job !== undefined);
    }
    const pages: Promise<Job[]>[] = [];
    for (let start = 0n; start < count; start += BigInt(PAGE_SIZE)) {
      pages.push(this.getJobs(start, PAGE_SIZE));
    }
    return (await Promise.all(pages)).flat();
  }

  jobsByOwner(owner: string): Promise<bigint[]> {
    return this.read("jobs_by_owner", { owner });
  }

  /** The small per-run part of a job: one ledger entry, cheapest to poll. */
  getJobState(jobId: bigint): Promise<JobState | undefined> {
    return this.read("get_job_state", { job_id: jobId });
  }

  getKeeper(keeper: string): Promise<Keeper | undefined> {
    return this.read("get_keeper", { keeper });
  }

  /** Executions, average lateness, missed windows and slashed stake. */
  keeperStats(keeper: string): Promise<KeeperStats | undefined> {
    return this.read("keeper_stats", { keeper });
  }

  /** Keepers in the assigned-window rotation. */
  activeKeepers(): Promise<string[]> {
    return this.read("active_keepers");
  }

  /** The keeper reserved for the job's next run, if assigned windows are on. */
  assignedKeeper(jobId: bigint): Promise<string | undefined> {
    return this.read("assigned_keeper", { job_id: jobId });
  }

  isTargetHalted(target: string): Promise<boolean> {
    return this.read("is_target_halted", { target });
  }

  /** The fee a run would pay now, including any late-run ramp. */
  currentFee(jobId: bigint): Promise<bigint | undefined> {
    return this.read("current_fee", { job_id: jobId });
  }

  /** Account proposed as the job's new owner that hasn't accepted yet (v5+). */
  pendingJobOwner(jobId: bigint): Promise<string | undefined> {
    return this.read("pending_job_owner", { job_id: jobId });
  }

  /** Code upgrade the admin has announced, if any (v5+). */
  pendingUpgrade(): Promise<PendingUpgrade | undefined> {
    return this.read("pending_upgrade");
  }

  /** Seconds an announced upgrade waits before it can be installed (v5+). */
  upgradeDelay(): Promise<bigint> {
    return this.read("upgrade_delay");
  }

  // --------------------------------------------------------------- events

  /** Soroban RPC client for this network. */
  get server(): rpc.Server {
    return new rpc.Server(this.network.rpcUrl, { allowHttp: this.network.rpcUrl.startsWith("http://") });
  }

  /** Raw registry events; see `fetchEvents`. */
  events(options: FetchEventsOptions = {}): Promise<EventPage> {
    return fetchEvents(this.server, this.contractId, options);
  }

  /** Recent `JobExecuted` receipts, newest last. */
  async recentExecutions(options: Omit<FetchEventsOptions, "names"> = {}): Promise<Execution[]> {
    const page = await this.events({ ...options, names: ["job_executed"] });
    return page.events.map(toExecution).filter((x): x is Execution => x !== undefined);
  }

  /** Authoritative due check, including the job's resolver. */
  isDue(jobId: bigint): Promise<boolean> {
    return this.read("is_due", { job_id: jobId });
  }

  // --------------------------------------------------------------- writes

  /**
   * Builds and simulates a call. Throws `SoroCronError` if the simulation
   * says the contract would reject it, so nothing is sent for a doomed call.
   */
  private async prepare<T>(method: string, args: Record<string, unknown>): Promise<Prepared<T>> {
    if (!this.publicKey) throw new Error("Connect a wallet (publicKey + signTransaction) to send transactions");
    const fn = this.client[method] as unknown as (
      args: Record<string, unknown>,
      options?: contract.MethodOptions,
    ) => Promise<contract.AssembledTransaction<unknown>>;
    if (typeof fn !== "function") {
      throw new Error(`Registry ${this.contractId} has no "${method}" function (older version?)`);
    }
    let tx: contract.AssembledTransaction<unknown>;
    try {
      tx = await fn.call(this.client, args, this.inclusionFee ? { fee: String(this.inclusionFee) } : undefined);
    } catch (err) {
      throw parseContractError(err) ?? err;
    }
    const result = unwrapResult<T>(tx.result);
    const resourceFee = BigInt(tx.simulationData?.transactionData.resourceFee ?? 0n);
    return {
      result,
      resourceFee,
      send: async () => {
        try {
          // Other accounts whose authorization the call needs (a keeper, when
          // a channel account is the transaction source) sign their entries.
          for (const address of tx.needsNonInvokerSigningBy()) {
            if (!this.signAuthEntry) throw new Error(`${address} must authorize this call; pass signAuthEntry`);
            await tx.signAuthEntries({ address, signAuthEntry: this.signAuthEntry });
          }
          const sent = await tx.signAndSend();
          return { hash: sent.sendTransactionResponse?.hash ?? "", result };
        } catch (err) {
          throw parseContractError(err) ?? err;
        }
      },
    };
  }

  private async send<T>(method: string, args: Record<string, unknown>): Promise<Sent<T>> {
    return (await this.prepare<T>(method, args)).send();
  }

  createJob(params: JobParams, deposit: bigint): Promise<Sent<bigint>> {
    return this.send("create_job", { owner: this.publicKey, params, deposit });
  }

  createJobs(jobs: JobParams[], deposits: bigint[]): Promise<Sent<bigint[]>> {
    return this.send("create_jobs", { owner: this.publicKey, jobs, deposits });
  }

  updateJob(jobId: bigint, update: JobUpdate): Promise<Sent<void>> {
    return this.send("update_job", { job_id: jobId, update });
  }

  fundJob(jobId: bigint, amount: bigint): Promise<Sent<bigint>> {
    return this.send("fund_job", { from: this.publicKey, job_id: jobId, amount });
  }

  setJobActive(jobId: bigint, active: boolean): Promise<Sent<void>> {
    return this.send("set_job_active", { job_id: jobId, active });
  }

  withdrawJobBalance(jobId: bigint, amount: bigint): Promise<Sent<bigint>> {
    return this.send("withdraw_job_balance", { job_id: jobId, amount });
  }

  cancelJob(jobId: bigint): Promise<Sent<bigint>> {
    return this.send("cancel_job", { job_id: jobId });
  }

  /**
   * Starts handing a job to `newOwner`, who completes it with
   * `acceptJobOwner`. Proposing this client's own account withdraws a
   * pending proposal (v5+).
   */
  proposeJobOwner(jobId: bigint, newOwner: string): Promise<Sent<void>> {
    return this.send("propose_job_owner", { job_id: jobId, new_owner: newOwner });
  }

  /** Takes over a job proposed to this client's account (v5+). */
  acceptJobOwner(jobId: bigint): Promise<Sent<void>> {
    return this.send("accept_job_owner", { job_id: jobId });
  }

  /**
   * Runs a due job. `keeper` (default: this client's account) is the staked
   * keeper that gets paid; when it differs from the transaction source, the
   * keeper's auth entry is signed with `signAuthEntry`.
   */
  execute(jobId: bigint, keeper = this.publicKey): Promise<Sent<void>> {
    return this.send("execute", { keeper, job_id: jobId });
  }

  executeBatch(jobIds: bigint[], keeper = this.publicKey): Promise<Sent<boolean[]>> {
    return this.send("execute_batch", { keeper, job_ids: jobIds });
  }

  /** Simulates `execute_batch`: which jobs would run and what it would cost. */
  prepareExecuteBatch(jobIds: bigint[], keeper = this.publicKey): Promise<Prepared<boolean[]>> {
    return this.prepare("execute_batch", { keeper, job_ids: jobIds });
  }

  stake(amount: bigint): Promise<Sent<bigint>> {
    return this.send("stake", { keeper: this.publicKey, amount });
  }

  beginUnbonding(): Promise<Sent<bigint>> {
    return this.send("begin_unbonding", { keeper: this.publicKey });
  }

  withdrawStake(): Promise<Sent<bigint>> {
    return this.send("withdraw_stake", { keeper: this.publicKey });
  }

  /** Pays out every listed keeper whose unbonding has finished. Anyone may send it. */
  withdrawStakes(keepers: string[]): Promise<Sent<bigint[]>> {
    return this.send("withdraw_stakes", { keepers });
  }
}

/** Unwraps a contract `Result` from a simulation, throwing SoroCronError on `Err`. */
export function unwrapResult<T>(value: unknown): T {
  if (value && typeof value === "object" && "isErr" in value && typeof value.isErr === "function") {
    const result = value as { isErr(): boolean; unwrap(): T; unwrapErr(): unknown };
    if (result.isErr()) {
      const err = result.unwrapErr();
      const parsed = parseContractError(err);
      if (parsed) throw parsed;
      const msg =
        (err as any)?.message ||
        (err as any)?.name ||
        (err as any)?.code ||
        JSON.stringify(err);
      throw new Error(`Contract error: ${msg}`);
    }
    return result.unwrap();
  }
  return value as T;
}

export { SoroCronError };
