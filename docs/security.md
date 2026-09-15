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
| No re-entrancy | Soroban forbids contract re-entrancy. The registry also updates state before external calls. |
| Users can always exit | `cancel_job`, `begin_unbonding` and `withdraw_stake` work while the registry is paused. |
| Bad resolvers can't break keepers | Resolvers are called with `try_invoke_contract`; failures count as "not ready". |
| Failed targets cost nothing | If the target panics, the whole `execute` reverts: no fee moves, the schedule doesn't advance. Keepers see this in simulation and skip the job. |
| No state archival of live data | TTLs are extended on every read/write. |
| Fee accounting | The contract's fee-token balance equals the sum of job balances plus keeper stakes (when fee and stake token are the same). Property tests for this invariant are on the roadmap. |

## Known limitations

- **Keeper racing:** execution is first-come-first-served. Rotation and slashing are planned.
- **Admin trust:** the admin can pause the registry and change `min_stake`. The admin cannot move user funds. Admin transfer is not implemented yet.
- **Failing jobs:** a job whose target always panics stays "due" forever and wastes keeper simulations. Planned: failure tracking and auto-deactivation.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting (Security tab → "Report a vulnerability") on this repository.
