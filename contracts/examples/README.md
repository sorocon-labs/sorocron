# SoroCron examples

Contracts that show what to automate with SoroCron and how. Each one builds
to WASM with `stellar contract build`, and each has tests that run it
through a real registry, executor and keeper using the shared
[`testkit`](../testkit) harness:

```bash
cargo test -p sorocron-example-price-resolver
```

A job is three things: a **target** call, a **schedule**, and optionally a
**resolver** that must answer `should_run(job_id) == true`. The tables below
use that shape.

## Targets: contracts a keeper calls

| Example | Calls | Shows |
|---|---|---|
| [`counter`](counter) | `increment(by)` | The smallest possible target |
| [`vesting`](vesting) | `release_vested(beneficiary)` monthly | Releasing vested tokens without anyone remembering to |
| [`dca`](dca) | `swap_tranche()` daily | Dollar-cost averaging through a Soroswap router that can't be drained ([walkthrough](../../docs/tutorials/dca.md)) |
| [`subscription`](subscription) | `charge(subscriber)` each period | Recurring payments pulled from a SEP-41 allowance, at most once per period |
| [`limit-order`](limit-order) | `fill()` | A limit order that fills once the market reaches the limit ([tutorial](../../docs/tutorials/limit-order.md)) |
| [`timelock`](timelock) | `execute_ready()` hourly | A DAO timelock whose passed proposals execute themselves |
| [`self-extending`](self-extending) | `extend_ttl()` daily | Keeping persistent storage from being archived |

The TTL Guardian ([`contracts/ttl-guardian`](../ttl-guardian)) is a target
too: schedule `extend(contract, threshold, extend_to)` to keep any
contract's instance and code alive.

## Resolvers: conditions a job waits for

| Example | `should_run` is true when |
|---|---|
| [`flag-resolver`](flag-resolver) | An admin has set a flag |
| [`price-resolver`](price-resolver) | A [Reflector](https://reflector.network) oracle price is above or below a threshold, and fresh |
| [`oracle-trigger`](oracle-trigger) | A pushed price crosses a threshold |
| [`composite-resolver`](composite-resolver) | ALL or ANY of several other resolvers agree |
| [`rebalance-resolver`](rebalance-resolver) | A pool's reserve ratio drifts past a band around its target |
| [`nft-floor-trigger`](nft-floor-trigger) | An NFT collection's floor drops below a bid |
| [`timelock-resolver`](timelock-resolver) | A governance proposal is inside its execution window |

`dca`, `subscription`, `limit-order` and `timelock` are also their own
resolvers, so keepers never pay for a run that would do nothing.

### Example: run a job when XLM drops below $0.10

```bash
# 1. Deploy the resolver pointing at Reflector's XLM feed
stellar contract deploy --wasm target/wasm32v1-none/release/sorocron_example_price_resolver.wasm \
  --source me --network testnet -- \
  --admin me \
  --condition '{"oracle":"<REFLECTOR_ID>","asset":{"Other":"XLM"},"threshold":"10000000000000","direction":"Below","max_age":600}'

# 2. Create the job with that resolver (here from the TypeScript SDK)
```

```ts
await cron.createJob(
  {
    target: MY_CONTRACT,
    function: "buy_the_dip",
    args: [],
    interval: 300n,
    schedule: schedule.interval(),
    start_at: 0n,
    fee_per_run: parseAmount("0.05"),
    max_fee_per_run: 0n,
    max_runs: 1,
    end_at: 0n,
    resolver: PRICE_RESOLVER_ID,
  },
  parseAmount("1"),
);
```

Reflector reports prices with 14 decimals, so `$0.10` is
`10_000_000_000_000`. The job is checked every five minutes but only runs
when the price is fresh and below the threshold.

## Chaining jobs

To run one job after another (harvest, then compound), you don't need a
resolver: set `after: <leader job id>` on the follower job and the registry
runs it once per new run of the leader. See
[architecture](../../docs/architecture.md#chaining-jobs) for why this lives
in the registry rather than a resolver.
