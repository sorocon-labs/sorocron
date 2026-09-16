# SoroCron Roadmap Issues

This document tracks the 20 structured backlog issues for the SoroCron ecosystem.

---

### Issue 1: `contracts: Dynamic priority fee scaling based on keeper latency`
- **Labels:** `area: contracts`, `complexity: medium`, `type: feature`
- **Context:** Jobs that need timely execution (e.g. liquidations) should be able to offer a dynamic fee multiplier that increases if the job remains unexecuted past its target time.
- **Tasks:**
  - [ ] Add `priority_fee_multiplier` or `fee_ramp_rate` parameter to `JobParams`
  - [ ] Compute effective payout in `execute()` based on `elapsed - interval`
  - [ ] Cap max fee ramp to prevent exceeding job deposit balance
  - [ ] Add test cases verifying fee escalation over delayed ledgers
- **Acceptance Criteria:** Fee dynamically scales up with keeper delay up to a max cap without violating balance invariants.

---

### Issue 2: `contracts: Multicall batch registration for cron jobs`
- **Labels:** `area: contracts`, `complexity: medium`, `type: feature`
- **Context:** Protocols setting up recurring vaults or automated systems often need to register multiple jobs in a single transaction to reduce setup friction and transaction overhead.
- **Tasks:**
  - [ ] Implement `create_jobs_batch(env, jobs: Vec<JobParams>) -> Vec<u64>` on `SoroCron` registry
  - [ ] Escrow cumulative deposit in a single aggregate token transfer
  - [ ] Emit individual `job_created` events for each registered job ID
  - [ ] Add tests for atomicity (revert if any job params are invalid)
- **Acceptance Criteria:** Creating multiple jobs in a single call correctly tracks sequential job IDs and exact total token escrow.

---

### Issue 3: `contracts: Emergency paused drain protection circuit breaker`
- **Labels:** `area: contracts`, `complexity: medium`, `type: security`
- **Context:** If an upstream target contract is compromised or malfunctioning, administrators or job owners need a circuit breaker mechanism that halts executions immediately without forfeiting unspent escrow.
- **Tasks:**
  - [ ] Add granular job pause reasons and emergency halt flag
  - [ ] Ensure keeper executions fail with `JobPaused` while job owner balance withdrawals remain fully functional
  - [ ] Write integration test simulating emergency pause during target exploit
- **Acceptance Criteria:** Circuit breaker stops execution immediately while preserving owner capital extraction.

---

### Issue 4: `contracts: Job execution receipt logs and error tracking`
- **Labels:** `area: contracts`, `complexity: medium`, `type: feature`
- **Context:** Keepers and job owners need on-chain telemetry to know why a job target execution failed or succeeded without deciphering raw host panics.
- **Tasks:**
  - [ ] Emit detailed execution status event `(job_id, keeper, success, return_data, gas_used)`
  - [ ] Track consecutive failure count in job storage
  - [ ] Unit tests verifying emitted execution events for success and catchable reverts
- **Acceptance Criteria:** Every execution emits a structured audit event containing execution metadata.

---

### Issue 5: `contracts: Resolver composability with AND / OR logical gates`
- **Labels:** `area: contracts`, `complexity: medium`, `type: feature`
- **Context:** Complex automation workflows often depend on multiple condition checks (e.g. price threshold AND time window OR vault capacity).
- **Tasks:**
  - [ ] Create `contracts/examples/composite-resolver` supporting multiple sub-resolvers
  - [ ] Support `ALL` (AND) and `ANY` (OR) evaluation modes
  - [ ] Add comprehensive test suite with mock sub-resolvers
- **Acceptance Criteria:** Composite resolver passes execution if and only if constituent sub-resolver conditions satisfy the logical gate.

---

### Issue 6: `contracts: Flash loan rebalance resolver example`
- **Labels:** `area: contracts`, `complexity: high`, `type: feature`
- **Context:** Yield aggregators and delta-neutral vaults need keepers to trigger flash-loan rebalances whenever pool weights deviate by more than epsilon.
- **Tasks:**
  - [ ] Create `contracts/examples/rebalance-resolver`
  - [ ] Implement deviation threshold calculation against target pool ratios
  - [ ] Provide tests with simulated price and reserve deviations
- **Acceptance Criteria:** Resolver evaluates to true when pool deviation exceeds threshold and returns false when balanced.

---

