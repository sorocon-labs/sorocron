/**
 * After a testnet reset, the registry's contract id in deployments/testnet.json
 * points at nothing, and building a client for it throws an RPC error that
 * doesn't explain what's wrong. Recognize that specific failure and turn it
 * into an actionable message instead.
 */

const MISSING_CONTRACT_MARKERS = ["Could not obtain contract instance", "MissingValue"];

/** True for the RPC error thrown when a contract id doesn't exist on the network. */
export function isMissingContractError(err: unknown): boolean {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err !== null && "message" in err
        ? String((err as { message: unknown }).message)
        : "";
  return MISSING_CONTRACT_MARKERS.some((marker) => message.includes(marker));
}

/**
 * A friendly explanation for `err` if it looks like a missing-contract
 * error, naming `contractId` and pointing at the fix. Returns `undefined`
 * for any other error, so callers can fall back to rethrowing it as-is.
 */
export function describeMissingContractError(err: unknown, contractId: string): string | undefined {
  if (!isMissingContractError(err)) return undefined;
  return (
    `No contract found at ${contractId}. If this is testnet, it may have been reset ` +
    `(testnet periodically wipes state) -- redeploy with \`npm run deploy:testnet\` ` +
    `and update deployments/testnet.json, then try again.`
  );
}
