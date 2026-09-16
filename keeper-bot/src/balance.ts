/**
 * A keeper that runs out of XLM to pay network fees silently stops working:
 * every execute() simulation still succeeds, but signing and sending the
 * transaction fails. Checking the balance each tick and warning early gives
 * an operator a chance to top up before that happens.
 */
import { XLM } from "./config.js";
import type { Logger } from "./tick.js";

export function isBalanceLow(balanceStroops: bigint, minXlm: number): boolean {
  return balanceStroops < XLM(minXlm);
}

export function formatXlm(stroops: bigint): string {
  return (Number(stroops) / 10_000_000).toFixed(2);
}

export async function warnIfBalanceLow(
  keeper: string,
  getBalance: (address: string) => Promise<bigint>,
  minXlm: number,
  log: Logger,
): Promise<void> {
  let balance: bigint;
  try {
    balance = await getBalance(keeper);
  } catch (err) {
    // Don't let a balance-check failure interrupt execution.
    log(`could not check keeper XLM balance: ${err instanceof Error ? err.message : err}`);
    return;
  }
  if (isBalanceLow(balance, minXlm)) {
    log(
      `warning: keeper XLM balance is low (${formatXlm(balance)} XLM, ` +
        `minimum ${minXlm} XLM) -- fund this account or executions will start failing`,
    );
  }
}
