/**
 * Reference SoroCron keeper node.
 *
 *   npm run keeper            run until stopped
 *   npm run keeper -- --once  single pass (useful in CI or cron)
 *
 * Keeps a local index of jobs from registry events, executes due jobs in
 * batches through one or more channel accounts, bids inclusion fees from
 * recent network fee stats, and alerts a webhook when it needs attention.
 * See docs/guides/keeper-deployment.md for running it in production.
 *
 * Observability: METRICS_PORT serves Prometheus metrics on /metrics and a
 * liveness probe on /healthz; LOG_FORMAT=json gives structured logs.
 */
import type { Keypair } from "@stellar/stellar-sdk";
import type { SoroCron } from "@sorocron/sdk";
import { Alerter } from "./alerts.js";
import { formatXlm, isBalanceLow } from "./balance.js";
import { ChannelPool } from "./channels.js";
import {
  EXPLORER,
  NATIVE_TOKEN_CONTRACT_ID,
  NETWORK,
  channelKeypairsFromEnv,
  connect,
  ensureFunded,
  keypairFromEnv,
  registryId,
  server,
  settings,
} from "./config.js";
import { describeMissingContractError } from "./contractErrors.js";
import { FeeStrategy } from "./fees.js";
import { JobIndex } from "./jobIndex.js";
import { createLogger } from "./logger.js";
import { Metrics, startMetricsServer, type HealthState } from "./metrics.js";
import { withRetry } from "./retry.js";
import { tick, type BatchClient, type TickSummary } from "./tick.js";

const once = process.argv.includes("--once");
const logger = createLogger();
const log = logger.info;

/** Consecutive failed ticks before the RPC is reported down. */
const RPC_DOWN_AFTER = 3;