### Issue 7: `contracts: Automated NFT floor price swept trigger`
- **Labels:** `area: contracts`, `complexity: medium`, `type: feature`
- **Context:** Automated NFT liquidity pools or auction liquidators require automated triggers when floor listings fall below target bids.
- **Tasks:**
  - [ ] Create `contracts/examples/nft-floor-trigger`
  - [ ] Implement price verification against oracle/index registry
  - [ ] Add unit tests simulating floor drops and triggers
- **Acceptance Criteria:** Trigger contract executes only when floor drops below configured threshold.

---

### Issue 8: `contracts: Timelock governance execution resolver`
- **Labels:** `area: contracts`, `complexity: medium`, `type: feature`
- **Context:** Governance proposals passed with a timelock delay require automated execution as soon as the ETA timestamp is reached.
- **Tasks:**
  - [ ] Create `contracts/examples/timelock-resolver`
  - [ ] Track proposal hashes, queued timestamp, and execution windows
  - [ ] Add unit tests covering queued, ready, and expired states
- **Acceptance Criteria:** Resolver returns true only during the valid execution window after timelock maturity.

---

### Issue 9: `keeper-bot: Dynamic gas and resource fee estimation`
- **Labels:** `area: keeper-bot`, `complexity: medium`, `type: feature`
- **Context:** Network congestion on Stellar can cause keeper transactions to stall if base fees fluctuate. Keepers need dynamic fee bumping.
- **Tasks:**
  - [ ] Query Stellar RPC fee stats (`fee_stats` endpoint)
  - [ ] Implement fee escalation strategy for pending keeper transactions
  - [ ] Add unit tests mocking fluctuating fee conditions
- **Acceptance Criteria:** Keeper bot adjusts transaction fee dynamically based on network fee percentiles.

---

### Issue 10: `keeper-bot: Multi-account nonce management and parallel execution`
- **Labels:** `area: keeper-bot`, `complexity: high`, `type: feature`
- **Context:** High job volume can bottle-neck a single keeper Stellar account due to sequential sequence numbers.
- **Tasks:**
  - [ ] Support a pool of keeper worker accounts in `keeper-bot`
  - [ ] Distribute ready jobs across available worker accounts concurrently
  - [ ] Add tests for concurrent execution and nonce error recovery
- **Acceptance Criteria:** Keeper bot can execute multiple due jobs in parallel using separate signing keys without sequence collisions.

---

### Issue 11: `keeper-bot: Healthcheck endpoint and Kubernetes liveness probes`
- **Labels:** `area: keeper-bot`, `complexity: trivial`, `good first issue`, `type: feature`
- **Context:** Production deployments of keeper bot require HTTP `/healthz` and `/readyz` endpoints for Docker and Kubernetes orchestration.
- **Tasks:**
  - [ ] Add lightweight HTTP server in keeper-bot
  - [ ] Expose `/healthz` (liveness) and `/metrics` (Prometheus)
  - [ ] Add tests for server response and heartbeat tracking
- **Acceptance Criteria:** Bot responds with 200 OK on `/healthz` while event loop is active and returns 503 if loop halts.

---

### Issue 12: `keeper-bot: Webhook alerting for keeper balance and failed jobs`
- **Labels:** `area: keeper-bot`, `complexity: medium`, `type: feature`
- **Context:** Node operators need Discord/Slack/Telegram alerts when keeper XLM balance falls below threshold or when target jobs consistently revert.
- **Tasks:**
  - [ ] Add configurable alert webhooks in `config.ts`
  - [ ] Trigger alert on low keeper balance, low stake, or RPC connection loss
  - [ ] Add unit tests mocking webhook payloads
- **Acceptance Criteria:** Alerts are dispatched with structured error details when threshold breaches occur.

---

### Issue 13: `sdk: React hook library for SoroCron integration (@sorocron/react)`
- **Labels:** `area: sdk`, `complexity: high`, `type: feature`
- **Context:** Frontend dApps building on Stellar need React hooks for viewing jobs, staking as keepers, and calculating next execution times.
- **Tasks:**
  - [ ] Create `packages/sorocron-react` with `useJob`, `useJobsByOwner`, `useKeeperStatus`
  - [ ] Provide auto-refreshing polling or subscription based on ledger intervals
  - [ ] Add mock unit tests for hooks
- **Acceptance Criteria:** Developers can query and monitor SoroCron jobs with 2 lines of React code.

---

