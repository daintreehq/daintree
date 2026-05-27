// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/clients/filesClient", () => ({
  filesClient: {
    read: vi.fn(),
  },
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
}));

import { filesClient } from "@/clients/filesClient";
import { ClientAppError } from "@/utils/clientAppError";
import { usePerfMetricsStore, resetPerfMetricsForTests, type PerfMode } from "../perfMetricsStore";

const mockRead = filesClient.read as ReturnType<typeof vi.fn>;

function makeSummary(
  mode: PerfMode,
  aggregates: Array<{
    id: string;
    name: string;
    p95Ms: number;
    failedBudget: boolean;
    budgetReason?: string;
  }>
) {
  return JSON.stringify({
    generatedAt: "2026-05-27T00:00:00.000Z",
    mode,
    nodeVersion: "v22.0.0",
    platform: "darwin",
    scenarioCount: aggregates.length,
    failedScenarios: aggregates.filter((a) => a.failedBudget).map((a) => a.id),
    aggregates: aggregates.map((a) => ({
      id: a.id,
      name: a.name,
      description: "",
      tier: "fast",
      runs: 5,
      p50Ms: a.p95Ms * 0.6,
      p95Ms: a.p95Ms,
      p99Ms: a.p95Ms * 1.1,
      maxMs: a.p95Ms * 1.2,
      meanMs: a.p95Ms * 0.7,
      stdDevMs: 1,
      metricAverages: {},
      failedBudget: a.failedBudget,
      budgetReason: a.budgetReason,
      notes: [],
    })),
  });
}