async function main() {
  const keeperKeys = keypairFromEnv();
  const keeper = keeperKeys.publicKey();
  const channelKeys: Keypair[] = channelKeypairsFromEnv();
  await ensureFunded(keeperKeys);
  for (const k of channelKeys) await ensureFunded(k);

  const contractId = registryId();
  let cron: SoroCron;
  let channels: ChannelPool<BatchClient>;
  try {
    cron = await connect(keeperKeys);
    const clients = channelKeys.length
      ? await Promise.all(channelKeys.map((k) => connect(keeperKeys, k)))
      : [cron];
    channels = new ChannelPool<BatchClient>(clients);
  } catch (err) {
    throw new Error(describeMissingContractError(err, contractId) ?? String(err));
  }

  const stats = await cron.keeperStats(keeper);
  if (!stats) throw new Error(`${keeper} is not a registered keeper. Stake first: npm run cli -- keeper stake <amount>`);
  if (!stats.eligible) throw new Error(`${keeper} can't execute (unbonding, or stake below the minimum).`);
  const config = await cron.config();

  const metrics = new Metrics();
  const health: HealthState = { lastSuccessMs: 0 };
  const staleAfterMs = Math.max(3 * settings.pollIntervalMs, 60_000);
  const metricsServer = settings.metricsPort
    ? startMetricsServer(settings.metricsPort, metrics, health, staleAfterMs)
    : undefined;

  const alerts = new Alerter({
    url: settings.alertWebhookUrl,
    format: settings.alertFormat,
    cooldownMs: settings.alertCooldownMs,
    source: `keeper ${keeper.slice(0, 6)}… on ${NETWORK}`,
    log: logger.warn,
  });
  const fees = new FeeStrategy(server, { percentile: settings.feePercentile, maxFee: settings.maxInclusionFee });
  const index = new JobIndex(
    {
      // Reads retry with backoff on transient RPC errors.
      jobCount: () => withRetry(() => cron.jobCount()),
      getJobs: (start, limit) => withRetry(() => cron.getJobs(start, limit)),
      getJob: (id) => withRetry(() => cron.getJob(id)),
      events: (options) => withRetry(() => cron.events(options)),
      latestLedger: async () => (await withRetry(() => server.getLatestLedger())).sequence,
    },
    log,
    settings.resyncEveryTicks,
  );
  await index.load();

  log(
    `Keeper ${keeper} watching registry ${contractId} with ${channels.size} channel(s)` +
      (metricsServer ? `, metrics on :${settings.metricsPort}` : "") +
      (alerts.enabled ? ", alerts on" : ""),
  );

  let stopping = false;
  const stop = () => {
    log("Shutting down...");
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let failedTicks = 0;
  let failedSends = 0;
  do {
    try {
      await checkAccounts(keeper, channelKeys, metrics, alerts);
      await checkStake(cron, keeper, config.min_stake, alerts);
      await fees.refresh();
      metrics.set("sorocron_keeper_inclusion_fee_stroops", "Current inclusion fee bid", fees.current());

      const started = Date.now();
      const summary = await tick(
        {
          index,
          channels,
          fees,
          keeper,
          log,
          batchSize: settings.batchSize,
          minProfitStroops: settings.minProfitStroops,
          feeIsNative: config.fee_token === NATIVE_TOKEN_CONTRACT_ID,
          explorer: EXPLORER,
        },
        BigInt(Math.floor(Date.now() / 1000)),
      );
      health.lastSuccessMs = Date.now();
      recordTick(metrics, summary, health.lastSuccessMs - started, index);
      failedTicks = 0;
      alerts.clear("rpc_down");

      failedSends = summary.failed > 0 && summary.executed === 0 ? failedSends + 1 : 0;
      if (failedSends >= 3) {
        await alerts.notify({
          kind: "runs_failing",
          severity: "warning",
          message: `every send has failed for ${failedSends} ticks in a row`,
          details: { lastFailed: summary.failed, feeBid: fees.current() },
        });
      }
    } catch (err) {
      failedTicks += 1;
      metrics.inc("sorocron_keeper_tick_errors_total", "Ticks that threw before finishing");
      logger.error(`tick failed: ${err instanceof Error ? err.message : err}`);
      if (failedTicks >= RPC_DOWN_AFTER) {
        await alerts.notify({
          kind: "rpc_down",
          severity: "critical",
          message: `${failedTicks} ticks in a row failed`,
          details: { rpc: server.serverURL.toString(), error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
    if (!once && !stopping) await new Promise((r) => setTimeout(r, settings.pollIntervalMs));
  } while (!once && !stopping);
  metricsServer?.close();
}

/** Warns when the keeper or a channel can't afford network fees much longer. */
async function checkAccounts(keeper: string, channels: Keypair[], metrics: Metrics, alerts: Alerter) {
  for (const address of [keeper, ...channels.map((c) => c.publicKey())]) {
    try {
      const balance = BigInt((await server.getAccountEntry(address)).balance);
      metrics.set("sorocron_keeper_balance_stroops", "Native XLM balance of keeper and channel accounts", Number(balance), {
        account: address,
      });
      if (isBalanceLow(balance, settings.minBalanceXlm)) {
        logger.warn(`${address} is low on XLM (${formatXlm(balance)}); fund it or sends will fail`);
        await alerts.notify(
          {
            kind: "low_balance",
            severity: "warning",
            message: `${address} has ${formatXlm(balance)} XLM, below ${settings.minBalanceXlm}`,
            details: { account: address },
          },
          `low_balance:${address}`,
        );
      } else {
        alerts.clear(`low_balance:${address}`);
      }
    } catch (err) {
      logger.warn(`could not check ${address}'s balance: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** Alerts when slashing or a raised minimum leaves the keeper ineligible. */
async function checkStake(cron: SoroCron, keeper: string, minStake: bigint, alerts: Alerter) {
  const stats = await cron.keeperStats(keeper);
  if (!stats || !stats.eligible) {
    await alerts.notify({
      kind: "keeper_ineligible",
      severity: "critical",
      message: "the keeper can no longer execute jobs",
      details: { stake: stats?.stake ?? 0n, minStake, slashed: stats?.slashed ?? 0n },
    });
  } else if (stats.stake < (minStake * 11n) / 10n) {
    await alerts.notify({
      kind: "low_stake",
      severity: "warning",
      message: "stake is within 10% of the minimum; one slash could make the keeper ineligible",
      details: { stake: stats.stake, minStake },
    });
  }
}

function recordTick(metrics: Metrics, summary: TickSummary, durationMs: number, index: JobIndex) {
  metrics.inc("sorocron_keeper_ticks_total", "Completed polling passes");
  metrics.set("sorocron_keeper_tick_duration_seconds", "Duration of the last tick", durationMs / 1000);
  metrics.set("sorocron_keeper_last_tick_timestamp_seconds", "Unix time of the last completed tick", Date.now() / 1000);
  metrics.set("sorocron_keeper_jobs_indexed", "Live jobs in the keeper's index", index.size);
  metrics.set("sorocron_keeper_jobs_due", "Jobs that looked due in the last tick", summary.due);
  metrics.set("sorocron_keeper_rpc_calls_last_sync", "RPC calls the last index sync made", index.lastSyncCalls);
  metrics.inc("sorocron_keeper_batches_total", "execute_batch transactions sent", {}, summary.batches);
  const help = "Due jobs by outcome";
  metrics.inc("sorocron_keeper_jobs_total", help, { outcome: "executed" }, summary.executed);
  metrics.inc("sorocron_keeper_jobs_total", help, { outcome: "skipped" }, summary.skipped);
  metrics.inc("sorocron_keeper_jobs_total", help, { outcome: "unprofitable" }, summary.unprofitable);
  metrics.inc("sorocron_keeper_jobs_total", help, { outcome: "failed" }, summary.failed);
  metrics.inc(
    "sorocron_keeper_fees_earned_stroops_total",
    "Fees earned from executed jobs paid in native XLM",
    {},
    Number(summary.earnedStroops),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
