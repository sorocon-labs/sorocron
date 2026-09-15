# Security model

> SoroCron has **not been audited**. Do not use it with real funds on mainnet yet.

## What SoroCron is for

SoroCron automates **functions that are safe for anyone to call at any time**, the kind that only need *someone* to call them:

- `release_vested()` once tokens have vested
- `liquidate(position)` once a position is unhealthy
- `harvest()` / `compound()` / `rebalance()`
- `execute_proposal(id)` once a DAO timelock expires

The target contract itself must enforce whether the call is valid. SoroCron only decides **when** it is called.

## Invoker authority

The registry calls targets directly, so inside the target the registry is the invoking contract. That means `registry_address.require_auth()` succeeds inside a target.

Consequences:

1. **Never give the registry privileges.** Don't make the SoroCron registry an admin, owner, or allow-listed caller of your contract. Any job owner can schedule any call, so any privilege you grant the registry is granted to everyone.
2. **The registry refuses to target itself, its fee token, or its stake token.** Otherwise a malicious job could call `token.transfer(registry → attacker)` with the registry's own authority and drain escrowed fees and stakes. Covered by `create_job_rejects_custodied_token_and_self_as_target`.

Planned hardening: move execution into a separate executor contract that holds no funds, so the registry's authority is never exposed to targets at all.

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
