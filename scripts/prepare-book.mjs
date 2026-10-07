#!/usr/bin/env node
// Assembles the documentation site's chapters into book/src (issue #55).
//
//   node scripts/prepare-book.mjs && mdbook build book
//
// The chapters are the repository's own Markdown (docs/ and the package
// READMEs), so they stay readable on GitHub and there's one copy of each.
// Links between chapters are rewritten to point at their place in the book;
// links to anything else in the repository (source files, examples,
// deployments) become GitHub URLs.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "book", "src");
const github = "https://github.com/sorocon-labs/sorocron";

/** Repository path -> path in the book. */
const chapters = {
  "book/introduction.md": "introduction.md",
  "docs/tutorial.md": "tutorial.md",
  "docs/cli.md": "cli.md",
  "docs/tutorials/dca.md": "tutorials/dca.md",
  "docs/tutorials/limit-order.md": "tutorials/limit-order.md",
  "contracts/examples/README.md": "examples.md",
  "docs/architecture.md": "architecture.md",
  "docs/costs.md": "costs.md",
  "docs/security.md": "security.md",
  "docs/threat-model.md": "threat-model.md",
  "keeper-bot/README.md": "reference/keeper.md",
  "keeper-rs/README.md": "reference/keeper-rs.md",
  "docs/guides/keeper-deployment.md": "guides/keeper-deployment.md",
  "packages/sdk/README.md": "reference/sdk.md",
  "packages/react/README.md": "reference/react.md",
  "CONTRIBUTING.md": "contributing.md",
};

/** Where a repository-relative link should point from `chapter` in the book. */
export function rewriteTarget(target, sourcePath, chapterPath) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("/")) return target;
  const [path, anchor] = splitAnchor(target);
  const repoPath = posix.normalize(posix.join(posix.dirname(sourcePath), decodeURI(path)));
  // GitHub-relative links such as ../../issues: resolve them as GitHub would.
  if (repoPath.startsWith("..")) return new URL(target, `${github}/blob/main/${sourcePath}`).href;

  const readme = posix.join(repoPath, "README.md");
  const linked = chapters[repoPath] ?? chapters[readme];
  if (linked) {
    const rel = posix.relative(posix.dirname(chapterPath), linked) || posix.basename(linked);
    return rel + anchor;
  }
  const full = join(root, repoPath);
  const isDir = existsSync(full) && statSync(full).isDirectory();
  return `${github}/${isDir ? "tree" : "blob"}/main/${encodeURI(repoPath)}${anchor}`;
}

function splitAnchor(target) {
  const i = target.indexOf("#");
  return i === -1 ? [target, ""] : [target.slice(0, i), target.slice(i)];
}

/**
 * Rewrites inline links and images outside fenced code blocks. Matches on
 * the `](target)` half so links whose text wraps onto a new line work too.
 */
export function rewriteLinks(markdown, sourcePath, chapterPath) {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      return line.replace(/(\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g, (_, open, target, close) => {
        return open + rewriteTarget(target, sourcePath, chapterPath) + close;
      });
    })
    .join("\n");
}

function main() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const [source, chapter] of Object.entries(chapters)) {
    const text = readFileSync(join(root, source), "utf8").replace(/\r\n/g, "\n");
    const dest = join(out, chapter);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, rewriteLinks(text, source, chapter));
  }
  cpSync(join(root, "book", "SUMMARY.md"), join(out, "SUMMARY.md"));
  console.log(`Wrote ${Object.keys(chapters).length} chapters to ${relative(root, out)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
