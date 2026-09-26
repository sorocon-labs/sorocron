import { describe, expect, it } from "vitest";
import { scValToNative } from "@stellar/stellar-sdk";
import {
  ERRORS,
  SoroCronError,
  arg,
  depositFor,
  formatAmount,
  formatDuration,
  jobStatus,
  parseAmount,
  parseArg,
  parseContractError,
  runsRemaining,
  ttlGuardianArgs,
  unwrapResult,
  type Job,
} from "./index.js";

const ADDR = "CDOAY46V2REWSINTZINUKTYELO5FYVEOCFWEKVMGH4BUJPSTRZTRGQ5W";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 0n,
    owner: "GA3MGO7TF2Y4KIUEMD7CHD4KMHLVOF5WF7R2UBI4LTPVAG7KSDNVNF53",
    target: ADDR,
    function: "increment",
    args: [],
    interval: 60n,
    next_run: 1_000n,
    fee_per_run: 10n,
    balance: 100n,
    max_runs: 0,
    runs: 0,
    end_at: 0n,
    active: true,
    ...overrides,
  };
}

describe("jobStatus", () => {
  it("follows the registry's check order", () => {
    expect(jobStatus(job(), 1_000n)).toBe("due");
    expect(jobStatus(job(), 999n)).toBe("scheduled");
    expect(jobStatus(job({ balance: 9n }), 1_000n)).toBe("underfunded");
    expect(jobStatus(job({ end_at: 1_000n }), 1_000n)).toBe("expired");
    expect(jobStatus(job({ max_runs: 2, runs: 2 }), 1_000n)).toBe("completed");
    // Paused wins over everything else, as in ensure_due.
    expect(jobStatus(job({ active: false, balance: 0n }), 1_000n)).toBe("paused");
  });
});

describe("runsRemaining and depositFor", () => {
  it("is limited by balance and by max_runs", () => {
    expect(runsRemaining(job())).toBe(10n);
    expect(runsRemaining(job({ max_runs: 5, runs: 2 }))).toBe(3n);
    expect(runsRemaining(job({ max_runs: 50, runs: 2 }))).toBe(10n);
    expect(runsRemaining(job({ max_runs: 2, runs: 5 }))).toBe(0n);
    expect(depositFor(30, 10n)).toBe(300n);
  });
});

describe("formatting", () => {
  it("formats durations with the two largest units", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(90n)).toBe("1m 30s");
    expect(formatDuration(86_400)).toBe("1d");
    expect(formatDuration(90_061)).toBe("1d 1h");
  });

  it("round-trips amounts with 7 decimals", () => {
    expect(formatAmount(15_000_000n)).toBe("1.5");
    expect(formatAmount(10_000_000n)).toBe("1");
    expect(formatAmount(1n)).toBe("0.0000001");
    expect(formatAmount(-25_000_000n)).toBe("-2.5");
    expect(parseAmount("1.5")).toBe(15_000_000n);
    expect(parseAmount("2")).toBe(20_000_000n);
    expect(parseAmount("0.0000001")).toBe(1n);
    expect(() => parseAmount("1.00000001")).toThrow();
    expect(() => parseAmount("abc")).toThrow();
  });
});

describe("args", () => {
  it("encodes typed values", () => {
    expect(scValToNative(arg.u32(7))).toBe(7);
    expect(scValToNative(arg.i128(5n))).toBe(5n);
    expect(scValToNative(arg.address(ADDR))).toBe(ADDR);
    expect(scValToNative(parseArg("u64", "42"))).toBe(42n);
    expect(scValToNative(parseArg("bool", "true"))).toBe(true);
    expect(scValToNative(parseArg("symbol", "hello"))).toBe("hello");
    expect([...scValToNative(parseArg("bytes", "0aff"))]).toEqual([10, 255]);
  });

  it("rejects malformed input", () => {
    expect(() => parseArg("u32", "1.5")).toThrow(/integer/);
    expect(() => parseArg("bool", "yes")).toThrow(/true or false/);
    expect(() => parseArg("bytes", "xyz")).toThrow(/hex/);
  });

  it("builds TTL Guardian args in ledgers", () => {
    const [target, threshold, extendTo] = ttlGuardianArgs(ADDR, 1, 2).map((v) => scValToNative(v));
    expect(target).toBe(ADDR);
    expect(threshold).toBe(17_280);
    expect(extendTo).toBe(34_560);
  });
});

describe("errors", () => {
  it("covers every registry error code without gaps", () => {
    const codes = Object.keys(ERRORS).map(Number);
    expect(codes).toEqual(Array.from({ length: codes.length }, (_, i) => i + 1));
  });

  it("parses numeric diagnostics and names", () => {
    const fromCode = parseContractError("HostError: Error(Contract, #8)");
    expect(fromCode).toBeInstanceOf(SoroCronError);
    expect(fromCode?.errorName).toBe("InsufficientJobBalance");

    expect(parseContractError({ message: "JobNotDue" })?.code).toBe(7);
    expect(parseContractError(new Error("network timeout"))).toBeUndefined();
  });

  it("unwraps simulation results", () => {
    const ok = { isErr: () => false, unwrap: () => 5n, unwrapErr: () => undefined };
    const err = { isErr: () => true, unwrap: () => undefined, unwrapErr: () => ({ message: "Paused" }) };
    expect(unwrapResult(ok)).toBe(5n);
    expect(unwrapResult(7)).toBe(7);
    expect(() => unwrapResult(err)).toThrow(ERRORS[1][1]);
  });
});
