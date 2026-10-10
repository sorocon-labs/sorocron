import { describe, expect, it } from "vitest";
import { Endpoints, endpointLabel, rpcUrlsFrom } from "./endpoints.js";

const A = "https://a.example/rpc";
const B = "https://b.example/rpc";
const C = "https://c.example/rpc";

/** Every endpoint answers at the given ledger (undefined: down). */
function probe(e: Endpoints, ledgers: Record<string, number | undefined>) {
  for (const [url, ledger] of Object.entries(ledgers)) e.recordProbe(url, ledger, 50);
  return e.choose();
}

describe("Endpoints", () => {
  it("starts on the first endpoint and drops duplicates", () => {
    const e = new Endpoints([A, B, A]);
    expect(e.active).toBe(A);
    expect(e.all.map((x) => x.url)).toEqual([A, B]);
    expect(() => new Endpoints([])).toThrow(/No RPC endpoints/);
  });

  it("moves to the next endpoint as soon as the active one stops answering", () => {
    const e = new Endpoints([A, B, C]);
    expect(probe(e, { [A]: undefined, [B]: 100, [C]: 100 })).toBe(true);
    expect(e.active).toBe(B);
  });

  it("moves after repeated failed ticks even if probes still answer", () => {
    const e = new Endpoints([A, B], { maxFailures: 3 });
    for (let i = 0; i < 2; i++) {
      e.recordFailure(A);
      expect(probe(e, { [A]: 100, [B]: 100 })).toBe(false);
    }
    e.recordFailure(A);
    expect(probe(e, { [A]: 100, [B]: 100 })).toBe(true);
    expect(e.active).toBe(B);
  });

  it("a successful tick clears the failure count", () => {
    const e = new Endpoints([A, B], { maxFailures: 3 });
    e.recordFailure(A);
    e.recordFailure(A);
    e.recordSuccess(A);
    e.recordFailure(A);
    expect(probe(e, { [A]: 100, [B]: 100 })).toBe(false);
  });

  it("moves off an endpoint that falls too far behind", () => {
    const e = new Endpoints([A, B], { maxLag: 10 });
    expect(probe(e, { [A]: 90, [B]: 100 })).toBe(false);
    expect(probe(e, { [A]: 89, [B]: 100 })).toBe(true);
    expect(e.active).toBe(B);
  });

  it("goes back to the preferred endpoint once it has recovered", () => {
    const e = new Endpoints([A, B], { maxFailures: 1, recoverAfter: 3 });
    e.recordFailure(A);
    // Probe 1 since the failure: A still answers, but it failed a tick.
    expect(probe(e, { [A]: 100, [B]: 100 })).toBe(true);
    expect(e.active).toBe(B);

    // Probe 2 isn't enough...
    expect(probe(e, { [A]: 101, [B]: 101 })).toBe(false);
    // ...but after `recoverAfter` answers in a row it is preferred again.
    expect(probe(e, { [A]: 102, [B]: 102 })).toBe(true);
    expect(e.active).toBe(A);
  });

  it("a probe that comes back after an outage is used again right away", () => {
    const e = new Endpoints([A, B]);
    probe(e, { [A]: undefined, [B]: 100 });
    expect(e.active).toBe(B);
    // A only went down (no failed ticks), so the next answer restores it.
    expect(probe(e, { [A]: 100, [B]: 100 })).toBe(true);
    expect(e.active).toBe(A);
  });

  it("stays put when nothing is healthy", () => {
    const e = new Endpoints([A, B]);
    expect(probe(e, { [A]: undefined, [B]: undefined })).toBe(false);
    expect(e.active).toBe(A);
    expect(e.anyHealthy()).toBe(false);
  });
});

describe("rpcUrlsFrom", () => {
  it("parses a comma-separated list and falls back to the single URL", () => {
    expect(rpcUrlsFrom(` ${A}, ${B} ,`, C)).toEqual([A, B]);
    expect(rpcUrlsFrom(undefined, C)).toEqual([C]);
    expect(rpcUrlsFrom("", "")).toEqual([]);
  });
});

describe("endpointLabel", () => {
  it("shows only the host, never a key in the path or query", () => {
    expect(endpointLabel("https://rpc.example.com/v1/SECRETKEY?token=abc")).toBe("rpc.example.com");
    expect(endpointLabel("http://localhost:8000/rpc")).toBe("localhost:8000");
    expect(endpointLabel("not a url")).toBe("invalid-url");
  });
});
