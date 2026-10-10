# Changelog

All notable changes to SoroCron are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Contract error codes and event fields are part of the public interface; changes to them are called out explicitly.

## [Unreleased]

### Added
- **Upgrade timelock**: `upgrade` is replaced by `propose_upgrade`, `apply_upgrade` and `cancel_upgrade`. An announced upgrade can't be applied before `upgrade_delay()`, which is never shorter than `unbonding_period + unbonding_epoch`, so job owners and keepers can withdraw before new code runs. `set_upgrade_delay` lengthens it, and lengthening the epoch or the delay after an announcement pushes the pending upgrade back for good. ([#109](https://github.com/sorocon-labs/sorocron/issues/109))
- **Job ownership transfer**: `propose_job_owner` and `accept_job_owner` hand a job to another account, keeping its id, balance and history; `sorocron jobs transfer` and `jobs accept` in the CLI. ([#110](https://github.com/sorocon-labs/sorocron/issues/110))
- **Keeper RPC failover**: `STELLAR_RPC_URLS` takes several endpoints; the keeper probes them every tick and moves off one that stops answering, keeps failing or falls behind, and back once it recovers. ([#112](https://github.com/sorocon-labs/sorocron/issues/112))
- **npm releases**: release tags publish `@sorocron/sdk` and `@sorocron/react` to npm with provenance, and CI checks what would be published on every pull request. Published packages export only the build. ([#115](https://github.com/sorocon-labs/sorocron/issues/115))
- **Callback tests**: targets and resolvers that call back into the registry mid-run (execute, batch, cancel, fund, withdraw, update) are rejected and leave every balance consistent. ([#118](https://github.com/sorocon-labs/sorocron/issues/118))
- **Dashboard tests**: the New Job form and how every job status is shown, run in CI. ([#119](https://github.com/sorocon-labs/sorocron/issues/119))

### Fixed
- The dashboard's Attention filter now includes failing jobs, which were only listed under All.

### Changed
- Debug builds compile dependencies without debug info and the workspace with line tables only: the registry's test build drops from 1.9 GB to 0.9 GB.

### Interface
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
