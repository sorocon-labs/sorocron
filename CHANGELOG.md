# Changelog

All notable changes to SoroCron are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Contract error codes and event fields are part of the public interface; changes to them are called out explicitly.

## [Unreleased]

### Security
- **Keepers only sign the registry call.** A job's target can call `require_auth` on the executing keeper (for example `token.transfer(keeper, attacker, amount)`), and simulation records that under the keeper's signature; a keeper that signs its simulation as-is hands over its XLM, and with channel accounts the channel's too. The SDK (`checkKeeperAuth`, used by `execute` and `execute_batch`) and the Rust keeper now refuse any authorization beyond `registry.execute(_batch)` itself. `test_security.rs` shows the theft against a keeper that signs everything.
- **One bad job can't block the others.** A job whose target or resolver exhausts the compute budget, that asks for the keeper's authorization, or that needs a restore the keeper won't pay for makes the whole `execute_batch` simulation fail. Both keepers now split such batches to find the job, run the rest, and set the job aside for 30 ticks.
- **The admin can't freeze stake with a huge unbonding epoch.** `set_unbonding_epoch` is capped at 30 days (`MAX_UNBONDING_EPOCH`).
- **Keepers cap network costs for jobs paid in other tokens.** The profit check only works when fees are in XLM; otherwise batches costing more than `MAX_COST_PER_JOB_STROOPS` (1 XLM) per job aren't sent.
- **Missed assigned windows no longer cost stake.** Up to v4, a keeper that let its window pass lost up to 10% of its stake to the keeper that ran the job. A job owner who was also a keeper could block a run through another keeper's window (a resolver that says no, pausing the job, draining its balance, or adding the victim to the allowlist only after the window), then run it right after and take 10% of the victim's stake per run. Reported privately in October 2026 and reproduced in `test_security.rs`. Since v5 a miss only updates the keeper's stats, and only when it had its whole window: no resolver or dependency, and timed from the last owner or admin change. `set_keeper_windows` takes just the window length, capped at a day; `KeeperSlashed` is replaced by `KeeperMissedWindow`. See [missed windows](docs/security.md#missed-windows).

