// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getBulkStatsMock, useProjectStoreMock, notifyMock, projectState, projectStatsState } =
  vi.hoisted(() => {
    const getBulkStatsMock = vi.fn();

    const projectStatsState = {
      stats: {} as Record<
        string,
        { activeAgentCount: number; waitingAgentCount: number; processCount: number }
      >,
    };

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

    const useProjectStoreMock = vi.fn((selector: (state: typeof projectState) => unknown) =>
      selector(projectState)
    );
    const notifyMock = vi.fn().mockReturnValue("");

    return {
      getBulkStatsMock,
      useProjectStoreMock,
      notifyMock,
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
  useProjectStatsStore: vi.fn((selector: (state: typeof projectStatsState) => unknown) =>
    selector(projectStatsState)
  ),
}));

vi.mock("@/lib/notify", () => ({
  notify: notifyMock,
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

    it("defaults to index 0 (most recent non-active) when 2+ projects exist", async () => {
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

      expect(result.current.selectedIndex).toBe(0);
      expect(result.current.results[0].id).toBe("project-2");
      expect(result.current.results[2].id).toBe("project-1");
    });

    it("defaults to index 0 when only 1 project exists", async () => {
      projectState.projects = [multipleProjects[0]];
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

    it("defaults to index 0 with exactly 2 projects (non-active first)", async () => {
      projectState.projects = [multipleProjects[0], multipleProjects[1]];
      projectState.currentProject = { id: "project-1" };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(["project-1", "project-2"]));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(2);
      });

      expect(result.current.selectedIndex).toBe(0);
      expect(result.current.results[0].id).toBe("project-2");
      expect(result.current.results[1].id).toBe("project-1");
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
          title: "Failed to close project",
        })
      );
    });
  });

  describe("search behavior", () => {
    const searchProjects = [
      {
        id: "project-1",
        name: "canopy-app",
        path: "/repos/canopy-app",
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
        name: "my-canopy-tools",
        path: "/repos/my-canopy-tools",
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
        result.current.setQuery("canopy");
      });

      // Results should be available immediately — no waitFor needed
      expect(result.current.results.length).toBeGreaterThanOrEqual(2);
      expect(result.current.results[0].name).toContain("canopy");
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
        result.current.setQuery("canopy");
      });
      expect(result.current.results.length).toBeLessThan(3);

      act(() => {
        result.current.setQuery("");
      });
      expect(result.current.results).toHaveLength(3);
    });
  });

  describe("toggle advances selection", () => {
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
        expect(result.current.selectedIndex).toBe(0);
      });

      expect(result.current.isOpen).toBe(true);

      await act(async () => {
        result.current.toggle();
      });

      expect(result.current.isOpen).toBe(true);
      expect(result.current.selectedIndex).toBe(1);
    });

    it("wraps to first non-active at end of list", async () => {
      projectState.projects = threeProjects;
      projectState.currentProject = { id: "project-1" };
      getBulkStatsMock.mockResolvedValue(emptyBulkStats(threeProjects.map((p) => p.id)));

      const { result } = renderHook(() => useProjectSwitcherPalette());

      await act(async () => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(3);
        expect(result.current.selectedIndex).toBe(0);
      });

      await act(async () => {
        result.current.toggle();
      });
      expect(result.current.selectedIndex).toBe(1);

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
      projectState.projects = [threeProjects[0]];
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

    it("wraps to first non-active project when cycling through all", async () => {
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

      // Non-active projects come first, active last
      expect(result.current.results[0].isActive).toBe(false);
      expect(result.current.selectedIndex).toBe(0);

      await act(async () => {
        result.current.toggle();
      });
      expect(result.current.selectedIndex).toBe(1);

      await act(async () => {
        result.current.toggle();
      });
      expect(result.current.selectedIndex).toBe(2);

      await act(async () => {
        result.current.toggle();
      });

      const firstNonActive = result.current.results.findIndex((p) => !p.isActive);
      expect(result.current.selectedIndex).toBe(firstNonActive);
    });
  });
});
