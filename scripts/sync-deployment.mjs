#!/usr/bin/env node
/**
 * After a redeploy, replaces each old contract address in the repo with the
 * new one (#31), so the README, docs and @sorocron/sdk stop pointing at
 * contracts a testnet reset deleted.
 *
 *   node scripts/sync-deployment.mjs <previous deployment.json> [new deployment.json]
 *
 * The new deployment defaults to deployments/testnet.json. Only files tracked
 * by git change; deployments/ and CHANGELOG.md keep their history.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const [previousPath, nextPath = "deployments/testnet.json"] = process.argv.slice(2);
if (!previousPath) {
  console.error("usage: node scripts/sync-deployment.mjs <previous deployment.json> [new deployment.json]");
  process.exit(2);
}
const previous = JSON.parse(readFileSync(previousPath, "utf8"));
const next = JSON.parse(readFileSync(nextPath, "utf8"));

const CONTRACT = /^C[A-Z2-7]{55}$/;
const replacements = Object.keys(next)
  .filter((key) => CONTRACT.test(previous[key] ?? "") && CONTRACT.test(next[key]) && previous[key] !== next[key])
  .map((key) => ({ key, from: previous[key], to: next[key] }));
if (replacements.length === 0) {
  console.log("No contract addresses changed.");
  process.exit(0);
}

let files = [];
try {
  const patterns = replacements.flatMap(({ from }) => ["-e", from]);
  const pathspec = ["--", ".", ":(exclude)deployments", ":(exclude)CHANGELOG.md"];
  files = execFileSync("git", ["grep", "-l", "-F", ...patterns, ...pathspec], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
} catch (err) {
  // git grep exits 1 when nothing matches.
  if (err.status !== 1) throw err;
}

for (const file of files) {
  const text = readFileSync(file, "utf8");
  let updated = text;
  for (const { from, to } of replacements) updated = updated.replaceAll(from, to);
  if (updated !== text) {
    writeFileSync(file, updated);
    console.log(`updated ${file}`);
  }
}
for (const { key, from, to } of replacements) console.log(`${key}: ${from} -> ${to}`);
