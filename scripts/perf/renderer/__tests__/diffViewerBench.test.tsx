/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";

/**
 * The oracle for PERF-248, run at a size cheap enough for `npm test`.
 *
 * The DiffViewer suites prove the staging contracts; this proves the thing the
 * benchmark's numbers depend on — that the instrument sees a staged table as
 * staged, sees an unstaged one as unstaged, and checks the whole table and its
 * tokens arrived either way.
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

const { buildAddedFileFixture, buildFullFileFixture, measureDiffTable, SLICE_ROW_CEILING } =
  await import("../diffViewerBench");

/** Past the ceiling, so an unstaged table can fail it, and still cheap. */
const LINES = SLICE_ROW_CEILING + 200;

describe("PERF-248 renderer benchmark", () => {
  it("builds fixtures whose row count it can state up front", () => {
    const added = buildAddedFileFixture(50);
    expect(added.expectedRows).toBe(50);
    expect(added.diff).toBe(buildAddedFileFixture(50).diff);
    const full = buildFullFileFixture(50);
    expect(full.expectedRows).toBe(50);
    expect(full.source?.split("\n")).toHaveLength(51);
  });

  it("sees an added file mount and highlight in bounded commits, all of it", async () => {
    flags.staging = true;
    const sample = await measureDiffTable(buildAddedFileFixture(LINES));
    expect(sample.initialMountedRows).toBeGreaterThan(0);
    expect(sample.initialMountedRows).toBeLessThan(LINES);
    expect(sample.finalRows).toBe(LINES);
    expect(sample.finalHighlightableRows).toBe(LINES);
    expect(sample.finalTokenizedRows).toBe(LINES);
    expect(sample.tokenRequests).toBe(1);
    expect(sample.stagingMisses).toBe(0);
    expect(sample.tokenMisses).toBe(0);
  }, 60_000);

  it("sees the full-file merge mount in bounded commits, all of it", async () => {
    flags.staging = true;
    const sample = await measureDiffTable(buildFullFileFixture(LINES));
    expect(sample.initialMountedRows).toBeLessThan(LINES);
    expect(sample.finalRows).toBe(LINES);
    expect(sample.finalHighlightableRows).toBeGreaterThan(LINES - 20);
    expect(sample.finalTokenizedRows).toBe(sample.finalHighlightableRows);
    expect(sample.stagingMisses).toBe(0);
    expect(sample.tokenMisses).toBe(0);
  }, 60_000);

  it("reports a staging miss when the table mounts every row at once", async () => {
    // The negative control, and the shape of the regression this guards: the
    // same viewer and fixture with staging off, which is what the table did
    // before #15677. It still renders everything correctly, so only the
    // staging predicate stands between it and a clean bill of health.
    flags.staging = false;
    try {
      const sample = await measureDiffTable(buildAddedFileFixture(LINES));
      expect(sample.initialMountedRows).toBe(LINES);
      expect(sample.maxSliceTokenizedRows).toBe(LINES);
      expect(sample.finalTokenizedRows).toBe(LINES);
      expect(sample.stagingMisses).toBeGreaterThan(0);
      expect(sample.tokenMisses).toBe(0);
    } finally {
      flags.staging = true;
    }
  }, 60_000);
});
