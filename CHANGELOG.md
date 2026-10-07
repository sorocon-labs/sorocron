# Changelog

All notable changes to SoroCron are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Contract error codes and event fields are part of the public interface; changes to them are called out explicitly.

## [0.3.0] - Unreleased

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
