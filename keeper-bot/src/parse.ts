/** Parsing for CLI input: durations, calendar times, typed arguments, amounts. */
import { parseArg, schedule, type ArgType, type Schedule } from "@sorocron/sdk";
import type { xdr } from "@stellar/stellar-sdk";

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3_600, d: 86_400, w: 604_800 };

/** "90", "90s", "15m", "1h30m", "1d" → seconds. */
export function parseDuration(text: string): bigint {
  const input = text.trim().toLowerCase();
  if (/^\d+$/.test(input)) return BigInt(input);
  const parts = [...input.matchAll(/(\d+)\s*([smhdw])/g)];
  if (parts.length === 0 || parts.map((p) => p[0]).join("") !== input.replace(/\s+/g, "")) {
    throw new Error(`Not a duration: "${text}" (try 30s, 15m, 1h30m, 1d)`);
  }
  return parts.reduce((sum, [, n, unit]) => sum + BigInt(n) * BigInt(UNITS[unit]), 0n);
}

/** "12:00" or "9:30" → [hour, minute]. */
function parseClock(text: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) throw new Error(`Not a time: "${text}" (use HH:MM, UTC)`);
  const [h, m] = [Number(match[1]), Number(match[2])];
  if (h > 23 || m > 59) throw new Error(`Not a time: "${text}"`);
  return [h, m];
}

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** `--daily 12:00` → Daily(12, 0). */
export function parseDaily(text: string): Schedule {
  return schedule.daily(...parseClock(text));
}

/** `--weekly mon@09:30` → Weekly(0, 9, 30). */
export function parseWeekly(text: string): Schedule {
  const [day, clock] = text.toLowerCase().split("@");
  const weekday = WEEKDAYS.indexOf(day?.slice(0, 3) ?? "");
  if (weekday < 0 || !clock) throw new Error(`Not a weekly time: "${text}" (use mon@09:30)`);
  return schedule.weekly(weekday, ...parseClock(clock));
}

const ARG_TYPES: ArgType[] = ["u32", "i32", "u64", "i64", "u128", "i128", "bool", "symbol", "string", "address", "bytes"];

/** `--arg u32:1 --arg address:G...` → encoded ScVals. */
export function parseArgSpec(spec: string): xdr.ScVal {
  const colon = spec.indexOf(":");
  const type = spec.slice(0, colon) as ArgType;
  if (colon < 0 || !ARG_TYPES.includes(type)) {
    throw new Error(`Argument "${spec}" must look like type:value, with type one of ${ARG_TYPES.join(", ")}`);
  }
  return parseArg(type, spec.slice(colon + 1));
}

/** An ISO date or unix seconds → unix seconds. */
export function parseTime(text: string): bigint {
  if (/^\d+$/.test(text.trim())) return BigInt(text.trim());
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new Error(`Not a date: "${text}" (use ISO 8601, e.g. 2026-11-01T12:00:00Z)`);
  return BigInt(Math.floor(ms / 1000));
}
