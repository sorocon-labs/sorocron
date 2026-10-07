/** Plain-text tables and key/value blocks for the CLI. No colours, so output pipes cleanly. */

export type Cell = string | number | bigint | boolean | null | undefined;

const text = (c: Cell) => (c === null || c === undefined ? "-" : String(c));

/** Left-aligned columns; numeric columns (all cells numbers or bigints) right-aligned. */
export function table(headers: string[], rows: Cell[][]): string {
  const cells = rows.map((r) => r.map(text));
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => (r[i] ?? "").length)));
  const numeric = headers.map((_, i) => rows.length > 0 && rows.every((r) => typeof r[i] === "number" || typeof r[i] === "bigint"));
  const line = (r: string[]) =>
    r
      .map((c, i) => (numeric[i] ? c.padStart(widths[i]) : c.padEnd(widths[i])))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...cells.map(line)].join("\n");
}

/** `key   value` lines with aligned values. */
export function details(pairs: [string, Cell][]): string {
  const width = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${k.padEnd(width)}  ${text(v)}`).join("\n");
}
