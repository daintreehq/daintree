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
    useProjectStatsStore.setState({ stats: {}, pushCount: 0 });
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
      "proj-1": {
        activeAgentCount: 2,
        waitingAgentCount: 1,
        blockedAgentCount: 0,
        completedAgentCount: 0,
        unacknowledgedCompletedAgentCount: 0,
        snoozedAgentCount: 0,
        processCount: 3,
      },
      "proj-2": {
        activeAgentCount: 0,
        waitingAgentCount: 0,
        blockedAgentCount: 0,
        completedAgentCount: 0,
        unacknowledgedCompletedAgentCount: 0,
        snoozedAgentCount: 0,
        processCount: 0,
      },
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

  describe("equal maps (#16418)", () => {
    const entry = (
      overrides: Partial<ProjectStatusMap[string]> = {}
    ): ProjectStatusMap[string] => ({
      activeAgentCount: 1,
      waitingAgentCount: 0,
      blockedAgentCount: 0,
      completedAgentCount: 0,
      unacknowledgedCompletedAgentCount: 0,
      snoozedAgentCount: 0,
      processCount: 1,
      ...overrides,
    });

    it("counts an equal push but keeps the map it already has", () => {
      setupProjectStatsListeners();
      capturedCallback!({ "proj-1": entry({ oldestWaitingSince: 5 }) });
      const before = useProjectStatsStore.getState().stats;

      // A replay arrives as a fresh object carrying the same counts.
      capturedCallback!({ "proj-1": entry({ oldestWaitingSince: 5 }) });

      expect(useProjectStatsStore.getState().stats).toBe(before);
      expect(useProjectStatsStore.getState().pushCount).toBe(2);
    });

    it("applies a push that changes a field, drops an optional field, or drops a project", () => {
      setupProjectStatsListeners();
      capturedCallback!({
        "proj-1": entry({ oldestWaitingSince: 5 }),
        "proj-2": entry(),
      });

      const changed = {
        "proj-1": entry({ oldestWaitingSince: 5, waitingAgentCount: 1 }),
        "proj-2": entry(),
      };
      capturedCallback!(changed);
      expect(useProjectStatsStore.getState().stats).toBe(changed);

      const withoutOptional = { "proj-1": entry({ waitingAgentCount: 1 }), "proj-2": entry() };
      capturedCallback!(withoutOptional);
      expect(useProjectStatsStore.getState().stats).toBe(withoutOptional);

      const withoutProject = { "proj-1": entry({ waitingAgentCount: 1 }) };
      capturedCallback!(withoutProject);
      expect(useProjectStatsStore.getState().stats).toBe(withoutProject);
      expect(useProjectStatsStore.getState().pushCount).toBe(4);
    });

    it("keeps the map on an equal write and takes a different one", () => {
      const first = { "proj-1": entry() };
      useProjectStatsStore.getState().setStats(first);
      expect(useProjectStatsStore.getState().stats).toBe(first);

      useProjectStatsStore.getState().setStats({ "proj-1": entry() });
      expect(useProjectStatsStore.getState().stats).toBe(first);

      const swapped = { "proj-2": entry() };
      useProjectStatsStore.getState().setStats(swapped);
      expect(useProjectStatsStore.getState().stats).toBe(swapped);
      // A write is not a push.
      expect(useProjectStatsStore.getState().pushCount).toBe(0);
    });
  });
});
