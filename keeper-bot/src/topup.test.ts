import { describe, expect, it } from "vitest";
import { planTopUp } from "./topup.js";

const keeper = (stake: bigint, unbonding_at?: bigint | null) => ({ stake, unbonding_at });

describe("planTopUp", () => {
  it("stakes the shortfall after a slash", () => {
    expect(planTopUp(keeper(7n), 10n)).toEqual({ action: "stake", amount: 3n, stake: 7n, target: 10n });
  });

  it("registers a new keeper with the whole target", () => {
    expect(planTopUp(undefined, 10n)).toEqual({ action: "stake", amount: 10n, stake: 0n, target: 10n });
  });

  it("does nothing at or above the target", () => {
    expect(planTopUp(keeper(10n), 10n)).toEqual({ action: "none", amount: 0n, stake: 10n, target: 10n });
    expect(planTopUp(keeper(15n), 10n).action).toBe("none");
  });

  it("won't stake more than the cap", () => {
    expect(planTopUp(keeper(2n), 10n, 5n)).toEqual({
      action: "blocked",
      reason: "over_max",
      amount: 8n,
      stake: 2n,
      target: 10n,
    });
    expect(planTopUp(keeper(5n), 10n, 5n).action).toBe("stake");
  });

  it("won't stake while unbonding", () => {
    const plan = planTopUp(keeper(2n, 1_700_000_000n), 10n);
    expect(plan.action === "blocked" && plan.reason).toBe("unbonding");
    expect(planTopUp(keeper(2n, null), 10n).action).toBe("stake");
  });

  it("rejects a zero target", () => {
    expect(() => planTopUp(keeper(1n), 0n)).toThrow(/more than zero/);
  });
});
