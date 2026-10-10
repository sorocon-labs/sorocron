import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Asset, Keypair, Networks, contract, rpc } from "@stellar/stellar-sdk";
import { SoroCron, type NetworkConfig } from "@sorocron/sdk";
import { rpcUrlsFrom } from "./endpoints.js";

const here = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = resolve(here, "..", "..");
export const BOT_ROOT = resolve(here, "..");
export const WASM_DIR = resolve(REPO_ROOT, "target", "wasm32v1-none", "release");

export type NetworkName = "testnet" | "mainnet" | "local";

interface NetworkDefaults {
  rpcUrl: string;
  passphrase: string;
  explorer: string;
  /** Funds new accounts; empty on mainnet. */
  friendbot: string;
}

const NETWORKS: Record<NetworkName, NetworkDefaults> = {
  testnet: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    passphrase: Networks.TESTNET,
    explorer: "https://stellar.expert/explorer/testnet",
    friendbot: "https://friendbot.stellar.org",
  },
  // There is no public mainnet RPC default: set STELLAR_RPC_URL to your provider.
  mainnet: { rpcUrl: "", passphrase: Networks.PUBLIC, explorer: "https://stellar.expert/explorer/public", friendbot: "" },
  // `docker run -p 8000:8000 stellar/quickstart --local`
  local: {
    rpcUrl: "http://localhost:8000/rpc",
    passphrase: Networks.STANDALONE,
    explorer: "",
    friendbot: "http://localhost:8000/friendbot",
  },
};

export const NETWORK = (process.env.STELLAR_NETWORK ?? "testnet") as NetworkName;
if (!(NETWORK in NETWORKS)) {
  throw new Error(`STELLAR_NETWORK must be testnet, mainnet or local (got ${NETWORK})`);
}
/**
 * RPC endpoints, most preferred first: STELLAR_RPC_URLS (comma-separated)
 * when set, otherwise STELLAR_RPC_URL or the network default. The keeper
 * fails over between them; scripts use the first.
 */
export const RPC_URLS = rpcUrlsFrom(process.env.STELLAR_RPC_URLS, process.env.STELLAR_RPC_URL || NETWORKS[NETWORK].rpcUrl);
export const RPC_URL = RPC_URLS[0] ?? "";
if (!RPC_URL) throw new Error("Set STELLAR_RPC_URL (or STELLAR_RPC_URLS) for mainnet.");
export const NETWORK_PASSPHRASE = NETWORKS[NETWORK].passphrase;
export const EXPLORER = NETWORKS[NETWORK].explorer;
export const FRIENDBOT_URL = process.env.FRIENDBOT_URL || NETWORKS[NETWORK].friendbot;
export const DEPLOYMENTS_FILE = resolve(REPO_ROOT, "deployments", `${NETWORK}.json`);

export function rpcServer(url: string): rpc.Server {
  return new rpc.Server(url, { allowHttp: url.startsWith("http://") });
}

export const server = rpcServer(RPC_URL);

/** The native XLM SEP-41 wrapper contract id on this network. */
export const NATIVE_TOKEN_CONTRACT_ID = Asset.native().contractId(NETWORK_PASSPHRASE);

export interface Deployment {
  network: string;
  registry: string;
  executor: string;
  ttlGuardian: string;
  counter: string;
  flagResolver: string;
  feeToken: string;
  admin: string;
  deployedAt: string;
}

/** Contract methods are generated at runtime from the on-chain spec. */
export type ContractMethods = Record<
  string,
  (args?: Record<string, unknown>) => Promise<contract.AssembledTransaction<any>>
>;

export function loadDeployment(): Deployment {
  if (!existsSync(DEPLOYMENTS_FILE)) {
    throw new Error(`No deployment found at ${DEPLOYMENTS_FILE}. Run \`npm run deploy\` first.`);
  }
  return JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")) as Deployment;
}

export function registryId(): string {
  return process.env.SOROCRON_CONTRACT_ID || loadDeployment().registry;
}

/** The SDK's view of this network and deployment, through `rpcUrl`. */
export function networkConfig(rpcUrl = RPC_URL): NetworkConfig {
  const d = existsSync(DEPLOYMENTS_FILE) ? loadDeployment() : undefined;
  return {
    name: NETWORK,
    rpcUrl,
    networkPassphrase: NETWORK_PASSPHRASE,
    explorer: EXPLORER,
    contracts: {
      registry: registryId(),
      executor: d?.executor ?? "",
      ttlGuardian: d?.ttlGuardian ?? "",
      feeToken: d?.feeToken ?? NATIVE_TOKEN_CONTRACT_ID,
      counter: d?.counter,
      flagResolver: d?.flagResolver,
    },
  };
}

