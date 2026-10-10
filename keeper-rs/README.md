# SoroCron keeper (Rust)

A keeper node in Rust, for operators who prefer Rust services to Node. It
reads the same environment variables as the [TypeScript keeper](../keeper-bot),
so one `.env` works for both.

```bash
cd keeper-rs
export STELLAR_SECRET_KEY=S...          # a staked keeper (npm run cli -- keeper stake 100)
cargo run --release                     # run until Ctrl+C
cargo run --release -- --once           # one pass
cargo run --release -- --dry-run --once # simulate only, never send
```

| Variable | Default |
|---|---|
| `STELLAR_SECRET_KEY` | required, except for `--dry-run` |
| `STELLAR_NETWORK` | `testnet` (`mainnet`, `local`) |
| `STELLAR_RPC_URL` | public testnet RPC; required on mainnet |
| `SOROCRON_CONTRACT_ID` | from `deployments/<network>.json` |
| `POLL_INTERVAL_MS` | `10000` |
| `INCLUSION_FEE` | `1000` stroops on top of the simulated resource fee |
| `BATCH_SIZE` | `10` jobs per `execute_batch` (at most 20) |
| `MIN_PROFIT_STROOPS` | `0`: skip batches whose XLM fees don't cover the network cost by this much |
| `METRICS_PORT` | off; set it to serve `/metrics` and `/healthz` |

Each tick it reads `job_count`, checks `is_due` for every job, and runs the
due jobs in `execute_batch` transactions of up to `BATCH_SIZE`. Each batch is
simulated first: the result says which jobs would run (resolvers, windows and
dependencies included), and the batch is only sent if something runs and,
when jobs pay in XLM, their fees cover the resource and inclusion fees. The
transaction is assembled from the simulation (footprint, resource fee,
authorization entries), signed with the keeper's ed25519 key and submitted
with [`stellar-rpc-client`](https://crates.io/crates/stellar-rpc-client), the
library the Stellar CLI uses. Registry errors from simulation are shown by
name, so you see `JobNotDue (#7)` rather than a raw host error.

```text
[1791598535] keeper GDVEU3...JCZA57 on testnet, batches of 10, metrics on :19464 (dry run: nothing is sent)
[1791598537] jobs 0,1: skipped (KeeperNotFound (#11))
[1791598537] tick: 2 jobs, 2 due, 0 executed, 2 skipped, 0 unprofitable, 0 failed in 1.7s
```

(Above: a dry run against testnet with an unstaked key, so the registry
refuses the batch.)

With `METRICS_PORT` set, `/metrics` serves Prometheus text with the
TypeScript keeper's names (`sorocron_keeper_ticks_total`,
`sorocron_keeper_jobs_total{outcome}`, `sorocron_keeper_batches_total`, ...),
so the same dashboards and alerts work for both, and `/healthz` answers 200
while ticks succeed and 503 once the last success is older than three poll
intervals (at least a minute).

## Compared with the TypeScript keeper

| | TypeScript (`keeper-bot`) | Rust (`keeper-rs`) |
|---|---|---|
| Finding due jobs | Index kept from registry events | `is_due` for every job each tick |
| `execute_batch` with simulation and profit check | Yes | Yes |
| Prometheus `/metrics` and `/healthz` | Yes | Yes, core metrics with the same names |
| Inclusion fee | Bids from recent network fees, escalates on failure | Fixed `INCLUSION_FEE` |
| Channel accounts for parallel sends | Yes | No |
| Several RPC endpoints with failover | Yes | No |
| Webhook alerts | Yes | No |
| Restoring archived state | Yes, up to `MAX_RESTORE_FEE_STROOPS` | No |
| Stake top-ups | Yes | No |
| `--dry-run` | No | Yes |

```bash
cargo test
cargo clippy --all-targets -- -D warnings
```

It is a separate Cargo workspace, so its async and RPC dependencies never
enter the contracts' build.
