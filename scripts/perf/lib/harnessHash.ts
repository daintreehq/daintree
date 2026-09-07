import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PERF_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Directories under `scripts/perf/` whose contents are not the harness.
 *
 * `history/` and `config/baseline.*.json` are OUTPUTS: they change on every
 * canonical run, so folding them in would make every run report a different
 * harness from the one before it and the hash would say nothing.
 */
const EXCLUDED_DIRS: ReadonlySet<string> = new Set(["history", "node_modules"]);
const EXCLUDED_FILES = /^baseline\.[a-z]+\.json$/;

function collect(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      collect(path.join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (EXCLUDED_FILES.test(entry.name)) continue;
    // Code and reference values only. Prose is not the instrument, and
    // including it would refuse a comparison over a README typo. `.tsx` is in
    // because part of the instrument is now a React component tree —
    // `renderer/` mounts the real lists for PERF-247, and a change to how it
    // mounts them changes what the numbers mean.
    if (!/\.(tsx|ts|js|json)$/.test(entry.name)) continue;
    out.push(path.join(dir, entry.name));
  }
}

/**
 * A content hash of the measuring instrument itself.
 *
 * Two runs of the same scenario on the same machine at the same iteration count
 * are still not comparable if the harness changed between them — and nothing
 * else in a summary file reveals that, because every field a reader would check
 * matches. `.agents/skills/optimize` already hashes this directory into its
 * precommit record for exactly this reason; recording it in `RunProtocol` puts
 * the same evidence in front of an ordinary `perf compare`.
 *
 * Returns null rather than throwing: a provenance label must never be a reason
 * to fail a run.
 */
export function hashHarnessSources(
  root: string = PERF_ROOT,
  /**
   * Extra files that decide what a run reports but may live outside the tree —
   * in practice the resolved `--budgets` path.
   *
   * Without it, `--budgets /tmp/a.json` and `--budgets /tmp/b.json` produce the
   * same harness hash while reporting different reference verdicts, so two runs
   * that are not comparable carry identical provenance. Hashed by CONTENT with
   * a fixed label rather than by path, so a temp directory's random name cannot
   * change the hash and an absolute path never lands in a committed summary.
   */
  extraInputs: readonly string[] = []
): string | null {
  try {
    const files: string[] = [];
    collect(root, files);
    const hash = createHash("sha256");
    for (const file of files) {
      hash.update(path.relative(root, file).split(path.sep).join("/"));
      hash.update("\0");
      hash.update(readFileSync(file));
      hash.update("\0");
    }
    for (const file of extraInputs) {
      // Length-prefixed rather than NUL-delimited. A delimiter alone is not an
      // injective framing: a file whose bytes contain the delimiter sequence
      // could, in principle, be indistinguishable from two files. The current
      // call site passes one JSON budget so it could not happen today, which is
      // the reason to fix the framing now rather than discover it later.
      const contents = readFileSync(file);
      hash.update(`extra:${contents.length}:`);
      hash.update(contents);
    }
    // Truncated: this is an identity check between two runs, not a signature.
    return hash.digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

/** Exposed so a test can prove the excluded paths really are excluded. */
export function harnessHashInputs(root: string = PERF_ROOT): string[] {
  const files: string[] = [];
  try {
    collect(root, files);
  } catch {
    return [];
  }
  return files.map((file) => path.relative(root, file).split(path.sep).join("/"));
}
