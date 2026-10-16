# SoroCron keeper and CLI

The reference keeper node that executes due SoroCron jobs for fees, and
`sorocron`, a command-line tool for managing jobs and keeper stake. Both use
[`@sorocron/sdk`](../packages/sdk).

For running a keeper in production (Docker, systemd, Kubernetes, key
handling, monitoring), see the
[operator guide](../docs/guides/keeper-deployment.md).

## Setup

From the repository root:

```bash
npm install                      # installs every workspace package
cp keeper-bot/.env.example keeper-bot/.env
```

Set `STELLAR_SECRET_KEY` in `keeper-bot/.env`, or leave it empty and
`npm run deploy -w sorocron-keeper-bot` will generate and fund a testnet key
while deploying your own copy of the contracts.

## The keeper

```bash
npm run keeper                   # run until stopped
npm run keeper -- --once         # one pass, e.g. from cron
npm run keeper -- --dry-run      # simulate only: log what would run, send nothing
```

`--dry-run` ticks as usual and simulates every batch, then logs which jobs
it would execute with what they'd earn and cost. It never funds, stakes,
restores, signs or sends, so it's safe for trying a new `BATCH_SIZE`,
`MIN_PROFIT_STROOPS` or fee setting against a live registry. Combine it with
`--once` for a single report.

Each tick it:

1. **Syncs its job index from registry events.** It loads every job once at
   startup, then follows `job_created`, `job_executed`, `job_funded` and the
   other events, so the RPC calls per tick scale with the jobs that are due,
   not with how many jobs exist. If it was offline longer than the RPC
   server keeps events, it reloads everything.
2. **Batches due jobs.** Up to `BATCH_SIZE` jobs go into one `execute_batch`
   transaction. Each batch is simulated first; the simulation reports
   exactly which jobs would run (resolvers, dependencies and assigned keeper
   windows included), and a batch is only sent if something runs and the
   fees cover the network cost. A batch that doesn't pay is split in halves,
   so one expensive job doesn't hold back cheap ones.
3. **Bids the inclusion fee from network conditions.** It bids the
   `FEE_PERCENTILE` of recent Soroban inclusion fees and steps up (p90, p95,
   p99, max) after a failed or timed-out send, never above
   `MAX_INCLUSION_FEE`.
4. **Sends batches in parallel through channel accounts.** One account can
   only have one transaction in flight. With `CHANNEL_SECRET_KEYS` set, each
   channel account pays for and sequences a batch while the keeper only
   signs its authorization, so N channels send N batches at once.
5. **Restores archived state when allowed.** If a job's target was archived
   (its TTL ran out), simulation asks for a `RestoreFootprint` first. With
   `MAX_RESTORE_FEE_STROOPS` set, the keeper sends the restore when its
   resource fee is within that limit and runs the batch in the same tick;
   otherwise it logs what the restore would cost and skips the batch.
6. **Signs only the registry call.** Before signing, the keeper checks that
   the transaction authorizes nothing but `registry.execute_batch`. A job's
   target that asks for the keeper's own authorization (to move its XLM,
   say) is refused, and the job is set aside.
7. **Isolates bad jobs.** A batch that fails as a whole because of one job
   (a target exhausting the compute budget, a request for the keeper's
   authorization, a restore over the limit) is split until that job is
   alone; the others run and the job sits out 30 ticks. When jobs pay in a
   token other than XLM, batches costing more than
   `MAX_COST_PER_JOB_STROOPS` per job aren't sent.
8. **Fails over between RPC endpoints.** With several comma-separated
   `STELLAR_RPC_URLS`, it probes each one every tick and uses the first that
   answers, isn't failing ticks, and is within 10 ledgers of the
   furthest-ahead endpoint. It goes back to the preferred endpoint after five
   good probes in a row. Logs and metrics show only each endpoint's host, in
   case a provider puts an API key in the URL.

### Alerts

Set `ALERT_WEBHOOK_URL` (and `ALERT_FORMAT=discord|slack|generic`) to be
told when:

| Alert | When |
|---|---|
| `low_balance` | The keeper or a channel account drops below `MIN_BALANCE_XLM` |
| `low_stake` | Stake is within 10% of the registry minimum, so raising the minimum could disqualify the keeper |
| `keeper_ineligible` | The keeper can no longer execute (below the minimum, or unbonding) |
| `rpc_down` | Three ticks in a row failed |
| `runs_failing` | Every send failed for three ticks in a row |
| `upgrade_announced` | The admin announced a registry upgrade; says when it can be applied, so you can unbond first if you disagree. Once per announcement |

Each alert repeats at most once per `ALERT_COOLDOWN_MS` (default one hour).

### Metrics

