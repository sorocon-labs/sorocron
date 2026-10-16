/**
 * What the CLI's read commands report, as plain objects (#114). `--json`
 * prints them with `toJson`; amounts stay in stroops and every `bigint` is
 * a string, so nothing loses precision in `jq` or JavaScript.
 */
import {
  describeSchedule,
  jobStatus,
  runsRemaining,
  type Config,
  type Job,
  type Keeper,
  type KeeperStats,
  type PendingUpgrade,
} from "@sorocron/sdk";

/** JSON with bigints as decimal strings and bytes as hex. */
export function toJson(value: unknown): string {
  return JSON.stringify(
    value,
    function (this: Record<string, unknown>, key, v) {
      // Read the raw value: Buffer's own toJSON has already run on `v`.
      const raw = this[key];
      if (typeof raw === "bigint") return raw.toString();
      if (raw instanceof Uint8Array) return Buffer.from(raw).toString("hex");
      return v;
    },
    2,
  );
}

export function jobView(job: Job, now: bigint) {
  return {
    ...job,
    status: jobStatus(job, now),
    schedule_description: describeSchedule(job),
    runs_left: runsRemaining(job),
  };
}

export function jobDetailView(job: Job, now: bigint, extra: { due: boolean; feeNow?: bigint; pendingOwner?: string }) {
  return {
    ...jobView(job, now),
    due_now: extra.due,
    fee_now: extra.feeNow ?? null,
    pending_owner: extra.pendingOwner ?? null,
  };
}

export function keeperView(address: string, info: Keeper | undefined, stats: KeeperStats | undefined, minStake: bigint) {
  if (!info || !stats) return { keeper: address, registered: false, min_stake: minStake };
  const unbondingAt = info.unbonding_at ?? null;
  return {
    keeper: address,
    registered: true,
    status: unbondingAt !== null ? "unbonding" : stats.eligible ? "active" : "below_minimum",
    unbonding_at: unbondingAt,
    min_stake: minStake,
    ...stats,
  };
}

export function registryView(
  contractId: string,
  version: number,
  jobCount: bigint,
  config: Config,
  upgradeDelay?: bigint,
  pendingUpgrade?: PendingUpgrade,
) {
  return {
    registry: contractId,
    version,
    job_count: jobCount,
    config,
    upgrade_delay: upgradeDelay ?? null,
    pending_upgrade: pendingUpgrade ?? null,
  };
}
