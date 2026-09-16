# Stellar CLI walkthrough

Every registry function, as a `stellar contract invoke` command, for
developers who'd rather use the [Stellar CLI][cli] than the TypeScript SDK.

Every command below was run against a throwaway instance of this version of
the registry contract on testnet (same code, same interface, just a fresh
deployment under a disposable identity so it doesn't touch the shared
project deployment). `get_jobs`, `jobs_by_owner`, `withdraw_job_balance`,
`cancel_admin_proposal`, `set_min_interval` and `set_max_args` are new in
this version and will work the same way against the project's [testnet
deployment](../deployments/testnet.json) once it's redeployed to include
them; every other command already works there today.

[cli]: https://developers.stellar.org/docs/tools/cli/stellar-cli

## Setup

```bash
# Install the CLI if you don't have it.
brew install stellar-cli   # or: cargo install --locked stellar-cli

# A funded testnet identity to sign with.
stellar keys generate me --network testnet --fund
ME=$(stellar keys address me)

# The registry from deployments/testnet.json.
REG=CDOAY46V2REWSINTZINUKTYELO5FYVEOCFWEKVMGH4BUJPSTRZTRGQ5W
COUNTER=CDAJHPUZX55DPNTABY5OTXJYK27XWS6V744BLS5LPWMOTTI7LERGJWU2
```

Every `invoke` below takes `--id $REG --source me --network testnet`. Read-only
calls (views) print their result from simulation; state-changing calls need
`--send=yes` to actually submit a transaction (the CLI submits automatically
when simulation shows required auth or writes, but `--send=yes` makes that
explicit and works either way).

## Jobs

### create_job

```bash
stellar contract invoke --id $REG --source me --network testnet --send=yes -- \
  create_job \
  --owner $ME \
  --params '{
    "target": "'"$COUNTER"'",
    "function": "increment",
    "args": [{"u32": 1}],
    "interval": 30,
    "start_at": 0,
    "fee_per_run": "100",
    "max_runs": 5,
    "end_at": 0,
    "resolver": null
  }' \
  --deposit 1000
```

`args` is a JSON array of [`ScVal`][scval]-shaped values; `{"u32": 1}` is the
first (and only) argument to `Counter::increment`. `resolver: null` means the
job always runs; pass a contract address instead to gate it on
`should_run(job_id)`. `end_at: 0` means the job never expires by date (see
`max_runs` for expiry by run count instead).

[scval]: https://developers.stellar.org/docs/learn/encyclopedia/data-format/xdr

### fund_job

```bash
stellar contract invoke --id $REG --source me --network testnet --send=yes -- \
  fund_job --from $ME --job_id 0 --amount 500
```

### get_job

```bash
stellar contract invoke --id $REG --source me --network testnet -- \
  get_job --job_id 0
```

### get_jobs

Paginated, skips cancelled ids, `limit` capped at 50.

```bash
stellar contract invoke --id $REG --source me --network testnet -- \
  get_jobs --start 0 --limit 10
```

### jobs_by_owner

```bash
stellar contract invoke --id $REG --source me --network testnet -- \
  jobs_by_owner --owner $ME
```

### job_count

```bash
stellar contract invoke --id $REG --source me --network testnet -- job_count
```

### is_due

```bash
stellar contract invoke --id $REG --source me --network testnet -- \
  is_due --job_id 0
```

### execute

Only a staked, eligible keeper can call this (see [Keepers](#keepers) below
to stake first).

```bash
stellar contract invoke --id $REG --source me --network testnet --send=yes -- \
  execute --keeper $ME --job_id 0
```

### set_job_active

Owner only. Pauses or resumes a job without touching its balance or schedule.

```bash
stellar contract invoke --id $REG --source me --network testnet --send=yes -- \
  set_job_active --job_id 0 --active false
```

### withdraw_job_balance

Owner only. Partial withdrawal, without cancelling the job; works even while
the registry is paused.

```bash
stellar contract invoke --id $REG --source me --network testnet --send=yes -- \
  withdraw_job_balance --job_id 0 --amount 200
```

### cancel_job

Owner only. Deletes the job and refunds whatever balance is left.

```bash
stellar contract invoke --id $REG --source me --network testnet --send=yes -- \
  cancel_job --job_id 0
```

## Keepers

### stake

```bash
stellar contract invoke --id $REG --source me --network testnet --send=yes -- \
  stake --keeper $ME --amount 10000000
```

### get_keeper

```bash
stellar contract invoke --id $REG --source me --network testnet -- \
  get_keeper --keeper $ME
```

### begin_unbonding

Stops the keeper from executing immediately; stake becomes withdrawable after
`config().unbonding_period` seconds.

```bash
stellar contract invoke --id $REG --source me --network testnet --send=yes -- \
  begin_unbonding --keeper $ME
```

### withdraw_stake

Fails with `UnbondingNotFinished` before the unbonding period elapses.

```bash
stellar contract invoke --id $REG --source me --network testnet --send=yes -- \
  withdraw_stake --keeper $ME
```

## Admin

These all require signing with the registry's current admin key, so they'll
fail (with an auth error) run against the shared testnet deployment from any
other account &mdash; this is the whole point of `require_auth`. Swap `me`
for an identity holding the admin key to actually run them.

### config

Anyone can read the config (it's the one view above that doesn't fit neatly
under "jobs" or "keepers"):

```bash
stellar contract invoke --id $REG --source me --network testnet -- config
```

### set_paused

```bash
stellar contract invoke --id $REG --source me --network testnet --send=yes -- \
  set_paused --paused true
```

### set_min_stake

```bash
stellar contract invoke --id $REG --source me --network testnet --send=yes -- \
  set_min_stake --min_stake 20000000
```

### set_min_interval

`0` disables the check (the default).

```bash
stellar contract invoke --id $REG --source me --network testnet --send=yes -- \
  set_min_interval --min_interval 60
```

### set_max_args

`0` disables the check (the default).

```bash
stellar contract invoke --id $REG --source me --network testnet --send=yes -- \
  set_max_args --max_args 16
```

### set_executor

Only works once; fails with `ExecutorAlreadySet` on the live deployment,
which already has its executor connected.

```bash
stellar contract invoke --id $REG --source me --network testnet --send=yes -- \
  set_executor --executor CBRQANLQBDWDUM5GRQBP7T3VZBOXG6EZEKNRNYMXTFAYWSDSJL6PPAFA
```

### propose_admin / pending_admin / cancel_admin_proposal / accept_admin

Two-step handover: the current admin proposes, the proposed address accepts
(or the current admin cancels before anyone accepts).

```bash
stellar contract invoke --id $REG --source me --network testnet --send=yes -- \
  propose_admin --new_admin GA...

stellar contract invoke --id $REG --source me --network testnet -- pending_admin

# Either:
stellar contract invoke --id $REG --source me --network testnet --send=yes -- \
  cancel_admin_proposal
# or, signed by the proposed address:
stellar contract invoke --id $REG --source new-admin --network testnet --send=yes -- \
  accept_admin
```
