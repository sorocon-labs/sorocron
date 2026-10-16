/**
 * What a keeper agrees to when it signs.
 *
 * A keeper signs the transaction its simulation produced, and simulation
 * records every authorization the call asks for, including any that a job's
 * target asks of the keeper: a target can call `token.transfer(keeper, ...)`
 * and the recorded entry would put that transfer under the keeper's
 * signature. The registry can't prevent this on-chain; the signer has to
 * look. Legitimate runs need the keeper's authorization for exactly one
 * thing, the registry call, so anything else is refused before signing.
 */
import { Address, xdr } from "@stellar/stellar-sdk";

/** Raised instead of signing a keeper call that would authorize more than itself. */
export class UnexpectedAuthError extends Error {
  constructor(readonly detail: string) {
    super(`Refusing to sign: the call would also authorize ${detail}`);
    this.name = "UnexpectedAuthError";
  }
}

/** Whether `err` is an `UnexpectedAuthError`, even across module copies. */
export function isUnexpectedAuth(err: unknown): err is UnexpectedAuthError {
  return err instanceof UnexpectedAuthError || (err as { name?: unknown } | null)?.name === "UnexpectedAuthError";
}

function describe(invocation: xdr.SorobanAuthorizedInvocation): { contract: string; fn: string } {
  const fn = invocation.function;
  if (fn.type !== "sorobanAuthorizedFunctionTypeContractFn") return { contract: "", fn: fn.type };
  return {
    contract: Address.fromScAddress(fn.contractFn.contractAddress).toString(),
    fn: fn.contractFn.functionName.toString(),
  };
}

/**
 * Throws `UnexpectedAuthError` unless every authorization entry is exactly
 * `registry.method(...)` with nothing nested inside it.
 */
export function checkKeeperAuth(entries: xdr.SorobanAuthorizationEntry[], registry: string, method: string): void {
  for (const entry of entries) {
    const root = entry.rootInvocation;
    const call = describe(root);
    if (call.contract !== registry || call.fn !== method) {
      throw new UnexpectedAuthError(`${call.fn} on ${call.contract || "a non-contract function"}`);
    }
    const nested = root.subInvocations;
    if (nested.length > 0) {
      const first = describe(nested[0]);
      throw new UnexpectedAuthError(`${first.fn} on ${first.contract} inside the ${method} call`);
    }
  }
}