/** The staked keeper: receives fees and signs `execute` authorizations. */
export function keypairFromEnv(): Keypair {
  const secret = process.env.STELLAR_SECRET_KEY;
  if (!secret) {
    throw new Error("Set STELLAR_SECRET_KEY in keeper-bot/.env (or run `npm run deploy` to generate one).");
  }
  return Keypair.fromSecret(secret);
}

/**
 * Optional channel accounts (CHANNEL_SECRET_KEYS, comma-separated) that pay
 * for and sequence transactions on the keeper's behalf, so several batches
 * can be in flight at once. Without them the keeper account does it alone.
 */
export function channelKeypairsFromEnv(): Keypair[] {
  return (process.env.CHANNEL_SECRET_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Keypair.fromSecret(s));
}

/**
 * An SDK client sending from `source` (default: the keeper itself). When the
 * source is a channel account, the keeper still signs its own auth entry.
 */
export function connect(keeper: Keypair, source: Keypair = keeper, rpcUrl = RPC_URL): Promise<SoroCron> {
  return SoroCron.connect({
    network: networkConfig(rpcUrl),
    publicKey: source.publicKey(),
    signTransaction: contract.basicNodeSigner(source, NETWORK_PASSPHRASE).signTransaction,
    signAuthEntry: contract.basicNodeSigner(keeper, NETWORK_PASSPHRASE).signAuthEntry,
  });
}

/** Raw generated contract client, for contracts without an SDK (deploy scripts). */
export function clientFor(contractId: string, keypair: Keypair) {
  return contract.Client.from<ContractMethods>({
    contractId,
    rpcUrl: RPC_URL,
    networkPassphrase: NETWORK_PASSPHRASE,
    publicKey: keypair.publicKey(),
    allowHttp: RPC_URL.startsWith("http://"),
    ...contract.basicNodeSigner(keypair, NETWORK_PASSPHRASE),
  });
}

/** Creates and funds the account via Friendbot if it doesn't exist yet (testnet and local only). */
export async function ensureFunded(keypair: Keypair): Promise<void> {
  try {
    await server.getAccount(keypair.publicKey());
  } catch {
    if (NETWORK === "mainnet") {
      throw new Error(`Account ${keypair.publicKey()} does not exist on mainnet. Fund it first.`);
    }
    console.log(`Funding ${keypair.publicKey()} with Friendbot...`);
    await server.fundAddress(keypair.publicKey(), FRIENDBOT_URL);
  }
}

/** Unwraps a Rust-style `Result` returned by the contract client, or passes plain values through. */
export function unwrap<T>(value: any): T {
  if (value && typeof value.isErr === "function") {
    if (value.isErr()) throw new Error(`Contract error: ${value.unwrapErr().message}`);
    return value.unwrap() as T;
  }
  return value as T;
}

export const XLM = (amount: number): bigint => BigInt(Math.round(amount * 10_000_000));

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number (got ${raw})`);
  return value;
}

/** Keeper node settings from the environment; see .env.example. */
export const settings = {
  pollIntervalMs: num("POLL_INTERVAL_MS", 10_000),
  minBalanceXlm: num("MIN_BALANCE_XLM", 5),
  minProfitStroops: BigInt(process.env.MIN_PROFIT_STROOPS ?? "0"),
  /** Jobs per execute_batch transaction (registry maximum 20). */
  batchSize: Math.min(20, Math.max(1, num("BATCH_SIZE", 10))),
  metricsPort: num("METRICS_PORT", 0),
  /** Inclusion fee percentile to bid: p10 … p99 of recent Soroban fees. */
  feePercentile: process.env.FEE_PERCENTILE ?? "p70",
  /** Never bid more than this inclusion fee, in stroops. */
  maxInclusionFee: num("MAX_INCLUSION_FEE", 100_000),
  /** Reload every job from scratch every N ticks, as a safety net for the event index. */
  resyncEveryTicks: num("RESYNC_EVERY_TICKS", 360),
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL ?? "",
  alertFormat: (process.env.ALERT_FORMAT ?? "generic") as "discord" | "slack" | "generic",
  alertCooldownMs: num("ALERT_COOLDOWN_MS", 3_600_000),
  /** Restore archived state for jobs when the restore's resource fee is at most this. 0 turns restores off. */
  maxRestoreFee: BigInt(num("MAX_RESTORE_FEE_STROOPS", 0)),
  /** Stake to hold: the keeper stakes back up to this after slashing. 0 turns top-ups off. */
  topUpStakeTo: XLM(num("TOPUP_STAKE_TO_XLM", 0)),
};
