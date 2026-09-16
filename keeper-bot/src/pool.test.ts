import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./pool.js";

describe("mapWithConcurrency", () => {
  it("preserves result order regardless of completion order", async () => {
    const delays = [30, 10, 20, 0];
    const results = await mapWithConcurrency(delays, 4, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(results).toEqual([0, 1, 2, 3]);
  });

  it("never runs more than `concurrency` calls at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return i;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("with concurrency 1, behaves fully sequentially", async () => {
    const order: number[] = [];
    await mapWithConcurrency([3, 1, 2], 1, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      order.push(i);
      return i;
    });
    expect(order).toEqual([0, 1, 2]);
  });

  it("returns an empty array for an empty input", async () => {
    const results = await mapWithConcurrency([], 5, async () => 1);
    expect(results).toEqual([]);
  });
});
