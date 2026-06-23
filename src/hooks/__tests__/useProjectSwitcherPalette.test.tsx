// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getBulkStatsMock,
  setStatsMock,
  useProjectStoreMock,
  useProjectStatsStoreMock,
  notifyMock,
  copyMock,
  projectState,
  projectStatsState,
} = vi.hoisted(() => {
  const getBulkStatsMock = vi.fn();
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

  const projectState = {
    projects: [
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
    ],
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
        status: "active" as const,
      },
      {
        id: "project-3",
        name: "Old Project",
        path: "/repo/old",
        emoji: "🌴",
        color: "#00cc00",
        lastOpened: 100,
        frecencyScore: 3.0,
        status: "active" as const,
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
          status: "active" as const,
        },
        {
          id: "project-b",
          name: "Low Frecency",
          path: "/repo/b",
          emoji: "🌿",
          color: "#00bb00",
          lastOpened: 300,
          frecencyScore: 1.0,
          status: "active" as const,
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
      status: "active" as const,
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
        status: "active" as const,
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
        status: "active" as const,
      },
      {
        id: "project-2",
        name: "other-service",
        path: "/repos/other-service",
        emoji: "🌿",
        color: "#00bb00",
        lastOpened: 200,
        frecencyScore: 7.0,
        status: "active" as const,
      },
      {
        id: "project-3",
        name: "my-daintree-tools",
        path: "/repos/my-daintree-tools",
        emoji: "🌴",
        color: "#00cc00",
        lastOpened: 100,
        frecencyScore: 3.0,
        status: "active" as const,
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
        status: "active" as const,
      },
      {
        id: "project-3",
        name: "Old Project",
        path: "/repo/old",
        emoji: "🌴",
        color: "#00cc00",
        lastOpened: 100,
        frecencyScore: 3.0,
        status: "active" as const,
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
          status: "active" as const,
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
          status: "active" as const,
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

    it("tolerates a bulk stats fetch rejection without throwing", async () => {
      getBulkStatsMock.mockRejectedValueOnce(new Error("stats failed"));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.isOpen).toBe(true);
        expect(getBulkStatsMock).toHaveBeenCalledWith(["project-1"]);
      });
      expect(setStatsMock).not.toHaveBeenCalled();
    });
  });
});
