import { describe, expect, it } from "vitest";
import {
  classifyMetric,
  durationsComparable,
  describeIncomparability,
  isMachineIndependent,
} from "../lib/comparability";
import type { RunEnvironment } from "../types";

function env(overrides: Partial<RunEnvironment> = {}): RunEnvironment {
  return {
    machineLabel: "greg-macbook-darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    cpuModel: "Apple M3 Max",
    cpuCount: 16,
    totalMemoryMb: 65536,
    osRelease: "24.0.0",
    nodeVersion: "v22.13.0",
    ...overrides,
  };
}

describe("classifyMetric", () => {
  // Pinned against metric names actually emitted by scenarios in this repo.
  // The point of the table is that a future regex tweak cannot silently
  // reclassify a real metric — particularly not a duration into a
  // machine-independent class, which would license a false cross-machine claim.
  const REAL_DURATIONS = [
    "msPerKAction",
    "msPerKFile",
    "msPerKLine",
    "msPerTargetAt48",
    "applyMsN50",
    "coldMsPerKFile",
    "cpuMsPerAgentSec30",
    "cpuMsPerMb30",
    "cycleMsN1",
    "cycleMsN50",
    "drainMsLargeBacklog",
    "fanoutMs6",
    "fanoutMs48",
    "fleetCpuMs30",
    "latencyMsN20",
    "worstMs380",
    "perApplyUs",
    "perApplyUsN200",
    "alignedMs",
    "avgKeystrokeMs",
    "eventLoopLagP95Ms",
    "firstEmitMs",
    "floodEchoP99Ms",
    "fleetReparseMs",
    "waitFlipLatencyMs",
    "serializeMs",
    "totalMs",
  ];

  const REAL_COUNTS = [
    "gitSpawns",
    "agentCount",
    "batchCount",
    "frameCount",
    "fileCount",
    "changedFileCount",
    "changedLines",
    "bufferLines",
    "decorations",
    "hunks",
    "attempts",
    "callbacks",
    "keystrokes",
    "roundTrips",
    "statusPasses",
    "filesTokenized",
    "tokensProduced",
    "eligibleTargets",
    "totalPanels",
    "restoredPanels",
    "visibleGroups",
    "items",
  ];

  const REAL_RATIOS = [
    "detectionToIntervalRatio",
    "coldToWarmRatio",
    "eluUtilization",
    "echoDegradationX",
    "mapChangesPerApply",
    "notifiesPerApply",
    "spawnsPerWorktreeN50",
    "memoryGrowthPct",
  ];

  const REAL_MEMORY = ["heapDeltaMb", "memoryGrowthMb", "peakMemoryGrowthMb"];

  const REAL_SIZES = ["bytes", "fleetSnapshotKB"];

  it.each(REAL_DURATIONS)("classifies %s as duration", (name) => {
    expect(classifyMetric(name)).toBe("duration");
  });

  it.each(REAL_COUNTS)("classifies %s as count", (name) => {
    expect(classifyMetric(name)).toBe("count");
  });

  it.each(REAL_RATIOS)("classifies %s as ratio", (name) => {
    expect(classifyMetric(name)).toBe("ratio");
  });

  it.each(REAL_MEMORY)("classifies %s as memory", (name) => {
    expect(classifyMetric(name)).toBe("memory");
  });

  it.each(REAL_SIZES)("classifies %s as size", (name) => {
    expect(classifyMetric(name)).toBe("size");
  });

  it("never lets a time-valued metric become machine-independent", () => {
    // The specific regression this guards: an earlier suffix-only classifier
    // read `msPerKAction` as a count because it ends in "n", which would have
    // licensed comparing a latency figure between a Mac and a Windows laptop.
    for (const name of REAL_DURATIONS) {
      expect(isMachineIndependent(classifyMetric(name))).toBe(false);
    }
  });

  it("treats runtime memory as machine-dependent, unlike a payload size", () => {
    // Retained heap moves with GC timing, allocator and pointer width; a byte
    // length does not. Grouping them would license a false cross-OS claim.
    expect(isMachineIndependent(classifyMetric("heapDeltaMb"))).toBe(false);
    expect(isMachineIndependent(classifyMetric("bytes"))).toBe(true);
  });

  it("falls back to unknown, and unknown is not comparable", () => {
    expect(classifyMetric("wibble")).toBe("unknown");
    expect(isMachineIndependent("unknown")).toBe(false);
  });
});

describe("durationsComparable", () => {
  it("accepts the same machine", () => {
    expect(durationsComparable(env(), env())).toBe(true);
  });

  it("refuses two different machines", () => {
    const other = env({ machineLabel: "greg-win-laptop-win32-x64" });
    expect(durationsComparable(env(), other)).toBe(false);
    expect(describeIncomparability(env(), other)).toContain("different machines");
  });

  it("refuses two hosted CI runs, which are never the same VM", () => {
    // Regression guard for the label collapse: every hosted Ubuntu job used to
    // report "gh-linux-x64", so two unrelated runs compared as one machine.
    const runA = env({
      machineLabel: "gh-linux-x64-perf-ci-111.1",
      platform: "linux",
      arch: "x64",
    });
    const runB = env({
      machineLabel: "gh-linux-x64-perf-ci-222.1",
      platform: "linux",
      arch: "x64",
    });
    expect(durationsComparable(runA, runB)).toBe(false);
  });

  it("refuses a platform or architecture change on the same label", () => {
    expect(durationsComparable(env(), env({ platform: "win32" }))).toBe(false);
    expect(describeIncomparability(env(), env({ platform: "win32" }))).toContain("platforms");
    expect(durationsComparable(env(), env({ arch: "x64" }))).toBe(false);
    expect(describeIncomparability(env(), env({ arch: "x64" }))).toContain("architectures");
  });
});
