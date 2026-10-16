import { describe, expect, it } from "vitest";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { UnexpectedAuthError, checkKeeperAuth, isUnexpectedAuth } from "./auth.js";

const REGISTRY = "CDQPGH3YKV22VYFCZ4WUSOWFBM26PZDCTATCNBRUKLOUYAIJWDCQ6PE4";
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const KEEPER = "GA3MGO7TF2Y4KIUEMD7CHD4KMHLVOF5WF7R2UBI4LTPVAG7KSDNVNF53";

function call(contract: string, fn: string, nested: xdr.SorobanAuthorizedInvocation[] = []) {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contract).toScAddress(),
        functionName: fn,
        args: [nativeToScVal(KEEPER, { type: "address" })],
      }),
    ),
    subInvocations: nested,
  });
}

const entry = (root: xdr.SorobanAuthorizedInvocation) =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: root,
  });

describe("checkKeeperAuth", () => {
  it("accepts exactly the registry call", () => {
    expect(() => checkKeeperAuth([entry(call(REGISTRY, "execute_batch"))], REGISTRY, "execute_batch")).not.toThrow();
    expect(() => checkKeeperAuth([], REGISTRY, "execute")).not.toThrow();
  });

  it("refuses a job target's transfer nested under the keeper's signature", () => {
    const theft = entry(call(REGISTRY, "execute_batch", [call(TOKEN, "transfer")]));
    expect(() => checkKeeperAuth([theft], REGISTRY, "execute_batch")).toThrow(
      new RegExp(`transfer on ${TOKEN} inside the execute_batch call`),
    );
  });

  it("refuses an authorization rooted anywhere else", () => {
    // What a channel account's entry would look like if a target asked it to pay.
    const other = entry(call(TOKEN, "transfer"));
    let caught: unknown;
    try {
      checkKeeperAuth([entry(call(REGISTRY, "execute")), other], REGISTRY, "execute");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnexpectedAuthError);
    expect(isUnexpectedAuth(caught)).toBe(true);
    expect(() => checkKeeperAuth([entry(call(REGISTRY, "cancel_job"))], REGISTRY, "execute")).toThrow(/cancel_job/);
  });
});
