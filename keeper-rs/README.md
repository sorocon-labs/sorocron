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

Each tick it reads `job_count`, checks `is_due` for every job, and for each
due job simulates `execute`, assembles the transaction from the simulation
(footprint, resource fee, authorization entries), signs it with the keeper's
ed25519 key and submits it with
[`stellar-rpc-client`](https://crates.io/crates/stellar-rpc-client), the
library the Stellar CLI uses. Registry errors from simulation are shown by
name, so you see `JobNotDue (#7)` rather than a raw host error.

```text
[1791403083] keeper GDVEU3...JCZA57 on testnet (dry run: nothing is sent)
[1791403085] job 0: skipped (KeeperNotFound (#11))
[1791403087] job 1: skipped (KeeperNotFound (#11))
[1791403087] tick: 2 jobs, 2 due, 0 executed, 2 skipped in 4.2s
```

(Above: a dry run against testnet with an unstaked key, so the registry
refuses the executions.)

The TypeScript keeper adds an event index, batching, fee bidding, channel
accounts and alerts; those are good next steps here too.

```bash
cargo test
cargo clippy --all-targets -- -D warnings
```

It is a separate Cargo workspace, so its async and RPC dependencies never
enter the contracts' build.
