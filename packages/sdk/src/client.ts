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
import { contract } from "@stellar/stellar-sdk";
import { SoroCronError, parseContractError } from "./errors.js";
import type { NetworkConfig } from "./networks.js";
import type { Config, Job, JobParams, JobUpdate, Keeper } from "./types.js";

export interface ConnectOptions {
  network: NetworkConfig;
  /** Override the network's registry address. */
  contractId?: string;
  /** Account that signs and pays for transactions. */
  publicKey?: string;
  signTransaction?: contract.ClientOptions["signTransaction"];
}

export interface Sent<T> {
  hash: string;
  result: T;
}

/** Page size used by `allJobs`; matches the registry's MAX_GET_JOBS_LIMIT. */
export const PAGE_SIZE = 50;

type Method = (args?: Record<string, unknown>) => Promise<contract.AssembledTransaction<unknown>>;

export class SoroCron {
  private constructor(
    private readonly client: contract.Client & Record<string, Method>,
    readonly contractId: string,
    readonly network: NetworkConfig,
    readonly publicKey?: string,
  ) {}

  static async connect(options: ConnectOptions): Promise<SoroCron> {
    const contractId = options.contractId ?? options.network.contracts.registry;
    const client = await contract.Client.from({
      contractId,
      rpcUrl: options.network.rpcUrl,
      networkPassphrase: options.network.networkPassphrase,
      publicKey: options.publicKey,
      signTransaction: options.signTransaction,
    });
    return new SoroCron(
      client as contract.Client & Record<string, Method>,
      contractId,
      options.network,
      options.publicKey,
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

  getKeeper(keeper: string): Promise<Keeper | undefined> {
    return this.read("get_keeper", { keeper });
  }

  /** Authoritative due check, including the job's resolver. */
  isDue(jobId: bigint): Promise<boolean> {
    return this.read("is_due", { job_id: jobId });
  }

  // --------------------------------------------------------------- writes

  private async send<T>(method: string, args: Record<string, unknown>): Promise<Sent<T>> {
    if (!this.publicKey) throw new Error("Connect a wallet (publicKey + signTransaction) to send transactions");
    const fn = this.client[method];
    if (typeof fn !== "function") {
      throw new Error(`Registry ${this.contractId} has no "${method}" function (older version?)`);
    }
    let tx: contract.AssembledTransaction<unknown>;
    try {
      tx = await fn.call(this.client, args);
    } catch (err) {
      throw parseContractError(err) ?? err;
    }
    const result = unwrapResult<T>(tx.result);
    try {
      const sent = await tx.signAndSend();
      return { hash: sent.sendTransactionResponse?.hash ?? "", result };
    } catch (err) {
      throw parseContractError(err) ?? err;
    }
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

  execute(jobId: bigint): Promise<Sent<void>> {
    return this.send("execute", { keeper: this.publicKey, job_id: jobId });
  }

  executeBatch(jobIds: bigint[]): Promise<Sent<boolean[]>> {
    return this.send("execute_batch", { keeper: this.publicKey, job_ids: jobIds });
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
}

/** Unwraps a contract `Result` from a simulation, throwing SoroCronError on `Err`. */
export function unwrapResult<T>(value: unknown): T {
  if (value && typeof value === "object" && "isErr" in value && typeof value.isErr === "function") {
    const result = value as { isErr(): boolean; unwrap(): T; unwrapErr(): unknown };
    if (result.isErr()) {
      const err = result.unwrapErr();
      throw parseContractError(err) ?? new Error(`Contract error: ${JSON.stringify(err)}`);
    }
    return result.unwrap();
  }
  return value as T;
}

export { SoroCronError };
