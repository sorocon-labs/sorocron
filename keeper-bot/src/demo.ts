/**
 * End-to-end demo against the testnet deployment:
 *   1. stake as a keeper
 *   2. schedule `counter.increment(1)` every 30 seconds and execute it once
 *   3. schedule a daily TTL Guardian job that keeps the counter contract from
 *      being archived, and execute it once
 *
 * Afterwards `npm run keeper` keeps executing both on schedule.
 */
import { Address, nativeToScVal } from "@stellar/stellar-sdk";
import {
  EXPLORER,
  XLM,
  clientFor,
  ensureFunded,
  keypairFromEnv,
  loadDeployment,
  unwrap,
} from "./config.js";

const LEDGERS_PER_DAY = 17_280;

async function main() {
  const deployment = loadDeployment();
  const keypair = keypairFromEnv();
  const me = keypair.publicKey();
  await ensureFunded(keypair);

  const registry = await clientFor(deployment.registry, keypair);
  const counter = await clientFor(deployment.counter, keypair);
  const config = (await registry.config()).result;

  // 1. Stake as a keeper (skipped if already staked enough).
  const keeper = (await registry.get_keeper({ keeper: me })).result;
  const currentStake: bigint = keeper?.stake ?? 0n;
  if (currentStake < config.min_stake) {
    const amount = config.min_stake - currentStake;
    console.log(`Staking ${amount} stroops as keeper...`);
    unwrap((await (await registry.stake({ keeper: me, amount })).signAndSend()).result);
  } else {
    console.log(`Already staked ${currentStake} stroops.`);
  }

  // 2. Schedule counter.increment(1) every 30s, max 10 runs, 0.1 XLM per run.
  console.log("\nCreating job: counter.increment(1) every 30s...");
  const createTx = await registry.create_job({
    owner: me,
    params: {
      target: deployment.counter,
      function: "increment",
      args: [nativeToScVal(1, { type: "u32" })],
      interval: 30n,
      start_at: 0n,
      fee_per_run: XLM(0.1),
      max_runs: 10,
      resolver: undefined,
    },
    deposit: XLM(1),
  });
  const jobId = unwrap<bigint>((await createTx.signAndSend()).result);
  console.log(`  job id: ${jobId}`);

  const before: number = (await counter.count()).result;
  console.log("Executing job as keeper...");
  const sent = await (await registry.execute({ keeper: me, job_id: jobId })).signAndSend();
  unwrap(sent.result);
  const after: number = (await counter.count()).result;

  const job = (await registry.get_job({ job_id: jobId })).result;
  console.log(`  counter: ${before} -> ${after}`);
  console.log(`  job runs: ${job.runs}, remaining balance: ${job.balance} stroops`);
  console.log(`  next run at: ${new Date(Number(job.next_run) * 1000).toISOString()}`);
  const hash = sent.sendTransactionResponse?.hash;
  if (hash) console.log(`  tx: ${EXPLORER}/tx/${hash}`);

  // 3. Keep the counter contract alive: extend its TTL daily when it drops
  //    below 60 days, back up to 90 days.
  console.log("\nCreating TTL Guardian job protecting the counter contract...");
  const guardTx = await registry.create_job({
    owner: me,
    params: {
      target: deployment.ttlGuardian,
      function: "extend",
      args: [
        new Address(deployment.counter).toScVal(),
        nativeToScVal(60 * LEDGERS_PER_DAY, { type: "u32" }),
        nativeToScVal(90 * LEDGERS_PER_DAY, { type: "u32" }),
      ],
      interval: 86_400n,
      start_at: 0n,
      fee_per_run: XLM(0.1),
      max_runs: 0,
      resolver: undefined,
    },
    deposit: XLM(1),
  });
  const guardId = unwrap<bigint>((await guardTx.signAndSend()).result);
  console.log(`  job id: ${guardId}`);

  console.log("Executing guardian job as keeper...");
  const guardSent = await (await registry.execute({ keeper: me, job_id: guardId })).signAndSend();
  unwrap(guardSent.result);
  const guardHash = guardSent.sendTransactionResponse?.hash;
  if (guardHash) console.log(`  tx: ${EXPLORER}/tx/${guardHash}`);

  console.log(`\nRegistry: ${EXPLORER}/contract/${deployment.registry}`);
  console.log("Run `npm run keeper` to keep executing due jobs.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
