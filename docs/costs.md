# Resource costs

What each SoroCron call costs, measured against the built WASM so VM
instantiation and real storage sizes are included.

## Reproduce

```bash
stellar contract build
cargo run -p sorocron-bench --release
```

The benchmark (`contracts/bench/src/main.rs`) deploys the registry, executor
and example counter from `target/wasm32v1-none/release`, runs each call once
and prints the resources the Soroban host metered for it. The fee column uses
the mainnet fee schedule snapshot built into `soroban-sdk` 28
(`CostEstimate::fee`), which deliberately overestimates storage rent, so treat
fees as an upper bound. Re-run it after changing the contracts and paste the
table below.

## v4 (current)

Registry interface v4, soroban-sdk 28.0.0.

| Call | CPU instructions | Memory (bytes) | Entries read | Entries written | Bytes written | Est. fee (stroops) |
|---|---:|---:|---:|---:|---:|---:|
| `stake` | 973,150 | 1,300,554 | 10 | 5 | 984 | 5,667,404 |
| `create_job` | 1,122,396 | 1,323,708 | 10 | 7 | 2,200 | 6,909,491 |
| `fund_job` | 942,584 | 1,292,020 | 8 | 4 | 760 | 2,213,998 |
| `is_due` (simulation) | 756,094 | 1,257,820 | 5 | 0 | 0 | 530 |
| `execute` (first run) | 1,695,725 | 3,534,486 | 15 | 6 | 1,212 | 320,802,766 |
| `execute` (steady state) | 1,696,847 | 3,526,325 | 15 | 6 | 1,212 | 2,223,878 |
| `create_job` (1 KB of args) | 1,164,663 | 1,329,660 | 10 | 7 | 3,268 | 11,436,559 |
| `execute` (1 KB of args) | 1,673,123 | 3,525,044 | 15 | 5 | 1,080 | 2,219,686 |
| `execute_batch` (5 jobs) | 4,834,609 | 4,271,509 | 23 | 10 | 2,172 | 2,250,803 |
| `cancel_job` | 1,132,787 | 1,315,379 | 10 | 6 | 732 | 2,221,823 |

Reading the table:

- **Steady-state `execute` costs about 0.22 XLM** in fees (2.2M stroops)
  at mainnet rates. The first run in the table is far higher only because it
  is the first call that extends the executor's TTL by 30 days, and the
  benchmark's rent rate is a conservative overestimate. That rent is paid
  once a month per contract, not per run.
- **Job fees should cover the keeper's cost.** A `fee_per_run` below the
  keeper's network fee makes the job unprofitable to run; the reference
  keeper skips such jobs (`MIN_PROFIT_STROOPS`).
- **Batching amortises the fixed cost.** Five jobs in one `execute_batch`
  cost about the same fee as one `execute`, so keepers batch whenever
  several jobs are due. `MAX_BATCH` is 20 jobs, which keeps a full batch of
  simple jobs well within Soroban's per-transaction limits.
- **Argument size doesn't affect execution.** A job carrying 1 KB of
  arguments pays for that storage once, at `create_job`.

## v3 to v4

v4 split each job into a settings entry and a small state entry (#81), so a
run no longer rewrites the job's target, function and arguments.

| Call | v3 bytes written | v4 bytes written | Change |
|---|---:|---:|---:|
| `execute` | 1,432 | 1,212 | −15% |
| `execute_batch` (5 jobs) | 3,656 | 2,172 | −41% |
| `fund_job` | 1,076 | 760 | −29% |
| `cancel_job` | 720 | 732 | +2% |
| `create_job` | 1,808 | 2,200 | +22% |

`create_job` writes more because v4 stores two entries and new fields
(schedule, fee ceiling, keeper allowlist); every run after that is cheaper,
and the gap grows with argument size. CPU per call rose about 10–15% for the
extra checks (assigned windows, halted targets, allowlists, fee ramps).

The v3 numbers were measured with the same benchmark against the v3 WASM
(commit `9386111`).
