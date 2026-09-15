import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, Networks, contract, rpc } from "@stellar/stellar-sdk";

const here = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = resolve(here, "..", "..");
export const BOT_ROOT = resolve(here, "..");
export const WASM_DIR = resolve(REPO_ROOT, "target", "wasm32v1-none", "release");

export const NETWORK = process.env.STELLAR_NETWORK ?? "testnet";
export const NETWORK_PASSPHRASE = NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
export const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
export const DEPLOYMENTS_FILE = resolve(REPO_ROOT, "deployments", `${NETWORK}.json`);
export const EXPLORER = `https://stellar.expert/explorer/${NETWORK === "mainnet" ? "public" : "testnet"}`;

export const server = new rpc.Server(RPC_URL);

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
    throw new Error(`No deployment found at ${DEPLOYMENTS_FILE}. Run \`npm run deploy:testnet\` first.`);
  }
  return JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")) as Deployment;
}

export function registryId(): string {
  return process.env.SOROCRON_CONTRACT_ID || loadDeployment().registry;
}

export function keypairFromEnv(): Keypair {
  const secret = process.env.STELLAR_SECRET_KEY;
  if (!secret) {
    throw new Error("Set STELLAR_SECRET_KEY in keeper-bot/.env (or run `npm run deploy:testnet` to generate one).");
  }
  return Keypair.fromSecret(secret);
}

export function clientFor(contractId: string, keypair: Keypair) {
  return contract.Client.from<ContractMethods>({
    contractId,
    rpcUrl: RPC_URL,
    networkPassphrase: NETWORK_PASSPHRASE,
    publicKey: keypair.publicKey(),
    ...contract.basicNodeSigner(keypair, NETWORK_PASSPHRASE),
  });
}

/** Creates and funds the account via Friendbot if it doesn't exist yet (testnet only). */
export async function ensureFunded(keypair: Keypair): Promise<void> {
  try {
    await server.getAccount(keypair.publicKey());
  } catch {
    if (NETWORK === "mainnet") {
      throw new Error(`Account ${keypair.publicKey()} does not exist on mainnet. Fund it first.`);
    }
    console.log(`Funding ${keypair.publicKey()} with Friendbot...`);
    await server.requestAirdrop(keypair.publicKey());
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