Set `METRICS_PORT` to serve Prometheus metrics on `/metrics` and a liveness
probe on `/healthz`, which returns 503 once no tick has succeeded for three
poll intervals.

| Metric | Type | Meaning |
|---|---|---|
| `sorocron_keeper_ticks_total` | counter | Completed polling passes |
| `sorocron_keeper_tick_errors_total` | counter | Ticks that failed |
| `sorocron_keeper_tick_duration_seconds` | gauge | Duration of the last tick |
| `sorocron_keeper_last_tick_timestamp_seconds` | gauge | When the last tick finished |
| `sorocron_keeper_jobs_indexed` | gauge | Live jobs in the index |
| `sorocron_keeper_jobs_due` | gauge | Jobs that looked due in the last tick |
| `sorocron_keeper_jobs_total{outcome}` | counter | Due jobs by outcome: `executed`, `skipped`, `unprofitable`, `failed`, `dry_run` |
| `sorocron_keeper_batches_total` | counter | `execute_batch` transactions sent |
| `sorocron_keeper_fees_earned_stroops_total` | counter | Fees earned (native XLM jobs) |
| `sorocron_keeper_balance_stroops{account}` | gauge | XLM balance of the keeper and each channel |
| `sorocron_keeper_inclusion_fee_stroops` | gauge | Current inclusion fee bid |
| `sorocron_keeper_max_inclusion_fee_stroops` | gauge | `MAX_INCLUSION_FEE`, the highest bid it will make |
| `sorocron_keeper_rpc_calls_last_sync` | gauge | RPC calls the last index sync made |
| `sorocron_keeper_jobs_quarantined` | gauge | Due jobs set aside after failing on their own |
| `sorocron_keeper_restores_total` | counter | Archived-state restores sent before executing |
| `sorocron_keeper_restore_fees_stroops_total` | counter | Resource fees of those restores |
| `sorocron_keeper_upgrade_available_at_seconds` | gauge | When an announced registry upgrade can be applied; 0 when none is pending |
| `sorocron_keeper_rpc_up{endpoint}` | gauge | With several endpoints: whether each answered its last probe |
| `sorocron_keeper_rpc_active{endpoint}` | gauge | 1 for the endpoint in use, 0 for the others |
| `sorocron_keeper_rpc_latest_ledger{endpoint}` | gauge | Latest ledger each endpoint reported |

Grafana queries:

```promql
# Executions per minute, by outcome
sum by (outcome) (rate(sorocron_keeper_jobs_total[5m])) * 60

# Share of due jobs that failed to send (alert above 0.2)
sum(rate(sorocron_keeper_jobs_total{outcome="failed"}[15m]))
  / clamp_min(sum(rate(sorocron_keeper_jobs_total[15m])), 1e-9)

# XLM earned per hour
rate(sorocron_keeper_fees_earned_stroops_total[1h]) * 3600 / 1e7

# Lowest account balance in XLM (alert below 5)
min(sorocron_keeper_balance_stroops) / 1e7

# Seconds since the last successful tick (alert above 60)
time() - sorocron_keeper_last_tick_timestamp_seconds
```

## The CLI

```bash
npm run cli -- <command>         # from the repository root
```

Read-only commands work without a key; the others sign with
`STELLAR_SECRET_KEY`. Amounts are in XLM, durations like `30s`, `15m`,
`1h30m`, `1d`, and calendar times in UTC. Contract errors are shown with
their code and a readable message.

Add `--json` to any command for one JSON document instead of text, for
scripts and monitoring. Amounts are in stroops and every 64- or 128-bit
number is a string, so nothing loses precision. Commands that send print
their result and `tx_hash`; errors go to stderr as
`{"error": {"code", "name", "message"}}` with exit code 1.

```bash
npm run cli -- --json jobs list | jq '.[0].id'
npm run cli -- --json jobs list --status underfunded | jq -r '.[].id'
npm run cli -- --json keeper status | jq '.stake'
```

### Jobs

