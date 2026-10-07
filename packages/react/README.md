# @sorocron/react

React hooks for [SoroCron](https://github.com/sorocon-labs/sorocron): show
jobs, countdowns and keeper status that refresh themselves.

```bash
npm install @sorocron/react @sorocron/sdk @stellar/stellar-sdk
```

## Two lines

```tsx
import { SoroCronProvider, useJob, useNextRun } from "@sorocron/react";
import { TESTNET } from "@sorocron/sdk";

function NextRun({ id }: { id: bigint }) {
  const { data: job } = useJob(id);                     // 1. load and keep it fresh
  return <span>{useNextRun(job)?.label ?? "…"}</span>;  // 2. live countdown: "in 4m 10s"
}

export default () => (
  <SoroCronProvider network={TESTNET}>
    <NextRun id={7n} />
  </SoroCronProvider>
);
```

## Hooks

| Hook | Returns |
|---|---|
| `useJob(id)` | One job (`null` if it doesn't exist) |
| `useJobs()` | Every live job |
| `useJobsByOwner(address)` | Jobs an account owns |
| `useKeeperStatus(address)` | Stake, eligibility, reputation (`keeper_stats`), unbonding time |
| `useRegistryConfig()` | Registry settings (refreshes every minute) |
| `useNextRun(job)` | `{ status, secondsUntil, label, schedule }`, ticking every second |
| `useNow()` | Unix seconds, ticking every second |
| `usePolled(fetch, deps)` | Build your own: any client call, polled |
| `useSoroCron()` | The shared client, to send transactions |

Data hooks return `{ data, error, loading, refresh }`. They poll every
`refreshMs` (default 10 s, about two ledgers), keep the last good value if a
refresh fails, and skip work until their arguments are known, so
`useJob(selectedId)` is safe while nothing is selected. Call `refresh()`
after sending a transaction to update right away.

## Sending transactions

Pass a wallet to the provider and use the client directly:

```tsx
import { signTransaction } from "@stellar/freighter-api";

<SoroCronProvider network={TESTNET} wallet={{ publicKey, signTransaction }}>

function FundButton({ id }: { id: bigint }) {
  const { client } = useSoroCron();
  const { refresh } = useJob(id);
  return (
    <button onClick={async () => {
      await (client as SoroCron).fundJob(id, parseAmount("1"));
      refresh();
    }}>
      Fund 1 XLM
    </button>
  );
}
```

## Testing your components

`SoroCronProvider` accepts a `client` instead of a `network`. Any object with
the methods the hooks call works, so tests need no network:

```tsx
render(
  <SoroCronProvider client={{ getJob: async () => myJob, /* ... */ }}>
    <MyComponent />
  </SoroCronProvider>,
);
```
