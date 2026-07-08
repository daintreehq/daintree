import { describe, expect, it } from "vitest";
import { mergeFlowControlSnapshots, mergeMemoryRollups } from "../rollupMerge.js";
import type {
  FlowControlSnapshot,
  MemoryRollup,
  TerminalResourceProcess,
} from "../../../../shared/types/pty-host.js";

function makeProcess(overrides: Partial<TerminalResourceProcess> = {}): TerminalResourceProcess {
  return { pid: 1, comm: "node", cpuPercent: 0, memoryKb: 100, ...overrides };
}

function makeRollup(overrides: Partial<MemoryRollup> = {}): MemoryRollup {
  return {
    byProject: [],
    totalMemoryKb: 0,
    totalProcessCount: 0,
    terminalCount: 0,
    available: true,
    sampledAt: 1000,
    ...overrides,
  };
}

function makeFlowControlSnapshot(
  overrides: Partial<FlowControlSnapshot> = {}
): FlowControlSnapshot {
  return {
    timestamp: 1000,
    terminals: [],
    queueDepth: [],
    totalPendingBytes: 0,
    stats: { pauseCount: 0, resumeCount: 0, suspendCount: 0, forceResumeCount: 0 },
    resourceGovernor: {
      isThrottling: false,
      isWarning: false,
      activeProfile: "balanced",
      smoothedUtilizationPercent: null,
      throttleDurationMs: 0,
    },
    eventLoop: null,
    ...overrides,
  };
}

describe("mergeMemoryRollups", () => {
  it("sums per-project rows that appear on only one shard", () => {
    const merged = mergeMemoryRollups([
      makeRollup({
        byProject: [
          {
            projectId: "a",
            terminalCount: 1,
            processCount: 2,
            memoryKb: 500,
            topProcesses: [makeProcess({ memoryKb: 500 })],
          },
        ],
        totalMemoryKb: 500,
        totalProcessCount: 2,
        terminalCount: 1,
        sampledAt: 100,
      }),
      makeRollup({
        byProject: [
          {
            projectId: "b",
            terminalCount: 1,
            processCount: 1,
            memoryKb: 300,
            topProcesses: [makeProcess({ memoryKb: 300 })],
          },
        ],
        totalMemoryKb: 300,
        totalProcessCount: 1,
        terminalCount: 1,
        sampledAt: 200,
      }),
    ]);

    expect(merged.byProject).toHaveLength(2);
    expect(merged.totalMemoryKb).toBe(800);
    expect(merged.totalProcessCount).toBe(3);
    expect(merged.terminalCount).toBe(2);
    // Newest sample wins for the merged timestamp.
    expect(merged.sampledAt).toBe(200);
  });

  it("merges duplicate project rows across shards and keeps only the top 5 processes", () => {
    const bigProcesses = Array.from({ length: 4 }, (_, i) =>
      makeProcess({ pid: i + 1, memoryKb: 1000 + i })
    );
    const merged = mergeMemoryRollups([
      makeRollup({
        byProject: [
          {
            projectId: "shared",
            terminalCount: 1,
            processCount: 4,
            memoryKb: 4006,
            topProcesses: bigProcesses,
          },
        ],
      }),
      makeRollup({
        byProject: [
          {
            projectId: "shared",
            terminalCount: 1,
            processCount: 2,
            memoryKb: 300,
            topProcesses: [
              makeProcess({ pid: 5, memoryKb: 200 }),
              makeProcess({ pid: 6, memoryKb: 100 }),
            ],
          },
        ],
      }),
    ]);

    expect(merged.byProject).toHaveLength(1);
    const row = merged.byProject[0];
    expect(row.terminalCount).toBe(2);
    expect(row.processCount).toBe(6);
    expect(row.memoryKb).toBe(4306);
    // 6 candidate processes total, capped at the top 5 by memory.
    expect(row.topProcesses).toHaveLength(5);
    expect(row.topProcesses[0].memoryKb).toBe(1003);
  });

  it("marks the merged rollup unavailable when any shard's rollup was unavailable", () => {
    const merged = mergeMemoryRollups([
      makeRollup({ available: true }),
      makeRollup({ available: false }),
    ]);
    expect(merged.available).toBe(false);
  });
});

describe("mergeFlowControlSnapshots", () => {
  it("concatenates terminal/queue arrays and sums the backpressure counters", () => {
    const merged = mergeFlowControlSnapshots([
      {
        shardKey: "main",
        snapshot: makeFlowControlSnapshot({
          terminals: [
            {
              terminalId: "t1",
              flowStatus: null,
              heldTokens: [],
              isSuspended: false,
              activityTier: "active",
              pausedDurationMs: null,
              droppedBytes: 0,
              dropCount: 0,
              lastDropAt: null,
            },
          ],
          stats: { pauseCount: 1, resumeCount: 2, suspendCount: 0, forceResumeCount: 0 },
          totalPendingBytes: 10,
        }),
      },
      {
        shardKey: "proj-a",
        snapshot: makeFlowControlSnapshot({
          stats: { pauseCount: 3, resumeCount: 1, suspendCount: 1, forceResumeCount: 2 },
          totalPendingBytes: 20,
        }),
      },
    ]);

    expect(merged.terminals).toHaveLength(1);
    expect(merged.totalPendingBytes).toBe(30);
    expect(merged.stats).toEqual({
      pauseCount: 4,
      resumeCount: 3,
      suspendCount: 1,
      forceResumeCount: 2,
    });
    expect(merged.shards).toHaveLength(2);
    expect(merged.shards?.map((s) => s.shardKey)).toEqual(["main", "proj-a"]);
  });

  it("carries the worst (highest p99) event-loop reading across shards", () => {
    const merged = mergeFlowControlSnapshots([
      {
        shardKey: "main",
        snapshot: makeFlowControlSnapshot({
          eventLoop: { p50Ms: 1, p95Ms: 2, p99Ms: 5, maxMs: 10, sampleCount: 100 },
        }),
      },
      {
        shardKey: "proj-a",
        snapshot: makeFlowControlSnapshot({
          eventLoop: { p50Ms: 1, p95Ms: 2, p99Ms: 40, maxMs: 50, sampleCount: 100 },
        }),
      },
    ]);

    expect(merged.eventLoop?.p99Ms).toBe(40);
  });

  it("treats a null event loop on every shard as null overall, never crashing on empty input", () => {
    const merged = mergeFlowControlSnapshots([
      { shardKey: "main", snapshot: makeFlowControlSnapshot({ eventLoop: null }) },
    ]);
    expect(merged.eventLoop).toBeNull();
  });

  it("resolves throttling/warning as true if any shard reports true", () => {
    const merged = mergeFlowControlSnapshots([
      {
        shardKey: "main",
        snapshot: makeFlowControlSnapshot({
          resourceGovernor: {
            isThrottling: false,
            isWarning: false,
            activeProfile: "balanced",
            smoothedUtilizationPercent: null,
            throttleDurationMs: 0,
          },
        }),
      },
      {
        shardKey: "proj-a",
        snapshot: makeFlowControlSnapshot({
          resourceGovernor: {
            isThrottling: true,
            isWarning: true,
            activeProfile: "performance",
            smoothedUtilizationPercent: 80,
            throttleDurationMs: 500,
          },
        }),
      },
    ]);

    expect(merged.resourceGovernor.isThrottling).toBe(true);
    expect(merged.resourceGovernor.isWarning).toBe(true);
    expect(merged.resourceGovernor.smoothedUtilizationPercent).toBe(80);
    expect(merged.resourceGovernor.throttleDurationMs).toBe(500);
  });
});
