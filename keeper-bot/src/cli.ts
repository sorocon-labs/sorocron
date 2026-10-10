#!/usr/bin/env node
/**
 * `sorocron`: manage jobs and keeper stake from the terminal (#47, #76).
 *
 *   npm run cli -- jobs list
 *   npm run cli -- jobs create --target C... --function increment --arg u32:1 --every 1h --fee 0.1 --runs 24
 *   npm run cli -- keeper stake 100
 *   npm run cli -- keeper topup --to 100
 *
 * Reads STELLAR_SECRET_KEY, STELLAR_NETWORK and the registry address from
 * keeper-bot/.env and deployments/<network>.json, like the keeper. Read-only
 * commands work without a key.
 */
import { Command } from "commander";
import {
  SoroCron,
  SoroCronError,
  describeSchedule,
  formatAmount,
  formatDuration,
  jobStatus,
  parseAmount,
  runsRemaining,
  schedule,
  type Job,
  type JobParams,
} from "@sorocron/sdk";
import { EXPLORER, connect, keypairFromEnv, networkConfig } from "./config.js";
import { details, table } from "./format.js";
import { parseArgSpec, parseDaily, parseDuration, parseTime, parseWeekly } from "./parse.js";
import { planTopUp } from "./topup.js";

const now = () => BigInt(Math.floor(Date.now() / 1000));
const xlm = (v: bigint) => `${formatAmount(v)} XLM`;
const when = (t: bigint) => {
  const d = t - now();
  return d >= 0n ? `in ${formatDuration(d)}` : `${formatDuration(-d)} ago`;
};

/** A read-only client, or a signing one when a key is configured and needed. */
async function client(sign = false): Promise<SoroCron> {
  if (sign) return connect(keypairFromEnv());
  return SoroCron.connect({ network: networkConfig() });
}

function txLine(hash: string) {
  return hash && EXPLORER ? `\n${EXPLORER}/tx/${hash}` : hash ? `\ntx ${hash}` : "";
}

const program = new Command()
  .name("sorocron")
  .description("Manage SoroCron jobs and keeper stake")
  .showHelpAfterError();

// ---------------------------------------------------------------- jobs

const jobs = program.command("jobs").description("Create, inspect and manage jobs");

jobs
  .command("list")
  .description("List live jobs")
  .option("--mine", "only jobs owned by the configured account")
  .option("--owner <address>", "only jobs owned by this account")
  .option("--status <status>", "due, scheduled, underfunded, paused, failing, expired or completed")
  .action(async (opts: { mine?: boolean; owner?: string; status?: string }) => {
    const cron = await client();
    const owner = opts.mine ? keypairFromEnv().publicKey() : opts.owner;
    let list: Job[] = await cron.allJobs();
    if (owner) list = list.filter((j) => j.owner === owner);
    const t = now();
    if (opts.status) list = list.filter((j) => jobStatus(j, t) === opts.status);
    if (list.length === 0) return console.log("No jobs.");
    console.log(
      table(
        ["ID", "CALL", "STATUS", "SCHEDULE", "NEXT RUN", "RUNS LEFT", "BALANCE"],
        list.map((j) => [
          j.id,
          `${j.function}()`,
          jobStatus(j, t),
          describeSchedule(j),
          jobStatus(j, t) === "due" || jobStatus(j, t) === "scheduled" ? when(j.next_run) : "-",
          runsRemaining(j),
          xlm(j.balance),
        ]),
      ),
    );
  });

