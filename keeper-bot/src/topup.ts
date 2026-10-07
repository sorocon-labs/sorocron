/**
 * Stake top-ups (#76). Slashing takes stake away, and a keeper below the
 * registry minimum can't execute anything. `planTopUp` works out how much to
 * stake to get back to a target; `keeper topup` in the CLI and the keeper
 * node's TOPUP_STAKE_TO_XLM setting both use it.
 */
import type { Keeper } from "@sorocron/sdk";

export type TopUpPlan = {
  stake: bigint;
  target: bigint;
  /** What staking `target - stake` would take; 0 when nothing is missing. */
  amount: bigint;
} & (
  | { action: "none" }
  | { action: "stake" }
  /** `unbonding`: the registry rejects new stake. `over_max`: the shortfall is more than allowed. */
  | { action: "blocked"; reason: "unbonding" | "over_max" }
);

/**
 * What to stake so `keeper` holds at least `target`. A missing keeper starts
 * from zero (its first stake registers it). Nothing is staked while the
 * keeper is unbonding, or when the shortfall is more than `max`.
 */
export function planTopUp(
  keeper: Pick<Keeper, "stake" | "unbonding_at"> | undefined,
  target: bigint,
  max?: bigint,
): TopUpPlan {
  if (target <= 0n) throw new Error("The top-up target must be more than zero.");
  const stake = keeper?.stake ?? 0n;
  const amount = stake < target ? target - stake : 0n;
  if (keeper?.unbonding_at !== undefined && keeper.unbonding_at !== null) {
    return { action: "blocked", reason: "unbonding", stake, target, amount };
  }
  if (amount === 0n) return { action: "none", stake, target, amount };
  if (max !== undefined && amount > max) return { action: "blocked", reason: "over_max", stake, target, amount };
  return { action: "stake", stake, target, amount };
}
