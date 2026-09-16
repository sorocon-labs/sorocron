import { describe, expect, it } from "vitest";
import { isBalanceLow, warnIfBalanceLow } from "./balance.js";

const XLM_STROOPS = 10_000_000n;

describe("isBalanceLow", () => {
  it("is true below the threshold", () => {
    expect(isBalanceLow(4n * XLM_STROOPS, 5)).toBe(true);
  });

  it("is false at or above the threshold", () => {
    expect(isBalanceLow(5n * XLM_STROOPS, 5)).toBe(false);
    expect(isBalanceLow(6n * XLM_STROOPS, 5)).toBe(false);
  });
});

describe("warnIfBalanceLow", () => {
  it("logs a warning when the balance is below the threshold", async () => {
    const lines: string[] = [];
    await warnIfBalanceLow("GKEEPER", async () => 1n * XLM_STROOPS, 5, (m) => lines.push(m));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("low");
    expect(lines[0]).toContain("1.00 XLM");
  });

  it("logs nothing when the balance is healthy", async () => {
    const lines: string[] = [];
    await warnIfBalanceLow("GKEEPER", async () => 10n * XLM_STROOPS, 5, (m) => lines.push(m));

    expect(lines).toHaveLength(0);
  });

  it("logs a note instead of throwing when the balance check itself fails", async () => {
    const lines: string[] = [];
    await warnIfBalanceLow(
      "GKEEPER",
      async () => {
        throw new Error("RPC down");
      },
      5,
      (m) => lines.push(m),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("RPC down");
  });
});
