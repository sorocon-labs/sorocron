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
