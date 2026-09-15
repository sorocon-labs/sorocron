/**
 * End-to-end demo against the testnet deployment:
 *   1. stake as a keeper
 *   2. schedule `counter.increment(1)` every 30 seconds
 *   3. execute the job once and show the counter moved and the keeper got paid
 *
 * Afterwards `npm run keeper` keeps executing it on schedule.
 */
import { nativeToScVal } from "@stellar/stellar-sdk";
import {
  EXPLORER,
  XLM,
  clientFor,
  ensureFunded,
  keypairFromEnv,
  loadDeployment,
  unwrap,
} from "./config.js";

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
  console.log("Creating job: counter.increment(1) every 30s...");
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

  // 3. Execute it once.
  const before: number = (await counter.count()).result;
  console.log("Executing job as keeper...");
  const execTx = await registry.execute({ keeper: me, job_id: jobId });
  const sent = await execTx.signAndSend();
  unwrap(sent.result);
  const after: number = (await counter.count()).result;

  const job = (await registry.get_job({ job_id: jobId })).result;
  console.log(`  counter: ${before} -> ${after}`);
  console.log(`  job runs: ${job.runs}, remaining balance: ${job.balance} stroops`);
  console.log(`  next run at: ${new Date(Number(job.next_run) * 1000).toISOString()}`);
  const hash = sent.sendTransactionResponse?.hash;
  if (hash) console.log(`  tx: ${EXPLORER}/tx/${hash}`);
  console.log(`\nRegistry: ${EXPLORER}/contract/${deployment.registry}`);
  console.log("Run `npm run keeper` to keep executing due jobs.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
