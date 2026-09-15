#!/usr/bin/env node
// Creates the labels and starter issue backlog on GitHub using the gh CLI.
//
//   gh auth login                       (once)
//   node scripts/create-issues.mjs --dry-run
//   node scripts/create-issues.mjs
//
// Run from inside the cloned repository. Issues whose title already exists
// (open or closed) are skipped, so it's safe to re-run.

import { execFileSync } from "node:child_process";
import { issues, labels } from "./issues.mjs";

const dryRun = process.argv.includes("--dry-run");

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

if (dryRun) {
  console.log(`Would create ${labels.length} labels and ${issues.length} issues:\n`);
  for (const issue of issues) console.log(`- ${issue.title}  [${issue.labels.join(", ")}]`);
  process.exit(0);
}

for (const label of labels) {
  gh(["label", "create", label.name, "--color", label.color, "--description", label.description, "--force"]);
}
console.log(`Labels ready (${labels.length}).`);

const existing = new Set(
  JSON.parse(gh(["issue", "list", "--state", "all", "--limit", "1000", "--json", "title"])).map((i) => i.title),
);

for (const issue of issues) {
  if (existing.has(issue.title)) {
    console.log(`skip (exists): ${issue.title}`);
    continue;
  }
  const url = gh([
    "issue",
    "create",
    "--title",
    issue.title,
    "--body",
    issue.body,
    ...issue.labels.flatMap((l) => ["--label", l]),
  ]).trim();
  console.log(`created: ${issue.title} -> ${url}`);
}
