# Soroswap integration regression tests

Runs the **current checkout's** DCA and limit-order WASM against real Soroswap
router/pool code and state captured from Stellar mainnet. Execution is local;
there are no wallet, deployment or transaction-submission steps.

From the repository root, with Rust and Stellar CLI installed:

```sh
stellar contract build --locked --package sorocron-example-dca --out-dir integration-tests/soroswap/wasm
stellar contract build --locked --package sorocron-example-limit-order --out-dir integration-tests/soroswap/wasm
cargo test --locked --manifest-path integration-tests/soroswap/Cargo.toml
```

Three tests verify:

- DCA swaps through the real router, refuses an immediate retry, and runs again
  after one interval.
- A funded limit order fills through the real router exactly once.
- The real router rejects `deadline == now` with error 503 and accepts `now + 1`.

The router requires a strictly future deadline. An invocation keeps the same
ledger timestamp through its nested calls, so `now + 1` is sufficient. Before
the fix for #172, both examples supplied `now`; their mock had a weaker `>`
check, hiding this mismatch. The mock now matches the router's `>=` boundary.

## Captured state and limitations

`fixtures/*.json` are coherent Protocol 30 mainnet captures. Each file records
its own ledger, provenance, known-absent keys and digest. The external router
and pools execute their captured WASM; the examples are rebuilt from current
source before the test. Do not replace this build with an old example binary.

Accounts and funding are local, and authorization is mocked. These checks do
not establish production signatures, fees, transaction admission or deployment
safety. A passing test means the exercised swaps work under these conditions.

Replay is strictly offline and rejects unknown keys. The first build fetches
Cargo dependencies; after that, `cargo test --locked --offline --manifest-path
integration-tests/soroswap/Cargo.toml` needs no network. This test package is
its own Cargo workspace so its capture dependencies do not affect contract
builds or the keeper.

To deliberately replace the captures, set `KANATOKO_CAPTURE_RPC` to a
Protocol 30 mainnet RPC URL and run the tests with `-- --test-threads=1`.
The refresh uses read-only RPC and CI uses the committed captures.

The initial reproduction is linked from
[issue #172](https://github.com/sorocon-labs/sorocron/issues/172).
See `NOTICE` for attribution of the captured code.
