/**
 * Prometheus metrics and a health endpoint for the keeper, with no
 * dependencies beyond node:http.
 *
 *   GET /metrics   Prometheus text exposition format (version 0.0.4)
 *   GET /healthz   200 while ticks are succeeding, 503 once the last
 *                  successful tick is older than `staleAfterMs`
 *
 * Enabled by setting METRICS_PORT (see keeper.ts). Metric names are part of
 * the operator-facing interface: dashboards and alerts depend on them, so
 * add new ones rather than renaming.
 */
import { createServer, type Server } from "node:http";

type Labels = Record<string, string>;

interface Metric {
  name: string;
  help: string;
  type: "counter" | "gauge";
  values: Map<string, { labels: Labels; value: number }>;
}

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(",");
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

export class Metrics {
  private metrics = new Map<string, Metric>();

  private define(name: string, help: string, type: Metric["type"]): Metric {
    let metric = this.metrics.get(name);
    if (!metric) {
      metric = { name, help, type, values: new Map() };
      this.metrics.set(name, metric);
    }
    return metric;
  }

  /** Adds `by` (default 1) to a counter. */
  inc(name: string, help: string, labels: Labels = {}, by = 1): void {
    const metric = this.define(name, help, "counter");
    const key = labelKey(labels);
    const current = metric.values.get(key)?.value ?? 0;
    metric.values.set(key, { labels, value: current + by });
  }

  /** Sets a gauge to `value`. */
  set(name: string, help: string, value: number, labels: Labels = {}): void {
    const metric = this.define(name, help, "gauge");
    metric.values.set(labelKey(labels), { labels, value });
  }

  get(name: string, labels: Labels = {}): number | undefined {
    return this.metrics.get(name)?.values.get(labelKey(labels))?.value;
  }

  render(): string {
    const lines: string[] = [];
    for (const metric of this.metrics.values()) {
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);
      for (const { labels, value } of metric.values.values()) {
        const pairs = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
        lines.push(`${metric.name}${pairs.length ? `{${pairs.join(",")}}` : ""} ${value}`);
      }
    }
    return lines.join("\n") + "\n";
  }
}

export interface HealthState {
  /** Unix ms of the last tick that completed without throwing, or 0. */
  lastSuccessMs: number;
}

/** Healthy once a tick has succeeded within the last `staleAfterMs`. */
export function isHealthy(state: HealthState, staleAfterMs: number, nowMs: number): boolean {
  return state.lastSuccessMs > 0 && nowMs - state.lastSuccessMs <= staleAfterMs;
}

export function startMetricsServer(
  port: number,
  metrics: Metrics,
  health: HealthState,
  staleAfterMs: number,
): Server {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(metrics.render());
    } else if (path === "/healthz") {
      const ok = isHealthy(health, staleAfterMs, Date.now());
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok, lastSuccess: health.lastSuccessMs ? new Date(health.lastSuccessMs).toISOString() : null }));
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(port);
  return server;
}