jobs
  .command("show <id>")
  .description("Show one job")
  .action(async (id: string) => {
    const cron = await client();
    const job = await cron.getJob(BigInt(id));
    if (!job) throw new Error(`Job ${id} doesn't exist (it may have been cancelled).`);
    const [due, fee, pendingOwner] = await Promise.all([
      cron.isDue(job.id),
      cron.currentFee(job.id).catch(() => undefined),
      // Registries before v5 can't transfer jobs.
      cron.pendingJobOwner(job.id).catch(() => undefined),
    ]);
    console.log(
      details([
        ["Job", `#${job.id}`],
        ["Status", `${jobStatus(job, now())}${due ? " (a keeper can run it now)" : ""}`],
        ["Owner", pendingOwner ? `${job.owner} (handing over to ${pendingOwner})` : job.owner],
        ["Call", `${job.target}.${job.function}(${job.args.length} args)`],
        ["Schedule", describeSchedule(job)],
        ["Next run", `${new Date(Number(job.next_run) * 1000).toISOString()} (${when(job.next_run)})`],
        ["Runs", job.max_runs ? `${job.runs} of ${job.max_runs}` : `${job.runs}`],
        ["Failures", job.failures],
        ["Fee per run", job.max_fee_per_run ? `${xlm(job.fee_per_run)} rising to ${xlm(job.max_fee_per_run)}` : xlm(job.fee_per_run)],
        ["Fee now", fee === undefined ? "-" : xlm(fee)],
        ["Balance", `${xlm(job.balance)} (${runsRemaining(job)} runs)`],
        ["Ends", job.end_at ? new Date(Number(job.end_at) * 1000).toISOString() : "never"],
        ["Resolver", job.resolver ?? "none"],
        ["Follows job", job.after === undefined || job.after === null ? "none" : `#${job.after}`],
        ["Keepers", job.keepers?.length ? job.keepers.join(", ") : "any staked keeper"],
      ]),
    );
  });

jobs
  .command("create")
  .description("Schedule a contract call")
  .requiredOption("--target <contract>", "contract to call")
  .requiredOption("--function <name>", "function to call")
  .option("--arg <type:value>", "an argument, e.g. u32:1 or address:G... (repeatable)", (v, all: string[]) => [...all, v], [])
  .option("--every <duration>", "run every interval, e.g. 30s, 15m, 1h, 1d")
  .option("--daily <HH:MM>", "run daily at this UTC time")
  .option("--weekly <day@HH:MM>", "run weekly, e.g. mon@09:30 (UTC)")
  .requiredOption("--fee <xlm>", "fee per run, paid to the keeper")
  .option("--max-fee <xlm>", "let the fee rise to this when a run is late")
  .option("--runs <n>", "runs to prepay", "10")
  .option("--max-runs <n>", "stop after this many runs", "0")
  .option("--start <time>", "first run (ISO date or unix seconds)")
  .option("--end <time>", "no runs after this time")
  .option("--resolver <contract>", "only run when this contract's should_run returns true")
  .option("--after <job>", "run once after each new run of this job")
  .option("--keeper <address>", "only this keeper may run it (repeatable)", (v, all: string[]) => [...all, v], [])
  .action(async (o) => {
    const kinds = [o.every, o.daily, o.weekly].filter(Boolean).length;
    if (kinds !== 1) throw new Error("Pass exactly one of --every, --daily or --weekly.");
    const fee = parseAmount(o.fee);
    const params: JobParams = {
      target: o.target,
      function: o.function,
      args: (o.arg as string[]).map(parseArgSpec),
      interval: o.every ? parseDuration(o.every) : 0n,
      schedule: o.daily ? parseDaily(o.daily) : o.weekly ? parseWeekly(o.weekly) : schedule.interval(),
      start_at: o.start ? parseTime(o.start) : 0n,
      fee_per_run: fee,
      max_fee_per_run: o.maxFee ? parseAmount(o.maxFee) : 0n,
      max_runs: Number(o.maxRuns),
      end_at: o.end ? parseTime(o.end) : 0n,
      resolver: o.resolver,
      keepers: (o.keeper as string[]).length ? o.keeper : undefined,
      after: o.after !== undefined ? BigInt(o.after) : undefined,
    };
    const deposit = fee * BigInt(o.runs);
    const cron = await client(true);
    const { hash, result } = await cron.createJob(params, deposit);
    console.log(`Created job #${result}, deposit ${xlm(deposit)}.${txLine(hash)}`);
  });

