import { describe, expect, it } from "vitest";
import { tick, type RegistryLike } from "./tick.js";

const KEEPER = "GABC...KEEPER";

function fakeRegistry(overrides: Partial<RegistryLike>): RegistryLike {
  return {
    job_count: async () => ({ result: 0n }),
    is_due: async () => ({ result: false }),
    execute: async () => {
      throw new Error("execute should not be called");
    },
    get_job: async () => ({ result: undefined }),
    config: async () => ({ result: { fee_token: "NATIVE" } }),
    ...overrides,
  };
}

function collectLogs(): { log: (m: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (m) => lines.push(m), lines };
}

describe("tick", () => {
  it("executes due jobs and skips ones that are not due", async () => {
    const executed: bigint[] = [];
    const registry = fakeRegistry({
      job_count: async () => ({ result: 3n }),
      is_due: async ({ job_id }) => ({ result: job_id === 1n }),
      execute: async ({ job_id }) => {
        executed.push(job_id);
        return {
          result: undefined,
          signAndSend: async () => ({ sendTransactionResponse: { hash: "abc123" } }),
        };
      },
    });
    const { log, lines } = collectLogs();

    await tick(registry, KEEPER, log);

    expect(executed).toEqual([1n]);
    expect(lines.some((l) => l.includes("job 1: executed"))).toBe(true);
  });

  it("skips a job whose simulated execution returns a contract error", async () => {
    const registry = fakeRegistry({
      job_count: async () => ({ result: 1n }),
      is_due: async () => ({ result: true }),
      execute: async () => ({
        result: {
          isErr: () => true,
          unwrapErr: () => ({ message: "JobNotDue" }),
        },
        signAndSend: async () => {
          throw new Error("should not send a failed simulation");
        },
      }),
    });
    const { log, lines } = collectLogs();

    await tick(registry, KEEPER, log);

    expect(lines.some((l) => l.includes("job 0: skipped (JobNotDue)"))).toBe(true);
  });

  it("logs and continues when signAndSend fails (e.g. another keeper won the race)", async () => {
    const registry = fakeRegistry({
      job_count: async () => ({ result: 2n }),
      is_due: async () => ({ result: true }),
      execute: async ({ job_id }) => ({
        result: undefined,
        signAndSend: async () => {
          if (job_id === 0n) throw new Error("txBadSeq\nmore detail on another line");
          return { sendTransactionResponse: { hash: "def456" } };
        },
      }),
    });
    const { log, lines } = collectLogs();

    await tick(registry, KEEPER, log);

    expect(lines.some((l) => l.includes("job 0: execution failed (txBadSeq)"))).toBe(true);
    expect(lines.some((l) => l.includes("job 1: executed"))).toBe(true);
  });

  it("treats an is_due RPC failure as not due, without aborting the pass", async () => {
    const registry = fakeRegistry({
      job_count: async () => ({ result: 2n }),
      is_due: async ({ job_id }) => {
        if (job_id === 0n) throw new Error("RPC timeout");
        return { result: true };
      },
      execute: async () => ({
        result: undefined,
        signAndSend: async () => ({ sendTransactionResponse: {} }),
      }),
    });
    const { log, lines } = collectLogs();

    await tick(registry, KEEPER, log);

    expect(lines.some((l) => l.includes("job 1: executed"))).toBe(true);
  });
});

