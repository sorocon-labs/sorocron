/**
 * End-to-end demo against a deployment (testnet by default):
 *   1. stake as a keeper
 *   2. schedule `counter.increment(1)` every 30 seconds and execute it once
 *   3. schedule a daily TTL Guardian job that keeps the counter contract from
 *      being archived, and execute it once
 *
 * Afterwards `npm run keeper` keeps executing both on schedule. With
 * STELLAR_NETWORK=local this is the end-to-end check CI runs against a
 * local network; it exits non-zero unless both jobs ran.
 */
import { arg, parseAmount, schedule, ttlGuardianArgs } from "@sorocron/sdk";
import { EXPLORER, connect, ensureFunded, keypairFromEnv, loadDeployment } from "./config.js";

const link = (hash: string) => (hash && EXPLORER ? `${EXPLORER}/tx/${hash}` : hash);

async function main() {
  const deployment = loadDeployment();
  const keypair = keypairFromEnv();
  const me = keypair.publicKey();
  await ensureFunded(keypair);
  const cron = await connect(keypair);
  const config = await cron.config();

  // 1. Stake as a keeper (skipped if already staked enough).
  const stake = (await cron.getKeeper(me))?.stake ?? 0n;
  if (stake < config.min_stake) {
    console.log(`Staking ${config.min_stake - stake} stroops as keeper...`);
    await cron.stake(config.min_stake - stake);
  } else {
    console.log(`Already staked ${stake} stroops.`);
  }

  const common = {
    start_at: 0n,
    max_fee_per_run: 0n,
    end_at: 0n,
    fee_per_run: parseAmount("0.1"),
  };

  // 2. counter.increment(1) every 30s, at most 10 runs.
  console.log("\nCreating job: counter.increment(1) every 30s...");
  const counterJob = await cron.createJob(
    {
      ...common,
      target: deployment.counter,
      function: "increment",
      args: [arg.u32(1)],
      interval: 30n,
      schedule: schedule.interval(),
      max_runs: 10,
    },
    parseAmount("1"),
  );
  console.log(`  job ${counterJob.result}: ${link(counterJob.hash)}`);
  const ran1 = await cron.execute(counterJob.result);
  console.log(`  executed: ${link(ran1.hash)}`);

  // 3. Keep the counter contract alive: extend its TTL daily.
  console.log("\nCreating job: TTL Guardian protects the counter daily...");
  const guardJob = await cron.createJob(
    {
      ...common,
      target: deployment.ttlGuardian,
      function: "extend",
      args: ttlGuardianArgs(deployment.counter, 60, 90),
      interval: 86_400n,
      schedule: schedule.interval(),
      max_runs: 0,
    },
    parseAmount("1"),
  );
  console.log(`  job ${guardJob.result}: ${link(guardJob.hash)}`);
  const ran2 = await cron.execute(guardJob.result);
  console.log(`  executed: ${link(ran2.hash)}`);

  const [a, b] = await Promise.all([cron.getJob(counterJob.result), cron.getJob(guardJob.result)]);
  if (a?.runs !== 1 || b?.runs !== 1) throw new Error(`expected both jobs to have run once (got ${a?.runs}, ${b?.runs})`);
  console.log("\nBoth jobs ran. Start a keeper with `npm run keeper` to keep them running.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
