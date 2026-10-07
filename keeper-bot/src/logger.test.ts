import { describe, expect, it } from "vitest";
import { formatLine } from "./logger.js";

const NOW = new Date("2026-10-07T12:00:00.000Z");

describe("formatLine", () => {
  it("emits one JSON object per line in json mode", () => {
    const line = formatLine("json", "warn", 'balance "low"', NOW);
    expect(JSON.parse(line)).toEqual({ time: "2026-10-07T12:00:00.000Z", level: "warn", msg: 'balance "low"' });
  });

  it("keeps the readable format otherwise, tagging non-info levels", () => {
    expect(formatLine("text", "info", "job 1: executed", NOW)).toBe("[2026-10-07T12:00:00.000Z] job 1: executed");
    expect(formatLine("text", "error", "tick failed", NOW)).toBe("[2026-10-07T12:00:00.000Z] ERROR tick failed");
  });
});