const simple = (
  name: string,
  description: string,
  run: (cron: SoroCron, id: bigint, amount?: string) => Promise<{ hash: string }>,
  done: string,
  withAmount = false,
) =>
  jobs
    .command(withAmount ? `${name} <id> <amount>` : `${name} <id>`)
    .description(description)
    .action(async (id: string, amount?: string) => {
      const { hash } = await run(await client(true), BigInt(id), amount);
      console.log(`${done.replace("{id}", id)}${txLine(hash)}`);
    });

simple("fund", "Add XLM to a job's balance", (c, id, a) => c.fundJob(id, parseAmount(a!)), "Funded job #{id}.", true);
simple("withdraw", "Take XLM back from your job", (c, id, a) => c.withdrawJobBalance(id, parseAmount(a!)), "Withdrew from job #{id}.", true);
simple("pause", "Pause your job", (c, id) => c.setJobActive(id, false), "Paused job #{id}.");
simple("resume", "Resume your job (clears its failure count)", (c, id) => c.setJobActive(id, true), "Resumed job #{id}.");
simple("cancel", "Delete your job and refund its balance", (c, id) => c.cancelJob(id), "Cancelled job #{id} and refunded its balance.");

jobs
  .command("transfer <id> <address>")
  .description("Hand your job to another account, which must then run `jobs accept`. Pass your own address to withdraw the offer")
  .action(async (id: string, address: string) => {
    const cron = await client(true);
    const { hash } = await cron.proposeJobOwner(BigInt(id), address);
    const done =
      address === cron.publicKey
        ? `Withdrew the pending handover of job #${id}.`
        : `Offered job #${id} to ${address}. It becomes theirs when they run \`sorocron jobs accept ${id}\`.`;
    console.log(done + txLine(hash));
  });

simple("accept", "Take over a job that was transferred to you", (c, id) => c.acceptJobOwner(id), "Job #{id} is now yours.");

// ---------------------------------------------------------------- keeper

const keeper = program.command("keeper").description("Stake, unbond and check keeper status");

keeper
  .command("status [address]")
  .description("Stake, eligibility and reputation (defaults to the configured account)")
  .action(async (address?: string) => {
    const cron = await client();
    const who = address ?? keypairFromEnv().publicKey();
    const [info, stats, config] = await Promise.all([cron.getKeeper(who), cron.keeperStats(who), cron.config()]);
    if (!info || !stats) return console.log(`${who} is not a keeper. Stake at least ${xlm(config.min_stake)} to become one.`);
    const unbonding = info.unbonding_at ?? undefined;
    console.log(
      details([
        ["Keeper", who],
        ["Status", unbonding !== undefined ? `unbonding, withdrawable ${when(unbonding)}` : stats.eligible ? "active" : "below minimum stake"],
        ["Stake", `${xlm(stats.stake)} (minimum ${xlm(config.min_stake)})`],
        ["Executions", stats.executions],
        ["Average lateness", formatDuration(stats.average_lateness)],
        ["Missed windows", stats.missed],
        ["Slashed", xlm(stats.slashed)],
        // Recent figures need a v5 registry.
        ...(stats.recent_lateness === undefined
          ? []
          : ([
              ["Recent lateness", `${formatDuration(stats.recent_lateness)} (last ~8 runs)`],
              ["Recent misses", `${(stats.recent_miss_bps ?? 0) / 100}% of recent runs`],
            ] as [string, string][])),
      ]),
    );
  });

keeper
  .command("stake <amount>")
  .description("Stake XLM (registers you as a keeper the first time)")
  .action(async (amount: string) => {
    const { hash, result } = await (await client(true)).stake(parseAmount(amount));
    console.log(`Staked. Total stake: ${xlm(result)}.${txLine(hash)}`);
  });

