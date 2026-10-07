import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Metrics, isHealthy, startMetricsServer } from "./metrics.js";

describe("Metrics", () => {
  it("renders counters and gauges in Prometheus text format", () => {
    const m = new Metrics();
    m.inc("jobs_total", "Jobs by outcome", { outcome: "executed" }, 2);
    m.inc("jobs_total", "Jobs by outcome", { outcome: "executed" });
    m.inc("jobs_total", "Jobs by outcome", { outcome: "failed" });
    m.set("balance", "Balance", 42);

    expect(m.render()).toBe(
      [
        "# HELP jobs_total Jobs by outcome",
        "# TYPE jobs_total counter",
        'jobs_total{outcome="executed"} 3',
        'jobs_total{outcome="failed"} 1',
        "# HELP balance Balance",
        "# TYPE balance gauge",
        "balance 42",
        "",
      ].join("\n"),
    );
  });

  it("overwrites gauges and escapes label values", () => {
    const m = new Metrics();
    m.set("g", "help", 1, { name: 'a"b\\c' });
    m.set("g", "help", 5, { name: 'a"b\\c' });
    expect(m.get("g", { name: 'a"b\\c' })).toBe(5);
    expect(m.render()).toContain('g{name="a\\"b\\\\c"} 5');
  });

  it("treats label order as irrelevant", () => {
    const m = new Metrics();
    m.inc("c", "help", { a: "1", b: "2" });
    m.inc("c", "help", { b: "2", a: "1" });
    expect(m.get("c", { a: "1", b: "2" })).toBe(2);
  });
});

describe("isHealthy", () => {
  it("is unhealthy before the first successful tick", () => {
    expect(isHealthy({ lastSuccessMs: 0 }, 30_000, 1_000_000)).toBe(false);
  });

  it("is healthy within the window and unhealthy after it", () => {
    expect(isHealthy({ lastSuccessMs: 1_000_000 }, 30_000, 1_030_000)).toBe(true);
    expect(isHealthy({ lastSuccessMs: 1_000_000 }, 30_000, 1_030_001)).toBe(false);
  });
});

describe("metrics server", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function start(lastSuccessMs: number) {
    const m = new Metrics();
    m.inc("sorocron_keeper_ticks_total", "Completed polling passes");
    server = startMetricsServer(0, m, { lastSuccessMs }, 60_000);
    await new Promise((r) => server!.once("listening", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("serves /metrics", async () => {
    const base = await start(Date.now());
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("sorocron_keeper_ticks_total 1");
  });

  it("reports health on /healthz", async () => {
    const healthy = await start(Date.now());
    expect((await fetch(`${healthy}/healthz`)).status).toBe(200);
    server!.close();

    const stale = await start(0);
    const res = await fetch(`${stale}/healthz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, lastSuccess: null });
  });

  it("returns 404 for anything else", async () => {
    const base = await start(Date.now());
    expect((await fetch(`${base}/`)).status).toBe(404);
  });
});
