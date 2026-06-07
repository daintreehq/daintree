// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { McpAnomalySignal, McpAuditStats } from "@shared/types/ipc/mcpServer";

let mockCurrentProjectId: string | null = null;
const getAuditStatsMock = vi.fn<() => Promise<McpAuditStats>>();
const logWarnMock = vi.fn();
const notifyMock = vi.fn();

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: { currentProject: { id: string } | null }) => unknown) =>
    selector({
      currentProject: mockCurrentProjectId ? { id: mockCurrentProjectId } : null,
    }),
}));

vi.mock("@/utils/logger", () => ({
  logWarn: (...args: unknown[]) => logWarnMock(...args),
}));

// Guard the "never notifies" contract directly at the hook level too.
vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => notifyMock(...args),
}));

import { useMcpAnomalyStats } from "../useMcpAnomalyStats";
import { __resetMcpAnomalyStoreForTesting, useMcpAnomalyStore } from "@/store/mcpAnomalyStore";

function signalFixture(id: string): McpAnomalySignal {
  return {
    id,
    kind: "failure-cluster",
    toolId: "help.search",
    severity: "danger",
    timestamp: 1_000,
    recordIds: [id],
  };
}

function statsFixture(overrides: Partial<McpAuditStats> = {}): McpAuditStats {
  return {
    auth401Count: 0,
    anomalySignals: [],
    anomalySuppressed: false,
    anomalyRecordFloor: 50,
    ...overrides,
  };
}

beforeEach(() => {
  mockCurrentProjectId = "project-a";
  getAuditStatsMock.mockReset();
  getAuditStatsMock.mockResolvedValue(statsFixture());
  logWarnMock.mockReset();
  notifyMock.mockReset();
  __resetMcpAnomalyStoreForTesting();
  vi.stubGlobal("window", {
    ...globalThis.window,
    electron: { mcpServer: { getAuditStats: getAuditStatsMock } },
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useMcpAnomalyStats", () => {
  it("populates the store from an initial successful poll", async () => {
    getAuditStatsMock.mockResolvedValueOnce(statsFixture({ anomalySignals: [signalFixture("a")] }));
    renderHook(() => useMcpAnomalyStats());
    await act(async () => {
      await Promise.resolve();
    });
    expect(useMcpAnomalyStore.getState().hasAnomaly).toBe(true);
    expect(useMcpAnomalyStore.getState().anomalyCount).toBe(1);
  });

  it("never calls notify() for anomaly signals", async () => {
    getAuditStatsMock.mockResolvedValueOnce(statsFixture({ anomalySignals: [signalFixture("a")] }));
    renderHook(() => useMcpAnomalyStats());
    await act(async () => {
      await Promise.resolve();
    });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("resets the store immediately when the project changes", async () => {
    getAuditStatsMock.mockResolvedValueOnce(statsFixture({ anomalySignals: [signalFixture("a")] }));
    const { rerender } = renderHook(() => useMcpAnomalyStats());
    await act(async () => {
      await Promise.resolve();
    });
    expect(useMcpAnomalyStore.getState().hasAnomaly).toBe(true);

    // Switch projects; the new poll resolves with no anomalies, but the reset
    // must have already cleared the flag synchronously on the project change.
    mockCurrentProjectId = "project-b";
    getAuditStatsMock.mockResolvedValueOnce(statsFixture({ anomalySignals: [] }));
    rerender();
    expect(useMcpAnomalyStore.getState().hasAnomaly).toBe(false);
  });

  it("fails closed and warns when the IPC rejects", async () => {
    getAuditStatsMock.mockResolvedValueOnce(statsFixture({ anomalySignals: [signalFixture("a")] }));
    renderHook(() => useMcpAnomalyStats());
    await act(async () => {
      await Promise.resolve();
    });
    expect(useMcpAnomalyStore.getState().hasAnomaly).toBe(true);

    getAuditStatsMock.mockRejectedValueOnce(new Error("IPC down"));
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(useMcpAnomalyStore.getState().hasAnomaly).toBe(false);
    expect(logWarnMock).toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("discards a stale response that resolves after a project change", async () => {
    let resolveA: (v: McpAuditStats) => void = () => {};
    const pendingA = new Promise<McpAuditStats>((r) => {
      resolveA = r;
    });
    getAuditStatsMock.mockReturnValueOnce(pendingA);

    const { rerender } = renderHook(() => useMcpAnomalyStats());

    // Switch to project-b before A resolves; B reports no anomalies.
    mockCurrentProjectId = "project-b";
    getAuditStatsMock.mockResolvedValueOnce(statsFixture({ anomalySignals: [] }));
    rerender();
    await act(async () => {
      await Promise.resolve();
    });
    expect(useMcpAnomalyStore.getState().hasAnomaly).toBe(false);

    // A's stale response (with anomalies) must be discarded.
    await act(async () => {
      resolveA(statsFixture({ anomalySignals: [signalFixture("a")] }));
      await Promise.resolve();
    });
    expect(useMcpAnomalyStore.getState().hasAnomaly).toBe(false);
  });
});
