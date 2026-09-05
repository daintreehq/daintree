/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import {
  buildChangeSetFixture,
  buildStagingFixture,
  measureDiffShelf,
  measureWorkingTreeList,
} from "../reviewListsBench";

/**
 * The oracle for PERF-247, run at a size cheap enough for `npm test`.
 *
 * This is not a duplicate of the component tests: those prove the keyboard and
 * accessibility contracts survive windowing, and mock `react-virtuoso` to do
 * it. This mounts the REAL virtualizer and asserts the thing the benchmark's
 * numbers depend on — that the lists actually window, and that the instrument
 * would notice if they stopped.
 */
describe("PERF-247 renderer benchmark", () => {
  it("builds a deterministic fixture at the requested size", () => {
    expect(buildStagingFixture(300)).toHaveLength(300);
    expect(buildStagingFixture(300)).toEqual(buildStagingFixture(300));
    // Nested paths with bounded fan-out — the shelf needs plausible groups.
    expect(new Set(buildChangeSetFixture(300).map((f) => f.path)).size).toBe(300);
  });

  it("windows the Review Hub section and keeps the selection mounted", async () => {
    const sample = await measureWorkingTreeList(300);
    expect(sample.fileCount).toBe(300);
    expect(sample.mountedRows).toBeGreaterThan(0);
    expect(sample.mountedRows).toBeLessThan(300);
    expect(sample.windowingMisses).toBe(0);
    expect(sample.selectionMisses).toBe(0);
  });

  it("reports a selection miss when the marker does not move", async () => {
    // The negative control for `selectionMisses`. Selecting the row that is
    // ALREADY current is a no-op re-render, so the marker never moves onto a
    // new row — the same DOM a component that ignored `focusedIndex` entirely
    // would produce, and the shape that makes a selection change look free.
    const sample = await measureWorkingTreeList(300, true, { selectionIndex: -1 });
    expect(sample.mountedRows).toBeLessThan(300);
    expect(sample.selectionMisses).toBeGreaterThan(0);
  });

  it("windows the diff shelf and keeps the current file mounted", async () => {
    const sample = await measureDiffShelf(300);
    expect(sample.fileCount).toBe(300);
    expect(sample.mountedRows).toBeGreaterThan(0);
    expect(sample.mountedRows).toBeLessThan(300);
    expect(sample.windowingMisses).toBe(0);
    expect(sample.selectionMisses).toBe(0);
  });

  it("reports a windowing miss when a large list mounts every row", async () => {
    // The exact shape of the regression this instrument exists to catch: the
    // same 300 files, the same components, windowing off. A benchmark that
    // reported this as healthy would report a virtualizer that silently
    // stopped working as the fastest run in the table.
    const sample = await measureWorkingTreeList(300, false);
    expect(sample.mountedRows).toBe(300);
    expect(sample.windowingMisses).toBeGreaterThan(0);
    // The selection still lands — a regressed list is wrong, not broken — so
    // the windowing predicate is the only thing standing between that run and
    // a clean bill of health.
    expect(sample.selectionMisses).toBe(0);
  });
});
