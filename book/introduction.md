# SoroCron

**Decentralized automation for Soroban smart contracts on Stellar.**

Soroban contracts can't run themselves: nothing happens on-chain until
someone sends a transaction. Protocols that need recurring or conditional
actions, such as vesting releases, liquidations, rebalancing, subscription
charges or keeping state from being archived, usually run a private cron
server, which becomes a single point of failure.

SoroCron replaces that server with an open network:

- **Job owners** schedule contract calls and prepay a fee per run in any
  SEP-41 token.
- **Keepers** stake, watch for due jobs, execute them and earn the fee.
- **Resolvers** let a job run only when an on-chain condition holds.
- **TTL Guardian** keeps any contract from being archived, as an ordinary
  scheduled job.

## Where to start

| If you want to | Read |
|---|---|
| Schedule your first job | [Automate your first contract](../docs/tutorial.md) |
| Automate a strategy | [Dollar-cost averaging](../docs/tutorials/dca.md), [a DEX limit order](../docs/tutorials/limit-order.md) and the [example contracts](../contracts/examples/README.md) |
| Integrate from an app | The [TypeScript SDK](../packages/sdk/README.md) and [React hooks](../packages/react/README.md) |
| Earn fees as a keeper | The [keeper and CLI](../keeper-bot/README.md), then [running a keeper in production](../docs/guides/keeper-deployment.md) |
| Review the design | [Architecture](../docs/architecture.md), the [security model](../docs/security.md) and the [threat model](../docs/threat-model.md) |

## Testnet

The current testnet addresses are always in
[`deployments/testnet.json`](../deployments/testnet.json). The SDK, CLI,
keepers and dashboard all read them from there.

The source is on [GitHub](https://github.com/sorocon-labs/sorocron) under the
MIT license.
