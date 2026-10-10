#!/usr/bin/env node
/**
 * Prepares @sorocron/sdk and @sorocron/react for npm and checks what would
 * be published (#115). Run it after building both packages.
 *
 *   node scripts/prepare-npm.mjs               CI: check every pull request
 *   node scripts/prepare-npm.mjs --tag v0.4.0  release: also check versions
 *
 * In this repository both packages export their TypeScript source under a
 * "development" condition, so the workspace runs without building them. A
 * published package mustn't: bundlers such as Vite resolve "development" in
 * dev mode and would load the .ts files. This script rewrites each
 * package.json to export only the build, then packs each package (dry run)
 * and fails if an export points at a file the tarball lacks, or if source
 * or tests would ship. It changes package.json in place, so run it in a
 * throwaway checkout (CI) or revert afterwards.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const PACKAGES = ["packages/sdk", "packages/react"];
const tagIndex = process.argv.indexOf("--tag");
const tag = tagIndex === -1 ? undefined : process.argv[tagIndex + 1];

const problems = [];
const manifests = {};

for (const dir of PACKAGES) {
  const path = `${dir}/package.json`;
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  manifests[pkg.name] = pkg;

  for (const conditions of Object.values(pkg.exports ?? {})) {
    if (conditions && typeof conditions === "object") delete conditions.development;
  }
  pkg.files = (pkg.files ?? []).filter((f) => f !== "src");
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const [packed] = JSON.parse(
    execFileSync(npm, ["pack", "--dry-run", "--json"], { cwd: dir, encoding: "utf8", shell: process.platform === "win32" }),
  );
  const files = new Set(packed.files.map((f) => f.path));

  const targets = [pkg.main, pkg.types, ...collect(pkg.exports)].filter(Boolean).map((t) => t.replace(/^\.\//, ""));
  for (const target of new Set(targets)) {
    if (!files.has(target)) problems.push(`${pkg.name}: "${target}" is exported but not in the package (build it first?)`);
  }
  for (const file of files) {
    if (file.startsWith("src/") || /\.test\.(js|d\.ts)$/.test(file)) problems.push(`${pkg.name}: ${file} shouldn't be published`);
  }
  if (tag && `v${pkg.version}` !== tag) problems.push(`${pkg.name}: version ${pkg.version} doesn't match tag ${tag}`);

  console.log(`${pkg.name}@${pkg.version}: ${files.size} files, ${(packed.size / 1024).toFixed(1)} kB packed`);
}

// The hooks must accept the SDK version they are released with.
const sdk = manifests["@sorocron/sdk"];
const wanted = manifests["@sorocron/react"]?.peerDependencies?.["@sorocron/sdk"];
if (sdk && wanted !== `^${sdk.version}`) {
  problems.push(`@sorocron/react: peer dependency @sorocron/sdk is "${wanted}", expected "^${sdk.version}"`);
}

if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
console.log("Both packages are ready to publish.");

/** Every file path in an `exports` map, at any depth. */
function collect(value) {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(collect);
  return [];
}
