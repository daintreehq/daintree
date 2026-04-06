// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectStatusMap } from "@shared/types/ipc/project";

type StatsCallback = (stats: ProjectStatusMap) => void;

let capturedCallback: StatsCallback | null = null;
const unsubMock = vi.fn();
const onStatsUpdatedMock = vi.fn((cb: StatsCallback) => {
  capturedCallback = cb;
  return unsubMock;
});

vi.stubGlobal("window", {
  electron: {
    project: {
      onStatsUpdated: onStatsUpdatedMock,
    },
  },
});

const { useProjectStatsStore, setupProjectStatsListeners, cleanupProjectStatsListeners } =
  await import("../projectStatsStore");

describe("projectStatsStore", () => {
  beforeEach(() => {
    cleanupProjectStatsListeners();
    useProjectStatsStore.setState({ stats: {} });
    vi.clearAllMocks();
    capturedCallback = null;
  });

  afterEach(() => {
    cleanupProjectStatsListeners();
  });

  it("subscribes to onStatsUpdated and updates store", () => {
    setupProjectStatsListeners();
    expect(onStatsUpdatedMock).toHaveBeenCalledOnce();

    const payload: ProjectStatusMap = {
      "proj-1": { activeAgentCount: 2, waitingAgentCount: 1, processCount: 3 },
      "proj-2": { activeAgentCount: 0, waitingAgentCount: 0, processCount: 0 },
    };

    capturedCallback!(payload);
    expect(useProjectStatsStore.getState().stats).toEqual(payload);
  });

  it("is idempotent — double setup registers only once", () => {
    setupProjectStatsListeners();
    setupProjectStatsListeners();
    expect(onStatsUpdatedMock).toHaveBeenCalledOnce();
  });

  it("cleanup unsubscribes and allows re-setup", () => {
    setupProjectStatsListeners();
    cleanupProjectStatsListeners();
    expect(unsubMock).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    setupProjectStatsListeners();
    expect(onStatsUpdatedMock).toHaveBeenCalledOnce();
  });

  it("setStats replaces the entire stats map", () => {
    const first: ProjectStatusMap = {
      a: { activeAgentCount: 1, waitingAgentCount: 0, processCount: 1 },
    };
    const second: ProjectStatusMap = {
      b: { activeAgentCount: 0, waitingAgentCount: 2, processCount: 4 },
    };

    useProjectStatsStore.getState().setStats(first);
    expect(useProjectStatsStore.getState().stats).toEqual(first);

    useProjectStatsStore.getState().setStats(second);
    expect(useProjectStatsStore.getState().stats).toEqual(second);
    expect(useProjectStatsStore.getState().stats["a"]).toBeUndefined();
  });
});
