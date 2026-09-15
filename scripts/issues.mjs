// Starter backlog for SoroCron. Used by scripts/create-issues.mjs.

export const labels = [
  { name: "good first issue", color: "7057ff", description: "Good for newcomers" },
  { name: "complexity: trivial", color: "c2e0c6", description: "A few hours of work" },
  { name: "complexity: medium", color: "fbca04", description: "A few days of work" },
  { name: "complexity: high", color: "d93f0b", description: "Design + implementation, a week or more" },
  { name: "area: contracts", color: "1d76db", description: "Soroban contracts" },
  { name: "area: keeper-bot", color: "5319e7", description: "Off-chain keeper node" },
  { name: "area: examples", color: "0e8a16", description: "Example integrations" },
  { name: "area: sdk", color: "bfdadc", description: "Client SDKs and frontends" },
  { name: "area: docs", color: "0075ca", description: "Documentation" },
  { name: "area: ci", color: "ededed", description: "CI and tooling" },
  { name: "type: feature", color: "a2eeef", description: "New capability" },
  { name: "type: security", color: "b60205", description: "Security hardening" },
  { name: "type: test", color: "fef2c0", description: "Test coverage" },
  { name: "type: bug", color: "d73a4a", description: "Something isn't working" },
];

const body = ({ context, tasks, acceptance, notes }) =>
  [
    "## Context",
    context,
    "",
    "## Tasks",
    ...tasks.map((t) => `- [ ] ${t}`),
    "",
    "## Acceptance criteria",
    ...acceptance.map((a) => `- ${a}`),
    ...(notes ? ["", "## Notes", notes] : []),
  ].join("\n");