keeper
  .command("topup")
  .description("Stake back up to a target, e.g. after slashing. Does nothing when already there, so it's safe to run from cron")
  .option("--to <xlm>", "stake to hold (default: the registry minimum)")
  .option("--max <xlm>", "fail instead of staking more than this")
  .option("--dry-run", "only show what would be staked")
  .action(async (o: { to?: string; max?: string; dryRun?: boolean }) => {
    const cron = await client(true);
    const who = cron.publicKey!;
    const [info, config] = await Promise.all([cron.getKeeper(who), cron.config()]);
    const plan = planTopUp(info, o.to ? parseAmount(o.to) : config.min_stake, o.max ? parseAmount(o.max) : undefined);
    if (plan.target < config.min_stake) {
      console.warn(`Note: ${xlm(plan.target)} is below the registry minimum of ${xlm(config.min_stake)}, so the keeper can't execute.`);
    }
    if (plan.action === "blocked") {
      throw new Error(
        plan.reason === "unbonding"
          ? "Can't top up while unbonding. Withdraw first, then stake again."
          : `Reaching ${xlm(plan.target)} needs ${xlm(plan.amount)}, more than --max ${xlm(parseAmount(o.max!))}.`,
      );
    }
    if (plan.action === "none") {
      return console.log(`Stake is ${xlm(plan.stake)}, already at least ${xlm(plan.target)}. Nothing to do.`);
    }
    if (o.dryRun) {
      return console.log(`Would stake ${xlm(plan.amount)} to bring ${xlm(plan.stake)} up to ${xlm(plan.target)}.`);
    }
    const { hash, result } = await cron.stake(plan.amount);
    console.log(`Topped up ${xlm(plan.amount)}. Total stake: ${xlm(result)}.${txLine(hash)}`);
  });

keeper
  .command("unbond")
  .description("Stop executing and start the unbonding timer")
  .action(async () => {
    const { hash, result } = await (await client(true)).beginUnbonding();
    console.log(`Unbonding. Withdrawable at ${new Date(Number(result) * 1000).toISOString()}.${txLine(hash)}`);
  });

keeper
  .command("withdraw")
  .description("Withdraw your stake once unbonding has finished")
  .action(async () => {
    const { hash, result } = await (await client(true)).withdrawStake();
    console.log(`Withdrew ${xlm(result)}.${txLine(hash)}`);
  });

keeper
  .command("settle <addresses...>")
  .description("Pay out every listed keeper whose unbonding has finished (anyone can do this)")
  .action(async (addresses: string[]) => {
    const { hash, result } = await (await client(true)).withdrawStakes(addresses);
    console.log(table(["KEEPER", "RELEASED"], addresses.map((a, i) => [a, xlm(result[i] ?? 0n)])) + txLine(hash));
  });

// ---------------------------------------------------------------- registry

program
  .command("registry")
  .description("Registry configuration")
  .action(async () => {
    const cron = await client();
    const [c, version, count] = await Promise.all([cron.config(), cron.version(), cron.jobCount()]);
    // Upgrades wait for a delay from v5 on; older registries upgrade immediately.
    const [delay, upgrade] =
      version >= 5 ? await Promise.all([cron.upgradeDelay(), cron.pendingUpgrade()]) : [undefined, undefined];
    console.log(
      details([
        ["Registry", `${cron.contractId} (interface v${version})`],
        ["Status", c.paused ? "paused" : "running"],
        ["Jobs created", count],
        ["Minimum stake", xlm(c.min_stake)],
        ["Unbonding", formatDuration(c.unbonding_period) + (c.unbonding_epoch ? `, in epochs of ${formatDuration(c.unbonding_epoch)}` : "")],
        ["Protocol fee", c.protocol_fee_bps ? `${c.protocol_fee_bps / 100}% to ${c.treasury}` : "none"],
        ["Assigned windows", c.grace_period ? `${formatDuration(c.grace_period)}, slashing ${c.slash_bps / 100}%` : "off"],
        ["Pause after failures", c.max_failures || "never"],
        ["Upgrade delay", delay === undefined ? "none (upgrades apply immediately)" : formatDuration(delay)],
        [
          "Pending upgrade",
          upgrade
            ? `${Buffer.from(upgrade.wasm_hash).toString("hex").slice(0, 16)}..., installable ${when(upgrade.available_at)}`
            : "none",
        ],
      ]),
    );
  });

program.parseAsync().catch((err: unknown) => {
  if (err instanceof SoroCronError) {
    console.error(`Error ${err.code} (${err.errorName}): ${err.message}`);
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
});
