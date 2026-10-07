/**
 * Known SoroCron deployments. Mirrors deployments/<network>.json in the
 * repository; update both together when redeploying (Stellar resets
 * testnet periodically).
 */
import { Networks } from "@stellar/stellar-sdk";

export interface NetworkConfig {
  name: "testnet" | "mainnet" | "local";
  rpcUrl: string;
  networkPassphrase: string;
  explorer: string;
  contracts: {
    registry: string;
    executor: string;
    ttlGuardian: string;
    feeToken: string;
    counter?: string;
    flagResolver?: string;
  };
}

/** Mirrors deployments/testnet.json; scripts/sync-deployment.mjs updates it on redeploy. */
export const TESTNET: NetworkConfig = {
  name: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
  explorer: "https://stellar.expert/explorer/testnet",
  contracts: {
    registry: "CDOAY46V2REWSINTZINUKTYELO5FYVEOCFWEKVMGH4BUJPSTRZTRGQ5W",
    executor: "CBRQANLQBDWDUM5GRQBP7T3VZBOXG6EZEKNRNYMXTFAYWSDSJL6PPAFA",
    ttlGuardian: "CB3KQFXKCL4SEBQTDGCZHJLBX365ORTHQY724SCETVS2GYZCXPGGLE73",
    feeToken: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    counter: "CDAJHPUZX55DPNTABY5OTXJYK27XWS6V744BLS5LPWMOTTI7LERGJWU2",
    flagResolver: "CDYKTISS6TCWDPE2NJ5YVD3FJU6ULCZXLMSQE32XQTIICMCVDDIGHWXO",
  },
};
