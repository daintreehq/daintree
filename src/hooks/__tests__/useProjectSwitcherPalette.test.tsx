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
      { activeAgentCount: number; waitingAgentCount: number; processCount: number }
    >,
  };

  const setStatsMock = vi.fn((stats: typeof projectStatsState.stats) => {
    projectStatsState.stats = stats;
  });

  // Modal browse lists only projects the user can switch to right now, so a
  // fixture that is not `currentProject` needs a reason to be listed —
  // "background" is the realistic one. A "closed"/idle non-current project is
  // correctly absent from `results` (#11071).
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
import { useProjectSwitcherPalette } from "../useProjectSwitcherPalette";

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
      expect(result.current.results[0]?.activeAgentCount).toBe(0);
      expect(result.current.results[0]?.waitingAgentCount).toBe(0);
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
      expect(result.current.results[0]?.activeAgentCount).toBe(1);
      expect(result.current.results[0]?.waitingAgentCount).toBe(1);
      expect(result.current.results[0]?.processCount).toBe(3);
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

    it("defaults to the MRU head when a scratch is active (no project is active)", async () => {
      // A scratch clears `currentProject` without touching any project's
      // `lastOpened`, and the departed project reconciles to "background". The
      // preselected row must be the pre-scratch project itself, not the row
      // after it — there is no active row to skip past (#11085).
      const scratchProjects = multipleProjects.map((project) => ({
        ...project,
        status: "background" as const,
      }));
      // Supplied out of MRU order so the assertion proves the computed sort,
      // not the fixture's array position.
      projectState.projects = [scratchProjects[2]!, scratchProjects[0]!, scratchProjects[1]!];
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
      expect(result.current.results[result.current.selectedIndex]?.id).toBe(freshest.id);
    });

    it("sorts by lastOpened, ignoring frecencyScore", async () => {
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

      // project-b has lower frecency but higher lastOpened — should come first
      expect(result.current.results[0]!.id).toBe("project-b");
      expect(result.current.results[1]!.id).toBe("project-a");
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
        expect(result.current.results[0]?.processCount).toBe(2);
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

    it("keeps activeProject populated even when the active project sits outside the 15-item results cap", async () => {
      // Build 20 projects with the active project at the back of the MRU list
      // (lowest lastOpened). With MAX_RESULTS=15, the active project should
      // NOT appear in results, but activeProject must still expose it.
      const projects = Array.from({ length: 20 }, (_, i) => makeProject(i + 1));
      // Make project-20 the most-stale entry so it falls outside the 15 window.
      projects[19] = { ...projects[19]!, lastOpened: 0 };
      projectState.projects = projects;
      projectState.currentProject = { id: "project-20" };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(projects.map((p) => p.id)));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      await waitFor(() => {
        expect(result.current.activeProject?.id).toBe("project-20");
      });

      const idsInResults = result.current.results.map((p) => p.id);
      expect(idsInResults).not.toContain("project-20");
      expect(result.current.results).toHaveLength(15);
      expect(result.current.activeProject?.isActive).toBe(true);
      // Fields the pill context-menu reads must remain populated even when
      // the active project sits outside the results window.
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
        },
      });

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(setStatsMock).toHaveBeenCalledWith({
          "project-1": { activeAgentCount: 1, waitingAgentCount: 3, processCount: 2 },
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

  // #11071: modal browse used to render a narrower list than the one
  // selectedIndex walked, so arrowing could land on a project that was never
  // on screen — no highlight, and Enter switched to an off-screen project.
  // `results` is now the single array the palette scopes, renders and indexes.
  describe("modal browse scope — issue #11071", () => {
    // MRU order interleaves a closed project between the two the modal shows,
    // which is exactly the arrangement that stranded the selection.
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

    async function openModal() {
      const { result } = renderHook(() => useProjectSwitcherPalette());
      act(() => {
        result.current.open("modal");
      });
      await waitFor(() => {
        expect(result.current.isOpen).toBe(true);
      });
      return result;
    }

    it("omits an idle project from modal browse even when it is more recent", async () => {
      const result = await openModal();

      await waitFor(() => {
        expect(result.current.results.map((p) => p.id)).toEqual(["current", "background"]);
      });
    });

    it("lands every arrow step on a project that is actually in results", async () => {
      const result = await openModal();
      await waitFor(() => {
        expect(result.current.results).toHaveLength(2);
      });

      // One full cycle in each direction: every stop must be a rendered row.
      const visited: string[] = [];
      for (let step = 0; step < result.current.results.length * 2; step++) {
        const selected = result.current.results[result.current.selectedIndex];
        expect(selected).toBeDefined();
        visited.push(selected!.id);
        act(() => {
          result.current.selectNext();
        });
      }
      for (let step = 0; step < result.current.results.length; step++) {
        act(() => {
          result.current.selectPrevious();
        });
        expect(result.current.results[result.current.selectedIndex]).toBeDefined();
      }

      expect(visited).not.toContain("closed");
    });

    it("confirmSelection switches to the highlighted project, never a scoped-out one", async () => {
      const result = await openModal();
      await waitFor(() => {
        expect(result.current.results).toHaveLength(2);
      });

      // Row 2 is the MRU switch target — under the old unscoped index this was
      // the closed project sitting at results[1].
      const highlighted = result.current.results[result.current.selectedIndex]!;
      expect(highlighted.id).toBe("background");

      act(() => {
        result.current.confirmSelection();
      });

      await waitFor(() => {
        expect(projectState.reopenProject).toHaveBeenCalledWith("background");
      });
      expect(projectState.switchProject).not.toHaveBeenCalledWith("closed");
      expect(projectState.reopenProject).not.toHaveBeenCalledWith("closed");
    });

    it("preselects against the destination list, not the mode being left", async () => {
      // Only the current project survives modal scope here, so the row-2 rule
      // MUST resolve against the destination list: counting all projects (or
      // the outgoing mode's list) would preselect a row modal doesn't have.
      projectState.projects = [interleaved[0]!, interleaved[1]!];
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(["current", "closed"]));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open("dropdown");
      });
      await waitFor(() => {
        expect(result.current.results).toHaveLength(2);
      });
      // Dropdown lists both, so row 2 is the closed project.
      expect(result.current.selectedIndex).toBe(1);
      expect(result.current.results[1]!.id).toBe("closed");

      act(() => {
        result.current.open("modal");
      });
      await waitFor(() => {
        expect(result.current.results).toHaveLength(1);
      });
      // Modal has a single row — the only valid selection is it.
      expect(result.current.selectedIndex).toBe(0);
      expect(result.current.results[0]!.id).toBe("current");
    });

    it("keeps a switchable project past the unscoped window inside modal browse", async () => {
      // Enough recent idle projects to fill the results cap on their own. The
      // background project is the stalest of all, so scoping BEFORE the cap is
      // the only way it survives — capping first would slice it away.
      const idle = Array.from({ length: 20 }, (_, i) => ({
        id: `idle-${i}`,
        name: `Idle ${i}`,
        path: `/repo/idle-${i}`,
        emoji: "🌿",
        lastOpened: 1000 - i,
        frecencyScore: 1.0,
        status: "closed" as const,
      }));
      const stale = {
        id: "stale-background",
        name: "Stale Background",
        path: "/repo/stale",
        emoji: "🌴",
        lastOpened: 1,
        frecencyScore: 1.0,
        status: "background" as const,
      };

      projectState.projects = [...idle, stale];
      projectState.currentProject = null;
      getBulkStatsMock.mockResolvedValue(emptyBulkStats([...idle.map((p) => p.id), stale.id]));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open("modal");
      });

      await waitFor(() => {
        expect(result.current.results.map((p) => p.id)).toEqual(["stale-background"]);
      });
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

      // Land on a MIDDLE row: bg-b at index 2.
      act(() => {
        result.current.selectNext();
      });
      expect(result.current.results[result.current.selectedIndex]!.id).toBe("bg-b");

      // A row ABOVE the selection goes away — every later row shifts up one.
      act(() => {
        projectState.projects = withThreeVisible.filter((p) => p.id !== "bg-a");
        rerender();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(3);
      });
      // The highlight tracks the project, not the slot it used to occupy.
      expect(result.current.results[result.current.selectedIndex]!.id).toBe("bg-b");
      expect(result.current.selectedIndex).toBeLessThan(result.current.results.length);
    });

    it("still finds a scoped-out project by search", async () => {
      const result = await openModal();
      await waitFor(() => {
        expect(result.current.results).toHaveLength(2);
      });

      act(() => {
        result.current.setQuery("Closed");
      });

      await waitFor(() => {
        expect(result.current.results.map((p) => p.id)).toContain("closed");
      });
    });

    it("keeps a scoped-out project's agents in the badge totals", async () => {
      // Agent counts and process counts arrive from separate ProjectStatsService
      // calls, so a waiting agent can land before its process count does. The
      // badge reads uncapped, unscoped totals so it can't blink off just
      // because modal browse drops that project for a beat.
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
        },
      });

      const result = await openModal();

      await waitFor(() => {
        expect(result.current.nonActiveAgentCounts.waitingAgentCount).toBe(2);
      });
      expect(result.current.results.map((p) => p.id)).not.toContain("closed");
    });
  });
});
