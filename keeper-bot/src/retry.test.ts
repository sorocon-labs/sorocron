import { describe, expect, it, vi } from "vitest";
import { withRetry } from "./retry.js";

const noSleep = { sleep: async () => {} };

describe("withRetry", () => {
  it("returns the result on the first success without sleeping", async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn(async () => "ok");

    const result = await withRetry(fn, { sleep });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries transient failures and returns once one succeeds", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "ok";
    });

    const result = await withRetry(fn, { ...noSleep, attempts: 5 });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws the last error once attempts are exhausted", async () => {
    const fn = vi.fn(async () => {
      throw new Error("still failing");
    });

    await expect(withRetry(fn, { ...noSleep, attempts: 3 })).rejects.toThrow("still failing");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry an error shouldRetry rejects, e.g. a contract error like JobNotDue", async () => {
    class ContractError extends Error {}
    const fn = vi.fn(async () => {
      throw new ContractError("JobNotDue");
    });

    await expect(
      withRetry(fn, {
        ...noSleep,
        attempts: 3,
        shouldRetry: (err) => !(err instanceof ContractError),
      }),
    ).rejects.toThrow("JobNotDue");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("waits the configured delay between attempts, escalating and holding on the last entry", async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 4) throw new Error("transient");
      return "ok";
    });

    await withRetry(fn, { sleep, attempts: 4, delaysMs: [500, 1000, 2000] });

    expect(delays).toEqual([500, 1000, 2000]);
  });
});
