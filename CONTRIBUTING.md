# Contributing to SoroCron

Thanks for helping build automation infrastructure for Stellar! This guide gets you from zero to a merged PR.

## Picking an issue

1. Browse [open issues](../../issues). Labels tell you what to expect:
   - `good first issue`: small, well-defined, great for your first Soroban PR
   - `complexity: trivial` / `complexity: medium` / `complexity: high`: rough size
   - `area: contracts` / `area: keeper-bot` / `area: examples` / `area: sdk` / `area: docs`
2. **Comment on the issue to be assigned before you start.** Unassigned PRs for already-assigned issues may be closed.
3. If you're participating through Drips Wave, follow the Wave's rules for claiming issues and timelines.
4. If you're stuck for more than a couple of days, say so on the issue. Asking is fine; going silent isn't.

## Setup

```bash
# Rust + the WASM target Soroban uses
rustup target add wasm32v1-none
rustup component add rustfmt clippy

# Contracts
cargo test
cargo build --release --target wasm32v1-none

# Keeper bot
cd keeper-bot
npm install
npm run typecheck
```

To try things on testnet, run `npm run deploy:testnet` and `npm run demo` in `keeper-bot/`. This deploys your own copy with a fresh funded key, so you won't touch the shared deployment.

## Before opening a PR

CI runs these; run them locally first:

```bash
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test
cd keeper-bot && npm run typecheck
```

- **One issue per PR.** Reference it with `Closes #123`.
- **Contract changes need tests** in `contracts/registry/src/test.rs` (or the example's test module). Cover the failure paths, not just the happy path.
- **Keep PRs focused.** Don't bundle refactors or formatting changes with features.

## Contract conventions

- **Error codes are append-only.** Never renumber or reuse a code in `errors.rs`; clients depend on them. Document new codes in `docs/architecture.md`.
- **Events are public API.** Add a `#[contractevent]` in `events.rs` for any new state change, and don't change existing event fields without discussion.
- **Checks, then effects, then interactions.** Validate and update storage before calling other contracts or moving tokens.
- **Extend TTLs** on persistent data you read or write; use the helpers in `storage.rs`.
- **Nothing in the registry should grant it privileges.** Read [docs/security.md](docs/security.md) before touching `create_job` or `execute`.
- `#![no_std]`: no `std`, no heap-heavy crates. Watch the WASM size CI reports (the Soroban limit is 64 KB).

## Commit messages

Use short, imperative messages: `Add two-step admin transfer`, `Fix unbonding check in execute`.

## Security issues

Don't open public issues for vulnerabilities. See [docs/security.md](docs/security.md).

## Code of conduct

Be kind and assume good faith. Review the code, not the person. Maintainers may remove comments or contributors that make the project hostile.
