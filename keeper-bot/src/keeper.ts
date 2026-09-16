/**
 * Reference SoroCron keeper node.
 *
 * Polls the registry, executes every job that is due, and collects fees.
 *
 *   npm run keeper            run forever
 *   npm run keeper -- --once  single pass (useful in CI or cron)
 *
 * This implementation scans every job id each tick. That is fine for a demo
 * but not for thousands of jobs; indexing JobCreated/JobCancelled events is
 * tracked as an open issue.
 */
import { clientFor, ensureFunded, keypairFromEnv, registryId } from "./config.js";
import { tick, type RegistryLike } from "./tick.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 10_000);
const once = process.argv.includes("--once");

function log(message: string) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function main() {
  const keypair = keypairFromEnv();
  const keeper = keypair.publicKey();
  await ensureFunded(keypair);

  const contractId = registryId();
  const registry = await clientFor(contractId, keypair);

  const info = (await registry.get_keeper({ keeper })).result;
  const { min_stake } = (await registry.config()).result;
  if (!info) {
    throw new Error(`${keeper} is not a registered keeper. Stake first (see \`npm run demo\`).`);
  }
  if (info.unbonding_at !== undefined && info.unbonding_at !== null) {
    throw new Error(`${keeper} is unbonding and cannot execute jobs.`);
  }
  if (info.stake < min_stake) {
    throw new Error(`Stake ${info.stake} is below the minimum ${min_stake}.`);
  }

  log(`Keeper ${keeper} watching registry ${contractId}`);

  let stopping = false;
  process.on("SIGINT", () => {
    log("Shutting down...");
    stopping = true;
  });

  do {
    try {
      // `registry`'s methods are generated at runtime from the on-chain
      // contract spec, so ContractMethods (config.ts) can't statically prove
      // it has job_count/is_due/execute -- it does, and RegistryLike pins
      // down exactly the shape tick() and its tests rely on.
      await tick(registry as unknown as RegistryLike, keeper, log);
    } catch (err) {
      log(`tick failed: ${err instanceof Error ? err.message : err}`);
    }
    if (!once && !stopping) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  } while (!once && !stopping);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
