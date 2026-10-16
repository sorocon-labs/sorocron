/**
 * Watches for registry upgrades the admin announces (#132).
 *
 * Upgrades wait at least the unbonding time after `propose_upgrade`, so a
 * keeper that disagrees with the new code can unbond and leave first, but
 * only if its operator hears about the announcement. The keeper reads
 * `pending_upgrade` every tick and raises one alert per announcement.
 */
import type { PendingUpgrade } from "@sorocron/sdk";
import type { Alert } from "./alerts.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

export class UpgradeWatch {
  /** Announcements already reported, by hash and time proposed. */
  private seen = new Set<string>();
  private current?: PendingUpgrade;

  /**
   * Records what `pending_upgrade` returned and gives the alert to raise for
   * a new announcement, once. A re-announced hash (cancelled, then proposed
   * again) counts as new.
   */
  update(pending: PendingUpgrade | undefined): Alert | undefined {
    this.current = pending;
    if (!pending) return undefined;
    const key = `${hex(pending.wasm_hash)}@${pending.proposed_at}`;
    if (this.seen.has(key)) return undefined;
    this.seen.add(key);
    const at = new Date(Number(pending.available_at) * 1000).toISOString();
    return {
      kind: "upgrade_announced",
      severity: "warning",
      message: `a registry upgrade was announced and can be applied from ${at}; unbond before then if you don't want to run under the new code`,
      details: {
        wasmHash: hex(pending.wasm_hash),
        proposedAt: pending.proposed_at,
        availableAt: pending.available_at,
      },
    };
  }

  /** Unix time the announced upgrade can be applied, or 0 when none is pending. */
  get availableAt(): number {
    return this.current ? Number(this.current.available_at) : 0;
  }
}
