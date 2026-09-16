# Automate your first contract in 10 minutes

This walkthrough deploys a small permissionless counter contract, schedules it
through SoroCron, and watches a keeper execute the job on Stellar testnet.
It uses the repository's own deploy and demo scripts, so the addresses and
secret key stay in your local `keeper-bot/.env` file.

> SoroCron is unaudited. Use a disposable testnet account and never use this
> walkthrough with real funds.

## Prerequisites

Install:

- Rust stable with `rustup`
- Node.js 20 or newer
- A network connection to Stellar testnet

The deploy script creates and funds a new testnet account automatically when
`STELLAR_SECRET_KEY` is empty. To use an existing testnet account instead, put
its secret key in `keeper-bot/.env` before deploying. Never commit that file.

## 1. Build the contracts

From the repository root:

```bash
rustup target add wasm32v1-none
cargo build --release --target wasm32v1-none
```

This builds the registry, executor, TTL Guardian, counter, and resolver WASM
files under `target/wasm32v1-none/release/`.

## 2. Install the keeper dependencies

```bash
cd keeper-bot
npm install
```

The deploy and demo scripts use the Stellar SDK directly; the Stellar CLI is
not required.

## 3. Deploy a personal testnet stack

Still in `keeper-bot/`, run:

```bash
npm run deploy:testnet
```

The script uploads and deploys all five contracts, connects the executor to
the registry, writes the addresses to `deployments/testnet.json`, and creates
`keeper-bot/.env` with the generated account and registry address.

The output ends with an explorer link and:

```text
Next: npm run demo
```

## 4. Create and execute jobs

In the same `keeper-bot/` directory, run:

```bash
npm run demo
```

The demo will:

1. stake the account as a keeper;
2. create a job that calls `counter.increment(1)` every 30 seconds, for up to
   10 runs;
3. execute that job once and print the counter transition;
4. create and execute a daily TTL Guardian job for the counter contract.

The counter's `increment` function is permissionless, which makes it a safe
example target for this walkthrough. The demo prints the job ids and links to
the submitted transactions.

## 5. Watch the keeper execute future runs

Leave the first terminal running, then open a second terminal at
`keeper-bot/`:

```bash
npm run keeper
```

The keeper polls every 10 seconds by default. It prints a transaction link when
it finds a due job:

```text
[2026-01-01T12:00:00.000Z] Keeper ... watching registry ...
[2026-01-01T12:00:30.000Z] job 0: executed https://stellar.expert/...
```

Stop it with `Ctrl+C`. For a single poll, which is useful in scripts or CI,
run:

```bash
npm run keeper -- --once
```

## Troubleshooting

- `No deployment found`: run `npm run deploy:testnet` from `keeper-bot/`.
- `...wasm not found`: return to the repository root and rerun the `cargo
  build --release --target wasm32v1-none` command.
- `not a registered keeper` or `below the minimum`: run `npm run demo` first;
  it stakes the account used by the keeper.
- Testnet account errors: check network access and delete `keeper-bot/.env` to
  let the deploy script generate a fresh disposable account.

To run the repository checks after editing contracts or keeper code:

```bash
cd ..
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test
cd keeper-bot
npm run typecheck
```
