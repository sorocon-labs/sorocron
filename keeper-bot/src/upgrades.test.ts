import { describe, expect, it } from "vitest";
import { UpgradeWatch } from "./upgrades.js";

const upgrade = (hashByte: number, proposedAt: bigint) => ({
  wasm_hash: new Uint8Array(32).fill(hashByte),
  proposed_at: proposedAt,
  available_at: proposedAt + 3_600n,
});

describe("UpgradeWatch", () => {
  it("alerts once per announcement, with the hash and when it can be applied", () => {
    const watch = new UpgradeWatch();
    expect(watch.update(undefined)).toBeUndefined();
    expect(watch.availableAt).toBe(0);

    const alert = watch.update(upgrade(0xab, 1_800_000_000n));
    expect(alert).toMatchObject({
      kind: "upgrade_announced",
      severity: "warning",
      details: { wasmHash: "ab".repeat(32), availableAt: 1_800_003_600n },
    });
    expect(alert?.message).toContain("2027-01-15T09:00:00.000Z");
    expect(watch.availableAt).toBe(1_800_003_600);

    // Still pending on later ticks: no repeat.
    expect(watch.update(upgrade(0xab, 1_800_000_000n))).toBeUndefined();
  });

  it("clears the gauge when the upgrade is applied or cancelled, and alerts on a new announcement", () => {
    const watch = new UpgradeWatch();
    watch.update(upgrade(0xab, 1_800_000_000n));
    watch.update(undefined);
    expect(watch.availableAt).toBe(0);

    // Same code proposed again later is a new announcement.
    expect(watch.update(upgrade(0xab, 1_800_100_000n))).toBeDefined();
    expect(watch.update(upgrade(0xcd, 1_800_100_000n))).toBeDefined();
  });
});
