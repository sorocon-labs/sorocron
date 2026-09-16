import { describe, expect, it } from "vitest";
import { describeMissingContractError, isMissingContractError } from "./contractErrors.js";

// Real shape observed from @stellar/stellar-sdk's contract.Client.from()
// against a syntactically valid but nonexistent testnet contract id.
const REAL_MISSING_CONTRACT_ERROR = { code: 404, message: "Could not obtain contract instance from server" };

describe("isMissingContractError", () => {
  it("recognizes the real error the SDK throws for a nonexistent contract", () => {
    expect(isMissingContractError(REAL_MISSING_CONTRACT_ERROR)).toBe(true);
  });

  it("recognizes it wrapped in an Error instance too", () => {
    expect(isMissingContractError(new Error("Could not obtain contract instance from server"))).toBe(true);
  });

  it("is false for unrelated errors", () => {
    expect(isMissingContractError(new Error("network timeout"))).toBe(false);
    expect(isMissingContractError({ code: 500, message: "internal error" })).toBe(false);
    expect(isMissingContractError("a plain string")).toBe(false);
    expect(isMissingContractError(undefined)).toBe(false);
  });
});

describe("describeMissingContractError", () => {
  it("names the contract id and suggests redeploying", () => {
    const message = describeMissingContractError(REAL_MISSING_CONTRACT_ERROR, "CABC123");
    expect(message).toContain("CABC123");
    expect(message).toContain("npm run deploy:testnet");
  });

  it("returns undefined for an unrelated error, so callers rethrow it as-is", () => {
    expect(describeMissingContractError(new Error("network timeout"), "CABC123")).toBeUndefined();
  });
});