```bash
# Every live job, or only yours, or only those due now
npm run cli -- jobs list
npm run cli -- jobs list --mine
npm run cli -- jobs list --status due

# Everything about one job, including whether a keeper could run it now
npm run cli -- jobs show 7

# Call counter.increment(1) every hour, prepaying 24 runs at 0.1 XLM.
# `create` first prints what a run costs a keeper and a suggested fee, and
# warns when --fee is below that cost.
npm run cli -- jobs create --target CDAJ...WU2 --function increment --arg u32:1 \
  --every 1h --fee 0.1 --runs 24

# Daily at 12:00 UTC, fee rising to 0.5 XLM when a run is late, stop after 30 runs
npm run cli -- jobs create --target C... --function payroll --daily 12:00 \
  --fee 0.1 --max-fee 0.5 --runs 30 --max-runs 30

# Mondays at 09:30 UTC, only when a resolver agrees
npm run cli -- jobs create --target C... --function rebalance --weekly mon@09:30 \
  --resolver C... --fee 0.2

# Run once after each run of job 7 (harvest, then compound)
npm run cli -- jobs create --target C... --function compound --every 1h --after 7 --fee 0.1

npm run cli -- jobs fund 7 5          # add 5 XLM
npm run cli -- jobs withdraw 7 2      # take 2 XLM back
npm run cli -- jobs pause 7
npm run cli -- jobs resume 7          # also clears its failure count
npm run cli -- jobs cancel 7          # delete it and refund the balance
npm run cli -- jobs transfer 7 GB...  # offer it to another account (v5 registries)
npm run cli -- jobs accept 7          # run by that account to take it over
```

### Following a job

`jobs watch` prints a line for each run (success, fee, lateness and the
transaction), top-up, withdrawal, pause, update, handover and cancellation
of one job as it lands, until Ctrl+C or the job is cancelled. With `--json`
it prints one JSON object per line.

```bash
npm run cli -- jobs watch 7                    # from now on
npm run cli -- jobs watch 7 --from-ledger 5219929   # replay first, as far back as the RPC keeps events
```

```text
2026-10-16T04:58:27Z  run 3 succeeded by GA3M…NF53, fee 0.1 XLM, 15s late, next run 2026-10-16T04:58:42.000Z  https://stellar.expert/explorer/testnet/tx/f2234f…
2026-10-16T05:01:47Z  ran out of balance (0 XLM left); fund it to keep it running  https://stellar.expert/explorer/testnet/tx/c19a1b…
```

### Owner alerts

`jobs monitor` checks an owner's jobs on an interval and posts to a
Discord, Slack or generic webhook (the keeper's formats) once when a job's
balance pays for fewer than `--min-runs` runs, once when it pauses itself
after failing, and once when it's within `--ends-within` of its end time.
Each alert fires again only after its condition clears, for example once
the job is funded.

```bash
npm run cli -- jobs monitor --owner GABC... --webhook https://discord.com/api/webhooks/... \
  --format discord --min-runs 5 --ends-within 2d --every 10m
npm run cli -- jobs monitor --once    # one check of the configured account's jobs
```

To run it continuously, use `docker compose --profile monitor up -d
job-monitor` (set `MONITOR_OWNER` and `ALERT_WEBHOOK_URL` in `.env`), or
[`deploy/systemd/sorocron-job-monitor.service`](../deploy/systemd/sorocron-job-monitor.service).
It only reads, so it needs no secret key when `--owner` is given.

### Keeper stake

```bash
npm run cli -- keeper status          # stake, eligibility, lateness, missed windows
npm run cli -- keeper status GABC...  # any keeper
npm run cli -- keeper stake 100       # become a keeper or add stake
npm run cli -- keeper topup           # stake back up to the registry minimum
npm run cli -- keeper topup --to 100 --max 20  # hold 100 XLM, adding at most 20 at a time
npm run cli -- keeper unbond          # stop executing, start the unbonding timer
npm run cli -- keeper withdraw        # once unbonding has finished
npm run cli -- keeper settle GA... GB...  # pay out every listed keeper whose unbonding finished
```

`keeper topup` stakes only what's missing and does nothing when the keeper
already holds the target, so it's safe to run from cron. `--dry-run` shows
what it would stake. To have the keeper node do it instead, set
`TOPUP_STAKE_TO_XLM`: each tick it stakes up to that amount whenever the
keeper holds less, for example on first start.

### Registry

```bash
npm run cli -- registry               # configuration, fees, windows, version
```

```text
Registry              CDOAY...TRGQ5W (interface v4)
Status                running
Jobs created          2
Minimum stake         1 XLM
Unbonding             1h
Protocol fee          none
Assigned windows      off
Pause after failures  3
```

## Deploying your own copy

```bash
stellar contract build                                   # from the repository root
npm run deploy -w sorocron-keeper-bot                    # testnet by default
STELLAR_NETWORK=local npm run deploy -w sorocron-keeper-bot   # a local quickstart network
npm run demo -w sorocron-keeper-bot                      # stake, schedule and run two jobs
```

## Development

```bash
npm test -w sorocron-keeper-bot
npm run typecheck -w sorocron-keeper-bot
```

During development the keeper, CLI and tests run against the SDK's
TypeScript source (the SDK's `development` export condition), so there is no
SDK build step. `npm run build` compiles against the SDK's built output,
which is what the Docker image ships.
