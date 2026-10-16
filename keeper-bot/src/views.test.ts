import { describe, expect, it } from "vitest";
import type { Config, Job } from "@sorocron/sdk";
import { jobDetailView, jobView, keeperView, registryView, toJson } from "./views.js";

const job: Job = {
  id: 7n,
  owner: "GOWNER",
  target: "CTARGET",
  function: "increment",
  args: [1],
  interval: 3_600n,
  schedule: { tag: "Interval" },
  next_run: 2_000n,
  fee_per_run: 1_000_000n,
  max_fee_per_run: 0n,
  balance: 5_000_000n,
  max_runs: 0,
  runs: 3,
  end_at: 0n,
  resolver: null,
  keepers: null,
  after: null,
  active: true,
  failures: 0,
};

const config: Config = {
  admin: "GADMIN",
  fee_token: "CXLM",
  stake_token: "CXLM",
  min_stake: 10_000_000n,
  unbonding_period: 3_600n,
  paused: false,
  executor: "CEXEC",
  min_interval: 0n,
  max_args: 0,
  protocol_fee_bps: 0,
  treasury: null,
  max_failures: 3,
  grace_period: 0n,
  slash_bps: 0,
  unbonding_epoch: 0n,
};

/** What `--json` would print, parsed back. */
const printed = (v: unknown) => JSON.parse(toJson(v));

describe("--json output (#114)", () => {
  it("encodes bigints as strings and bytes as hex", () => {
    expect(printed({ a: 10n ** 30n, b: new Uint8Array([0xab, 0x01]), c: Buffer.from([0xff]) })).toEqual({
      a: "1000000000000000000000000000000",
      b: "ab01",
      c: "ff",
    });
  });

  it("jobs list: every job field plus status, schedule and runs left", () => {
    expect(printed([jobView(job, 1_000n)])[0]).toEqual({
      id: "7",
      owner: "GOWNER",
      target: "CTARGET",
      function: "increment",
      args: [1],
      interval: "3600",
      schedule: { tag: "Interval" },
      next_run: "2000",
      fee_per_run: "1000000",
      max_fee_per_run: "0",
      balance: "5000000",
      max_runs: 0,
      runs: 3,
      end_at: "0",
      resolver: null,
      keepers: null,
      after: null,
      active: true,
      failures: 0,
      status: "scheduled",
      schedule_description: "every 1h",
      runs_left: "5",
    });
  });

  it("jobs show: adds whether it's due now, the current fee and any pending owner", () => {
    const view = printed(jobDetailView(job, 3_000n, { due: true, feeNow: 1_000_000n }));
    expect(view).toMatchObject({ id: "7", status: "due", due_now: true, fee_now: "1000000", pending_owner: null });
  });

  it("keeper status: registered or not", () => {
    expect(printed(keeperView("GK", undefined, undefined, 10n))).toEqual({ keeper: "GK", registered: false, min_stake: "10" });
    const view = printed(
      keeperView(
        "GK",
        { stake: 20n, unbonding_at: null, executions: 4, total_lateness: 8n, missed: 1, slashed: 0n },
        { stake: 20n, executions: 4, average_lateness: 2n, missed: 1, slashed: 0n, eligible: true, recent_lateness: 1n, recent_miss_bps: 500 },
        10n,
      ),
    );
    expect(view).toEqual({
      keeper: "GK",
      registered: true,
      status: "active",
      unbonding_at: null,
      min_stake: "10",
      stake: "20",
      executions: 4,
      average_lateness: "2",
      missed: 1,
      slashed: "0",
      eligible: true,
      recent_lateness: "1",
      recent_miss_bps: 500,
    });
  });

  it("registry: config, version, upgrade delay and any pending upgrade", () => {
    const view = printed(
      registryView("CREG", 5, 2n, config, 3_600n, {
        wasm_hash: new Uint8Array(32).fill(0x11),
        proposed_at: 100n,
        available_at: 3_700n,
      }),
    );
    expect(view).toMatchObject({
      registry: "CREG",
      version: 5,
      job_count: "2",
      upgrade_delay: "3600",
      pending_upgrade: { wasm_hash: "11".repeat(32), proposed_at: "100", available_at: "3700" },
    });
    expect(view.config).toMatchObject({ admin: "GADMIN", min_stake: "10000000", unbonding_period: "3600" });
    expect(printed(registryView("CREG", 4, 0n, config))).toMatchObject({ upgrade_delay: null, pending_upgrade: null });
  });
});
