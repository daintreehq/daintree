import { describe, expect, it } from "vitest";

import { allScenarios } from "../scenarios";
import {
  CENSUS_POLL_INTERVAL_MS,
  CENSUS_WINDOW_READS,
  cpuTicksForPid,
  gradeCpuTicks,
  gradeSnapshot,
  nearestRankPercentile,
  parseBaselineResponse,
  ticksToMs,
  windowsCensusScenarios,
} from "../scenarios/windowsCensus";

/**
 * PERF-409 itself can only run on Windows, and this repo's push/PR CI is Ubuntu
 * only — so the scenario's driving loop is never exercised by an automated run.
 * Its parsing, percentile and oracle logic live as pure functions precisely so
 * that much IS covered everywhere, which is the difference between a benchmark
 * with an untested edge and a benchmark that is untested.
 */
describe("PERF-409 apparatus", () => {
  describe("nearestRankPercentile", () => {
    it("returns a value the sample actually contains", () => {
      const values = [10, 20, 30, 40, 50];
      expect(values).toContain(nearestRankPercentile(values, 0.95));
    });

    it("puts p95 at the top of a 40-sample window", () => {
      const values = Array.from({ length: 40 }, (_, i) => i + 1);
      expect(nearestRankPercentile(values, 0.95)).toBe(38);
    });

    it("is order-independent", () => {
      expect(nearestRankPercentile([50, 10, 30, 20, 40], 0.5)).toBe(
        nearestRankPercentile([10, 20, 30, 40, 50], 0.5)
      );
    });

    it("reports 0 for an empty sample rather than NaN", () => {
      expect(nearestRankPercentile([], 0.95)).toBe(0);
    });

    it("handles a single sample at both ends", () => {
      expect(nearestRankPercentile([7], 0)).toBe(7);
      expect(nearestRankPercentile([7], 1)).toBe(7);
    });
  });

  describe("cpuTicksForPid", () => {
    const rows = [
      { ProcessId: 100, KernelModeTime: "1000000", UserModeTime: "2000000" },
      { ProcessId: 200, KernelModeTime: "0", UserModeTime: "0" },
    ];

    it("sums kernel and user ticks", () => {
      expect(cpuTicksForPid(rows, 100)).toBe(3_000_000n);
    });

    it("keeps UInt64 precision that Number would lose", () => {
      // The counters really are 64-bit; the census carries them as strings for
      // this reason and a Number round-trip would quietly round them.
      const wide = [{ ProcessId: 1, KernelModeTime: "9007199254740993", UserModeTime: "0" }];
      expect(cpuTicksForPid(wide, 1)).toBe(9007199254740993n);
    });

    it("returns null for a PID the census did not contain", () => {
      expect(cpuTicksForPid(rows, 999)).toBeNull();
    });

    it("returns null rather than throwing on an unparseable counter", () => {
      expect(cpuTicksForPid([{ ProcessId: 1, KernelModeTime: "n/a" }], 1)).toBeNull();
    });

    it("treats a missing counter as zero", () => {
      expect(cpuTicksForPid([{ ProcessId: 1 }], 1)).toBe(0n);
    });
  });

  it("converts 100ns ticks to milliseconds", () => {
    expect(ticksToMs(10_000n)).toBe(1);
    expect(ticksToMs(0n)).toBe(0);
  });

  describe("parseBaselineResponse", () => {
    it("splits the census payload from the CPU self-report", () => {
      const parsed = parseBaselineResponse('[{"ProcessId":1}]\nCPUMS:123.5\n');
      expect(parsed.rows).toEqual([{ ProcessId: 1 }]);
      expect(parsed.cpuMs).toBe(123.5);
    });

    it("wraps a single-object payload into an array", () => {
      // ConvertTo-Json emits a bare object when the machine has exactly one
      // matching process, which is the shape the cache also has to handle.
      expect(parseBaselineResponse('{"ProcessId":1}\nCPUMS:1').rows).toEqual([{ ProcessId: 1 }]);
    });

    it("tolerates a leading BOM", () => {
      expect(parseBaselineResponse('\uFEFF[{"ProcessId":1}]\nCPUMS:1').rows).toHaveLength(1);
    });

    it("reports no rows for an empty or null census", () => {
      expect(parseBaselineResponse("CPUMS:5").rows).toEqual([]);
      expect(parseBaselineResponse("null\nCPUMS:5").rows).toEqual([]);
      expect(parseBaselineResponse("null\nCPUMS:5").cpuMs).toBe(5);
    });

    it("reports zero CPU when the self-report is missing or unparseable", () => {
      expect(parseBaselineResponse("[]").cpuMs).toBe(0);
      expect(parseBaselineResponse("[]\nCPUMS:nope").cpuMs).toBe(0);
    });
  });

  describe("gradeSnapshot", () => {
    const expected = [
      { pid: 10, ppid: 1 },
      { pid: 11, ppid: 1 },
    ];

    it("reports zero misses when every child is present under the right parent", () => {
      const reading = gradeSnapshot((pid) => (pid === 10 || pid === 11 ? { ppid: 1 } : undefined), expected);
      expect(reading).toEqual({ fixtureDiscoveryMisses: 0, fixtureParentMisses: 0 });
    });

    it("counts a child the census never reported", () => {
      const reading = gradeSnapshot((pid) => (pid === 10 ? { ppid: 1 } : undefined), expected);
      expect(reading.fixtureDiscoveryMisses).toBe(1);
      // A missing child is not also a parent miss — the two readings answer
      // different questions and must not double-count.
      expect(reading.fixtureParentMisses).toBe(0);
    });

    it("counts a child reparented away from the fixture", () => {
      const reading = gradeSnapshot(() => ({ ppid: 999 }), expected);
      expect(reading).toEqual({ fixtureDiscoveryMisses: 0, fixtureParentMisses: 2 });
    });

    it("scores a dead census as every miss it can, never as a clean run", () => {
      // The failure this predicate exists for: a census that stopped starts
      // nothing and would otherwise post the best number in the suite.
      const reading = gradeSnapshot(() => undefined, expected);
      expect(reading.fixtureDiscoveryMisses).toBe(expected.length);
    });
  });

  describe("gradeCpuTicks", () => {
    const expected = [{ pid: 10, ppid: 1 }];

    it("passes a child with CPU time against it", () => {
      expect(gradeCpuTicks([{ ProcessId: 10, KernelModeTime: "1", UserModeTime: "1" }], expected)).toBe(0);
    });

    it("counts a child the census reported no CPU for", () => {
      expect(gradeCpuTicks([{ ProcessId: 10, KernelModeTime: "0", UserModeTime: "0" }], expected)).toBe(1);
    });

    it("counts a child missing from the payload entirely", () => {
      expect(gradeCpuTicks([], expected)).toBe(1);
    });
  });

  describe("registration", () => {
    it("declares itself Windows-only", () => {
      const [scenario] = windowsCensusScenarios;
      expect(scenario.platforms).toEqual({
        linux: "unsupported",
        darwin: "unsupported",
        win32: "supported",
      });
    });

    it("is in the matrix exactly once", () => {
      expect(allScenarios.filter((s) => s.id === "PERF-409")).toHaveLength(1);
    });

    it("keeps every correctness term a metric the run actually emits", () => {
      // A declared term the run never emits aggregates to nothing, which reads
      // as a pass. The scenario's own failure path names all of them, so it is
      // the cheapest place to check the two lists agree.
      const [scenario] = windowsCensusScenarios;
      expect(scenario.correctness).toContain("spawnObserverMisses");
      expect(scenario.correctness).toContain("censusLivenessMisses");
      expect(scenario.correctness).toContain("helperReuseMisses");
      expect(scenario.correctness).toContain("baselineFidelityMisses");
      expect(scenario.correctness).toContain("fixtureDiscoveryMisses");
      expect(scenario.correctness).toContain("fixtureParentMisses");
      expect(scenario.correctness).toContain("fixtureCpuMisses");
    });

    it("drives the pty-host's own cadence for a 60s window", () => {
      expect(CENSUS_POLL_INTERVAL_MS).toBe(1_500);
      expect(CENSUS_WINDOW_READS * CENSUS_POLL_INTERVAL_MS).toBe(60_000);
    });
  });
});