describe("perfMetricsStore refreshSummaries", () => {
  beforeEach(() => {
    mockRead.mockReset();
    resetPerfMetricsForTests();
  });

  afterEach(() => {
    resetPerfMetricsForTests();
  });

  it("reads all 4 mode files and flattens aggregates", async () => {
    mockRead.mockImplementation(async ({ path }: { path: string }) => {
      if (path.endsWith("latest-smoke.summary.json")) {
        return {
          content: makeSummary("smoke", [
            { id: "boot", name: "Boot", p95Ms: 100, failedBudget: false },
          ]),
        };
      }
      if (path.endsWith("latest-ci.summary.json")) {
        return {
          content: makeSummary("ci", [
            { id: "boot", name: "Boot", p95Ms: 220, failedBudget: true, budgetReason: "Over p95" },
            { id: "render", name: "Render", p95Ms: 30, failedBudget: false },
          ]),
        };
      }
      throw new ClientAppError("NOT_FOUND", "file missing");
    });

    await usePerfMetricsStore.getState().refreshSummaries("/project");

    const state = usePerfMetricsStore.getState();
    expect(state.summaryRows.length).toBe(3);
    expect(state.failedBudgetCount).toBe(1);
    expect(state.isLoadingSummaries).toBe(false);
    expect(state.summaryLoadError).toBeNull();
    expect(state.lastLoadedAt).not.toBeNull();
    expect(mockRead).toHaveBeenCalledTimes(4);
  });

  it("silently skips missing files (NOT_FOUND)", async () => {
    mockRead.mockRejectedValue(new ClientAppError("NOT_FOUND", "file missing"));

    await usePerfMetricsStore.getState().refreshSummaries("/project");

    const state = usePerfMetricsStore.getState();
    expect(state.summaryRows).toEqual([]);
    expect(state.failedBudgetCount).toBe(0);
    expect(state.summaryLoadError).toBeNull();
  });

  it("sets summaryLoadError when read fails with a non-NOT_FOUND code", async () => {
    mockRead.mockRejectedValue(new ClientAppError("PERMISSION", "no access"));

    await usePerfMetricsStore.getState().refreshSummaries("/project");

    const state = usePerfMetricsStore.getState();
    expect(state.summaryLoadError).not.toBeNull();
    expect(state.isLoadingSummaries).toBe(false);
  });

  it("derives failedBudgetCount from loaded aggregates", async () => {
    mockRead.mockImplementation(async ({ path }: { path: string }) => {
      if (path.endsWith("latest-ci.summary.json")) {
        return {
          content: makeSummary("ci", [
            { id: "a", name: "A", p95Ms: 100, failedBudget: true },
            { id: "b", name: "B", p95Ms: 200, failedBudget: true },
            { id: "c", name: "C", p95Ms: 50, failedBudget: false },
          ]),
        };
      }
      throw new ClientAppError("NOT_FOUND", "file missing");
    });

    await usePerfMetricsStore.getState().refreshSummaries("/project");

    expect(usePerfMetricsStore.getState().failedBudgetCount).toBe(2);
  });

  it("replaces stale rows on repeated refresh", async () => {
    mockRead.mockResolvedValueOnce({
      content: makeSummary("ci", [{ id: "x", name: "X", p95Ms: 100, failedBudget: true }]),
    });
    mockRead.mockRejectedValue(new ClientAppError("NOT_FOUND", "file missing"));

    await usePerfMetricsStore.getState().refreshSummaries("/project");
    expect(usePerfMetricsStore.getState().summaryRows.length).toBe(1);

    mockRead.mockReset();
    mockRead.mockResolvedValueOnce({
      content: makeSummary("ci", [
        { id: "y", name: "Y", p95Ms: 50, failedBudget: false },
        { id: "z", name: "Z", p95Ms: 70, failedBudget: false },
      ]),
    });
    mockRead.mockRejectedValue(new ClientAppError("NOT_FOUND", "file missing"));

    await usePerfMetricsStore.getState().refreshSummaries("/project");
    const state = usePerfMetricsStore.getState();
    expect(state.summaryRows.length).toBe(2);
    expect(state.summaryRows.map((r) => r.scenarioId).sort()).toEqual(["y", "z"]);
    expect(state.failedBudgetCount).toBe(0);
  });

  it("ignores stale results when a newer refresh starts first", async () => {
    let resolveFirst!: (value: { content: string }) => void;
    const firstCall = new Promise<{ content: string }>((res) => {
      resolveFirst = res;
    });

    mockRead.mockReturnValueOnce(firstCall);
    mockRead.mockReturnValueOnce(firstCall);
    mockRead.mockReturnValueOnce(firstCall);
    mockRead.mockReturnValueOnce(firstCall);

    const firstPromise = usePerfMetricsStore.getState().refreshSummaries("/project");

    mockRead.mockReset();
    mockRead.mockResolvedValue({
      content: makeSummary("ci", [{ id: "new", name: "New", p95Ms: 80, failedBudget: false }]),
    });

    await usePerfMetricsStore.getState().refreshSummaries("/project");
    expect(usePerfMetricsStore.getState().summaryRows.length).toBe(4); // 4 mode reads × 1 row each

    resolveFirst({
      content: makeSummary("smoke", [
        { id: "stale", name: "Stale", p95Ms: 999, failedBudget: true },
      ]),
    });
    await firstPromise;

    const state = usePerfMetricsStore.getState();
    expect(state.summaryRows.some((r) => r.scenarioId === "stale")).toBe(false);
  });

  it("clearSummaries empties summary rows and resets count", async () => {
    mockRead.mockResolvedValue({
      content: makeSummary("ci", [{ id: "x", name: "X", p95Ms: 100, failedBudget: true }]),
    });
    await usePerfMetricsStore.getState().refreshSummaries("/project");
    expect(usePerfMetricsStore.getState().summaryRows.length).toBe(4);

    usePerfMetricsStore.getState().clearSummaries();
    const state = usePerfMetricsStore.getState();
    expect(state.summaryRows).toEqual([]);
    expect(state.failedBudgetCount).toBe(0);
    expect(state.lastLoadedAt).toBeNull();
  });

  it("treats empty projectRoot as a clear", async () => {
    mockRead.mockResolvedValue({
      content: makeSummary("ci", [{ id: "x", name: "X", p95Ms: 100, failedBudget: true }]),
    });
    await usePerfMetricsStore.getState().refreshSummaries("/project");
    expect(usePerfMetricsStore.getState().summaryRows.length).toBeGreaterThan(0);

    await usePerfMetricsStore.getState().refreshSummaries("");
    const state = usePerfMetricsStore.getState();
    expect(state.summaryRows).toEqual([]);
    expect(state.failedBudgetCount).toBe(0);
    expect(mockRead).toHaveBeenCalledTimes(4);
  });
});