### Issue 14: `sdk: CLI tool for keeper balance auto-topup and unbonding`
- **Labels:** `area: sdk`, `complexity: medium`, `good first issue`, `type: feature`
- **Context:** Keepers running automated nodes need CLI commands to manage their stake lifecycle (`stake`, `unbond`, `withdraw`).
- **Tasks:**
  - [ ] Add `sorocron keeper stake <amount>`, `sorocron keeper unbond`, `sorocron keeper withdraw`
  - [ ] Format terminal outputs with clean status tables
  - [ ] Write integration test with Stellar sandbox
- **Acceptance Criteria:** CLI supports full keeper lifecycle with clear human-readable output.

---

### Issue 15: `ci: Automated fuzz testing for math and schedule overflow`
- **Labels:** `area: ci`, `complexity: high`, `type: test`
- **Context:** Edge case schedule intervals (max u64 timestamps, zero intervals, extreme fee values) should be continuously fuzzed with `cargo-fuzz` or `proptest`.
- **Tasks:**
  - [ ] Set up `proptest` harness for registry schedule calculations
  - [ ] Add GitHub Actions CI workflow step running fuzz tests
  - [ ] Verify arithmetic safety on timestamp boundaries
- **Acceptance Criteria:** Fuzz suite runs on PRs and finds zero arithmetic panics or infinite loops.

---

### Issue 16: `ci: WebAssembly binary size budget and diff reporter`
- **Labels:** `area: ci`, `complexity: trivial`, `good first issue`, `type: test`
- **Context:** Soroban contracts have strict contract size limits. CI should automatically report WASM size diffs on PRs.
- **Tasks:**
  - [ ] Add GitHub Action step measuring WASM output sizes with `twiggy` or `wasm-opt`
  - [ ] Fail CI if any contract exceeds the Soroban 64KB bytecode budget
  - [ ] Output table of contract sizes in CI summary
- **Acceptance Criteria:** Any PR that increases contract size over budget is caught before merge.

---

### Issue 17: `docs: Step-by-step tutorial: Automating a DEX limit order with SoroCron`
- **Labels:** `area: docs`, `complexity: medium`, `good first issue`, `type: feature`
- **Context:** Developers need practical end-to-end tutorials showing how to schedule limit orders on Stellar using SoroCron.
- **Tasks:**
  - [ ] Write `docs/tutorials/limit-order.md` with complete Rust and JS examples
  - [ ] Provide diagrams illustrating Keeper -> Registry -> Resolver -> Target interaction
  - [ ] Include CLI deployment commands for Testnet
- **Acceptance Criteria:** New developers can copy-paste and deploy a working limit-order job on Testnet.

---

### Issue 18: `docs: Keeper node operator production deployment guide`
- **Labels:** `area: docs`, `complexity: trivial`, `good first issue`, `type: feature`
- **Context:** Node operators need clear instructions for running keeper bots with Docker, Systemd, and Kubernetes.
- **Tasks:**
  - [ ] Create `docs/guides/keeper-deployment.md`
  - [ ] Document environment variables, RPC endpoints, security best practices (key storage)
  - [ ] Provide sample systemd service file and Kubernetes Helm chart instructions
- **Acceptance Criteria:** Comprehensive operational guide for running 24/7 keeper infrastructure.

---

### Issue 19: `contracts: Storage footprint optimization for Job storage maps`
- **Labels:** `area: contracts`, `complexity: medium`, `type: feature`
- **Context:** Optimizing storage footprint in Soroban persistent storage reduces ledger rent and fees for job creators.
- **Tasks:**
  - [ ] Profile storage key packing for `Job` and `Keeper` structs
  - [ ] Benchmark ledger footprint before and after optimization
  - [ ] Add tests verifying serialization backward compatibility
- **Acceptance Criteria:** Storage operations consume fewer CPU and memory instructions per job registration.

---

### Issue 20: `contracts: Epoch-based batch unbonding for keepers`
- **Labels:** `area: contracts`, `complexity: medium`, `type: feature`
- **Context:** Processing unbonding periods per keeper individually can lead to fragmented unbonding queues; batching by epochs simplifies settlement.
- **Tasks:**
  - [ ] Design epoch schedule for keeper unbonding windows
  - [ ] Allow keepers unbonding within the same epoch to claim in batch
  - [ ] Write unit tests for multiple keepers unbonding in the same epoch
- **Acceptance Criteria:** Keepers unbonding within an epoch can withdraw as soon as the epoch matures.
