import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import type { PtyClient } from "../PtyClient.js";
import type { MemoryRollup } from "../../../shared/types/pty-host.js";

vi.mock("electron", () => ({
  app: {
    getAppMetrics: vi.fn(() => []),
  },
}));

import { app } from "electron";
import {
  composeMemorySnapshot,
  getCachedMemoryRollup,
  getCompositeMemorySnapshot,
  resetMemoryAccountingForTesting,
} from "../memoryAccounting.js";
import { resetAppMetricsSnapshotForTesting } from "../../utils/appMetricsSnapshot.js";
import { TERMINAL_WORKLOAD_STALE_MS } from "../../../shared/types/memoryAccounting.js";

const mockGetAppMetrics = app.getAppMetrics as Mock;

const NOW = 1_000_000;

function makeMetric(workingSetKb: number): Electron.ProcessMetric {
  return {
    pid: Math.floor(Math.random() * 10000),
    type: "Tab",
    creationTime: NOW,
    cpu: { percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
    memory: {
      workingSetSize: workingSetKb,
      peakWorkingSetSize: workingSetKb,
      privateBytes: 0,
    },
    sandboxed: false,
    integrityLevel: "untrusted",
  } as unknown as Electron.ProcessMetric;
}

function makeRollup(overrides?: Partial<MemoryRollup>): MemoryRollup {
  return {
    byProject: [
      {
        projectId: "proj-a",
        terminalCount: 2,
        processCount: 5,
        memoryKb: 512_000,
        topProcesses: [{ pid: 42, comm: "node", cpuPercent: 3.5, memoryKb: 200_000 }],
      },
    ],
    totalMemoryKb: 512_000,
    totalProcessCount: 5,
    terminalCount: 2,
    available: true,
    sampledAt: NOW - 2_000,
    ...overrides,
  };
}

describe("composeMemorySnapshot", () => {
  it("composes Electron metrics alone when no rollup source exists", () => {
    const snapshot = composeMemorySnapshot(
      [makeMetric(100 * 1024), makeMetric(50 * 1024)],
      NOW - 1_000,
      null,
      NOW
    );

    expect(snapshot.electron).toEqual({
      available: true,
      totalWorkingSetMb: 150,
      processCount: 2,
      sampledAt: NOW - 1_000,
    });
    expect(snapshot.terminalWorkloads).toEqual({
      available: false,
      stale: false,
      ageMs: null,
      sampledAt: 0,
      totalMemoryMb: 0,
      processCount: 0,
      terminalCount: 0,
      byProject: [],
    });
  });

  it("marks the Electron slice unavailable when the metrics sweep failed", () => {
    const snapshot = composeMemorySnapshot(null, 0, makeRollup(), NOW);
    expect(snapshot.electron.available).toBe(false);
    expect(snapshot.electron.totalWorkingSetMb).toBe(0);
    // The workload slice is independent — a metrics failure must not degrade it.
    expect(snapshot.terminalWorkloads.available).toBe(true);
    expect(snapshot.terminalWorkloads.totalMemoryMb).toBe(500);
  });

  it("preserves last-good workload values on an unavailable rollup instead of zeroing", () => {
    const snapshot = composeMemorySnapshot(
      [],
      NOW,
      makeRollup({ available: false, sampledAt: NOW - 40_000 }),
      NOW
    );

    expect(snapshot.terminalWorkloads.available).toBe(false);
    expect(snapshot.terminalWorkloads.stale).toBe(true);
    expect(snapshot.terminalWorkloads.ageMs).toBe(40_000);
    // The pty-host aggregates over its retained cache even when ps fails —
    // the numbers survive, explicitly flagged rather than dropped to 0.
    expect(snapshot.terminalWorkloads.totalMemoryMb).toBe(500);
    expect(snapshot.terminalWorkloads.byProject).toHaveLength(1);
  });

  it("passes very high terminal descendant memory through without clamping", () => {
    const snapshot = composeMemorySnapshot(
      [],
      NOW,
      makeRollup({ totalMemoryKb: 64 * 1024 * 1024, sampledAt: NOW - 1_000 }),
      NOW
    );
    expect(snapshot.terminalWorkloads.available).toBe(true);
    expect(snapshot.terminalWorkloads.stale).toBe(false);
    expect(snapshot.terminalWorkloads.totalMemoryMb).toBe(64 * 1024);
  });

  it("flags huge-but-stale process-tree data as stale while keeping the values", () => {
    const age = TERMINAL_WORKLOAD_STALE_MS + 5_000;
    const snapshot = composeMemorySnapshot(
      [],
      NOW,
      makeRollup({ totalMemoryKb: 32 * 1024 * 1024, sampledAt: NOW - age }),
      NOW
    );
    expect(snapshot.terminalWorkloads.available).toBe(true);
    expect(snapshot.terminalWorkloads.stale).toBe(true);
    expect(snapshot.terminalWorkloads.ageMs).toBe(age);
    expect(snapshot.terminalWorkloads.totalMemoryMb).toBe(32 * 1024);
  });

  it("reports a never-sampled rollup as ageless rather than infinitely stale", () => {
    const snapshot = composeMemorySnapshot([], NOW, makeRollup({ sampledAt: 0 }), NOW);
    expect(snapshot.terminalWorkloads.ageMs).toBeNull();
    expect(snapshot.terminalWorkloads.stale).toBe(false);
  });

  it("clamps a negative age (clock skew) to zero", () => {
    const snapshot = composeMemorySnapshot([], NOW, makeRollup({ sampledAt: NOW + 10_000 }), NOW);
    expect(snapshot.terminalWorkloads.ageMs).toBe(0);
    expect(snapshot.terminalWorkloads.stale).toBe(false);
  });

  it("maps per-project attribution to MB and keeps only process basenames", () => {
    const snapshot = composeMemorySnapshot([], NOW, makeRollup(), NOW);
    const project = snapshot.terminalWorkloads.byProject[0];
    expect(project).toEqual({
      projectId: "proj-a",
      terminalCount: 2,
      processCount: 5,
      memoryMb: 500,
      topProcesses: [{ pid: 42, comm: "node", cpuPercent: 3.5, memoryKb: 200_000 }],
    });
    expect(JSON.stringify(project)).not.toContain("command");
  });
});

describe("getCachedMemoryRollup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetMemoryAccountingForTesting();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makePtyClient(rollup: MemoryRollup): { client: PtyClient; fetch: Mock } {
    const fetch = vi.fn().mockResolvedValue(rollup);
    return { client: { getMemoryRollup: fetch } as unknown as PtyClient, fetch };
  }

  it("returns null without a PtyClient", async () => {
    await expect(getCachedMemoryRollup(null)).resolves.toBeNull();
  });

  it("serves repeat reads within the TTL from cache", async () => {
    const { client, fetch } = makePtyClient(makeRollup());
    await getCachedMemoryRollup(client);
    await getCachedMemoryRollup(client);
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + 6_000);
    await getCachedMemoryRollup(client);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent reads onto one in-flight request", async () => {
    const { client, fetch } = makePtyClient(makeRollup());
    const [a, b] = await Promise.all([
      getCachedMemoryRollup(client),
      getCachedMemoryRollup(client),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("treats a backwards clock as a stale cache", async () => {
    const { client, fetch } = makePtyClient(makeRollup());
    await getCachedMemoryRollup(client);
    vi.setSystemTime(NOW - 60_000);
    await getCachedMemoryRollup(client);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("getCompositeMemorySnapshot", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    resetMemoryAccountingForTesting();
    resetAppMetricsSnapshotForTesting();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("degrades the Electron slice when app.getAppMetrics throws", async () => {
    mockGetAppMetrics.mockImplementation(() => {
      throw new Error("metrics unavailable");
    });
    const client = {
      getMemoryRollup: vi.fn().mockResolvedValue(makeRollup({ sampledAt: NOW - 1_000 })),
    } as unknown as PtyClient;

    const snapshot = await getCompositeMemorySnapshot(client);
    expect(snapshot.electron.available).toBe(false);
    expect(snapshot.terminalWorkloads.available).toBe(true);
    expect(snapshot.terminalWorkloads.totalMemoryMb).toBe(500);
  });

  it("combines both slices with independent timestamps", async () => {
    mockGetAppMetrics.mockReturnValue([makeMetric(200 * 1024)]);
    const client = {
      getMemoryRollup: vi.fn().mockResolvedValue(makeRollup({ sampledAt: NOW - 3_000 })),
    } as unknown as PtyClient;

    const snapshot = await getCompositeMemorySnapshot(client);
    expect(snapshot.timestamp).toBe(NOW);
    expect(snapshot.electron).toMatchObject({
      available: true,
      totalWorkingSetMb: 200,
      sampledAt: NOW,
    });
    expect(snapshot.terminalWorkloads).toMatchObject({
      available: true,
      sampledAt: NOW - 3_000,
      ageMs: 3_000,
    });
  });
});
