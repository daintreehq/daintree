// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectStatus } from "@shared/types";

/**
 * `status` is widened to the full union so a describe can pin a fixture to any
 * lifecycle state — inferring it from the default fixture would freeze the
 * shared array at that one literal.
 */
type ProjectFixture = {
  id: string;
  name: string;
  path: string;
  emoji: string;
  lastOpened: number;
  status: ProjectStatus;
  color?: string;
  frecencyScore?: number;
  pinned?: boolean;
};

const {
  getBulkStatsMock,
  freeMemoryMock,
  setStatsMock,
  useProjectStoreMock,
  useProjectStatsStoreMock,
  notifyMock,
  copyMock,
  projectState,
  projectStatsState,
} = vi.hoisted(() => {
  const getBulkStatsMock = vi.fn();
  const freeMemoryMock = vi.fn();
  const copyMock = vi.fn().mockResolvedValue(true);

  const projectStatsState = {
    stats: {} as Record<
      string,
      {
        activeAgentCount: number;
        waitingAgentCount: number;
        blockedAgentCount?: number;
        oldestWaitingSince?: number;
        completedAgentCount?: number;
        unacknowledgedCompletedAgentCount?: number;
        oldestUnacknowledgedCompletionAt?: number;
        latestUnacknowledgedCompletionAt?: number;
        latestCompletionAt?: number;
        latestWorkingSince?: number;
        processCount: number;
      }
    >,
  };

  const setStatsMock = vi.fn((stats: typeof projectStatsState.stats) => {
    projectStatsState.stats = stats;
  });

  // Browse lists every registered project in both modes; "background" is just
  // the realistic status for a fixture that isn't the current project.
  const defaultProjects: ProjectFixture[] = [
    {
      id: "project-1",
      name: "Project One",
      path: "/repo/one",
      emoji: "🌲",
      color: "#00aa00",
      lastOpened: 123,
      frecencyScore: 3.0,
      status: "background",
    },
  ];

  const projectState = {
    projects: defaultProjects,
    currentProject: null as { id: string } | null,
    switchProject: vi.fn().mockResolvedValue(undefined),
    reopenProject: vi.fn().mockResolvedValue(undefined),
    loadProjects: vi.fn().mockResolvedValue(undefined),
    addProject: vi.fn().mockResolvedValue(undefined),
    closeProject: vi.fn().mockResolvedValue({ processesKilled: 0 }),
    closeActiveProject: vi.fn().mockResolvedValue({ processesKilled: 0 }),
    removeProject: vi.fn().mockResolvedValue(undefined),
    locateProject: vi.fn().mockResolvedValue(undefined),
  };

  const useProjectStoreMock = Object.assign(
    vi.fn((selector: (state: typeof projectState) => unknown) => selector(projectState)),
    { getState: () => projectState }
  );
  const useProjectStatsStoreMock = Object.assign(
    vi.fn((selector: (state: typeof projectStatsState) => unknown) => selector(projectStatsState)),
    { getState: () => ({ stats: projectStatsState.stats, setStats: setStatsMock }) }
  );
  const notifyMock = vi.fn().mockReturnValue("");

  return {
    getBulkStatsMock,
    freeMemoryMock,
    setStatsMock,
    useProjectStoreMock,
    useProjectStatsStoreMock,
    notifyMock,
    copyMock,
    projectState,
    projectStatsState,
  };
});

vi.mock("@/clients", () => ({
  projectClient: {
    getBulkStats: getBulkStatsMock,
    freeMemory: freeMemoryMock,
  },
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: useProjectStoreMock,
}));

vi.mock("@/store/projectStatsStore", () => ({
  useProjectStatsStore: useProjectStatsStoreMock,
}));

vi.mock("@/lib/notify", () => ({
  notify: notifyMock,
}));

vi.mock("@/hooks/useCopyWithFeedback", () => ({
  useCopyWithFeedback: () => ({ copied: false, copy: copyMock }),
}));

import { usePaletteStore } from "@/store/paletteStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import {
  DEFAULT_OTHER_PROJECTS_SORT_MODE,
  OTHER_PROJECTS_SORT_MODES,
  type OtherProjectsSortMode,
} from "@/lib/projectSort";
import { useProjectSwitcherPalette } from "../useProjectSwitcherPalette";
import type { ProjectSwitcherProjectRow, ProjectSwitcherRow } from "../useProjectSwitcherPalette";

/**
 * Narrows a result row to a project, throwing if it isn't one.
 *
 * Search mixes scratches into `results` (#11466), so the project-only fields
 * these specs read are no longer unconditionally present. Throwing rather than
 * asserting keeps the failure honest: a spec that expected a project and got a
 * scratch has found a real defect, not a typing inconvenience.
 */
function asProject(row: ProjectSwitcherRow | undefined): ProjectSwitcherProjectRow {
  if (row?.kind !== "project") {
    throw new Error(`expected a project row, got ${row?.kind ?? "nothing"}`);
  }
  return row;
}

function setOtherSortMode(mode: OtherProjectsSortMode): void {
  usePreferencesStore.getState().setProjectSwitcherOtherSortMode(mode);
}

const emptyBulkStats = (projectIds: string[]) => {
  const result: Record<
    string,
    {
      processCount: number;
      terminalCount: number;
      estimatedMemoryMB: number;
      terminalTypes: Record<string, number>;
      processIds: number[];
      activeAgentCount: number;
      waitingAgentCount: number;
      blockedAgentCount: number;
      oldestWaitingSince?: number;
      completedAgentCount: number;
      unacknowledgedCompletedAgentCount: number;
      oldestUnacknowledgedCompletionAt?: number;
      latestUnacknowledgedCompletionAt?: number;
      latestCompletionAt?: number;
      latestWorkingSince?: number;
    }
  > = {};
  for (const id of projectIds) {
    result[id] = {
      processCount: 0,
      terminalCount: 0,
      estimatedMemoryMB: 0,
      terminalTypes: {},
      processIds: [],
      activeAgentCount: 0,
      waitingAgentCount: 0,
      blockedAgentCount: 0,
      completedAgentCount: 0,
      unacknowledgedCompletedAgentCount: 0,
    };
  }
  return result;
};

