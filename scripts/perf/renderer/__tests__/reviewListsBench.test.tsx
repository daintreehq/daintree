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

  it("windows the diff shelf and keeps the current file mounted", async () => {
    const sample = await measureDiffShelf(300);
    expect(sample.fileCount).toBe(300);
    expect(sample.mountedRows).toBeGreaterThan(0);
    expect(sample.mountedRows).toBeLessThan(300);
    expect(sample.windowingMisses).toBe(0);
    expect(sample.selectionMisses).toBe(0);
  });

  it("reports a windowing miss when every row is mounted", async () => {
    // A list that fits inside the viewport mounts every row, which is
    // indistinguishable — to this instrument — from a virtualizer that stopped
    // working. The predicate must call it either way, which is also why
    // PERF-247 only ever measures sizes far past the viewport.
    const sample = await measureWorkingTreeList(20);
    expect(sample.mountedRows).toBe(20);
    expect(sample.windowingMisses).toBeGreaterThan(0);
  });
});
