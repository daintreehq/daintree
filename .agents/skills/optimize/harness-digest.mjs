/**
 * A hash over the measurement apparatus.
 *
 * "Never edit a measurement surface" is the one rule in this loop an agent can
 * break without anything noticing: a benchmark edited to measure less produces
 * a smaller number, and every downstream check passes because the files are
 * internally consistent. Pinning the apparatus at precommit time and comparing
 * it at claim time turns that instruction into a check.
 *
 * Covered: everything under `scripts/perf/` — scenarios, fixtures, the runner,
 * the comparator, `budgets.json`, the baselines — plus the gate scripts in the
 * skill directory, because tampering with the gate is the same attack as
 * tampering with the benchmark. Excluded: `scripts/perf/history/`, which every
 * unfiltered run writes and which records measurements rather than shaping
 * them, and `agents/`, which is prompt text for a different runner.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..", "..", "..");

const DIGEST_ROOTS = [
  { root: join(REPO_ROOT, "scripts", "perf"), skip: new Set(["history", "node_modules"]) },
  { root: HERE, skip: new Set(["agents"]) },
];

function collectFiles(dir, skip, out) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1
  );
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".gitkeep") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skip.has(entry.name)) continue;
      collectFiles(full, skip, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/**
 * @returns {{ digest: string, fileCount: number }} A digest stable across
 * operating systems: paths are repo-relative and POSIX-separated, so a Windows
 * leg and a macOS leg of the same tree agree.
 */
export function harnessDigest() {
  const hash = createHash("sha256");
  const files = [];
  for (const { root, skip } of DIGEST_ROOTS) {
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    files.push(...collectFiles(root, skip, []));
  }
  for (const file of files.sort()) {
    hash.update(relative(REPO_ROOT, file).split(sep).join("/"));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return { digest: hash.digest("hex"), fileCount: files.length };
}
