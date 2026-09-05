/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";

/**
 * PERF-247's measurement pass. Skipped unless `DAINTREE_PERF_OUT` names a file
 * to write, which is how the scenario in `scenarios/panels.ts` drives it — an
 * ordinary `npm test` must not pay for a 2,000-row mount, four times over.
 *
 * Both arms run in ONE process so the before/after table the issue asks for is
 * same-machine, same-session by construction rather than by discipline. The
 * "before" arm is the static path the components still ship for small lists —
 * byte-identical to what they did before this change, which is why the existing
 * suites needed no edits.
 */
const flags = vi.hoisted(() => ({ windowing: true }));

vi.mock("@/lib/fileListWindowing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fileListWindowing")>();
  return {
    ...actual,
    shouldVirtualizeFileList: (count: number) =>
      flags.windowing && actual.shouldVirtualizeFileList(count),
  };
});

const { measureDiffShelf, measureWorkingTreeList, toMetrics } = await import("../reviewListsBench");

/** PERF-245's changeset, to the file. The issue's "~420" is 423 in the fixture. */
const REPRESENTATIVE = 423;
/** The scaling arm the issue's landing gate is stated against. */
const LARGE = 2000;

const outPath = process.env.DAINTREE_PERF_OUT;

describe.skipIf(!outPath)("PERF-247 measurement", () => {
  it("measures both list surfaces windowed and unwindowed", async () => {
    const metrics: Record<string, number> = {};

    for (const windowing of [false, true]) {
      flags.windowing = windowing;
      const arm = windowing ? "windowed" : "static";
      for (const [label, count] of [
        ["420", REPRESENTATIVE],
        ["2000", LARGE],
      ] as const) {
        Object.assign(
          metrics,
          toMetrics(`${arm}WorkingTree${label}`, await measureWorkingTreeList(count, windowing)),
          toMetrics(`${arm}Shelf${label}`, await measureDiffShelf(count))
        );
      }
    }
    flags.windowing = true;

    // The instrument's own negative control. If the static arm did NOT report
    // windowing misses, the mock above is not reaching the components and both
    // arms are measuring the same thing — which would make every comparison
    // below a comparison of noise.
    expect(metrics.staticWorkingTree2000WindowingMisses).toBeGreaterThan(0);
    expect(metrics.staticShelf2000WindowingMisses).toBeGreaterThan(0);
    expect(metrics.windowedWorkingTree2000WindowingMisses).toBe(0);
    expect(metrics.windowedShelf2000WindowingMisses).toBe(0);

    writeFileSync(outPath as string, JSON.stringify(metrics, null, 2));
  }, 180_000);
});
