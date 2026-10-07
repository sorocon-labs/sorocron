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
    registry: "CDQPGH3YKV22VYFCZ4WUSOWFBM26PZDCTATCNBRUKLOUYAIJWDCQ6PE4",
    executor: "CA7YGKMX4OZYNRMQWTLYZSG2WC52OWOCSV4XIQ75SX5LIRISTQIWMLCV",
    ttlGuardian: "CB7GKJSFY7PIESJW7JEPH4HHOAJ5XOCESWJPPWDGZ4REEQ2Y72YCDFGP",
    feeToken: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    counter: "CBYUUVNSCHQ7Q4X5XCPOP76UBDEXA6LO54F27LLXAZH5VMNXIN73MB7W",
    flagResolver: "CDYKTISS6TCWDPE2NJ5YVD3FJU6ULCZXLMSQE32XQTIICMCVDDIGHWXO",
  },
};
