/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";

/**
 * PERF-248's measurement pass. Skipped unless `DAINTREE_PERF_OUT` names a file
 * to write, which is how the scenario in `scenarios/panels.ts` drives it — an
 * ordinary `npm test` must not pay for four 5,000-row tables.
 *
 * Both arms run in ONE process, so the before/after comparison is same-machine
 * and same-session by construction. The "unstaged" arm is the viewer with
 * staging switched off through its own policy helper: the same components and
 * fixtures, committing every row at once as the table did before #15677.
 */
const flags = vi.hoisted(() => ({ staging: true }));

vi.mock("@/components/Worktree/diffRowStaging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/Worktree/diffRowStaging")>();
  return {
    ...actual,
    shouldStageRows: (rows: number) => flags.staging && actual.shouldStageRows(rows),
  };
});

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn().mockResolvedValue({ ok: true }) },
}));

const { BENCH_LINES, buildAddedFileFixture, buildFullFileFixture, measureDiffTable, toMetrics } =
  await import("../diffViewerBench");

const outPath = process.env.DAINTREE_PERF_OUT;

describe.skipIf(!outPath)("PERF-248 measurement", () => {
  it("measures the added-file and full-file tables staged and unstaged", async () => {
    const metrics: Record<string, number> = {};

    for (const staging of [false, true]) {
      flags.staging = staging;
      const arm = staging ? "staged" : "unstaged";
      Object.assign(
        metrics,
        toMetrics(`${arm}Added5000`, await measureDiffTable(buildAddedFileFixture(BENCH_LINES))),
        toMetrics(`${arm}FullFile5000`, await measureDiffTable(buildFullFileFixture(BENCH_LINES)))
      );
    }
    flags.staging = true;

    // The instrument's own negative control. If the unstaged arm did NOT
    // report staging misses, the mock is not reaching the viewer and both arms
    // are measuring the same thing.
    expect(metrics.unstagedAdded5000StagingMisses).toBeGreaterThan(0);
    expect(metrics.unstagedFullFile5000StagingMisses).toBeGreaterThan(0);
    expect(metrics.stagedAdded5000StagingMisses).toBe(0);
    expect(metrics.stagedFullFile5000StagingMisses).toBe(0);

    writeFileSync(outPath as string, JSON.stringify(metrics, null, 2));
  }, 300_000);
});