describe("useProjectSwitcherPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectState.currentProject = null;
    projectStatsState.stats = {};
    getBulkStatsMock.mockResolvedValue(emptyBulkStats(["project-1"]));
    freeMemoryMock.mockResolvedValue({
      terminalsKilled: 0,
      rendererEvicted: false,
      workspaceEvicted: false,
    });
    setStatsMock.mockImplementation((stats: typeof projectStatsState.stats) => {
      projectStatsState.stats = stats;
    });
    usePaletteStore.setState({ activePaletteId: null });
  });

  it("reads project stats from the push-based store", async () => {
    projectStatsState.stats = {
      "project-1": { activeAgentCount: 0, waitingAgentCount: 0, processCount: 0 },
    };

    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => {
      result.current.open();
    });

    await waitFor(() => {
      expect(result.current.results).toHaveLength(1);
      expect(asProject(result.current.results[0]).activeAgentCount).toBe(0);
      expect(asProject(result.current.results[0]).waitingAgentCount).toBe(0);
    });
  });

  it("does not leak unhandled rejections when project loading fails", async () => {
    projectState.loadProjects.mockRejectedValueOnce(new Error("load failed"));
    getBulkStatsMock.mockResolvedValue(emptyBulkStats(["project-1"]));

    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => {
      result.current.open();
    });

    await waitFor(() => {
      expect(result.current.isOpen).toBe(true);
      expect(result.current.results).toHaveLength(1);
    });
  });

  it("populates agent counts from push-based stats store", async () => {
    projectStatsState.stats = {
      "project-1": {
        processCount: 3,
        activeAgentCount: 1,
        waitingAgentCount: 1,
      },
    };

    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => {
      result.current.open();
    });

    await waitFor(() => {
      expect(result.current.results).toHaveLength(1);
      expect(asProject(result.current.results[0]).activeAgentCount).toBe(1);
      expect(asProject(result.current.results[0]).waitingAgentCount).toBe(1);
      expect(asProject(result.current.results[0]).processCount).toBe(3);
    });
  });

  describe("default selection index", () => {
    const multipleProjects = [
      {
        id: "project-1",
        name: "Current Project",
        path: "/repo/current",
        emoji: "🌲",
        color: "#00aa00",
        lastOpened: 300,
        frecencyScore: 10.0,
        status: "active" as const,
      },
      {
        id: "project-2",
        name: "Previous Project",
        path: "/repo/previous",
        emoji: "🌿",
        color: "#00bb00",
        lastOpened: 200,
        frecencyScore: 7.0,
        status: "background" as const,
      },
      {
        id: "project-3",
        name: "Old Project",
        path: "/repo/old",
        emoji: "🌴",
        color: "#00cc00",
        lastOpened: 100,
        frecencyScore: 3.0,
        status: "background" as const,
      },
    ];

    it("defaults to index 1 (active project at index 0) when 2+ projects exist", async () => {
      projectState.projects = multipleProjects;
      projectState.currentProject = { id: "project-1" };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(multipleProjects.map((p) => p.id)));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(3);
      });

      expect(result.current.selectedIndex).toBe(1);
      expect(result.current.results[0]!.id).toBe("project-1");
      expect(result.current.results[0]!.isActive).toBe(true);
      expect(result.current.results[1]!.id).toBe("project-2");
      expect(result.current.results[2]!.id).toBe("project-3");
    });

    it("defaults to index 0 when only 1 project exists", async () => {
      projectState.projects = [multipleProjects[0]!];
      projectState.currentProject = { id: "project-1" };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(["project-1"]));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(1);
      });

      expect(result.current.selectedIndex).toBe(0);
    });

    it("defaults to index 0 when no projects exist", async () => {
      projectState.projects = [];
      projectState.currentProject = null;
      getBulkStatsMock.mockResolvedValue({});

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(0);
      });

      expect(result.current.selectedIndex).toBe(0);
    });

    it("defaults to index 1 with exactly 2 projects (active first)", async () => {
      projectState.projects = [multipleProjects[0]!, multipleProjects[1]!];
      projectState.currentProject = { id: "project-1" };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(["project-1", "project-2"]));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(2);
      });

      expect(result.current.selectedIndex).toBe(1);
      expect(result.current.results[0]!.id).toBe("project-1");
      expect(result.current.results[1]!.id).toBe("project-2");
    });

    /**
     * The state the renderer actually holds on the first palette open from a
     * scratch: the scratch switch cleared `currentProject` but never demoted or
     * broadcast the row it left, so the pre-scratch project is still "active"
     * with no process of its own. Main repairs that to "background" on its next
     * read — which lands only after the palette's async reload (#11085).
     */
    function scratchWorkspaceProjects() {
      // Supplied out of MRU order so assertions prove the computed sort, not the
      // fixture's array position.
      return [
        { ...multipleProjects[2]!, status: "background" as const },
        { ...multipleProjects[0]!, status: "active" as const },
        { ...multipleProjects[1]!, status: "background" as const },
      ];
    }

    it("keeps the pre-scratch project browsable and preselected on the first open", async () => {
      const scratchProjects = scratchWorkspaceProjects();
      projectState.projects = scratchProjects;
      projectState.currentProject = null;
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(multipleProjects.map((p) => p.id)));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(3);
      });

      const freshest = [...scratchProjects].sort((a, b) => b.lastOpened - a.lastOpened)[0]!;
      expect(result.current.results.some((project) => project.isActive)).toBe(false);
      // The stale-"active" row must survive the modal-browse scope filter, not
      // get dropped for being neither active nor background.
      expect(result.current.results.map((project) => project.id)).toContain(freshest.id);
      expect(result.current.results[result.current.selectedIndex]?.id).toBe(freshest.id);
    });

    it("preselects the pre-scratch project in dropdown mode too", async () => {
      const scratchProjects = scratchWorkspaceProjects();
      projectState.projects = scratchProjects;
      projectState.currentProject = null;
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(multipleProjects.map((p) => p.id)));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open("dropdown");
      });

      await waitFor(() => {
        expect(result.current.isOpen).toBe(true);
      });

      const freshest = [...scratchProjects].sort((a, b) => b.lastOpened - a.lastOpened)[0]!;
      expect(result.current.results[result.current.selectedIndex]?.id).toBe(freshest.id);
    });

    it("preselects the freshest switchable project when the active one isn't the MRU head", async () => {
      // Reachable when the active project's `lastOpened` write was suppressed or
      // another window bumped a different project. The preselect must be the MRU
      // switch target — the freshest row that isn't the one we're already in —
      // never the active row itself, which Enter would no-op on.
      projectState.projects = [
        { ...multipleProjects[1]!, lastOpened: 300, status: "background" as const },
        { ...multipleProjects[0]!, lastOpened: 100, status: "active" as const },
        { ...multipleProjects[2]!, lastOpened: 50, status: "background" as const },
      ];
      projectState.currentProject = { id: multipleProjects[0]!.id };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(multipleProjects.map((p) => p.id)));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(3);
      });

      const selected = result.current.results[result.current.selectedIndex];
      expect(selected?.isActive).toBe(false);
      expect(selected?.id).toBe(multipleProjects[1]!.id);
    });

    it("orders browse by frecency, not raw lastOpened", async () => {
      const projectsWithMismatchedScores = [
        {
          id: "project-a",
          name: "High Frecency",
          path: "/repo/a",
          emoji: "🌲",
          color: "#00aa00",
          lastOpened: 100,
          frecencyScore: 50.0,
          status: "background" as const,
        },
        {
          id: "project-b",
          name: "Low Frecency",
          path: "/repo/b",
          emoji: "🌿",
          color: "#00bb00",
          lastOpened: 300,
          frecencyScore: 1.0,
          status: "background" as const,
        },
      ];

      projectState.projects = projectsWithMismatchedScores;
      projectState.currentProject = null;
      getBulkStatsMock.mockResolvedValue(
        emptyBulkStats(projectsWithMismatchedScores.map((p) => p.id))
      );

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(2);
      });

      // project-a was opened longer ago but is used far more often. Browse
      // reflects durable use, so a project touched once yesterday no longer
      // outranks the one worked in every day.
      expect(result.current.results[0]!.id).toBe("project-a");
      expect(result.current.results[1]!.id).toBe("project-b");
    });
  });

  describe("active project close", () => {
    const activeProject = {
      id: "project-1",
      name: "Active Project",
      path: "/repo/active",
      emoji: "🌲",
      color: "#00aa00",
      lastOpened: 300,
      frecencyScore: 8.0,
      status: "active" as const,
    };
    const inactiveProject = {
      id: "project-2",
      name: "Inactive Project",
      path: "/repo/inactive",
      emoji: "🌿",
      color: "#00bb00",
      lastOpened: 200,
      frecencyScore: 5.0,
      status: "background" as const,
    };

    beforeEach(() => {
      projectState.projects = [activeProject, inactiveProject];
      projectState.currentProject = { id: "project-1" };
      getBulkStatsMock.mockResolvedValue({
        "project-1": {
          processCount: 2,
          terminalCount: 2,
          estimatedMemoryMB: 100,
          terminalTypes: {},
          processIds: [],
          activeAgentCount: 0,
          waitingAgentCount: 0,
        },
        "project-2": {
          processCount: 0,
          terminalCount: 0,
          estimatedMemoryMB: 0,
          terminalTypes: {},
          processIds: [],
          activeAgentCount: 0,
          waitingAgentCount: 0,
        },
      });
    });

    it("allows active project to enter confirm flow", async () => {
      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(2);
      });

      const activeResult = result.current.results.find((p) => p.id === "project-1");
      expect(activeResult?.isActive).toBe(true);

      await act(async () => {
        result.current.removeProject("project-1");
      });

      expect(result.current.removeConfirmProject?.id).toBe("project-1");
    });

    it("confirm calls closeActiveProject for active project, not removeProject", async () => {
      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(2);
      });

      await act(async () => {
        result.current.removeProject("project-1");
      });

      expect(result.current.removeConfirmProject?.id).toBe("project-1");

      await act(async () => {
        await result.current.confirmRemoveProject();
      });

      expect(projectState.closeActiveProject).toHaveBeenCalledWith("project-1");
      expect(projectState.removeProject).not.toHaveBeenCalled();
      expect(result.current.removeConfirmProject).toBeNull();
    });

    it("stop confirmation closes the active project so the renderer leaves project view", async () => {
      const { result } = renderHook(() => useProjectSwitcherPalette());

      await act(async () => {
        await result.current.stopProject("project-1");
      });

      expect(result.current.stopConfirmProjectId).toBe("project-1");

      await act(async () => {
        await result.current.confirmStopProject();
      });

      expect(projectState.closeActiveProject).toHaveBeenCalledWith("project-1");
      expect(projectState.closeProject).not.toHaveBeenCalled();
      expect(result.current.stopConfirmProjectId).toBeNull();
    });

    it("stop confirmation uses closeProject for a non-active project", async () => {
      projectState.currentProject = null;

      const { result } = renderHook(() => useProjectSwitcherPalette());

      await act(async () => {
        await result.current.stopProject("project-1");
      });

      expect(result.current.stopConfirmProjectId).toBe("project-1");

      await act(async () => {
        await result.current.confirmStopProject();
      });

      expect(projectState.closeProject).toHaveBeenCalledWith("project-1", { killTerminals: true });
      expect(projectState.closeActiveProject).not.toHaveBeenCalled();
      expect(result.current.stopConfirmProjectId).toBeNull();
    });

    it("stop confirmation uses closeProject when a different project is active", async () => {
      projectState.currentProject = { id: "project-2" };

      const { result } = renderHook(() => useProjectSwitcherPalette());

      await act(async () => {
        await result.current.stopProject("project-1");
      });

      await act(async () => {
        await result.current.confirmStopProject();
      });

      expect(projectState.closeProject).toHaveBeenCalledWith("project-1", { killTerminals: true });
      expect(projectState.closeActiveProject).not.toHaveBeenCalled();
    });

    it("stop confirmation re-evaluates isActive at confirm time, not at stopProject time", async () => {
      const { result } = renderHook(() => useProjectSwitcherPalette());

      await act(async () => {
        await result.current.stopProject("project-1");
      });

      projectState.currentProject = null;

      await act(async () => {
        await result.current.confirmStopProject();
      });

      expect(projectState.closeProject).toHaveBeenCalledWith("project-1", { killTerminals: true });
      expect(projectState.closeActiveProject).not.toHaveBeenCalled();
    });

    it("confirm calls removeProject for non-active project, not closeActiveProject", async () => {
      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(2);
      });

      await act(async () => {
        result.current.removeProject("project-2");
      });

      expect(result.current.removeConfirmProject?.id).toBe("project-2");

      await act(async () => {
        await result.current.confirmRemoveProject();
      });

      expect(projectState.removeProject).toHaveBeenCalledWith("project-2");
      expect(projectState.closeActiveProject).not.toHaveBeenCalled();
      expect(result.current.removeConfirmProject).toBeNull();
    });

    it("shows error notification when closeActiveProject fails", async () => {
      notifyMock.mockClear();
      projectState.closeActiveProject.mockRejectedValueOnce(new Error("close failed"));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(2);
      });

      await act(async () => {
        result.current.removeProject("project-1");
      });

      await act(async () => {
        await result.current.confirmRemoveProject();
      });

      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: "Couldn't close project",
        })
      );
    });
  });

  describe("free memory", () => {
    beforeEach(() => {
      // Pin a single, non-active project so ordering with describes that mutate
      // the shared projects array can't change result counts.
      projectState.projects = [
        {
          id: "project-1",
          name: "Project One",
          path: "/repo/one",
          emoji: "🌲",
          color: "#00aa00",
          lastOpened: 123,
          frecencyScore: 3.0,
          status: "background" as const,
        },
      ];
      projectState.currentProject = null;
    });

    const bulkStats = (
      counts: { processCount?: number; activeAgentCount?: number; waitingAgentCount?: number } = {}
    ) => ({
      "project-1": {
        processCount: counts.processCount ?? 0,
        terminalCount: counts.processCount ?? 0,
        estimatedMemoryMB: 0,
        terminalTypes: {},
        processIds: [],
        activeAgentCount: counts.activeAgentCount ?? 0,
        waitingAgentCount: counts.waitingAgentCount ?? 0,
      },
    });

    it("D0: a project with no live processes frees immediately, no confirm dialog", async () => {
      getBulkStatsMock.mockResolvedValue(bulkStats());

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(1);
      });

      await act(async () => {
        await result.current.freeMemoryProject("project-1");
      });

      expect(freeMemoryMock).toHaveBeenCalledWith("project-1");
      expect(result.current.freeMemoryConfirmProject).toBeNull();
    });

    it("D1: a project with live processes opens a confirm dialog before freeing", async () => {
      getBulkStatsMock.mockResolvedValue(bulkStats({ processCount: 2, activeAgentCount: 1 }));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(asProject(result.current.results[0]).processCount).toBe(2);
      });

      await act(async () => {
        await result.current.freeMemoryProject("project-1");
      });

      // Snapshot captured, nothing freed yet.
      expect(result.current.freeMemoryConfirmProject?.id).toBe("project-1");
      expect(result.current.freeMemoryConfirmProject?.processCount).toBe(2);
      expect(freeMemoryMock).not.toHaveBeenCalled();

      await act(async () => {
        await result.current.confirmFreeMemory();
      });

      expect(freeMemoryMock).toHaveBeenCalledWith("project-1");
      expect(result.current.freeMemoryConfirmProject).toBeNull();
    });

    it("refuses to free the active project and surfaces guidance instead", async () => {
      projectState.currentProject = { id: "project-1" };
      getBulkStatsMock.mockResolvedValue(bulkStats());

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(1);
      });

      await act(async () => {
        await result.current.freeMemoryProject("project-1");
      });

      expect(freeMemoryMock).not.toHaveBeenCalled();
      expect(result.current.freeMemoryConfirmProject).toBeNull();
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Switch away first" })
      );
    });

    it("shows an error notification when freeing fails", async () => {
      notifyMock.mockClear();
      freeMemoryMock.mockRejectedValueOnce(new Error("free failed"));
      getBulkStatsMock.mockResolvedValue(bulkStats());

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(1);
      });

      await act(async () => {
        await result.current.freeMemoryProject("project-1");
      });

      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", title: "Couldn't free memory" })
      );
    });
  });

  describe("activeProject decoupling — issue #8174", () => {
    function makeProject(i: number) {
      return {
        id: `project-${i}`,
        name: `Project ${i}`,
        path: `/repo/p${i}`,
        emoji: "🌲",
        color: "#00aa00",
        lastOpened: 1000 - i,
        frecencyScore: 1.0,
        status: "background" as const,
      };
    }

    it("exposes the active project as a SearchableProject with enriched stats + pin state", async () => {
      const projects = [{ ...makeProject(1), pinned: true }, makeProject(2)];
      projectState.projects = projects;
      projectState.currentProject = { id: "project-1" };
      projectStatsState.stats = {
        "project-1": { processCount: 3, activeAgentCount: 1, waitingAgentCount: 0 },
      };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(["project-1", "project-2"]));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      await waitFor(() => {
        expect(result.current.activeProject).not.toBeNull();
      });

      expect(result.current.activeProject?.id).toBe("project-1");
      expect(result.current.activeProject?.isActive).toBe(true);
      // Conditional context-menu items on the toolbar pill depend on these
      // enriched fields, so assert them explicitly rather than relying on id
      // equality to imply they're populated.
      expect(result.current.activeProject?.isPinned).toBe(true);
      expect(result.current.activeProject?.processCount).toBe(3);
      expect(result.current.activeProject?.path).toBe("/repo/p1");
    });

    it("renders every project and floats the active one to the top", async () => {
      // The stalest project by lastOpened used to be unreachable in browse once
      // the list exceeded fifteen. Being the active project is now what decides
      // its position, and nothing decides its absence.
      const projects = Array.from({ length: 20 }, (_, i) => makeProject(i + 1));
      projects[19] = { ...projects[19]!, lastOpened: 0 };
      projectState.projects = projects;
      projectState.currentProject = { id: "project-20" };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(projects.map((p) => p.id)));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      await waitFor(() => {
        expect(result.current.activeProject?.id).toBe("project-20");
      });

      expect(result.current.results).toHaveLength(20);
      expect(result.current.results[0]!.id).toBe("project-20");
      expect(result.current.activeProject?.isActive).toBe(true);
      expect(result.current.activeProject?.path).toBe("/repo/p20");
      expect(result.current.activeProject?.processCount).toBe(0);
    });

    it("keeps activeProject populated even when the current query filters out the active project", async () => {
      const projects = [
        { ...makeProject(1), name: "alpha-service" },
        { ...makeProject(2), name: "beta-app" },
      ];
      projectState.projects = projects;
      projectState.currentProject = { id: "project-1" };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(["project-1", "project-2"]));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      await waitFor(() => {
        expect(result.current.activeProject?.id).toBe("project-1");
      });

      act(() => {
        result.current.setQuery("beta");
      });

      // The active project is filtered out by the query, but activeProject still resolves.
      const idsInResults = result.current.results.map((p) => p.id);
      expect(idsInResults).not.toContain("project-1");
      expect(result.current.activeProject?.id).toBe("project-1");
    });

    it("returns null when no project is currently active", async () => {
      projectState.projects = [makeProject(1)];
      projectState.currentProject = null;
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(["project-1"]));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      // Wait for searchableProjects to populate so the activeProject memo has
      // genuinely run with a non-empty list, otherwise the `null` assertion
      // could resolve trivially before any project data is present.
      await waitFor(() => {
        expect(result.current.results).toHaveLength(1);
      });

      expect(result.current.activeProject).toBeNull();
    });
  });

  describe("search behavior", () => {
    const searchProjects = [
      {
        id: "project-1",
        name: "daintree-app",
        path: "/repos/daintree-app",
        emoji: "🌲",
        color: "#00aa00",
        lastOpened: 300,
        frecencyScore: 10.0,
        status: "background" as const,
      },
      {
        id: "project-2",
        name: "other-service",
        path: "/repos/other-service",
        emoji: "🌿",
        color: "#00bb00",
        lastOpened: 200,
        frecencyScore: 7.0,
        status: "background" as const,
      },
      {
        id: "project-3",
        name: "my-daintree-tools",
        path: "/repos/my-daintree-tools",
        emoji: "🌴",
        color: "#00cc00",
        lastOpened: 100,
        frecencyScore: 3.0,
        status: "background" as const,
      },
    ];

    it("filters results synchronously with zero debounce", async () => {
      projectState.projects = searchProjects;
      projectState.currentProject = null;
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(searchProjects.map((p) => p.id)));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(3);
      });

      act(() => {
        result.current.setQuery("daintree");
      });

      // Results should be available immediately — no waitFor needed
      expect(result.current.results.length).toBeGreaterThanOrEqual(2);
      expect(result.current.results[0]!.name).toContain("daintree");
    });

    it("returns empty results for non-matching query", async () => {
      projectState.projects = searchProjects;
      projectState.currentProject = null;
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(searchProjects.map((p) => p.id)));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(3);
      });

      act(() => {
        result.current.setQuery("zzzzz");
      });

      expect(result.current.results).toHaveLength(0);
    });

    it("restores browse results when query is cleared", async () => {
      projectState.projects = searchProjects;
      projectState.currentProject = null;
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(searchProjects.map((p) => p.id)));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(3);
      });

      act(() => {
        result.current.setQuery("daintree");
      });
      expect(result.current.results.length).toBeLessThan(3);

      act(() => {
        result.current.setQuery("");
      });
      expect(result.current.results).toHaveLength(3);
    });
  });

  describe("toggle for repeated Cmd+Alt+P", () => {
    const threeProjects = [
      {
        id: "project-1",
        name: "Current Project",
        path: "/repo/current",
        emoji: "🌲",
        color: "#00aa00",
        lastOpened: 300,
        frecencyScore: 10.0,
        status: "active" as const,
      },
      {
        id: "project-2",
        name: "Previous Project",
        path: "/repo/previous",
        emoji: "🌿",
        color: "#00bb00",
        lastOpened: 200,
        frecencyScore: 7.0,
        status: "background" as const,
      },
      {
        id: "project-3",
        name: "Old Project",
        path: "/repo/old",
        emoji: "🌴",
        color: "#00cc00",
        lastOpened: 100,
        frecencyScore: 3.0,
        status: "background" as const,
      },
    ];

    it("opens from closed and selects the most recent non-current project", async () => {
      projectState.projects = threeProjects;
      projectState.currentProject = { id: "project-1" };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(threeProjects.map((p) => p.id)));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      expect(result.current.isOpen).toBe(false);

      await act(async () => {
        result.current.toggle();
      });

      await waitFor(() => {
        expect(result.current.isOpen).toBe(true);
        expect(result.current.results).toHaveLength(3);
        expect(result.current.selectedIndex).toBe(1);
      });
    });

    it("advances selection when toggled while open", async () => {
      projectState.projects = threeProjects;
      projectState.currentProject = { id: "project-1" };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(threeProjects.map((p) => p.id)));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      await act(async () => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(3);
        expect(result.current.selectedIndex).toBe(1);
      });

      expect(result.current.isOpen).toBe(true);

      await act(async () => {
        result.current.toggle();
      });

      expect(result.current.isOpen).toBe(true);
      expect(result.current.selectedIndex).toBe(2);
    });

    it("wraps to index 0 at end of list", async () => {
      projectState.projects = threeProjects;
      projectState.currentProject = { id: "project-1" };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(threeProjects.map((p) => p.id)));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      await act(async () => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(3);
        expect(result.current.selectedIndex).toBe(1);
      });

      await act(async () => {
        result.current.toggle();
      });
      expect(result.current.selectedIndex).toBe(2);

      await act(async () => {
        result.current.toggle();
      });
      expect(result.current.selectedIndex).toBe(0);
    });

    it("is a no-op with only 1 project", async () => {
      projectState.projects = [threeProjects[0]!];
      projectState.currentProject = { id: "project-1" };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(["project-1"]));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(1);
      });

      expect(result.current.selectedIndex).toBe(0);

      act(() => {
        result.current.toggle();
      });

      expect(result.current.selectedIndex).toBe(0);
    });

    it("cycles through all projects in MRU order", async () => {
      const projectsWithActiveNotFirst = [
        {
          id: "project-1",
          name: "Old Project",
          path: "/repo/old",
          emoji: "🌴",
          color: "#00cc00",
          lastOpened: 100,
          frecencyScore: 3.0,
          status: "background" as const,
        },
        {
          id: "project-2",
          name: "Current Project",
          path: "/repo/current",
          emoji: "🌲",
          color: "#00aa00",
          lastOpened: 300,
          frecencyScore: 10.0,
          status: "active" as const,
        },
        {
          id: "project-3",
          name: "Recent Project",
          path: "/repo/recent",
          emoji: "🌿",
          color: "#00bb00",
          lastOpened: 200,
          frecencyScore: 7.0,
          status: "background" as const,
        },
      ];

      projectState.projects = projectsWithActiveNotFirst;
      projectState.currentProject = { id: "project-2" };
      getBulkStatsMock.mockResolvedValue(
        emptyBulkStats(projectsWithActiveNotFirst.map((p) => p.id))
      );

      const { result } = renderHook(() => useProjectSwitcherPalette());

      await act(async () => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(3);
      });

      // MRU order: active (project-2, lastOpened:300) first, then by lastOpened
      expect(result.current.results[0]!.id).toBe("project-2");
      expect(result.current.results[0]!.isActive).toBe(true);
      expect(result.current.results[1]!.id).toBe("project-3");
      expect(result.current.results[2]!.id).toBe("project-1");
      expect(result.current.selectedIndex).toBe(1);

      // Toggle cycle: 1 → 2 → 0 → 1
      await act(async () => {
        result.current.toggle();
      });
      expect(result.current.selectedIndex).toBe(2);

      await act(async () => {
        result.current.toggle();
      });
      expect(result.current.selectedIndex).toBe(0);

      await act(async () => {
        result.current.toggle();
      });
      expect(result.current.selectedIndex).toBe(1);
    });
  });

  describe("copyPath", () => {
    it("writes the path to the clipboard and emits a transient Path copied toast on success", async () => {
      copyMock.mockResolvedValueOnce(true);

      const { result } = renderHook(() => useProjectSwitcherPalette());

      await act(async () => {
        result.current.copyPath("/repo/one");
      });

      expect(copyMock).toHaveBeenCalledWith("/repo/one");
      expect(notifyMock).toHaveBeenCalledWith({
        type: "info",
        title: "Path copied",
        message: "/repo/one",
        transient: true,
      });
    });

    it("does not emit a toast when the clipboard write fails", async () => {
      copyMock.mockResolvedValueOnce(false);

      const { result } = renderHook(() => useProjectSwitcherPalette());

      await act(async () => {
        result.current.copyPath("/repo/one");
      });

      expect(copyMock).toHaveBeenCalledWith("/repo/one");
      expect(notifyMock).not.toHaveBeenCalled();
    });
  });

  describe("stats refresh on open", () => {
    let savedProjects: typeof projectState.projects;

    beforeEach(() => {
      savedProjects = projectState.projects;
      projectState.projects = [
        {
          id: "project-1",
          name: "Project One",
          path: "/repo/one",
          emoji: "🌲",
          color: "#00aa00",
          lastOpened: 123,
          frecencyScore: 3.0,
          status: "active" as const,
        },
      ];
    });

    afterEach(() => {
      projectState.projects = savedProjects;
    });

    it("pulls fresh bulk stats for loaded project IDs when opened", async () => {
      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(getBulkStatsMock).toHaveBeenCalledWith(["project-1"]);
      });
    });

    it("updates the stats store with mapped agent counts from the bulk response", async () => {
      getBulkStatsMock.mockResolvedValue({
        "project-1": {
          processCount: 2,
          terminalCount: 2,
          estimatedMemoryMB: 10,
          terminalTypes: {},
          processIds: [1, 2],
          activeAgentCount: 1,
          waitingAgentCount: 3,
          blockedAgentCount: 0,
        },
      });

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(setStatsMock).toHaveBeenCalledWith({
          "project-1": {
            activeAgentCount: 1,
            waitingAgentCount: 3,
            blockedAgentCount: 0,
            processCount: 2,
          },
        });
      });
    });

    it("seeds only projects the push store has never heard of", async () => {
      // Bulk stats can't tell an error-blocked wait from a prompt and don't net
      // out the assistant PTY, and the push service suppresses unchanged
      // payloads — so a bulk write landing on top of a push would stick until
      // the underlying counts happened to move again. Bulk fills gaps only.
      projectStatsState.stats = {
        "project-1": {
          activeAgentCount: 0,
          waitingAgentCount: 3,
          blockedAgentCount: 2,
          oldestWaitingSince: 1_000,
          processCount: 2,
        },
      };
      getBulkStatsMock.mockResolvedValue({
        "project-1": {
          processCount: 99,
          terminalCount: 99,
          estimatedMemoryMB: 0,
          terminalTypes: {},
          processIds: [],
          activeAgentCount: 99,
          waitingAgentCount: 99,
          blockedAgentCount: 9,
        },
      });

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(getBulkStatsMock).toHaveBeenCalled();
      });
      // Nothing was absent, so nothing was written.
      expect(setStatsMock).not.toHaveBeenCalled();
      expect(asProject(result.current.results[0]).blockedAgentCount).toBe(2);
    });

    it("seeds a project the push store has no entry for", async () => {
      projectStatsState.stats = {};
      getBulkStatsMock.mockResolvedValue({
        "project-1": {
          processCount: 2,
          terminalCount: 2,
          estimatedMemoryMB: 10,
          terminalTypes: {},
          processIds: [],
          activeAgentCount: 1,
          waitingAgentCount: 3,
          blockedAgentCount: 0,
        },
      });

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(setStatsMock).toHaveBeenCalledWith({
          "project-1": {
            activeAgentCount: 1,
            waitingAgentCount: 3,
            // Bulk cannot know this, and guessing would paint a row red.
            blockedAgentCount: 0,
            processCount: 2,
          },
        });
      });
    });

    it("does not request stats when no projects are loaded", async () => {
      const originalProjects = projectState.projects;
      projectState.projects = [];

      try {
        const { result } = renderHook(() => useProjectSwitcherPalette());

        act(() => {
          result.current.open();
        });

        await waitFor(() => {
          expect(result.current.isOpen).toBe(true);
        });
        expect(getBulkStatsMock).not.toHaveBeenCalled();
        expect(setStatsMock).not.toHaveBeenCalled();
      } finally {
        projectState.projects = originalProjects;
      }
    });

    it("tolerates a bulk stats fetch rejection without throwing or leaking", async () => {
      const unhandled = vi.fn();
      window.addEventListener("unhandledrejection", unhandled);
      getBulkStatsMock.mockRejectedValueOnce(new Error("stats failed"));

      try {
        const { result } = renderHook(() => useProjectSwitcherPalette());

        act(() => {
          result.current.open();
        });

        await waitFor(() => {
          expect(result.current.isOpen).toBe(true);
          expect(getBulkStatsMock).toHaveBeenCalledWith(["project-1"]);
        });
        // Let any pending microtask rejection settle.
        await act(async () => {
          await Promise.resolve();
        });
        expect(setStatsMock).not.toHaveBeenCalled();
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener("unhandledrejection", unhandled);
      }
    });
  });

  // Classification is tested here, against raw projects plus pushed stats,
  // rather than through the component — a component fixture that restates the
  // banding rules would go on passing while this logic drifted.
  describe("Other band sort mode — issue #11455", () => {
    const base = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      name: id,
      path: `/repo/${id}`,
      emoji: "🌲",
      lastOpened: 100,
      frecencyScore: 3.0,
      status: "closed" as const,
      ...extra,
    });

    // Every signal disagrees, so each mode must produce a different order.
    const conflicting = () => [
      base("zulu", { lastOpened: 300, frecencyScore: 9.0 }),
      base("alpha", { lastOpened: 100, frecencyScore: 3.0 }),
      base("mike", { lastOpened: 500, frecencyScore: 1.0 }),
    ];

    async function openWith(mode: OtherProjectsSortMode, projects: ReturnType<typeof base>[]) {
      setOtherSortMode(mode);
      projectState.projects = projects;
      projectState.currentProject = null;
      projectStatsState.stats = {};
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(projects.map((p) => p.id)));

      const view = renderHook(() => useProjectSwitcherPalette());
      act(() => {
        view.result.current.open("modal");
      });
      await waitFor(() => {
        expect(view.result.current.results).toHaveLength(projects.length);
      });
      return view;
    }

    afterEach(() => {
      setOtherSortMode(DEFAULT_OTHER_PROJECTS_SORT_MODE);
    });

    const EXPECTED_ORDER: Record<OtherProjectsSortMode, string[]> = {
      mostUsed: ["zulu", "alpha", "mike"],
      recent: ["mike", "zulu", "alpha"],
      alphabetical: ["alpha", "mike", "zulu"],
    };

    it.each(OTHER_PROJECTS_SORT_MODES)("orders the Other band for %s", async (mode) => {
      const view = await openWith(mode, conflicting());
      expect(view.result.current.results.map((p) => p.id)).toEqual(EXPECTED_ORDER[mode]);
      view.unmount();
    });

    // The load-bearing orders belong to their bands, not to this preference:
    // asking for A-Z in the residual band is not asking for it everywhere, and
    // asking for Recent must not un-sort a user-curated pinned set.
    it.each(OTHER_PROJECTS_SORT_MODES)("leaves every other band untouched in %s", async (mode) => {
      const projects = [
        // Attention: severity then oldest first — the reverse of every mode here.
        base("zBlocked", { lastOpened: 9_000, frecencyScore: 50.0 }),
        base("aWaiting", { lastOpened: 100, frecencyScore: 1.0 }),
        // Pinned: alphabetical.
        base("zPinned", { pinned: true, lastOpened: 9_000, frecencyScore: 50.0 }),
        base("aPinned", { pinned: true, lastOpened: 100, frecencyScore: 1.0 }),
        // Running: most work first.
        base("aOneAgent", { lastOpened: 9_000, frecencyScore: 50.0 }),
        base("zThreeAgents", { lastOpened: 100, frecencyScore: 1.0 }),
        // Unavailable: alphabetical.
        base("zGone", { status: "missing", lastOpened: 9_000, frecencyScore: 50.0 }),
        base("aGone", { status: "missing", lastOpened: 100, frecencyScore: 1.0 }),
        ...conflicting(),
      ];
      setOtherSortMode(mode);
      projectState.projects = projects;
      projectState.currentProject = null;
      projectStatsState.stats = {
        zBlocked: {
          activeAgentCount: 0,
          waitingAgentCount: 1,
          blockedAgentCount: 1,
          processCount: 0,
        },
        aWaiting: { activeAgentCount: 0, waitingAgentCount: 1, processCount: 0 },
        aOneAgent: { activeAgentCount: 1, waitingAgentCount: 0, processCount: 0 },
        zThreeAgents: { activeAgentCount: 3, waitingAgentCount: 0, processCount: 0 },
      };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(projects.map((p) => p.id)));

      const { result, unmount } = renderHook(() => useProjectSwitcherPalette());
      act(() => {
        result.current.open("modal");
      });
      await waitFor(() => {
        expect(result.current.results).toHaveLength(projects.length);
      });

      const idsIn = (section: string) =>
        result.current.results
          .map(asProject)
          .filter((p) => p.section === section)
          .map((p) => p.id);

      // Blocked outranks a plain wait; a pin outranks recency; most agents
      // first; missing rows are alphabetical. None of these follow the mode.
      expect(idsIn("attention")).toEqual(["zBlocked", "aWaiting"]);
      expect(idsIn("pinned")).toEqual(["aPinned", "zPinned"]);
      expect(idsIn("running")).toEqual(["zThreeAgents", "aOneAgent"]);
      expect(idsIn("unavailable")).toEqual(["aGone", "zGone"]);
      // Only the residual band tracks the preference.
      expect(idsIn("other")).toEqual(EXPECTED_ORDER[mode]);
      unmount();
    });

    it("re-sorts on the next open when the mode changed while closed", async () => {
      const view = await openWith("mostUsed", conflicting());
      act(() => {
        view.result.current.close();
      });

      act(() => {
        setOtherSortMode("alphabetical");
      });
      act(() => {
        view.result.current.open("modal");
      });

      await waitFor(() => {
        expect(view.result.current.results.map((p) => p.id)).toEqual(["alpha", "mike", "zulu"]);
      });
      // And the highlight opens on the new order's top row rather than the old
      // order's — the same promise the in-place reset makes, kept here by
      // `open()`'s preselect reading the freshly sorted list.
      expect(view.result.current.results[view.result.current.selectedIndex]?.id).toBe("alpha");
      view.unmount();
    });

    it("re-sorts the Other band without disturbing a frozen band", async () => {
      // The freeze holds a row in the band it had at open, so an agent
      // finishing mid-read can't move it. Changing an unrelated band's sort
      // order must not become a back door that releases that hold.
      const projects = [base("waiting"), ...conflicting()];
      setOtherSortMode("mostUsed");
      projectState.projects = projects;
      projectState.currentProject = null;
      projectStatsState.stats = {
        waiting: { activeAgentCount: 0, waitingAgentCount: 1, processCount: 0 },
      };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(projects.map((p) => p.id)));

      const { result, rerender, unmount } = renderHook(() => useProjectSwitcherPalette());
      act(() => {
        result.current.open("modal");
      });
      await waitFor(() => {
        expect(result.current.results[0]!.id).toBe("waiting");
      });
      expect(asProject(result.current.results[0]).section).toBe("attention");

      // The agent finishes: live state now puts this row in Other, but the
      // freeze keeps it where the user last saw it.
      act(() => {
        projectStatsState.stats = {
          waiting: { activeAgentCount: 0, waitingAgentCount: 0, processCount: 0 },
        };
        rerender();
      });
      expect(asProject(result.current.results[0]).section).toBe("attention");

      act(() => {
        setOtherSortMode("alphabetical");
      });

      await waitFor(() => {
        expect(result.current.results.slice(1).map((p) => p.id)).toEqual(["alpha", "mike", "zulu"]);
      });
      // Still first, still in Needs attention — the mode change reordered the
      // Other band only, and did not adopt live band membership wholesale.
      expect(result.current.results[0]!.id).toBe("waiting");
      expect(asProject(result.current.results[0]).section).toBe("attention");
      // The highlight reads the same frozen membership. Deciding it against
      // LIVE sections would see this row as Other and drag it into the reset.
      expect(result.current.results[result.current.selectedIndex]?.id).toBe("waiting");
      unmount();
    });

    it("re-sorts an already-open palette when the mode changes", async () => {
      // Without an explicit recapture the frozen layout keeps serving the order
      // captured at open(), so the menu would appear to do nothing.
      const view = await openWith("mostUsed", conflicting());
      expect(view.result.current.results.map((p) => p.id)).toEqual(["zulu", "alpha", "mike"]);

      act(() => {
        setOtherSortMode("alphabetical");
      });

      await waitFor(() => {
        expect(view.result.current.results.map((p) => p.id)).toEqual(["alpha", "mike", "zulu"]);
      });
    });

    it("sorts a project that registered mid-session into the new order", async () => {
      // Arrivals join the freeze at their band's end, which is a position, not
      // a ranking. The re-sort has to take them with it, or the row the user
      // watched appear is the one row their chosen order does not describe.
      const view = await openWith("mostUsed", conflicting());
      act(() => {
        projectState.projects = [...conflicting(), base("bravo")];
        view.rerender();
      });
      await waitFor(() => {
        expect(view.result.current.results.map((p) => p.id)).toEqual([
          "zulu",
          "alpha",
          "mike",
          "bravo",
        ]);
      });

      act(() => {
        setOtherSortMode("alphabetical");
      });

      await waitFor(() => {
        expect(view.result.current.results.map((p) => p.id)).toEqual([
          "alpha",
          "bravo",
          "mike",
          "zulu",
        ]);
      });
      view.unmount();
    });

    // Two bands above Other, so "top of the Other band" and "top of the list"
    // are different rows — a reset that merely went to index 0, or that cleared
    // the selection outright, would be indistinguishable without them.
    async function openBanded(mode: OtherProjectsSortMode) {
      const projects = [base("blocked"), base("waiting"), ...conflicting()];
      setOtherSortMode(mode);
      projectState.projects = projects;
      projectState.currentProject = null;
      projectStatsState.stats = {
        blocked: {
          activeAgentCount: 0,
          waitingAgentCount: 1,
          blockedAgentCount: 1,
          processCount: 0,
        },
        waiting: { activeAgentCount: 0, waitingAgentCount: 1, processCount: 0 },
      };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(projects.map((p) => p.id)));

      const view = renderHook(() => useProjectSwitcherPalette());
      act(() => {
        view.result.current.open("modal");
      });
      await waitFor(() => {
        expect(view.result.current.results.map((p) => p.id)).toEqual([
          "blocked",
          "waiting",
          ...EXPECTED_ORDER[mode],
        ]);
      });
      return view;
    }

    const selectedId = (view: Awaited<ReturnType<typeof openBanded>>) =>
      view.result.current.results[view.result.current.selectedIndex]?.id;

    it("restarts the highlight at the top of the band it just reordered", async () => {
      const view = await openBanded("mostUsed");
      // Walk the highlight to the band's last row, so a highlight that merely
      // followed its project would be provably somewhere else afterwards.
      act(() => {
        view.result.current.selectNext();
        view.result.current.selectNext();
        view.result.current.selectNext();
        view.result.current.selectNext();
      });
      expect(selectedId(view)).toBe("mike");

      act(() => {
        setOtherSortMode("alphabetical");
      });

      await waitFor(() => {
        expect(view.result.current.results.slice(2).map((p) => p.id)).toEqual([
          "alpha",
          "mike",
          "zulu",
        ]);
      });
      // Asking for a different order is asking to read that band again, not to
      // be shown where the old row landed in it. The top of the BAND, not of
      // the list: the two attention rows above it keep their claim on the eye.
      expect(selectedId(view)).toBe("alpha");
      expect(view.result.current.selectedIndex).toBe(2);
      view.unmount();
    });

    it("leaves a highlight outside that band exactly where it is", async () => {
      // The control orders the Other band and says nothing about any other, so
      // a user parked in Needs attention must not be pulled out of it.
      const view = await openBanded("mostUsed");
      act(() => {
        view.result.current.selectNext();
      });
      expect(selectedId(view)).toBe("waiting");

      act(() => {
        setOtherSortMode("alphabetical");
      });

      await waitFor(() => {
        expect(view.result.current.results.slice(2).map((p) => p.id)).toEqual([
          "alpha",
          "mike",
          "zulu",
        ]);
      });
      expect(selectedId(view)).toBe("waiting");
      view.unmount();
    });

    it("skips a row that went missing while the palette was open", async () => {
      // Missing rows keep their frozen slot, so the reset can land on one. It
      // must not: selecting a missing project opens the relocation dialog,
      // which is the right answer to a click and the wrong one to the Enter
      // that follows a reflexive reorder (the same skip `open()` makes).
      const view = await openWith("mostUsed", conflicting());
      act(() => {
        view.result.current.selectNext();
      });
      expect(selectedId(view)).toBe("alpha");

      act(() => {
        projectState.projects = conflicting().map((project) =>
          project.id === "alpha" ? { ...project, status: "missing" as const } : project
        );
        view.rerender();
      });

      act(() => {
        setOtherSortMode("alphabetical");
      });

      // Alphabetical puts "alpha" at the top of the band, and it still renders
      // there — only the highlight steps over it.
      await waitFor(() => {
        expect(view.result.current.results.map((p) => p.id)).toEqual(["alpha", "mike", "zulu"]);
      });
      expect(selectedId(view)).toBe("mike");
      view.unmount();
    });

    it("leaves a search highlight alone when the mode changes underneath it", async () => {
      // The component renders no band headers while searching, so the control
      // is out of reach today — this pins the hook's own contract rather than a
      // journey. The rows on screen are query-ranked, so the band order this
      // changed is not what sequenced them, and seating the highlight on a
      // browse-order row would land it on whatever the search shows there.
      const view = await openWith("mostUsed", conflicting());
      act(() => {
        view.result.current.setQuery("l");
      });
      expect(view.result.current.results.map((p) => p.id)).toEqual(["zulu", "alpha"]);
      // Wrap back to the first match, so the highlight is held explicitly and
      // is NOT the row a reset would pick — alphabetical would seat it on
      // "alpha", which is where an unguarded reset lands.
      act(() => {
        view.result.current.selectNext();
        view.result.current.selectNext();
      });
      expect(view.result.current.results[view.result.current.selectedIndex]?.id).toBe("zulu");

      act(() => {
        setOtherSortMode("alphabetical");
      });

      expect(view.result.current.results[view.result.current.selectedIndex]?.id).toBe("zulu");
    });
  });

  describe("section classification", () => {
    const base = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      name: id,
      path: `/repo/${id}`,
      emoji: "🌲",
      lastOpened: 100,
      frecencyScore: 3.0,
      status: "closed" as const,
      ...extra,
    });

    it("bands every project by what it needs, not by when it was opened", async () => {
      const projects = [
        base("active", { status: "active" }),
        base("waiting"),
        base("blocked"),
        base("working"),
        base("processes"),
        base("pinnedProj", { pinned: true }),
        base("idle"),
        base("gone", { status: "missing" }),
      ];
      projectState.projects = projects;
      projectState.currentProject = { id: "active" };
      projectStatsState.stats = {
        waiting: { activeAgentCount: 0, waitingAgentCount: 2, processCount: 0 },
        blocked: {
          activeAgentCount: 0,
          waitingAgentCount: 1,
          blockedAgentCount: 1,
          processCount: 0,
        },
        working: { activeAgentCount: 3, waitingAgentCount: 0, processCount: 0 },
        processes: { activeAgentCount: 0, waitingAgentCount: 0, processCount: 2 },
      };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(projects.map((p) => p.id)));

      const { result } = renderHook(() => useProjectSwitcherPalette());
      act(() => {
        result.current.open("modal");
      });
      await waitFor(() => {
        expect(result.current.results).toHaveLength(projects.length);
      });

      const sectionOf = (id: string) =>
        result.current.results.map(asProject).find((p) => p.id === id)?.section;
      expect(sectionOf("active")).toBe("current");
      expect(sectionOf("waiting")).toBe("attention");
      expect(sectionOf("blocked")).toBe("attention");
      expect(sectionOf("working")).toBe("running");
      // Bare leftover processes are residency, not intent — no Running slot.
      expect(sectionOf("processes")).toBe("other");
      expect(sectionOf("pinnedProj")).toBe("pinned");
      expect(sectionOf("idle")).toBe("other");
      expect(sectionOf("gone")).toBe("unavailable");

      // Bands appear in priority order and each appears exactly once.
      const bands: string[] = [];
      for (const project of result.current.results.map(asProject)) {
        if (bands.at(-1) !== project.section) bands.push(project.section);
      }
      expect(bands).toEqual(["current", "attention", "pinned", "running", "other", "unavailable"]);
    });

    it("holds a project with unseen completed work in the attention band", async () => {
      const projects = [base("reviewMe"), base("ackd"), base("idle")];
      projectState.projects = projects;
      projectState.currentProject = null;
      projectStatsState.stats = {
        reviewMe: {
          activeAgentCount: 0,
          waitingAgentCount: 0,
          processCount: 1,
          completedAgentCount: 1,
          unacknowledgedCompletedAgentCount: 1,
          oldestUnacknowledgedCompletionAt: 5_000,
          latestUnacknowledgedCompletionAt: 5_000,
        },
        // Acknowledged completion falls through — reviewed work stays quiet.
        ackd: {
          activeAgentCount: 0,
          waitingAgentCount: 0,
          processCount: 1,
          completedAgentCount: 1,
          unacknowledgedCompletedAgentCount: 0,
          latestCompletionAt: 4_000,
        },
      };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(projects.map((p) => p.id)));

      const { result } = renderHook(() => useProjectSwitcherPalette());
      act(() => {
        result.current.open("modal");
      });
      await waitFor(() => {
        expect(result.current.results).toHaveLength(3);
      });

      const sectionOf = (id: string) =>
        result.current.results.map(asProject).find((p) => p.id === id)?.section;
      expect(sectionOf("reviewMe")).toBe("attention");
      expect(sectionOf("ackd")).toBe("other");
    });

    it("sorts attention as blocked, then waits, then oldest-first review", async () => {
      const projects = [base("newDone"), base("oldDone"), base("waitProj"), base("blockedProj")];
      projectState.projects = projects;
      projectState.currentProject = null;
      const completion = (at: number) => ({
        activeAgentCount: 0,
        waitingAgentCount: 0,
        processCount: 0,
        completedAgentCount: 1,
        unacknowledgedCompletedAgentCount: 1,
        oldestUnacknowledgedCompletionAt: at,
        latestUnacknowledgedCompletionAt: at,
      });
      projectStatsState.stats = {
        newDone: completion(9_000),
        oldDone: completion(1_000),
        waitProj: {
          activeAgentCount: 0,
          waitingAgentCount: 1,
          processCount: 0,
          oldestWaitingSince: 8_000,
        },
        blockedProj: {
          activeAgentCount: 0,
          waitingAgentCount: 1,
          blockedAgentCount: 1,
          processCount: 0,
          oldestWaitingSince: 50_000,
        },
      };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(projects.map((p) => p.id)));

      const { result } = renderHook(() => useProjectSwitcherPalette());
      act(() => {
        result.current.open("modal");
      });
      await waitFor(() => {
        expect(result.current.results).toHaveLength(4);
      });

      // Severity tiers: blocked → waiting → review; review is oldest-first so
      // a completion can't starve below a stream of newer ones.
      expect(result.current.results.map((p) => p.id)).toEqual([
        "blockedProj",
        "waitProj",
        "oldDone",
        "newDone",
      ]);
    });

    it("sorts pinned projects alphabetically, ignoring recency and frecency", async () => {
      const projects = [
        base("zulu", { pinned: true, lastOpened: 9_000, frecencyScore: 50.0 }),
        base("alpha", { pinned: true, lastOpened: 100, frecencyScore: 1.0 }),
      ];
      projectState.projects = projects;
      projectState.currentProject = null;
      projectStatsState.stats = {};
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(projects.map((p) => p.id)));

      const { result } = renderHook(() => useProjectSwitcherPalette());
      act(() => {
        result.current.open("modal");
      });
      await waitFor(() => {
        expect(result.current.results).toHaveLength(2);
      });

      // A hidden adaptive score reordering a user-curated set reads as rows
      // moving on their own — alphabetical wins over every usage signal.
      expect(result.current.results.map((p) => p.id)).toEqual(["alpha", "zulu"]);
    });

    it("orders Running by agent count, then the freshest working transition", async () => {
      const projects = [
        base("staleWork", { lastOpened: 9_000 }),
        base("freshWork", { lastOpened: 100 }),
        base("busiest", { lastOpened: 50 }),
      ];
      projectState.projects = projects;
      projectState.currentProject = null;
      projectStatsState.stats = {
        staleWork: {
          activeAgentCount: 1,
          waitingAgentCount: 0,
          processCount: 0,
          latestWorkingSince: 1_000,
        },
        freshWork: {
          activeAgentCount: 1,
          waitingAgentCount: 0,
          processCount: 0,
          latestWorkingSince: 9_000,
        },
        busiest: {
          activeAgentCount: 3,
          waitingAgentCount: 0,
          processCount: 0,
          latestWorkingSince: 500,
        },
      };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(projects.map((p) => p.id)));

      const { result } = renderHook(() => useProjectSwitcherPalette());
      act(() => {
        result.current.open("modal");
      });
      await waitFor(() => {
        expect(result.current.results).toHaveLength(3);
      });

      // busiest leads on agent count; between equals, the freshest working
      // transition wins even though its lastOpened is older.
      expect(result.current.results.map((p) => p.id)).toEqual([
        "busiest",
        "freshWork",
        "staleWork",
      ]);
    });

    it("seeds Running order from bulk stats when no push has arrived", async () => {
      const projects = [base("first", { lastOpened: 9_000 }), base("second", { lastOpened: 100 })];
      projectState.projects = projects;
      projectState.currentProject = null;
      // Cold renderer: nothing pushed yet — the bulk seed is the only source.
      projectStatsState.stats = {};
      const bulk = emptyBulkStats(projects.map((p) => p.id));
      bulk.first!.activeAgentCount = 1;
      bulk.first!.latestWorkingSince = 1_000;
      bulk.second!.activeAgentCount = 1;
      bulk.second!.latestWorkingSince = 9_000;
      getBulkStatsMock.mockResolvedValue(bulk);

      const { result, rerender } = renderHook(() => useProjectSwitcherPalette());
      act(() => {
        result.current.open("modal");
      });
      await waitFor(() => {
        expect(setStatsMock).toHaveBeenCalled();
      });
      act(() => {
        rerender();
      });

      // The open froze a guess before the seed landed; the seed resolves it in
      // place. Without latestWorkingSince riding the bulk contract this would
      // fall back to lastOpened and invert — and without the regroup it would
      // stay inverted for the whole session, since unchanged pushes are
      // suppressed and the freeze would hold the placeholder ordering.
      await waitFor(() => {
        expect(result.current.results.map((p) => p.id)).toEqual(["second", "first"]);
      });
      expect(result.current.results.map(asProject).every((p) => p.section === "running")).toBe(
        true
      );
    });

    it("regroups a cold session in place when stats arrive, then holds", async () => {
      const projects = [base("quiet"), base("busy"), base("stuck")];
      projectState.projects = projects;
      projectState.currentProject = null;
      // No push has reached this view, so every row reads as zero agents.
      projectStatsState.stats = {};
      const bulk = emptyBulkStats(projects.map((p) => p.id));
      bulk.busy!.activeAgentCount = 2;
      bulk.stuck!.waitingAgentCount = 1;
      getBulkStatsMock.mockResolvedValue(bulk);

      const { result, rerender } = renderHook(() => useProjectSwitcherPalette());
      act(() => {
        result.current.open("modal");
      });

      // The freeze taken at open put everything in one band.
      expect(result.current.results.map(asProject).every((p) => p.section === "other")).toBe(true);

      await waitFor(() => {
        expect(setStatsMock).toHaveBeenCalled();
      });
      act(() => {
        rerender();
      });

      // Bands and within-band order both come from the real data, without the
      // user closing and reopening the palette.
      await waitFor(() => {
        expect(result.current.results.map(asProject).map((p) => [p.id, p.section])).toEqual([
          ["stuck", "attention"],
          ["busy", "running"],
          ["quiet", "other"],
        ]);
      });

      // The regroup is spent: the session is now a decision, so a later change
      // is held exactly as it would have been on a warm open.
      act(() => {
        projectStatsState.stats = {
          quiet: { activeAgentCount: 4, waitingAgentCount: 0, processCount: 4 },
          busy: { activeAgentCount: 0, waitingAgentCount: 0, processCount: 0 },
          stuck: { activeAgentCount: 0, waitingAgentCount: 0, processCount: 0 },
        };
        rerender();
      });

      expect(result.current.results.map(asProject).map((p) => [p.id, p.section])).toEqual([
        ["stuck", "attention"],
        ["busy", "running"],
        ["quiet", "other"],
      ]);
      expect(asProject(result.current.results[2]).activeAgentCount).toBe(4);
    });

    it("never preselects an unavailable row while an available one exists", async () => {
      const projects = [
        base("active", { status: "active" }),
        base("gone", { status: "missing" }),
        base("healthy"),
      ];
      projectState.projects = projects;
      projectState.currentProject = { id: "active" };
      projectStatsState.stats = {};
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(projects.map((p) => p.id)));

      const { result } = renderHook(() => useProjectSwitcherPalette());
      act(() => {
        result.current.open("modal");
      });
      await waitFor(() => {
        expect(result.current.results).toHaveLength(3);
      });

      const selected = result.current.results[result.current.selectedIndex]!;
      // Enter-on-open must land on a switchable row, never the relocation
      // dialog a missing row would open.
      expect(selected.id).toBe("healthy");
    });

    it("still preselects something when every other project is missing", async () => {
      const projects = [base("active", { status: "active" }), base("gone", { status: "missing" })];
      projectState.projects = projects;
      projectState.currentProject = { id: "active" };
      projectStatsState.stats = {};
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(projects.map((p) => p.id)));

      const { result } = renderHook(() => useProjectSwitcherPalette());
      act(() => {
        result.current.open("modal");
      });
      await waitFor(() => {
        expect(result.current.results).toHaveLength(2);
      });

      const selected = result.current.results[result.current.selectedIndex]!;
      // The fallback chain lands on the missing row rather than nothing — a
      // selectable row is required for the keyboard contract, and selecting it
      // routes to relocation, which is the only useful action left.
      expect(selected.id).toBe("gone");
    });

    it("sorts attention by blocked first, then by the oldest wait", async () => {
      const projects = [base("newWait"), base("oldWait"), base("blockedProj")];
      projectState.projects = projects;
      projectState.currentProject = null;
      projectStatsState.stats = {
        newWait: {
          activeAgentCount: 0,
          waitingAgentCount: 1,
          processCount: 0,
          oldestWaitingSince: 9_000,
        },
        oldWait: {
          activeAgentCount: 0,
          waitingAgentCount: 1,
          processCount: 0,
          oldestWaitingSince: 1_000,
        },
        blockedProj: {
          activeAgentCount: 0,
          waitingAgentCount: 1,
          blockedAgentCount: 1,
          processCount: 0,
          oldestWaitingSince: 50_000,
        },
      };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(projects.map((p) => p.id)));

      const { result } = renderHook(() => useProjectSwitcherPalette());
      act(() => {
        result.current.open("modal");
      });
      await waitFor(() => {
        expect(result.current.results).toHaveLength(3);
      });

      // A stopped agent outranks a long wait; among plain waits, oldest first.
      expect(result.current.results.map((p) => p.id)).toEqual([
        "blockedProj",
        "oldWait",
        "newWait",
      ]);
    });

    it("holds the order and the bands still while the palette is open", async () => {
      const projects = [base("waiting"), base("idle")];
      projectState.projects = projects;
      projectState.currentProject = null;
      projectStatsState.stats = {
        waiting: { activeAgentCount: 0, waitingAgentCount: 1, processCount: 0 },
      };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(["waiting", "idle"]));

      const { result, rerender } = renderHook(() => useProjectSwitcherPalette());
      act(() => {
        result.current.open("modal");
      });
      await waitFor(() => {
        expect(result.current.results[0]!.id).toBe("waiting");
      });
      expect(asProject(result.current.results[0]).section).toBe("attention");

      // The agent finishes while the user is reading the list, and the push
      // that carries it also fills in the row that had no entry at open. A
      // partial map is not a cold session, so this must not unlock the freeze.
      act(() => {
        projectStatsState.stats = {
          waiting: { activeAgentCount: 0, waitingAgentCount: 0, processCount: 0 },
          idle: { activeAgentCount: 3, waitingAgentCount: 0, processCount: 3 },
        };
        rerender();
      });

      // The row keeps its slot and its band, so nothing moves under the pointer.
      expect(result.current.results[0]!.id).toBe("waiting");
      expect(asProject(result.current.results[0]).section).toBe("attention");
      // Content underneath is live, though.
      expect(asProject(result.current.results[0]).waitingAgentCount).toBe(0);
      expect(asProject(result.current.results[1]).section).toBe("other");
      expect(asProject(result.current.results[1]).activeAgentCount).toBe(3);
    });

    it("regroups a project that registers while the session is still a guess", async () => {
      const first = base("first");
      const late = base("late");
      projectState.projects = [first];
      projectState.currentProject = null;
      projectStatsState.stats = {};
      getBulkStatsMock.mockResolvedValue({});

      const { result, rerender } = renderHook(() => useProjectSwitcherPalette());
      act(() => {
        result.current.open("modal");
      });

      // Registered before anything hydrated, so it joins the pending regroup
      // rather than being locked at the band its missing stats implied.
      act(() => {
        projectState.projects = [first, late];
        rerender();
      });
      act(() => {
        projectStatsState.stats = {
          first: { activeAgentCount: 0, waitingAgentCount: 0, processCount: 0 },
        };
        rerender();
      });
      expect(result.current.results.map(asProject).find((p) => p.id === "late")!.section).toBe(
        "other"
      );

      act(() => {
        projectStatsState.stats = {
          first: { activeAgentCount: 0, waitingAgentCount: 0, processCount: 0 },
          late: { activeAgentCount: 2, waitingAgentCount: 0, processCount: 2 },
        };
        rerender();
      });

      await waitFor(() => {
        expect(result.current.results.map(asProject).find((p) => p.id === "late")!.section).toBe(
          "running"
        );
      });
    });

    it("waits for every guessed row, and a removed one stops holding it up", async () => {
      const first = base("first");
      const removed = base("removed");
      projectState.projects = [first, removed];
      projectState.currentProject = null;
      projectStatsState.stats = {};
      getBulkStatsMock.mockResolvedValue({});

      const { result, rerender } = renderHook(() => useProjectSwitcherPalette());
      act(() => {
        result.current.open("modal");
      });

      // One row resolves, the other has not: a partial answer must not move
      // rows, or the list would regroup in installments under the pointer.
      act(() => {
        projectStatsState.stats = {
          first: { activeAgentCount: 2, waitingAgentCount: 0, processCount: 2 },
        };
        rerender();
      });
      expect(result.current.results.map(asProject).find((p) => p.id === "first")!.section).toBe(
        "other"
      );
      expect(
        result.current.results.map(asProject).find((p) => p.id === "first")!.activeAgentCount
      ).toBe(2);

      // The unresolved row goes away, so nothing is a guess any more.
      act(() => {
        projectState.projects = [first];
        rerender();
      });

      await waitFor(() => {
        expect(asProject(result.current.results[0]).section).toBe("running");
      });
    });

    it("treats an active-only stats map as a guess for the rows that can switch", async () => {
      const projects = [base("active", { status: "active" }), base("busy")];
      projectState.projects = projects;
      projectState.currentProject = { id: "active" };
      // The active row is keyed, but nothing is known about the switch target,
      // so this session is still a guess despite a non-empty map.
      projectStatsState.stats = {
        active: { activeAgentCount: 0, waitingAgentCount: 0, processCount: 0 },
      };
      const bulk = emptyBulkStats(projects.map((p) => p.id));
      bulk.busy!.activeAgentCount = 2;
      getBulkStatsMock.mockResolvedValue(bulk);

      const { result, rerender } = renderHook(() => useProjectSwitcherPalette());
      act(() => {
        result.current.open("modal");
      });
      expect(result.current.results.map(asProject).find((p) => p.id === "busy")!.section).toBe(
        "other"
      );

      await waitFor(() => {
        expect(setStatsMock).toHaveBeenCalled();
      });
      act(() => {
        rerender();
      });

      await waitFor(() => {
        expect(result.current.results.map(asProject).find((p) => p.id === "busy")!.section).toBe(
          "running"
        );
      });
    });

    it("holds a project that arrives after the freeze just as still", async () => {
      projectState.projects = [base("first")];
      projectState.currentProject = null;
      // Keyed and idle, not absent: this session opens on real data, so the
      // freeze is a decision from the start and no regroup is pending.
      projectStatsState.stats = {
        first: { activeAgentCount: 0, waitingAgentCount: 0, processCount: 0 },
      };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(["first"]));

      const { result, rerender } = renderHook(() => useProjectSwitcherPalette());
      act(() => {
        result.current.open("modal");
      });
      await waitFor(() => {
        expect(result.current.results).toHaveLength(1);
      });

      // A second window registers a project while this palette sits open.
      act(() => {
        projectState.projects = [base("first"), base("late")];
        rerender();
      });
      await waitFor(() => {
        expect(result.current.results.map((p) => p.id)).toEqual(["first", "late"]);
      });
      expect(asProject(result.current.results[1]).section).toBe("other");

      // Its agents start working. A late arrival left outside the freeze would
      // jump into the running band above "first"; a frozen one stays put.
      act(() => {
        projectStatsState.stats = {
          late: { activeAgentCount: 2, waitingAgentCount: 0, processCount: 2 },
        };
        rerender();
      });

      expect(result.current.results.map((p) => p.id)).toEqual(["first", "late"]);
      expect(asProject(result.current.results[1]).section).toBe("other");
      expect(asProject(result.current.results[1]).activeAgentCount).toBe(2);
    });

    it("re-bands on the next open", async () => {
      const projects = [base("waiting"), base("idle")];
      projectState.projects = projects;
      projectState.currentProject = null;
      projectStatsState.stats = {
        waiting: { activeAgentCount: 0, waitingAgentCount: 1, processCount: 0 },
      };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(["waiting", "idle"]));

      const { result, rerender } = renderHook(() => useProjectSwitcherPalette());
      act(() => {
        result.current.open("modal");
      });
      await waitFor(() => {
        expect(asProject(result.current.results[0]).section).toBe("attention");
      });

      act(() => {
        result.current.close();
      });
      act(() => {
        projectStatsState.stats = {
          waiting: { activeAgentCount: 0, waitingAgentCount: 0, processCount: 0 },
        };
        // A real stats push updates the store and renders; the layout captured
        // on the next open has to come from that render, not the one before it.
        rerender();
      });
      act(() => {
        result.current.open("modal");
      });

      await waitFor(() => {
        expect(result.current.results.map(asProject).every((p) => p.section !== "attention")).toBe(
          true
        );
      });
    });

    it("carries pushed blocked and wait-age data through to the row", async () => {
      const projects = [base("p")];
      projectState.projects = projects;
      projectState.currentProject = null;
      projectStatsState.stats = {
        p: {
          activeAgentCount: 0,
          waitingAgentCount: 3,
          blockedAgentCount: 1,
          oldestWaitingSince: 4_242,
          processCount: 0,
        },
      };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(["p"]));

      const { result } = renderHook(() => useProjectSwitcherPalette());
      act(() => {
        result.current.open("modal");
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(1);
      });
      const row = asProject(result.current.results[0]);
      expect(row.blockedAgentCount).toBe(1);
      expect(row.oldestWaitingSince).toBe(4_242);
      expect(row.section).toBe("attention");
    });
  });

  // #11071: browse used to render a narrower list than the one selectedIndex
  // walked, so arrowing could land on a project that was never on screen — no
  // highlight, and Enter switched to an off-screen project. `results` is the
  // single array the palette renders, sections and indexes; the guarantee has
  // to survive now that browse is section-ordered rather than flat.
  describe("browse list — issue #11071", () => {
    const interleaved = [
      {
        id: "current",
        name: "Current Project",
        path: "/repo/current",
        emoji: "🌲",
        color: "#00aa00",
        lastOpened: 300,
        frecencyScore: 10.0,
        status: "active" as const,
      },
      {
        id: "closed",
        name: "Closed Project",
        path: "/repo/closed",
        emoji: "🌿",
        color: "#00bb00",
        lastOpened: 200,
        frecencyScore: 7.0,
        status: "closed" as const,
      },
      {
        id: "background",
        name: "Background Project",
        path: "/repo/background",
        emoji: "🌴",
        color: "#00cc00",
        lastOpened: 100,
        frecencyScore: 3.0,
        status: "background" as const,
      },
    ];

    beforeEach(() => {
      projectState.projects = interleaved;
      projectState.currentProject = { id: "current" };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(interleaved.map((p) => p.id)));
    });

    async function openIn(mode: "modal" | "dropdown") {
      const { result } = renderHook(() => useProjectSwitcherPalette());
      act(() => {
        result.current.open(mode);
      });
      await waitFor(() => {
        expect(result.current.isOpen).toBe(true);
      });
      return result;
    }

    it("lists every project in the same order in both modes", async () => {
      const modal = await openIn("modal");
      await waitFor(() => {
        expect(modal.current.results).toHaveLength(3);
      });
      const modalOrder = modal.current.results.map((p) => p.id);
      const modalSections = modal.current.results.map(asProject).map((p) => p.section);

      const dropdown = await openIn("dropdown");
      await waitFor(() => {
        expect(dropdown.current.results).toHaveLength(3);
      });

      // Compared in order, not as sets: the two surfaces previously agreed on
      // neither scope nor grouping, and membership alone would not catch that.
      expect(dropdown.current.results.map((p) => p.id)).toEqual(modalOrder);
      expect(dropdown.current.results.map(asProject).map((p) => p.section)).toEqual(modalSections);
      expect(modalOrder).toContain("closed");
    });

    it("puts the current project first and groups the rest into contiguous sections", async () => {
      const result = await openIn("modal");

      await waitFor(() => {
        expect(result.current.results).toHaveLength(3);
      });
      expect(asProject(result.current.results[0]).section).toBe("current");

      // Sections must never interleave, or the component's contiguous-run
      // grouping would emit the same header twice.
      const seen: string[] = [];
      for (const project of result.current.results.map(asProject)) {
        if (seen.at(-1) !== project.section) seen.push(project.section);
      }
      expect(new Set(seen).size).toBe(seen.length);
    });

    it("visits every result exactly once per cycle and never lands off-list", async () => {
      const result = await openIn("modal");
      await waitFor(() => {
        expect(result.current.results).toHaveLength(3);
      });

      const size = result.current.results.length;
      const visited: string[] = [];
      for (let step = 0; step < size; step++) {
        const selected = result.current.results[result.current.selectedIndex];
        // Asserting "defined" alone would pass even if the selection never
        // moved — the identities have to be collected and compared.
        expect(selected).toBeDefined();
        visited.push(selected!.id);
        act(() => {
          result.current.selectNext();
        });
      }
      expect(new Set(visited).size).toBe(size);
      expect([...visited].sort()).toEqual(result.current.results.map((p) => p.id).sort());

      // One more step wraps back to where the cycle began.
      expect(result.current.results[result.current.selectedIndex]!.id).toBe(visited[0]);

      const backwards: string[] = [];
      for (let step = 0; step < size; step++) {
        act(() => {
          result.current.selectPrevious();
        });
        const selected = result.current.results[result.current.selectedIndex];
        expect(selected).toBeDefined();
        backwards.push(selected!.id);
      }
      expect(new Set(backwards).size).toBe(size);
    });

    it("confirmSelection switches to the highlighted project", async () => {
      const result = await openIn("modal");
      await waitFor(() => {
        expect(result.current.results).toHaveLength(3);
      });

      const highlighted = result.current.results[result.current.selectedIndex]!;
      expect(highlighted.isActive).toBe(false);

      act(() => {
        result.current.confirmSelection();
      });

      await waitFor(() => {
        const called =
          projectState.switchProject.mock.calls.length +
          projectState.reopenProject.mock.calls.length;
        expect(called).toBeGreaterThan(0);
      });
      const target =
        projectState.switchProject.mock.calls[0]?.[0] ??
        projectState.reopenProject.mock.calls[0]?.[0];
      expect(target).toBe(highlighted.id);
    });

    it("treats picking the current project as a dismissal, not a dead end", async () => {
      const result = await openIn("modal");
      await waitFor(() => {
        expect(result.current.results).toHaveLength(3);
      });

      const current = asProject(result.current.results.find((project) => project.isActive));

      act(() => {
        void result.current.selectProject(current);
      });

      await waitFor(() => {
        expect(result.current.isOpen).toBe(false);
      });
      // Nothing to switch to — but the palette must not just sit there.
      expect(projectState.switchProject).not.toHaveBeenCalled();
      expect(projectState.reopenProject).not.toHaveBeenCalled();
    });

    it("preselects the first row that isn't the active project, in either mode", async () => {
      for (const mode of ["modal", "dropdown"] as const) {
        const result = await openIn(mode);
        await waitFor(() => {
          expect(result.current.results).toHaveLength(3);
        });
        expect(result.current.results[result.current.selectedIndex]!.isActive).toBe(false);
        expect(result.current.selectedIndex).toBe(1);
      }
    });

    it("renders projects far past the old fifteen-row cap", async () => {
      const many = Array.from({ length: 40 }, (_, i) => ({
        id: `idle-${i}`,
        name: `Idle ${i}`,
        path: `/repo/idle-${i}`,
        emoji: "🌿",
        lastOpened: 1000 - i,
        frecencyScore: 1.0,
        status: "closed" as const,
      }));

      projectState.projects = many;
      projectState.currentProject = null;
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(many.map((p) => p.id)));

      const result = await openIn("modal");

      await waitFor(() => {
        expect(result.current.results).toHaveLength(40);
      });
      expect(result.current.results.map((p) => p.id)).toContain("idle-39");
    });

    it("keeps the highlight on the selected project when a row above it disappears", async () => {
      const withThreeVisible = [
        interleaved[0]!,
        { ...interleaved[2]!, id: "bg-a", name: "Background A", lastOpened: 250 },
        { ...interleaved[2]!, id: "bg-b", name: "Background B", lastOpened: 150 },
        { ...interleaved[2]!, id: "bg-c", name: "Background C", lastOpened: 50 },
      ];
      projectState.projects = withThreeVisible;
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(withThreeVisible.map((p) => p.id)));

      const { result, rerender } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open("modal");
      });
      await waitFor(() => {
        expect(result.current.results).toHaveLength(4);
      });

      // Land on a middle row so there is a row above it to remove.
      act(() => {
        result.current.selectNext();
      });
      act(() => {
        result.current.selectNext();
      });
      const held = result.current.results[result.current.selectedIndex]!.id;
      const above = result.current.results
        .slice(0, result.current.selectedIndex)
        .map((p) => p.id)
        .find((id) => id !== held);
      expect(above).toBeDefined();

      act(() => {
        projectState.projects = withThreeVisible.filter((p) => p.id !== above);
        rerender();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(3);
      });
      // The highlight tracks the PROJECT, not the slot it used to occupy.
      expect(result.current.results[result.current.selectedIndex]!.id).toBe(held);
    });

    it("finds any project by search regardless of its state", async () => {
      const result = await openIn("modal");
      await waitFor(() => {
        expect(result.current.results).toHaveLength(3);
      });

      act(() => {
        result.current.setQuery("Closed");
      });

      await waitFor(() => {
        expect(result.current.results.map((p) => p.id)).toContain("closed");
      });
    });

    it("counts non-active agents in the badge totals", async () => {
      getBulkStatsMock.mockResolvedValue({
        ...emptyBulkStats(interleaved.map((p) => p.id)),
        closed: {
          processCount: 0,
          terminalCount: 0,
          estimatedMemoryMB: 0,
          terminalTypes: {},
          processIds: [],
          activeAgentCount: 0,
          waitingAgentCount: 2,
          blockedAgentCount: 0,
        },
      });

      const result = await openIn("modal");

      await waitFor(() => {
        expect(result.current.nonActiveAgentCounts.waitingAgentCount).toBe(2);
      });
      // One project needs attention, not two agents' worth of obligation.
      expect(result.current.nonActiveAgentCounts.waitingProjectCount).toBe(1);
    });
  });
});
