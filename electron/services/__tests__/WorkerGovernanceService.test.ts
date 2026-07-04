import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerResourceSnapshot } from "../../../shared/types/workerGovernance.js";

const appMetricsMock = vi.hoisted(() => ({
  getAppMetricsSnapshot: vi.fn(
    (): Array<{ pid: number; memory: { workingSetSize: number } }> => []
  ),
}));
vi.mock("../../utils/appMetricsSnapshot.js", () => appMetricsMock);

vi.mock("../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import {
  GOVERNANCE_TRIM_COOLDOWN_MS,
  WorkerGovernanceService,
} from "../WorkerGovernanceService.js";

function snapshot(overrides: Partial<WorkerResourceSnapshot> = {}): WorkerResourceSnapshot {
  return {
    kind: "plugin-worker",
    id: "test-worker",
    pid: null,
    threadId: null,
    alive: true,
    activeSessionCount: 0,
    queueDepth: 0,
    lastActivityAt: null,
    memory: null,
    eligibility: { trim: false, dispose: false, restart: false },
    state: "running",
    ...overrides,
  };
}

describe("WorkerGovernanceService", () => {
  beforeEach(() => {
    appMetricsMock.getAppMetricsSnapshot.mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("collects from every provider and flattens the snapshots", async () => {
    const service = new WorkerGovernanceService();
    service.register({ name: "a", collect: () => [snapshot({ id: "a-1" })] });
    service.register({
      name: "b",
      collect: async () => [snapshot({ id: "b-1" }), snapshot({ id: "b-2" })],
    });

    const report = await service.collectReport();
    expect(report.subsystems.map((s) => s.id).sort()).toEqual(["a-1", "b-1", "b-2"]);
    expect(report.errors).toEqual([]);
  });

  it("isolates a throwing provider — others still report, the failure is recorded", async () => {
    const service = new WorkerGovernanceService();
    service.register({
      name: "broken",
      collect: () => {
        throw new Error("collect exploded");
      },
    });
    service.register({ name: "healthy", collect: () => [snapshot({ id: "ok" })] });

    const report = await service.collectReport();
    expect(report.subsystems.map((s) => s.id)).toEqual(["ok"]);
    expect(report.errors).toEqual([{ provider: "broken", error: "collect exploded" }]);
  });

  it("time-boxes a hung provider instead of wedging the report", async () => {
    const service = new WorkerGovernanceService();
    service.register({
      name: "hung",
      collect: () => new Promise<WorkerResourceSnapshot[]>(() => {}),
    });
    service.register({ name: "healthy", collect: () => [snapshot({ id: "ok" })] });

    const report = await service.collectReport(20);
    expect(report.subsystems.map((s) => s.id)).toEqual(["ok"]);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].provider).toBe("hung");
  });

  it("joins pid-bearing snapshots to app-metrics memory without overwriting subsystem-reported memory", async () => {
    appMetricsMock.getAppMetricsSnapshot.mockReturnValue([
      { pid: 100, memory: { workingSetSize: 2048 } },
      { pid: 200, memory: { workingSetSize: 512 } },
    ]);
    const service = new WorkerGovernanceService();
    service.register({
      name: "p",
      collect: () => [
        snapshot({ id: "joined", pid: 100 }),
        snapshot({ id: "already", pid: 200, memory: { rssBytes: 1 } }),
        snapshot({ id: "no-pid" }),
      ],
    });

    const report = await service.collectReport();
    const byId = new Map(report.subsystems.map((s) => [s.id, s]));
    expect(byId.get("joined")?.memory).toEqual({ rssBytes: 2048 * 1024 });
    expect(byId.get("already")?.memory).toEqual({ rssBytes: 1 });
    expect(byId.get("no-pid")?.memory).toBeNull();
  });

  it("fans trim out to every provider even when one throws synchronously", () => {
    const service = new WorkerGovernanceService();
    const trims: string[] = [];
    service.register({
      name: "first",
      collect: () => [],
      trim: () => {
        trims.push("first");
        throw new Error("trim exploded");
      },
    });
    service.register({
      name: "second",
      collect: () => [],
      trim: () => {
        trims.push("second");
      },
    });

    expect(service.requestEfficiencyTrim(1_000_000)).toBe(true);
    expect(trims).toEqual(["first", "second"]);
  });

  it("absorbs a rejecting async trim without unhandled rejection", async () => {
    const service = new WorkerGovernanceService();
    service.register({
      name: "rejecting",
      collect: () => [],
      trim: async () => {
        throw new Error("async trim failed");
      },
    });
    expect(service.requestEfficiencyTrim(1_000_000)).toBe(true);
    // Let the rejection settle through the isolation .catch.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("enforces the trim cooldown so profile flapping cannot churn workers", () => {
    const service = new WorkerGovernanceService();
    const trim = vi.fn();
    service.register({ name: "p", collect: () => [], trim });

    const t0 = 10_000_000;
    expect(service.requestEfficiencyTrim(t0)).toBe(true);
    expect(service.requestEfficiencyTrim(t0 + 1000)).toBe(false);
    expect(service.requestEfficiencyTrim(t0 + GOVERNANCE_TRIM_COOLDOWN_MS)).toBe(true);
    expect(trim).toHaveBeenCalledTimes(2);
  });

  it("summarizes queue depth and degraded subsystems for why-slow", async () => {
    const service = new WorkerGovernanceService();
    service.register({
      name: "p",
      collect: () => [
        snapshot({ id: "busy", queueDepth: 3 }),
        snapshot({ id: "pinned", state: "fallback-pinned", alive: false }),
        snapshot({ id: "down", state: "degraded" }),
      ],
    });

    const summary = service.summarize(await service.collectReport());
    expect(summary).toEqual({
      subsystemCount: 3,
      aliveWorkerCount: 2,
      totalQueueDepth: 3,
      degraded: ["pinned", "down"],
    });
  });
});
