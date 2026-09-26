/**
 * Builders for a job's `args`. The registry stores them as `Vec<Val>`, so
 * each must already be an ScVal of the exact type the target function
 * expects: `u32(1)` and `u64(1)` are different arguments on-chain.
 */
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";

export const arg = {
  u32: (v: number) => nativeToScVal(v, { type: "u32" }),
  i32: (v: number) => nativeToScVal(v, { type: "i32" }),
  u64: (v: bigint | number) => nativeToScVal(BigInt(v), { type: "u64" }),
  i64: (v: bigint | number) => nativeToScVal(BigInt(v), { type: "i64" }),
  u128: (v: bigint | number) => nativeToScVal(BigInt(v), { type: "u128" }),
  i128: (v: bigint | number) => nativeToScVal(BigInt(v), { type: "i128" }),
  bool: (v: boolean) => xdr.ScVal.scvBool(v),
  symbol: (v: string) => nativeToScVal(v, { type: "symbol" }),
  string: (v: string) => nativeToScVal(v, { type: "string" }),
  address: (v: string) => Address.fromString(v).toScVal(),
  bytes: (v: Uint8Array) => nativeToScVal(v, { type: "bytes" }),
};

export type ArgType = keyof typeof arg;

/** Encodes a `type:value` pair typed by a user, such as in a form. */
export function parseArg(type: ArgType, raw: string): xdr.ScVal {
  const value = raw.trim();
  switch (type) {
    case "u32":
    case "i32":
      if (!/^-?\d+$/.test(value)) throw new Error(`${type} needs an integer, got "${raw}"`);
      return arg[type](Number(value));
    case "u64":
    case "i64":
    case "u128":
    case "i128":
      if (!/^-?\d+$/.test(value)) throw new Error(`${type} needs an integer, got "${raw}"`);
      return arg[type](BigInt(value));
    case "bool":
      if (value !== "true" && value !== "false") throw new Error(`bool must be true or false, got "${raw}"`);
      return arg.bool(value === "true");
    case "symbol":
    case "string":
    case "address":
      return arg[type](value);
    case "bytes":
      if (!/^([0-9a-fA-F]{2})*$/.test(value)) throw new Error(`bytes must be hex, got "${raw}"`);
      return arg.bytes(Uint8Array.from(value.match(/../g) ?? [], (h) => parseInt(h, 16)));
  }
}

/** Ledgers per day at Stellar's ~5 second close time, for TTL Guardian args. */
export const LEDGERS_PER_DAY = 17_280;

/**
 * Arguments for a TTL Guardian `extend` job: keep `contract` alive by
 * extending its TTL to `extendToDays` whenever it drops below `thresholdDays`.
 */
export function ttlGuardianArgs(contract: string, thresholdDays = 60, extendToDays = 90): xdr.ScVal[] {
  return [
    arg.address(contract),
    arg.u32(thresholdDays * LEDGERS_PER_DAY),
    arg.u32(extendToDays * LEDGERS_PER_DAY),
  ];
}
