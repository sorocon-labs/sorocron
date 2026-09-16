# Contributing to SoroCron

Thanks for helping build trust-minimized, decentralized automation infrastructure for Stellar!

SoroCron is deliberately structured with clear module boundaries so multiple contributors can build and ship in parallel with minimal merge conflicts. This guide will take you from zero to a merged PR.

---

## Subsystem Map

Find the area that matches your contribution. Keep changes scoped to their designated paths:

| Subsystem | Paths | Scope & Responsibilities |
|---|---|---|
| **Core Registry** | `contracts/registry/` | Job scheduling, execution interval rules, keeper staking & reward accounting |
| **Execution Engine** | `contracts/executor/` | Contract call dispatcher, gas enforcement, and caller authentication |
| **TTL Guardian** | `contracts/ttl-guardian/` | Automated storage TTL renewal and persistent state rent maintenance |
| **Example Workloads** | `contracts/examples/` | Reference recurring task contracts (e.g. DCA, auto-compound, batch payments) |
| **Keeper Daemon** | `keeper-bot/` | TypeScript daemon: Horizon event poller, execution scheduler, tx signer |
| **Deployments** | `deployments/` | Network configurations, contract addresses, WASM artifacts, and deploy scripts |
| **Documentation** | `docs/` | Architecture decision records, threat models, API specs, and tutorials |

---

## Rules of the Road

1. **Stay within your subsystem**: Avoid touching contracts when working on the `keeper-bot`, and vice-versa.
2. **Core contract changes are delicate**:
   - `contracts/registry/src/errors.rs` codes are strictly **append-only**. Never renumber or reuse an error code; external clients and keepers depend on them.
   - Storage data keys (`storage.rs`) are immutable in structure. Document any schema changes in `docs/architecture.md`.
3. **Keep PRs atomic**: One issue per PR. Do not bundle refactoring or unrelated formatting changes with new features or bugfixes.
4. **Preserve cross-boundary contracts**: If you modify contract events in `events.rs`, ensure `keeper-bot` event parsers and types are updated in tandem.

---

## Picking an Issue & Drips Guidelines

1. Browse [open issues](../../issues). Labels indicate domain and complexity:
   - `good first issue`: small, well-defined, great for your first Soroban PR.
   - `complexity: trivial` / `complexity: medium` / `complexity: high`: estimated scope.
   - `area: contracts` / `area: keeper-bot` / `area: examples` / `area: sdk` / `area: docs`.
2. **Comment on the issue to request assignment before you start.**
   - Maintainers officially assign contributors using `/assign @username`.
   - If you can no longer work on an assigned issue, comment `/unassign` or `/release` so another contributor can take it over.
   - *Note:* Unassigned PRs for already-assigned issues may be closed without review.
3. If participating through **Drips Waves**, issues must be assigned by a maintainer before work begins to comply with wave limits and reward allocation.
4. If you are blocked or stuck for more than 48 hours, please post an update on the issue so maintainers can assist.

---

## Local Development & Setup

### 1. Prerequisites

```bash
# Rust + WebAssembly target for Soroban
rustup target add wasm32v1-none
rustup component add rustfmt clippy

# Install Node.js (v20+ recommended)
node --version
```

### 1.5 Shortcut: `just`

The commands below are also available as [`just`](https://just.systems)
recipes (`brew install just`, or see their install docs for Linux/Windows):

```bash
just build           # cargo build --release --target wasm32v1-none
just test            # cargo test
just lint            # cargo fmt --all --check && cargo clippy --all-targets -- -D warnings
just deploy-testnet  # keeper-bot's deploy:testnet script
just demo            # keeper-bot's end-to-end testnet demo
just keeper          # run the keeper bot
```

### 2. Contracts (Rust)

```bash
# Run all contract unit & integration tests
cargo test

# Build release WASM contracts
cargo build --release --target wasm32v1-none

# Verify formatting and Clippy lints
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
```

### 3. Keeper Bot (TypeScript)

```bash
cd keeper-bot

# Install dependencies
npm install

# Typecheck and run tests
npm run typecheck
npm test

# Testnet deployment demo (uses isolated testnet funded key)
npm run deploy:testnet
npm run demo
```

---

## Contract Conventions & Invariants

All smart contracts in SoroCron adhere to strict production standards:

- **`#![no_std]` & Size Budget**: Soroban rejects WASM binaries over 64 KB. No heap-heavy crates or `std` dependencies. CI enforces a 60 KB budget check.
- **Checks, then Effects, then Interactions**: Always validate preconditions and update contract storage before making cross-contract calls or transferring tokens.
- **Explicit Storage TTLs**: Every persistent read or write must extend its storage TTL using the helper routines in `storage.rs`.
- **Events are Public API**: Emit a typed `#[contractevent]` for every state change. Do not rename or remove existing event fields without consensus.
- **Zero Privileged Backdoors**: SoroCron contracts are self-contained. The registry never possesses special administrative power to siphon user funds. Read [docs/security.md](docs/security.md).

---

## Pre-PR Checklist

Before opening a pull request, ensure the full validation passes locally:

```bash
# 1. Format & Lint
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings

# 2. Contract Test Suite
cargo test

# 3. Keeper Bot Typecheck
cd keeper-bot && npm run typecheck && cd ..
```

- **Commit Messages**: Use short, imperative titles (e.g. `feat(registry): add two-step admin transfer`, `fix(keeper): handle missing horizon cursor`).
- **Linking Issues**: Include `Closes #123` or `Fixes #123` in your PR description.
- **Test Coverage**: Any contract logic change must have unit tests covering both the happy path and failure/unauthorized paths in `src/test.rs`.

---

## Security Inquiries

Do not report security vulnerabilities through public GitHub issues. Please refer to our [Security Policy](SECURITY.md) and report privately via [GitHub Security Advisories](https://github.com/sorocon-labs/sorocron/security/advisories/new).

---

## Code of Conduct

We are dedicated to providing a welcoming and supportive environment for all contributors. Please review and adhere to our [Code of Conduct](CODE_OF_CONDUCT.md).
