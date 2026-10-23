import { existsSync, readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { computeDefaultCachedViews } from "../../../shared/config/cachedProjectViews";
import { REGISTRY } from "../../../scripts/perf/registry";
import {
  LIFECYCLE_DOC,
  LIFECYCLE_MATRIX,
  LIFECYCLE_PERF_COMMAND,
  LIFECYCLE_PERF_SPEC,
  LIFECYCLE_SPEC,
  LIFECYCLE_WORKLOAD,
  REFERENCE_APP_SOURCE,
  type LifecycleRow,
} from "../referenceAppLifecycle";

/**
 * The reference-app matrix is only worth having if it cannot quietly drift
 * from what runs. Neither spec runs in CI, so this is the one check that does:
 * every row names a test that exists, a metric the benchmark reports, or a gap
 * with its reason, and the workload still evicts on any machine's default cache.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

/** Titles of real `test(...)` calls — a comment or a stray string does not count. */
function declaredTestTitles(source: string): string[] {
  const titles: string[] = [];
  for (const match of source.matchAll(/^\s*test\(\s*"((?:[^"\\]|\\.)*)"\s*,/gm)) {
    titles.push(match[1]);
  }
  return titles;
}

/** Where a row's coverage falls short: a missing test, an unreported metric, an empty gap. */
function matrixProblems(
  rows: readonly LifecycleRow[],
  titles: readonly string[],
  perfSource: string
): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) problems.push(`${row.id}: duplicate id`);
    ids.add(row.id);
    if (row.coverage.length === 0) problems.push(`${row.id}: no coverage and no gap`);
    for (const coverage of row.coverage) {
      if (coverage.kind === "test" && !titles.includes(coverage.title)) {
        problems.push(`${row.id}: no test titled "${coverage.title}"`);
      }
      if (coverage.kind === "perf" && !perfSource.includes(`\`${coverage.metric}\``)) {
        problems.push(`${row.id}: the benchmark does not document ${coverage.metric}`);
      }
      if (coverage.kind === "gap" && coverage.reason.trim().length < 40) {
        problems.push(`${row.id}: a gap needs a reason`);
      }
      if (coverage.kind === "gap") {
        for (const spec of coverage.elsewhere ?? []) {
          if (!existsSync(path.join(REPO_ROOT, spec))) {
            problems.push(`${row.id}: ${spec} does not exist`);
          }
        }
      }
    }
  }
  return problems;
}

describe("reference-app lifecycle matrix", () => {
  const specSource = read(LIFECYCLE_SPEC);
  const perfSource = read(LIFECYCLE_PERF_SPEC);
  const titles = declaredTestTitles(specSource);

  it("rotates through more projects than the largest default cache", () => {
    const ceiling = computeDefaultCachedViews(Number.MAX_SAFE_INTEGER);
    expect(LIFECYCLE_WORKLOAD.projects.length).toBeGreaterThan(ceiling);
    expect(LIFECYCLE_WORKLOAD.projects.length).toBeGreaterThan(LIFECYCLE_WORKLOAD.cachedViewLimit);
    expect(new Set(LIFECYCLE_WORKLOAD.projects).size).toBe(LIFECYCLE_WORKLOAD.projects.length);
  });

  it("names projects the switcher can tell apart", () => {
    // The switcher matches a substring of the folder name.
    const names = LIFECYCLE_WORKLOAD.projects;
    for (const name of names) {
      expect(names.filter((other) => other.includes(name))).toEqual([name]);
    }
  });

  it("covers every row with a real test, a reported metric or a reasoned gap", () => {
    expect(matrixProblems(LIFECYCLE_MATRIX, titles, perfSource)).toEqual([]);
  });

  it("has no test in the spec the matrix does not account for", () => {
    const claimed = new Set(
      LIFECYCLE_MATRIX.flatMap((row) =>
        row.coverage.flatMap((c) => (c.kind === "test" ? [c.title] : []))
      )
    );
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.filter((title) => !claimed.has(title))).toEqual([]);
  });

  it("flags a renamed test, a missing metric and an empty gap", () => {
    const rows: LifecycleRow[] = [
      { id: "a", criterion: "a", coverage: [{ kind: "test", title: "gone" }] },
      { id: "b", criterion: "b", coverage: [{ kind: "perf", metric: "switch.lukewarm" }] },
      { id: "c", criterion: "c", coverage: [{ kind: "gap", reason: " " }] },
      { id: "d", criterion: "d", coverage: [] },
    ];
    expect(matrixProblems(rows, ["present"], "`switch.warm`")).toHaveLength(4);
  });

  it("reads test titles from calls only", () => {
    const source = [
      '// test("commented out", async () => {',
      'const title = "test(\\"not a call\\", x)";',
      '  test("a real one", async () => {',
      '  test.describe.serial("a suite", () => {',
    ].join("\n");
    expect(declaredTestTitles(source)).toEqual(["a real one"]);
  });

  it("registers the benchmark under its command", () => {
    expect(REGISTRY[LIFECYCLE_PERF_COMMAND]?.spec).toBe(LIFECYCLE_PERF_SPEC);
  });

  it("loads the reference app from its committed build", () => {
    const manifest = JSON.parse(read(`${REFERENCE_APP_SOURCE}/plugin.json`)) as { main: string };
    expect(existsSync(path.join(REPO_ROOT, REFERENCE_APP_SOURCE, manifest.main))).toBe(true);
  });

  it("documents every row and the explicit invocations", () => {
    const doc = read(LIFECYCLE_DOC);
    for (const row of LIFECYCLE_MATRIX) expect(doc).toContain(`\`${row.id}\``);
    expect(doc).toContain(LIFECYCLE_SPEC);
    expect(doc).toContain(`npm run perf ${LIFECYCLE_PERF_COMMAND}`);
  });
});
