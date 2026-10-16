#!/usr/bin/env node
/**
 * Checks the Grafana dashboard and Prometheus alert rules in deploy/ against
 * the keepers (#135): the dashboard must be valid JSON with a datasource and
 * position on every panel, and every `sorocron_keeper_*` metric either file
 * queries must be one a keeper actually exports. `promtool check rules`
 * covers the rule syntax separately.
 *
 *   node scripts/check-monitoring.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const METRIC = /sorocron_keeper_[a-z_]+/g;
const sources = [
  ...readdirSync("keeper-bot/src").filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => join("keeper-bot/src", f)),
  ...readdirSync("keeper-rs/src").filter((f) => f.endsWith(".rs")).map((f) => join("keeper-rs/src", f)),
];
const exported = new Set(sources.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/"(sorocron_keeper_[a-z_]+)"/g)].map((m) => m[1])));

const problems = [];
const dashboard = JSON.parse(readFileSync("deploy/grafana/sorocron-keeper.json", "utf8"));
const queried = new Map();
for (const panel of dashboard.panels) {
  if (panel.type === "row") continue;
  if (!panel.datasource) problems.push(`panel "${panel.title}" has no datasource`);
  if (!panel.gridPos) problems.push(`panel "${panel.title}" has no gridPos`);
  if (!panel.targets?.length) problems.push(`panel "${panel.title}" has no queries`);
  for (const target of panel.targets ?? []) {
    for (const [name] of target.expr.matchAll(METRIC)) queried.set(name, `dashboard panel "${panel.title}"`);
  }
}
for (const [name] of readFileSync("deploy/prometheus/alerts.yml", "utf8").matchAll(METRIC)) {
  queried.set(name, queried.get(name) ?? "deploy/prometheus/alerts.yml");
}
for (const [name, where] of queried) {
  if (!exported.has(name)) problems.push(`${where} queries ${name}, which no keeper exports`);
}

if (problems.length) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log(`dashboard and alerts query ${queried.size} metrics, all exported`);
