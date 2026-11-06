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

const {
  buildAddedFileFixture,
  buildFullFileFixture,
  measureDiffTable,
  scoreStaging,
  SLICE_ROW_CEILING,
} = await import("../diffViewerBench");

/** Past the ceiling, so an unstaged table can fail it, and still cheap. */
const LINES = SLICE_ROW_CEILING + 200;

/** A sample that passes every predicate; each scoring test breaks exactly one thing. */
const HEALTHY = {
  expectedRows: 3000,
  initialMountedRows: 200,
  initialRenderMs: 1,
  maxSliceRows: 200,
  maxSliceTokenizedRows: 200,
  maxSliceMs: 1,
  slices: 30,
  finalRows: 3000,
  highlightableCells: 2990,
  finalTokenizedCells: 2990,
  textMismatches: 0,
  completeMs: 30,
  tokenRequests: 1,
};

describe("PERF-248 scoring", () => {
  it("passes a healthy sample", () => {
    expect(scoreStaging(HEALTHY)).toEqual({ stagingMisses: 0, tokenMisses: 0 });
  });

  it.each([
    ["nothing on the first commit", { initialMountedRows: 0 }],
    ["a first commit past the ceiling", { initialMountedRows: SLICE_ROW_CEILING + 1 }],
    ["a later commit past the ceiling", { maxSliceRows: SLICE_ROW_CEILING + 1 }],
    ["a token commit past the ceiling", { maxSliceTokenizedRows: SLICE_ROW_CEILING + 1 }],
    ["a table that ended short", { finalRows: 2999 }],
  ])("reports one staging miss for %s", (_label, change) => {
    expect(scoreStaging({ ...HEALTHY, ...change })).toEqual({ stagingMisses: 1, tokenMisses: 0 });
  });

  it.each([
    ["no tokens at all", { finalTokenizedCells: 0 }],
    ["a partial pass", { finalTokenizedCells: 2989 }],
    ["a pass that changed the code", { textMismatches: 1 }],
    ["a plain table with nothing to highlight", { highlightableCells: 0, finalTokenizedCells: 0 }],
  ])("reports a token miss for %s", (_label, change) => {
    const { stagingMisses, tokenMisses } = scoreStaging({ ...HEALTHY, ...change });
    expect(stagingMisses).toBe(0);
    expect(tokenMisses).toBeGreaterThan(0);
  });
});

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
    // One code cell per row in a single-sided table, every one with code in it.
    expect(sample.highlightableCells).toBe(LINES);
    expect(sample.finalTokenizedCells).toBe(LINES);
    expect(sample.textMismatches).toBe(0);
    expect(sample.tokenRequests).toBe(1);
    expect(sample.stagingMisses).toBe(0);
    expect(sample.tokenMisses).toBe(0);
  }, 60_000);

  it("sees the full-file merge mount in bounded commits, all of it", async () => {
    flags.staging = true;
    const sample = await measureDiffTable(buildFullFileFixture(LINES));
    expect(sample.initialMountedRows).toBeLessThan(LINES);
    expect(sample.finalRows).toBe(LINES);
    // Two code cells per split row; the known blank context rows are the only exemptions.
    expect(sample.highlightableCells).toBeGreaterThan(LINES * 2 - 40);
    expect(sample.finalTokenizedCells).toBe(sample.highlightableCells);
    expect(sample.textMismatches).toBe(0);
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
      expect(sample.finalTokenizedCells).toBe(LINES);
      expect(sample.stagingMisses).toBeGreaterThan(0);
      expect(sample.tokenMisses).toBe(0);
    } finally {
      flags.staging = true;
    }
  }, 60_000);

  it("reports a token miss when the pass never arrives", async () => {
    // Every row present and correct, just plain: only the token predicate can
    // tell this run apart from a healthy one.
    flags.staging = true;
    const sample = await measureDiffTable(buildAddedFileFixture(LINES), { withholdTokens: true });
    expect(sample.finalRows).toBe(LINES);
    expect(sample.stagingMisses).toBe(0);
    expect(sample.finalTokenizedCells).toBe(0);
    expect(sample.tokenMisses).toBeGreaterThan(0);
  }, 60_000);
});
