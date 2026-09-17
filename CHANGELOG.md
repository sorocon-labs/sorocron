# Changelog

All notable changes to SoroCron are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Contract error codes and event fields are part of the public interface; changes to them are called out explicitly.

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

[0.2.0]: https://github.com/sorocon-labs/sorocron/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sorocon-labs/sorocron/releases/tag/v0.1.0