describe("tick profitability check (#22)", () => {
  it("skips a due job whose network fee would exceed fee_per_run, when paid in the native token", async () => {
    const sent: bigint[] = [];
    const registry = fakeRegistry({
      job_count: async () => ({ result: 1n }),
      is_due: async () => ({ result: true }),
      config: async () => ({ result: { fee_token: "NATIVE" } }),
      get_job: async () => ({ result: { fee_per_run: 100n } }),
      execute: async ({ job_id }) => ({
        result: undefined,
        simulationData: { transactionData: { resourceFee: 500n } },
        signAndSend: async () => {
          sent.push(job_id);
          return {};
        },
      }),
    });
    const { log, lines } = collectLogs();

    await tick(registry, KEEPER, log, { nativeFeeTokenId: "NATIVE" });

    expect(sent).toEqual([]);
    expect(lines.some((l) => l.includes("job 0: skipped (unprofitable"))).toBe(true);
  });

  it("executes a due job whose fee covers the network cost plus the configured minimum profit", async () => {
    const sent: bigint[] = [];
    const registry = fakeRegistry({
      job_count: async () => ({ result: 1n }),
      is_due: async () => ({ result: true }),
      config: async () => ({ result: { fee_token: "NATIVE" } }),
      get_job: async () => ({ result: { fee_per_run: 1_000n } }),
      execute: async ({ job_id }) => ({
        result: undefined,
        simulationData: { transactionData: { resourceFee: 200n } },
        signAndSend: async () => {
          sent.push(job_id);
          return { sendTransactionResponse: { hash: "abc" } };
        },
      }),
    });
    const { log, lines } = collectLogs();

    await tick(registry, KEEPER, log, { nativeFeeTokenId: "NATIVE", minProfitStroops: 500n });

    expect(sent).toEqual([0n]);
    expect(lines.some((l) => l.includes("job 0: executed"))).toBe(true);
  });

  it("does not check profitability when the job's fee token isn't the native token", async () => {
    const sent: bigint[] = [];
    const registry = fakeRegistry({
      job_count: async () => ({ result: 1n }),
      is_due: async () => ({ result: true }),
      config: async () => ({ result: { fee_token: "SOME_OTHER_TOKEN" } }),
      get_job: async () => {
        throw new Error("get_job should not be called when the fee token isn't native");
      },
      execute: async ({ job_id }) => ({
        result: undefined,
        simulationData: { transactionData: { resourceFee: 999_999n } },
        signAndSend: async () => {
          sent.push(job_id);
          return {};
        },
      }),
    });
    const { log } = collectLogs();

    await tick(registry, KEEPER, log, { nativeFeeTokenId: "NATIVE" });

    expect(sent).toEqual([0n]);
  });

  it("skips the profitability check entirely when nativeFeeTokenId is omitted", async () => {
    const sent: bigint[] = [];
    const registry = fakeRegistry({
      job_count: async () => ({ result: 1n }),
      is_due: async () => ({ result: true }),
      config: async () => {
        throw new Error("config should not be called when nativeFeeTokenId is omitted");
      },
      execute: async ({ job_id }) => ({
        result: undefined,
        simulationData: { transactionData: { resourceFee: 999_999n } },
        signAndSend: async () => {
          sent.push(job_id);
          return {};
        },
      }),
    });
    const { log } = collectLogs();

    await tick(registry, KEEPER, log);

    expect(sent).toEqual([0n]);
  });
});

describe("tick concurrency (#48)", () => {
  it("checks is_due concurrently, but still builds/simulates/sends each due job one at a time, in job id order", async () => {
    let dueCheckInFlight = 0;
    let maxDueCheckInFlight = 0;
    let buildOrSendInFlight = 0;
    let maxBuildOrSendInFlight = 0;
    const submitted: bigint[] = [];

    const registry = fakeRegistry({
      job_count: async () => ({ result: 5n }),
      is_due: async ({ job_id }) => {
        dueCheckInFlight++;
        maxDueCheckInFlight = Math.max(maxDueCheckInFlight, dueCheckInFlight);
        await new Promise((r) => setTimeout(r, 5));
        dueCheckInFlight--;
        return { result: job_id !== 2n }; // every job but #2 is due
      },
      execute: async ({ job_id }) => {
        // Building a transaction bakes in the account's sequence number, so
        // this must never overlap another job's build or send either.
        buildOrSendInFlight++;
        maxBuildOrSendInFlight = Math.max(maxBuildOrSendInFlight, buildOrSendInFlight);
        await new Promise((r) => setTimeout(r, 2));
        buildOrSendInFlight--;
        return {
          result: undefined,
          signAndSend: async () => {
            buildOrSendInFlight++;
            maxBuildOrSendInFlight = Math.max(maxBuildOrSendInFlight, buildOrSendInFlight);
            await new Promise((r) => setTimeout(r, 5));
            buildOrSendInFlight--;
            submitted.push(job_id);
            return {};
          },
        };
      },
    });
    const { log } = collectLogs();

    await tick(registry, KEEPER, log, { maxConcurrency: 4 });

    expect(maxDueCheckInFlight).toBeGreaterThan(1);
    expect(maxBuildOrSendInFlight).toBe(1);
    expect(submitted).toEqual([0n, 1n, 3n, 4n]);
  });

  it("defaults to fully sequential is_due checks when maxConcurrency is omitted", async () => {
    let maxDueCheckInFlight = 0;
    let dueCheckInFlight = 0;
    const registry = fakeRegistry({
      job_count: async () => ({ result: 3n }),
      is_due: async () => {
        dueCheckInFlight++;
        maxDueCheckInFlight = Math.max(maxDueCheckInFlight, dueCheckInFlight);
        await new Promise((r) => setTimeout(r, 1));
        dueCheckInFlight--;
        return { result: true };
      },
      execute: async () => ({ result: undefined, signAndSend: async () => ({}) }),
    });
    const { log } = collectLogs();

    await tick(registry, KEEPER, log);

    expect(maxDueCheckInFlight).toBe(1);
  });
});
