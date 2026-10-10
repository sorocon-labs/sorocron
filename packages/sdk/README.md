# @sorocron/sdk

Typed TypeScript client for the [SoroCron](https://github.com/sorocon-labs/sorocron) automation registry on Stellar/Soroban.

```bash
npm install @sorocron/sdk @stellar/stellar-sdk
```

Published to npm from every release tag, with [provenance](https://docs.npmjs.com/generating-provenance-statements) linking each version to the workflow run that built it.

## Read the registry

```ts
import { SoroCron, TESTNET, jobStatus, runsRemaining, formatAmount } from "@sorocron/sdk";

const cron = await SoroCron.connect({ network: TESTNET });
const now = BigInt(Math.floor(Date.now() / 1000));

for (const job of await cron.allJobs()) {
  console.log(job.id, job.function, jobStatus(job, now), `${runsRemaining(job)} runs left`, formatAmount(job.balance));
}
```

Reads need no wallet. `isDue(id)` is the authoritative check (it runs the job's resolver on-chain); `jobStatus` is a free local approximation.

## Schedule a job

Pass the signing account and a signer. Freighter's `signTransaction` works as is; in Node use `contract.basicNodeSigner(keypair, passphrase).signTransaction`.

```ts
import { signTransaction } from "@stellar/freighter-api";
import { SoroCron, TESTNET, arg, parseAmount } from "@sorocron/sdk";

const cron = await SoroCron.connect({ network: TESTNET, publicKey, signTransaction });

const { hash, result: jobId } = await cron.createJob(
  {
    target: TESTNET.contracts.counter!,
    function: "increment",
    args: [arg.u32(1)],
    interval: 3_600n,          // every hour
    start_at: 0n,              // starting now
    fee_per_run: parseAmount("0.1"),
    max_runs: 0,               // unlimited
    end_at: 0n,                // never expires
  },
  parseAmount("5"),            // deposit: 50 runs
);
```

Keep a contract from being archived with the TTL Guardian:

```ts
import { ttlGuardianArgs } from "@sorocron/sdk";

await cron.createJob(
  { target: TESTNET.contracts.ttlGuardian, function: "extend", args: ttlGuardianArgs(myContract), interval: 86_400n, start_at: 0n, fee_per_run: parseAmount("0.1"), max_runs: 0, end_at: 0n },
  parseAmount("10"),
);
```

## Manage jobs and keepers

| Method | Contract function |
|---|---|
| `createJob`, `createJobs` | `create_job`, `create_jobs` |
| `updateJob`, `fundJob`, `setJobActive`, `withdrawJobBalance`, `cancelJob` | job owner functions |
| `proposeJobOwner`, `acceptJobOwner`, `pendingJobOwner` | job handover (v5 registries) |
| `pendingUpgrade`, `upgradeDelay` | announced registry upgrades (v5 registries) |
| `stake`, `beginUnbonding`, `withdrawStake`, `execute`, `executeBatch` | keeper functions |
| `config`, `version`, `jobCount`, `getJob`, `getJobs`, `allJobs`, `jobsByOwner`, `getKeeper`, `isDue` | views |

## Errors

Contract rejections are thrown as `SoroCronError` with the registry's `code`, `errorName` and a readable message:

```ts
import { SoroCronError } from "@sorocron/sdk";

try {
  await cron.fundJob(7n, parseAmount("1"));
} catch (err) {
  if (err instanceof SoroCronError && err.errorName === "JobNotFound") { /* ... */ }
}
```

`parseContractError(anything)` does the same for errors you catch yourself.

## Arguments

A job's `args` are stored as raw Soroban values, so their types must match the target function exactly. Use `arg.u32`, `arg.u64`, `arg.i128`, `arg.address`, `arg.symbol`, `arg.string`, `arg.bool`, `arg.bytes`, or `parseArg(type, text)` for user input.