export const issues = [
  // ------------------------------------------------------------------ contracts: high
  {
    title: "Split execution into a fund-less executor contract",
    labels: ["area: contracts", "type: security", "complexity: high"],
    body: body({
      context:
        "Targets are currently invoked directly by the registry, so the registry's authority is visible to target contracts (`registry.require_auth()` succeeds inside them). We block the registry and its custodied tokens as targets, but a cleaner design keeps all funds away from the contract that makes arbitrary calls. See `docs/security.md`.",
      tasks: [
        "Create `contracts/executor` that only accepts calls from the registry (`registry.require_auth()`) and forwards `invoke_contract(target, function, args)`",
        "Registry stores the executor address (constructor arg) and calls it from `execute`",
        "Remove or keep the forbidden-target check with justification",
        "Update tests and `docs/security.md`",
      ],
      acceptance: [
        "The executor holds no tokens and has no storage besides the registry address",
        "A job targeting the fee token can no longer move registry funds, and a test proves it",
        "All existing tests pass",
      ],
    }),
  },
  {
    title: "Rotating keeper execution windows",
    labels: ["area: contracts", "type: feature", "complexity: high"],
    body: body({
      context:
        "Execution is first-come-first-served, so the fastest bot wins every fee and slower keepers waste simulations. Give each due job a designated keeper for a short window, then open it to everyone.",
      tasks: [
        "Maintain an ordered list of active keepers in storage (add on stake, remove on unbonding)",
        "Deterministically assign a keeper per (job_id, run) such as `hash(job_id, runs) % n`",
        "Only the assigned keeper may execute during the first `grace_period` seconds after `next_run`; afterwards anyone may",
        "Add a view `assigned_keeper(job_id) -> Option<Address>`",
        "Write a design note in `docs/architecture.md`",
      ],
      acceptance: [
        "Tests cover: assigned keeper succeeds in window, other keeper fails with a new error code, anyone succeeds after grace",
        "Keeper list stays correct across stake/unbond/withdraw",
      ],
      notes: "Discuss the design in this issue before implementing. Slashing (separate issue) builds on this.",
    }),
  },
  {
    title: "Slash keepers who miss their assigned window",
    labels: ["area: contracts", "type: feature", "complexity: high"],
    body: body({
      context:
        "Depends on the rotating execution windows issue. When an assigned keeper misses its window and another keeper executes, part of the missing keeper's stake should be slashed.",
      tasks: [
        "Add `slash_bps` to config (admin-settable, capped)",
        "In `execute`, if the caller is not the assigned keeper and the window expired, slash the assigned keeper and reward the caller or a treasury",
        "Emit a `KeeperSlashed` event",
      ],
      acceptance: [
        "Tests for slashing math, including a keeper whose stake drops below `min_stake`",
        "No slashing happens when the assigned keeper was not active",
      ],
    }),
  },
  {
    title: "TTL Guardian: job type that keeps another contract from being archived",
    labels: ["area: contracts", "type: feature", "complexity: high"],
    body: body({
      context:
        "State archival on Stellar means contract instances and code expire unless someone extends their TTL. That makes it a natural keeper task. The Soroban deployer exposes host functions to extend another contract's instance and code TTL.",
      tasks: [
        "Research the deployer TTL-extension API available in soroban-sdk 27 and document it in this issue",
        "Add a job kind (for example an enum `JobKind::Call | JobKind::ExtendTtl { contract, threshold, extend_to }`) without breaking existing storage layout, or ship a small `ttl-guardian` target contract that the registry calls",
        "Tests using `env.ledger()` to advance past the TTL and prove the target stays live",
        "Docs section on how to protect your contract with SoroCron",
      ],
      acceptance: [
        "A contract protected by a guardian job survives past its original TTL in tests",
        "Keeper fees work exactly like normal jobs",
      ],
    }),
  },
  {
    title: "Property-based tests for fee accounting invariants",
    labels: ["area: contracts", "type: test", "complexity: high"],
    body: body({
      context:
        "The registry's token balance must always equal the sum of job balances plus keeper stakes (when fee and stake token are the same). We want randomized sequences of operations to verify it.",
      tasks: [
        "Add `proptest` (dev-dependency) or a seeded random operation generator",
        "Generate sequences of create/fund/cancel/execute/stake/unbond/withdraw with random time jumps",
        "After each step, assert the invariant and that no call panics unexpectedly",
      ],
      acceptance: [
        "At least 1,000 generated cases run in CI in under 2 minutes",
        "Invariant documented in `docs/security.md`",
      ],
    }),
  },

  // ------------------------------------------------------------------ contracts: medium
  {
    title: "Two-step admin transfer",
    labels: ["area: contracts", "type: security", "complexity: medium"],
    body: body({
      context: "The admin set at deploy time can never change. Add a safe two-step transfer.",
      tasks: [
        "`propose_admin(new_admin)`: admin only, stores a pending admin",
        "`accept_admin()`: pending admin only, finalizes the transfer",
        "Events `AdminProposed` and `AdminChanged`",
      ],
      acceptance: ["Tests for happy path, wrong caller, and overwriting a pending proposal"],
    }),
  },
  {
    title: "Protocol fee to a treasury",
    labels: ["area: contracts", "type: feature", "complexity: medium"],
    body: body({
      context: "Sustainable infrastructure needs revenue. Take a small share of each execution fee.",
      tasks: [
        "Add `protocol_fee_bps` (max 1000 = 10%) and `treasury` to config with admin setters",
        "In `execute`, split `fee_per_run` between keeper and treasury",
        "Include the split in the `JobExecuted` event",
      ],
      acceptance: ["Tests for rounding at small fees (1 stroop) and for bps = 0 and the maximum"],
    }),
  },
  {
    title: "Track target failures and auto-deactivate broken jobs",
    labels: ["area: contracts", "type: feature", "complexity: medium"],
    body: body({
      context:
        "If a target always panics, `execute` reverts and the job stays due forever, wasting keeper simulations. Use `try_invoke_contract` to record failures instead.",
      tasks: [
        "Use `env.try_invoke_contract` for the target call",
        "On failure: increment `consecutive_failures`, still charge the fee (the keeper did the work), emit `JobFailed`",
        "Deactivate the job after N consecutive failures (config value)",
        "Reset the counter on success",
      ],
      acceptance: ["Tests with a target that always panics and one that fails once then succeeds"],
      notes: "Charging for failures is a policy decision. Propose it in this issue first.",
    }),
  },
  {
    title: "Owner can pause and resume individual jobs",
    labels: ["area: contracts", "type: feature", "complexity: medium"],
    body: body({
      context: "Owners currently have to cancel a job to stop it, which loses its id and history.",
      tasks: [
        "Add `active: bool` to `Job` (default true)",
        "`set_job_active(job_id, active)`: owner only",
        "`execute` and `is_due` respect it",
        "Event `JobActiveSet`",
      ],
      acceptance: ["Tests: paused job is not due, cannot be executed, and resumes correctly"],
    }),
  },
  {
    title: "update_job: change interval, fee, args or resolver",
    labels: ["area: contracts", "type: feature", "complexity: medium"],
    body: body({
      context: "Owners can't adjust a job without cancelling and recreating it.",
      tasks: [
        "Add `update_job(job_id, params: JobUpdate)` with optional fields",
        "Apply the same validation as `create_job`, including the forbidden-target check",
        "Event `JobUpdated`",
      ],
      acceptance: ["Tests for each field and for validation failures"],
    }),
  },
  {
    title: "Upgradeable registry (admin-gated)",
    labels: ["area: contracts", "type: feature", "complexity: medium"],
    body: body({
      context: "Soroban contracts can upgrade their WASM in place with `env.deployer().update_current_contract_wasm`.",
      tasks: [
        "Add `upgrade(new_wasm_hash: BytesN<32>)`: admin only",
        "Emit `Upgraded` event",
        "Test by uploading a v2 WASM in the test environment",
        "Document upgrade and migration policy in `docs/security.md`",
      ],
      acceptance: ["Test proves state survives an upgrade"],
    }),
  },
  {
    title: "Calendar schedules (for example daily at 12:00 UTC)",
    labels: ["area: contracts", "type: feature", "complexity: medium"],
    body: body({
      context: "Intervals drift relative to wall-clock time. Many jobs such as payroll and reports want fixed times.",
      tasks: [
        "Add a schedule enum: `Interval(u64)` or `Daily { hour, minute }` or `Weekly { weekday, hour, minute }`",
        "Compute `next_run` from the ledger timestamp without floating point",
        "Keep storage backward compatible or document a migration",
      ],
      acceptance: ["Tests around midnight boundaries and missed runs"],
    }),
  },
  {
    title: "Configurable minimum interval and max args length",
    labels: ["area: contracts", "type: security", "complexity: medium"],
    body: body({
      context: "Very small intervals or huge argument vectors can make jobs expensive to store and run.",
      tasks: [
        "Add `min_interval` and `max_args` to config with admin setters",
        "Validate in `create_job` (and `update_job` if merged)",
        "New error codes, appended to the end",
      ],
      acceptance: ["Tests for boundary values"],
    }),
  },

  // ------------------------------------------------------------------ contracts: trivial / good first
  {
    title: "Assert emitted events in registry tests",
    labels: ["area: contracts", "type: test", "complexity: trivial", "good first issue"],
    body: body({
      context: "Every state change emits an event (`events.rs`), but no test checks them yet.",
      tasks: [
        "Use `env.events().all()` in tests to assert `JobCreated`, `JobFunded`, `JobExecuted`, `JobCancelled`",
        "Same for `KeeperStaked`, `KeeperUnbonding`, `KeeperWithdrawn`, `PausedSet`, `MinStakeSet`",
      ],
      acceptance: ["Each event type is asserted at least once with correct topics and data"],
    }),
  },
  {
    title: "Add jobs_by_owner view",
    labels: ["area: contracts", "type: feature", "complexity: trivial", "good first issue"],
    body: body({
      context: "Frontends need to list a user's jobs without scanning every id.",
      tasks: [
        "Maintain `OwnerJobs(Address) -> Vec<u64>` on create and cancel",
        "Add `jobs_by_owner(owner) -> Vec<u64>`",
      ],
      acceptance: ["Tests: create two jobs, cancel one, view returns the remaining id"],
    }),
  },
  {
    title: "Test that non-admins cannot pause or change min stake",
    labels: ["area: contracts", "type: test", "complexity: trivial", "good first issue"],
    body: body({
      context: "Tests use `mock_all_auths`, so admin-only checks aren't actually exercised.",
      tasks: [
        "Write tests without `mock_all_auths` (or with `mock_auths` for a specific address) proving `set_paused` and `set_min_stake` require the admin",
        "Same for `cancel_job` requiring the owner",
      ],
      acceptance: ["Tests fail if the `require_auth` calls are removed"],
    }),
  },
  {
    title: "Test constructor rejects negative min_stake",
    labels: ["area: contracts", "type: test", "complexity: trivial", "good first issue"],
    body: body({
      context: "`__constructor` panics with `InvalidAmount` for a negative `min_stake`, but this is untested.",
      tasks: ["Add a `#[should_panic]` test (or `try_register`-style check) for the constructor"],
      acceptance: ["Test fails if the check is removed"],
    }),
  },

  // ------------------------------------------------------------------ examples
  {
    title: "Example: oracle price-threshold resolver (Reflector)",
    labels: ["area: examples", "type: feature", "complexity: medium"],
    body: body({
      context:
        "Show a real conditional job: run only when an asset price crosses a threshold, using the Reflector oracle on Stellar.",
      tasks: [
        "`contracts/examples/price-resolver`: stores oracle address, asset, threshold, direction",
        "`should_run` reads the oracle's latest price",
        "Unit tests with a mock oracle",
        "README section showing how to schedule a job with it",
      ],
      acceptance: ["Builds to WASM, tests pass, documented"],
    }),
  },
  {
    title: "Example: token vesting with automated release",
    labels: ["area: examples", "type: feature", "complexity: medium"],
    body: body({
      context: "Vesting contracts need someone to call `release` periodically, which is a perfect SoroCron job.",
      tasks: [
        "`contracts/examples/vesting`: linear vesting with permissionless `release()`",
        "Integration test in which a SoroCron job releases tokens over several intervals",
      ],
      acceptance: ["Test demonstrates beneficiary balance increasing through keeper executions"],
    }),
  },
  {
    title: "Example: DCA (dollar-cost averaging) via Soroswap",
    labels: ["area: examples", "type: feature", "complexity: high"],
    body: body({
      context: "Recurring swaps are one of the most requested automation use cases.",
      tasks: [
        "`contracts/examples/dca-vault`: user deposits token A, permissionless `swap_tranche()` swaps a fixed amount to token B through the Soroswap router at most once per interval",
        "Unit tests with a mock router",
        "Testnet walkthrough in docs",
      ],
      acceptance: ["The vault can't be drained by calling `swap_tranche` early or repeatedly"],
    }),
  },

  // ------------------------------------------------------------------ keeper bot
  {
    title: "Keeper: index jobs from events instead of scanning every id",
    labels: ["area: keeper-bot", "type: feature", "complexity: medium"],
    body: body({
      context: "`keeper.ts` calls `is_due` for every id on every tick. That doesn't scale past a few hundred jobs.",
      tasks: [
        "On startup, backfill with `getEvents` for `job_created` and `job_cancelled`",
        "Keep a local set of live job ids and `next_run`; only simulate jobs whose `next_run <= now`",
        "Refresh from new events each tick",
      ],
      acceptance: ["RPC calls per tick scale with due jobs, not total jobs", "Handles RPC event retention limits gracefully"],
    }),
  },
  {
    title: "Keeper: skip unprofitable jobs",
    labels: ["area: keeper-bot", "type: feature", "complexity: medium"],
    body: body({
      context: "A keeper pays the network fee in XLM. If `fee_per_run` is worth less than that, executing loses money.",
      tasks: [
        "Read the simulated resource fee from the assembled transaction",
        "Compare it with `fee_per_run` (XLM fee token first; price feed for other tokens later)",
        "Add `MIN_PROFIT_STROOPS` env var",
      ],
      acceptance: ["Log line explains why a job was skipped"],
    }),
  },
  {
    title: "Keeper: retry with exponential backoff on RPC errors",
    labels: ["area: keeper-bot", "type: feature", "complexity: trivial", "good first issue"],
    body: body({
      context: "Transient RPC failures currently just log and wait for the next tick.",
      tasks: ["Wrap RPC calls in a small retry helper (for example 3 attempts: 500ms, 1s, 2s)", "Don't retry contract errors such as `JobNotDue`"],
      acceptance: ["Unit test for the helper"],
    }),
  },
  {
    title: "Keeper: Dockerfile and docker-compose",
    labels: ["area: keeper-bot", "type: feature", "complexity: trivial", "good first issue"],
    body: body({
      context: "Make it trivial to run a keeper on any server.",
      tasks: ["Multi-stage `keeper-bot/Dockerfile`", "`docker-compose.yml` reading `.env`", "Docs in README"],
      acceptance: ["`docker compose up` starts a working keeper"],
    }),
  },
  {
    title: "Keeper: JSON logs and Prometheus metrics",
    labels: ["area: keeper-bot", "type: feature", "complexity: medium"],
    body: body({
      context: "Operators need observability.",
      tasks: [
        "`LOG_FORMAT=json` option",
        "`/metrics` endpoint: executions, failures, fees earned, tick duration",
      ],
      acceptance: ["Metrics documented with example Grafana query"],
    }),
  },
  {
    title: "Keeper: unit tests for tick logic",
    labels: ["area: keeper-bot", "type: test", "complexity: trivial", "good first issue"],
    body: body({
      context: "The keeper loop has no tests.",
      tasks: [
        "Refactor `tick` to accept an interface instead of the concrete client",
        "Add `vitest` and tests with a fake registry: due and not-due jobs, simulated error, send failure",
      ],
      acceptance: ["`npm test` runs in CI"],
    }),
  },

  // ------------------------------------------------------------------ sdk / frontend
  {
    title: "Typed TypeScript SDK generated from the contract spec",
    labels: ["area: sdk", "type: feature", "complexity: medium"],
    body: body({
      context: "`stellar contract bindings typescript` can generate a typed client from the registry WASM.",
      tasks: [
        "Generate bindings into `sdk/ts` with a script",
        "Add helpers: `createIntervalJob`, `listDueJobs`, and error-code-to-message mapping",
        "Switch `keeper-bot` to use it",
      ],
      acceptance: ["No `any` types in keeper-bot contract calls"],
    }),
  },
  {
    title: "Web dashboard: create, fund and cancel jobs with Freighter",
    labels: ["area: sdk", "type: feature", "complexity: high"],
    body: body({
      context: "Non-developers should be able to schedule jobs.",
      tasks: [
        "Vite + React app in `dashboard/`",
        "Connect Freighter wallet; list my jobs, create job form, fund, cancel",
        "Show keeper leaderboard from `JobExecuted` events",
      ],
      acceptance: ["Deployed preview (for example GitHub Pages) working against testnet"],
    }),
  },

  // ------------------------------------------------------------------ docs / ci
  {
    title: "Docs: Stellar CLI walkthrough for every registry function",
    labels: ["area: docs", "complexity: trivial", "good first issue"],
    body: body({
      context: "Many Soroban developers use the Stellar CLI rather than JS.",
      tasks: ["`docs/cli.md` with a `stellar contract invoke` example for each function against the testnet deployment"],
      acceptance: ["Every example was actually run and works"],
    }),
  },
  {
    title: "Docs: resource cost benchmarks for create_job and execute",
    labels: ["area: docs", "complexity: trivial", "good first issue"],
    body: body({
      context: "Job owners and keepers want to know what operations cost.",
      tasks: ["Simulate each function on testnet and record CPU instructions, memory, read/write bytes and fee", "Publish in `docs/costs.md` with the script used"],
      acceptance: ["Numbers are reproducible with the script"],
    }),
  },
  {
    title: "CI: redeploy to testnet on release tags",
    labels: ["area: ci", "complexity: medium"],
    body: body({
      context: "Stellar resets testnet periodically, and the README addresses go stale.",
      tasks: [
        "Workflow on `v*` tags: build WASM, run `npm run deploy:testnet` with a secret key, commit updated `deployments/testnet.json`",
        "Scheduled weekly check that the registry still exists; redeploy if not",
      ],
      acceptance: ["README links to `deployments/testnet.json` as the source of truth"],
    }),
  },
  {
    title: "Add justfile/Makefile for common tasks",
    labels: ["area: ci", "complexity: trivial", "good first issue"],
    body: body({
      context: "Contributors have to remember several commands.",
      tasks: ["Targets: `build`, `test`, `lint`, `deploy-testnet`, `demo`, `keeper`", "Mention in CONTRIBUTING.md"],
      acceptance: ["Works on Linux, macOS and Windows (Git Bash)"],
    }),
  },
];
