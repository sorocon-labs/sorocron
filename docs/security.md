# Security model

> SoroCron has **not been audited**. Do not use it with real funds on mainnet yet.

## What SoroCron is for

SoroCron automates **functions that are safe for anyone to call at any time**, the kind that only need *someone* to call them:

- `release_vested()` once tokens have vested
- `liquidate(position)` once a position is unhealthy
- `harvest()` / `compound()` / `rebalance()`
- `execute_proposal(id)` once a DAO timelock expires

The target contract itself must enforce whether the call is valid. SoroCron only decides **when** it is called.

## Invoker authority and the executor split

In Soroban, when contract A calls contract B, `A.require_auth()` succeeds inside B automatically. If the registry called targets itself, every job would run with the authority of the contract that custodies all job deposits and keeper stakes. For example, a job targeting `token.transfer(registry → attacker)` would drain it.

SoroCron separates the two roles:

| Contract | Holds funds | Calls targets |
|---|---|---|
| Registry (`contracts/registry`) | yes | never |
| Executor (`contracts/executor`) | no | yes, and only when the registry asks |

Targets only ever see the executor as their invoker, and the executor owns nothing. The test `targets_cannot_use_registry_authority` proves that a job targeting a token the registry holds cannot move it.

The executor is connected once with `set_executor` and can never be swapped, so users can verify which executor their jobs run through.

Consequences for integrators:

1. **Never give the executor (or the registry) privileges.** Don't make either an admin, owner, or allow-listed caller of your contract. Any job owner can schedule any call, so a privilege granted to the executor is granted to everyone.
2. **Defence in depth:** jobs still may not target the registry, the executor, or the fee and stake tokens (`ForbiddenTarget`).

## Other properties

| Property | How |
|---|---|
| No re-entrancy | Soroban forbids contract re-entrancy. The target can't call back into the registry while a run is in progress. |
| Users can always exit | `cancel_job`, `withdraw_job_balance`, `begin_unbonding`, `withdraw_stake` and `withdraw_stakes` work while the registry is paused or a target is halted. |
| Bad resolvers can't break keepers | Resolvers are called with `try_invoke_contract`; failures count as "not ready". |
| Broken targets stop costing keepers | Failed runs are charged and recorded, and a job pauses itself after `max_failures` consecutive failures. |
| Compromised targets can be cut off | `set_target_halted` stops every job calling a contract without pausing the registry. |
| No state archival of live data | TTLs are extended on every read/write. |
| Fee accounting | See the invariant below. |

## Fee accounting invariant

When the fee and stake token are the same:

```text
registry token balance == sum(live job balances) + sum(registered keepers' stakes)
```

Every token that enters (deposits, funding, stake) is credited to exactly one job or keeper, and every token that leaves (keeper fees, protocol fees, refunds, withdrawals, slashing rewards) is debited from exactly one of them. `contracts/registry/src/invariants.rs` checks this after every step of random operation sequences: creates, funding, withdrawals, cancellations, single and batched executions (with failing targets and fee ramps), staking, unbonding, epoch settlement and clock jumps, with protocol fees, assigned windows and slashing enabled. CI runs 1,000 generated cases on every pull request. The same test fails if any call errors outside the registry's own error codes.

## Failure charging

A run whose target fails is still charged, because the keeper did the work and paid the network fee for it, and refusing to pay would leave a broken job due forever, wasting every keeper's simulations. Could a keeper fake a failure to collect fees for free? Soroban makes the two levers unavailable:

- **Starving the call of budget:** running out of CPU or memory budget is not recoverable by `try_call`. The whole transaction fails, including the keeper's fee.
- **Omitting storage from the footprint:** accessing an entry outside the transaction footprint is also non-recoverable.

Both are classified non-recoverable in `soroban-env-host` (`HostError::is_recoverable`). What remains is a target that genuinely fails in the current state, which is the owner's to fix. After `max_failures` consecutive failures the job pauses, which bounds what a broken job can spend.

## Upgrades and migrations

Upgrades are timelocked. The admin announces new code with `propose_upgrade(wasm_hash)`, which emits `UpgradeProposed` with the time it becomes available, and can only install it with `apply_upgrade()` once `upgrade_delay()` seconds have passed. The delay can't be shorter than `unbonding_period + unbonding_epoch`, the longest a keeper can need to unbond and withdraw, so everyone who disagrees with an upgrade can leave before it runs: job owners can cancel or withdraw at any time, keepers can unbond and withdraw within the delay. The admin can lengthen the delay with `set_upgrade_delay` or withdraw the announcement with `cancel_upgrade`. Lengthening the epoch or the delay after an announcement pushes the pending upgrade back, and shortening them again never brings it forward, so keepers who start unbonding after an announcement always get out first. Keepers that were already unbonding under a longer epoch the admin has since shortened aren't covered. Storage and the contract address are kept, and an `Upgraded` event records the new hash and the previous `version()`. The test `upgrade_to_real_wasm_preserves_state` uploads the built WASM, upgrades to it and checks that jobs, keepers and config survive and keep working.

Policy:

- **The admin key must still be a multisig in production.** The delay gives users time to leave, but anyone who doesn't watch for `UpgradeProposed` events could miss it, and the admin's other powers (pausing, halting targets, fees) take effect immediately.
- Every interface change bumps `version()`. Clients check it before relying on new functions.
- Storage layout changes need a migration plan in the upgrade's pull request: either new keys alongside old ones, or a one-off migration function that is removed in the following release. v4 changed the job layout, so v3 deployments are redeployed rather than upgraded.
- Error codes and event fields are only ever appended.

## Known limitations

- **Admin trust:** the admin can pause the registry, halt targets, change `min_stake`, set the protocol fee and slash share (each capped at 10%), connect the executor once and announce upgrades. The admin cannot move escrowed funds except through an upgrade, and an upgrade can't run until users have had time to withdraw. Handover uses a two-step `propose_admin` / `accept_admin` flow.
- **Rotation size:** at most 64 keepers take part in assigned windows; others can still run any job after its window.
- **Lateness metrics** are averages over a keeper's lifetime, not a sliding window.

See the [threat model](threat-model.md) for a structured list of threats and open risks.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting (Security tab → "Report a vulnerability") on this repository.