### Added
- **Upgrade timelock**: `upgrade` is replaced by `propose_upgrade`, `apply_upgrade` and `cancel_upgrade`. An announced upgrade can't be applied before `upgrade_delay()`, which is never shorter than `unbonding_period + unbonding_epoch`, so job owners and keepers can withdraw before new code runs. `set_upgrade_delay` lengthens it, and lengthening the epoch or the delay after an announcement pushes the pending upgrade back for good. ([#109](https://github.com/sorocon-labs/sorocron/issues/109))
- **Job ownership transfer**: `propose_job_owner` and `accept_job_owner` hand a job to another account, keeping its id, balance and history; `sorocron jobs transfer` and `jobs accept` in the CLI. ([#110](https://github.com/sorocon-labs/sorocron/issues/110))
- **Keeper RPC failover**: `STELLAR_RPC_URLS` takes several endpoints; the keeper probes them every tick and moves off one that stops answering, keeps failing or falls behind, and back once it recovers. ([#112](https://github.com/sorocon-labs/sorocron/issues/112))
- **npm releases**: release tags publish `@sorocron/sdk` and `@sorocron/react` to npm with provenance, and CI checks what would be published on every pull request. Published packages export only the build. ([#115](https://github.com/sorocon-labs/sorocron/issues/115))
- **Callback tests**: targets and resolvers that call back into the registry mid-run (execute, batch, cancel, fund, withdraw, update) are rejected and leave every balance consistent. ([#118](https://github.com/sorocon-labs/sorocron/issues/118))
- **Dashboard tests**: the New Job form and how every job status is shown, run in CI. ([#119](https://github.com/sorocon-labs/sorocron/issues/119))
- **Recent keeper reputation**: `keeper_stats` adds `recent_lateness` and `recent_miss_bps`, moving averages where each run counts for 1/8, kept in a small entry of their own so a run costs the same however long a keeper has run. Shown by `sorocron keeper status` and the dashboard. ([#122](https://github.com/sorocon-labs/sorocron/issues/122))
- **Archived-state restores**: with `MAX_RESTORE_FEE_STROOPS` set, the keeper restores a job target's archived state when the restore costs at most that, then runs the job in the same tick; the SDK raises `RestoreRequiredError` with the restore's fee and a `restore()` function. ([#111](https://github.com/sorocon-labs/sorocron/issues/111))
- **Rust keeper batching and metrics**: `keeper-rs` runs due jobs in `execute_batch` transactions, sends only batches that run something and pay for themselves, and serves `/metrics` and `/healthz` with the TypeScript keeper's metric names. ([#116](https://github.com/sorocon-labs/sorocron/issues/116))
- **Dashboard accessibility**: selects are WAI-ARIA comboboxes with Home and End, the date picker's calendar has rows and arrow-key, Page Up and Page Down navigation and returns focus on close, job lists name each job with its status and schedule, headings follow the page outline, and secondary text meets WCAG AA contrast in both themes. `axe-core` checks run in CI. ([#120](https://github.com/sorocon-labs/sorocron/issues/120))

- **Keeper dry runs**: `npm run keeper -- --dry-run` simulates every batch and logs what it would execute, with earnings and costs, and never funds, stakes, restores, signs or sends. ([#113](https://github.com/sorocon-labs/sorocron/issues/113))
- **Keeper dashboard and alert rules**: `deploy/grafana/sorocron-keeper.json` and `deploy/prometheus/alerts.yml` cover runs, earnings, balances, fee bids, tick health, RPC endpoints, restores and announced upgrades. CI runs `promtool check rules` and checks that both only query metrics the keepers export; the keeper adds `sorocron_keeper_max_inclusion_fee_stroops`. ([#135](https://github.com/sorocon-labs/sorocron/issues/135))
- **Upgrade alerts**: the keeper reads `pending_upgrade` every tick, posts one `upgrade_announced` alert per announcement saying when it can be applied, and exports `sorocron_keeper_upgrade_available_at_seconds`. ([#132](https://github.com/sorocon-labs/sorocron/issues/132))

### Fixed
- The keeper splits a batch that costs more than it earns instead of skipping all of it, so one expensive job no longer holds back cheap ones.
- The dashboard's Attention filter now includes failing jobs, which were only listed under All.

### Changed
- Debug builds compile dependencies without debug info and the workspace with line tables only: the registry's test build drops from 1.9 GB to 0.9 GB.

### Interface
- `KeeperStats` gains `recent_lateness` and `recent_miss_bps`.
- Interface version 5. New functions: `propose_upgrade`, `apply_upgrade`, `cancel_upgrade`, `set_upgrade_delay`, `pending_upgrade`, `upgrade_delay`, `propose_job_owner`, `accept_job_owner`, `pending_job_owner`. Removed: `upgrade`.
- New errors: `NoPendingUpgrade` (33), `UpgradeNotReady` (34), `NoPendingOwner` (35).
- New events: `UpgradeProposed`, `UpgradeCancelled`, `UpgradeDelaySet`, `JobOwnerProposed`, `JobOwnerChanged`. New type: `PendingUpgrade`.
- Storage: three new keys; every existing entry keeps its layout.

## [0.3.0] - 2026-10-07

### Added
- **`update_job`**: owners change a job's function, args, interval, fee, `max_runs`, `end_at` and resolver; balance and `next_run` are kept. ([#10](https://github.com/sorocon-labs/sorocron/issues/10))
- **`create_jobs`**: register up to 20 jobs with a single token transfer, all or nothing. ([#64](https://github.com/sorocon-labs/sorocron/issues/64))
- **`execute_batch`**: keepers run up to 20 jobs per transaction; jobs that aren't due or whose target fails are skipped instead of reverting the batch, and fees are paid in one transfer. ([#33](https://github.com/sorocon-labs/sorocron/issues/33))
- **`upgrade` and `version`**: admin-gated code upgrades that keep storage and address; `version()` returns the interface version (3). ([#11](https://github.com/sorocon-labs/sorocron/issues/11))
- **`@sorocron/sdk`** (`packages/sdk`): typed TypeScript client, argument builders, schedule helpers and `SoroCronError`. ([#27](https://github.com/sorocon-labs/sorocron/issues/27))
- **Web dashboard** (`app/`): browse jobs, schedule and manage them with Freighter, stake as a keeper. Deployed to GitHub Pages from `main`. ([#28](https://github.com/sorocon-labs/sorocron/issues/28))
- **Keeper stake top-ups**: `sorocron keeper topup [--to] [--max] [--dry-run]` stakes back up to a target and does nothing when already there, and `TOPUP_STAKE_TO_XLM` makes the keeper node do it each tick after slashing. The end-to-end CI job now takes a second keeper through register, top up, unbond and withdraw. ([#76](https://github.com/sorocon-labs/sorocron/issues/76))
- **Keeper observability**: Prometheus `/metrics`, `/healthz` liveness endpoint, `LOG_FORMAT=json`, Docker `HEALTHCHECK`, clean SIGTERM shutdown. ([#25](https://github.com/sorocon-labs/sorocron/issues/25), [#73](https://github.com/sorocon-labs/sorocron/issues/73))

### Changed
- soroban-sdk 27 → 28. Contract WASM is now built with `stellar contract build` (Stellar CLI v25.2+); CI installs it with `stellar/stellar-cli`.
- Target calls go through the executor's `try_execute`: a failing target now returns `TargetFailed` instead of the target's own error, and nothing is written.

### Interface
- New errors: `TargetFailed` (23), `InvalidBatchSize` (24), `LengthMismatch` (25).
- New events: `JobUpdated`, `Upgraded`.
- New type: `JobUpdate`. Storage layout is unchanged from v0.2.0, but the testnet deployment predates several v0.2.x additions and should be redeployed.

## [0.2.0] - 2026-09-15

### Added
- **Executor contract** (`contracts/executor`): performs every target call on the registry's behalf and holds no funds, so jobs can never act with the authority of the contract that custodies deposits and stakes. Connected once with `set_executor`. ([#1](https://github.com/sorocon-labs/sorocron/issues/1))
- **TTL Guardian** (`contracts/ttl-guardian`): schedule `extend(contract, threshold, extend_to)` to keep a contract's instance and code from being archived. ([#4](https://github.com/sorocon-labs/sorocron/issues/4))
- **Two-step admin transfer:** `propose_admin`, `accept_admin`, `pending_admin`. ([#6](https://github.com/sorocon-labs/sorocron/issues/6))
- **Per-job pause:** `set_job_active` lets owners pause and resume a job without losing its id, balance or schedule. ([#9](https://github.com/sorocon-labs/sorocron/issues/9))
- Keeper bot: deploys and connects the executor and guardian; the demo also schedules a guardian job..
- `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, Dependabot, CODEOWNERS, and a WASM size budget in CI.

### Changed
- `execute` calls targets through the executor. `is_due` returns `false` until an executor is connected.
- `Config` gains `executor: Option<Address>`; `Job` gains `active: bool`.

### Interface
- New errors: `ExecutorNotSet` (16), `ExecutorAlreadySet` (17), `NoPendingAdmin` (18), `JobPaused` (19).
- New events: `ExecutorSet`, `AdminProposed`, `AdminChanged`, `JobActiveSet`; TTL Guardian emits `TtlExtended`.
- Storage layout changed; v0.1.0 deployments must be redeployed.

## [0.1.0] - 2026-09-15

### Added
- Registry contract: interval jobs with fee escrow in any SEP-41 token, optional resolver conditions, `max_runs`, catch-up-safe scheduling.
- Keeper staking with an unbonding period; emergency pause that never blocks cancellations or withdrawals.
- Example target (`counter`) and resolver (`flag-resolver`).
- TypeScript keeper node, testnet deploy script and end-to-end demo.
- Architecture and security documentation, CI (fmt, clippy, tests, WASM build).

[0.3.0]: https://github.com/sorocon-labs/sorocron/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/sorocon-labs/sorocron/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sorocon-labs/sorocron/releases/tag/v0.1.0
