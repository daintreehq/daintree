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
    electronVersion: "42.0.0",
    gitVersion: "2.45.2",
    sourceSha: "0dbb0b4",
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

  // Proportions between two deterministic quantities. Every one of these has a
  // proportional FORM and no runtime base, which is the half of the
  // derived-ratio conjunction that must not be enough on its own.
  const REAL_RATIOS = [
    "mapChangesPerApply",
    "notifiesPerApply",
    "spawnsPerWorktreeN50",
    "messagesPerKLine",
    "writeAmplificationRatio",
    // "load" lives inside "payload", so an unanchored base token would drag a
    // deterministic bytes-per-message figure into the machine-dependent group.
    "payloadBytesPerMessage",
  ];

  // Proportions whose numerator or denominator is itself a runtime measurement.
  // Normalising by a runtime number does not remove the machine, it changes the
  // units it is wrong in.
  const REAL_DERIVED_RATIOS = [
    "cpuPct",
    "memoryGrowthPct",
    "peakMemoryGrowthPct",
    "eluUtilization",
    "eventLoopUtilization",
    "echoDegradationX",
    // Both operands are measured durations. A speedup is more portable than
    // either duration alone, which is exactly what makes it tempting — but the
    // contract for `ratio` is that BOTH operands are machine-independent, and
    // cache hierarchy and core count make a 3.2x here a different number there.
    "batchSpeedupRatio",
    "indexSpeedupRatio",
    "readCacheSpeedupRatio",
    "drizzleOverheadRatio",
    "coldToWarmRatio",
    "largeToSmallBlockingRatio",
    "detectionToIntervalRatio",
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

  it.each(REAL_DERIVED_RATIOS)("classifies %s as derived-ratio", (name) => {
    expect(classifyMetric(name)).toBe("derived-ratio");
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

  it("keeps a runtime-derived proportion off the cross-machine table", () => {
    // The defect this class exists for: every `Pct` and `Utilization` used to
    // classify as `ratio`, which licensed reading "Windows event-loop
    // utilization 41%, macOS 12%" as a statement about the code.
    for (const name of REAL_DERIVED_RATIOS) {
      expect(isMachineIndependent(classifyMetric(name))).toBe(false);
    }
    expect(isMachineIndependent("derived-ratio")).toBe(false);
  });

  it("needs BOTH halves of the conjunction before calling a number derived", () => {
    // A runtime base alone is not a proportion: a heap delta is a reading.
    expect(classifyMetric("heapDeltaMb")).toBe("memory");
    // A proportional form alone is not machine-dependent: this divides one
    // tally by another and carries no machine at all.
    expect(classifyMetric("spawnsPerWorktreeN50")).toBe("ratio");
    // And one word carries both halves by itself.
    expect(classifyMetric("eventLoopUtilization")).toBe("derived-ratio");
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

describe("bystander metric classification", () => {
  /**
   * `lib/bystander.ts` emits blocked-time percentages, and a percentage over a
   * runtime base is machine-dependent no matter how portable it looks. Without a
   * base token these fell through to structural `ratio` and were marked "compare
   * freely" — so "Windows 60% blocked, macOS 12%" would have been presented as a
   * portable finding about the code rather than about two machines.
   */
  it("treats blocked-time percentages as machine-dependent", () => {
    for (const name of [
      "loadBlockedPct",
      "idleBlockedPct",
      "inThreadBlockedPct",
      "workerBlockedPct",
    ]) {
      expect(classifyMetric(name)).toBe("derived-ratio");
      expect(isMachineIndependent(classifyMetric(name))).toBe(false);
    }
  });

  it("keeps the stall readings themselves as durations", () => {
    for (const name of [
      "loadLongestStallMs",
      "loadBlockedMs",
      "excessLongestStallMs",
      "stallReductionMs",
      "blockedReductionMs",
    ]) {
      expect(classifyMetric(name)).toBe("duration");
    }
  });

  it("catches the lowercase-leading spellings too", () => {
    // The base tokens are `[Bb]locked` and `[Ss]tall`, matched anywhere, so a
    // metric named without a camelCase prefix classifies the same way. Pinned
    // because a reviewer read the pattern as requiring a preceding lowercase
    // character — as `[a-z0-9]Load([A-Z0-9]|$)` genuinely does — and a
    // false negative here silently grants a runtime percentage a cross-machine
    // comparison.
    expect(classifyMetric("blockedPct")).toBe("derived-ratio");
    expect(classifyMetric("stallFraction")).toBe("derived-ratio");
    expect(classifyMetric("stalledPercent")).toBe("derived-ratio");
  });

  it("does not grant the new base tokens a free ride to any percentage", () => {
    // The base group is a CONJUNCTION with a proportional form. A base alone
    // must not turn a plain reading into a derived ratio, or `blockedMs` would
    // stop being a duration.
    expect(classifyMetric("blockedMs")).toBe("duration");
    expect(classifyMetric("stalledWriteCount")).toBe("count");
    // And an unrelated percentage keeps its structural comparison.
    expect(classifyMetric("hiddenFilePct")).toBe("ratio");
  });
});
