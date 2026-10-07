import { describe, expect, it } from "vitest";
import { scValToNative } from "@stellar/stellar-sdk";
import { details, table } from "./format.js";
import { parseArgSpec, parseDaily, parseDuration, parseTime, parseWeekly } from "./parse.js";

describe("CLI parsing", () => {
  it("parses durations", () => {
    expect(parseDuration("90")).toBe(90n);
    expect(parseDuration("30s")).toBe(30n);
    expect(parseDuration("15m")).toBe(900n);
    expect(parseDuration("1h30m")).toBe(5_400n);
    expect(parseDuration("1d")).toBe(86_400n);
    expect(() => parseDuration("soon")).toThrow(/duration/);
    expect(() => parseDuration("1h banana")).toThrow();
  });

  it("parses calendar schedules", () => {
    expect(parseDaily("12:00")).toEqual({ tag: "Daily", values: [12, 0] });
    expect(parseWeekly("mon@09:30")).toEqual({ tag: "Weekly", values: [0, 9, 30] });
    expect(parseWeekly("Friday@18:05")).toEqual({ tag: "Weekly", values: [4, 18, 5] });
    expect(() => parseDaily("25:00")).toThrow();
    expect(() => parseWeekly("someday@09:00")).toThrow();
  });

  it("parses typed arguments", () => {
    expect(scValToNative(parseArgSpec("u32:7"))).toBe(7);
    expect(scValToNative(parseArgSpec("i128:-5"))).toBe(-5n);
    expect(scValToNative(parseArgSpec("symbol:hello"))).toBe("hello");
    expect(() => parseArgSpec("7")).toThrow(/type:value/);
    expect(() => parseArgSpec("float:1.5")).toThrow(/type:value/);
  });

  it("parses times", () => {
    expect(parseTime("1700000000")).toBe(1_700_000_000n);
    expect(parseTime("2023-11-14T22:13:20Z")).toBe(1_700_000_000n);
    expect(() => parseTime("tomorrow")).toThrow(/date/);
  });
});

describe("CLI output", () => {
  it("aligns tables, right-aligning numeric columns", () => {
    const out = table(
      ["ID", "CALL", "RUNS LEFT"],
      [
        [3n, "increment()", 10n],
        [12n, "extend()", 9n],
      ],
    );
    expect(out.split("\n")).toEqual([
      "ID  CALL         RUNS LEFT",
      "--  -----------  ---------",
      " 3  increment()         10",
      "12  extend()             9",
    ]);
  });

  it("prints aligned details", () => {
    expect(details([["Job", "#1"], ["Resolver", null]])).toBe("Job       #1\nResolver  -");
  });
});
