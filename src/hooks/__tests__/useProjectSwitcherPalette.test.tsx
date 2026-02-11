// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getStatsMock,
  getForProjectMock,
  useProjectStoreMock,
  useNotificationStoreMock,
  projectState,
} = vi.hoisted(() => {
  const getStatsMock = vi.fn();
  const getForProjectMock = vi.fn();

  const projectState = {
    projects: [
      {
        id: "project-1",
        name: "Project One",
        path: "/repo/one",
        emoji: "🌲",
        color: "#00aa00",
        lastOpened: 123,
        status: "active" as const,
      },
    ],
    currentProject: null as { id: string } | null,
    switchProject: vi.fn().mockResolvedValue(undefined),
    reopenProject: vi.fn().mockResolvedValue(undefined),
    loadProjects: vi.fn().mockResolvedValue(undefined),
    addProject: vi.fn().mockResolvedValue(undefined),
    closeProject: vi.fn().mockResolvedValue({ processesKilled: 0 }),
    removeProject: vi.fn().mockResolvedValue(undefined),
  };

  const useProjectStoreMock = vi.fn((selector: (state: typeof projectState) => unknown) =>
    selector(projectState)
  );
  const useNotificationStoreMock = vi.fn(() => ({
    addNotification: vi.fn(),
  }));

  return {
    getStatsMock,
    getForProjectMock,
    useProjectStoreMock,
    useNotificationStoreMock,
    projectState,
  };
});

vi.mock("@/clients", () => ({
  projectClient: {
    getStats: getStatsMock,
  },
  terminalClient: {
    getForProject: getForProjectMock,
  },
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: useProjectStoreMock,
}));

vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: useNotificationStoreMock,
}));

vi.mock("@shared/config/panelKindRegistry", () => ({
  panelKindHasPty: vi.fn(() => true),
}));

vi.mock("@/utils/terminalType", () => ({
  isAgentTerminal: vi.fn(() => true),
}));

import { useProjectSwitcherPalette } from "../useProjectSwitcherPalette";

describe("useProjectSwitcherPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectState.currentProject = null;
  });

  it("tolerates malformed terminal lists when fetching project stats", async () => {
    getStatsMock.mockResolvedValue({
      processCount: 0,
      terminalCount: 0,
      estimatedMemoryMB: 0,
      terminalTypes: {},
      processIds: [],
    });
    getForProjectMock.mockResolvedValue(undefined);

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
    getStatsMock.mockResolvedValue({
      processCount: 0,
      terminalCount: 0,
      estimatedMemoryMB: 0,
      terminalTypes: {},
      processIds: [],
    });
    getForProjectMock.mockResolvedValue([]);

    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => {
      result.current.open();
    });

    await waitFor(() => {
      expect(result.current.isOpen).toBe(true);
      expect(result.current.results).toHaveLength(1);
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
        status: "active" as const,
      },
      {
        id: "project-2",
        name: "Previous Project",
        path: "/repo/previous",
        emoji: "🌿",
        color: "#00bb00",
        lastOpened: 200,
        status: "active" as const,
      },
      {
        id: "project-3",
        name: "Old Project",
        path: "/repo/old",
        emoji: "🌴",
        color: "#00cc00",
        lastOpened: 100,
        status: "active" as const,
      },
    ];

    it("defaults to index 1 when 2+ projects exist", async () => {
      projectState.projects = multipleProjects;
      projectState.currentProject = { id: "project-1" };
      getStatsMock.mockResolvedValue({
        processCount: 0,
        terminalCount: 0,
        estimatedMemoryMB: 0,
        terminalTypes: {},
        processIds: [],
      });
      getForProjectMock.mockResolvedValue([]);

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(3);
      });

      expect(result.current.selectedIndex).toBe(1);
    });

    it("defaults to index 0 when only 1 project exists", async () => {
      projectState.projects = [multipleProjects[0]];
      projectState.currentProject = { id: "project-1" };
      getStatsMock.mockResolvedValue({
        processCount: 0,
        terminalCount: 0,
        estimatedMemoryMB: 0,
        terminalTypes: {},
        processIds: [],
      });
      getForProjectMock.mockResolvedValue([]);

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
      getStatsMock.mockResolvedValue({
        processCount: 0,
        terminalCount: 0,
        estimatedMemoryMB: 0,
        terminalTypes: {},
        processIds: [],
      });
      getForProjectMock.mockResolvedValue([]);

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(0);
      });

      expect(result.current.selectedIndex).toBe(0);
    });

    it("defaults to index 1 with exactly 2 projects", async () => {
      projectState.projects = [multipleProjects[0], multipleProjects[1]];
      projectState.currentProject = { id: "project-1" };
      getStatsMock.mockResolvedValue({
        processCount: 0,
        terminalCount: 0,
        estimatedMemoryMB: 0,
        terminalTypes: {},
        processIds: [],
      });
      getForProjectMock.mockResolvedValue([]);

      const { result } = renderHook(() => useProjectSwitcherPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(2);
      });

      expect(result.current.selectedIndex).toBe(1);
      expect(result.current.results[1].id).toBe("project-2");
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
        status: "active" as const,
      },
      {
        id: "project-2",
        name: "Previous Project",
        path: "/repo/previous",
        emoji: "🌿",
        color: "#00bb00",
        lastOpened: 200,
        status: "active" as const,
      },
      {
        id: "project-3",
        name: "Old Project",
        path: "/repo/old",
        emoji: "🌴",
        color: "#00cc00",
        lastOpened: 100,
        status: "active" as const,
      },
    ];

    it("advances selection when toggled while open", async () => {
      projectState.projects = threeProjects;
      projectState.currentProject = { id: "project-1" };
      getStatsMock.mockResolvedValue({
        processCount: 0,
        terminalCount: 0,
        estimatedMemoryMB: 0,
        terminalTypes: {},
        processIds: [],
      });
      getForProjectMock.mockResolvedValue([]);

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

    it("wraps to index 1 at end of list (skipping current project)", async () => {
      projectState.projects = threeProjects;
      projectState.currentProject = { id: "project-1" };
      getStatsMock.mockResolvedValue({
        processCount: 0,
        terminalCount: 0,
        estimatedMemoryMB: 0,
        terminalTypes: {},
        processIds: [],
      });
      getForProjectMock.mockResolvedValue([]);

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
      expect(result.current.selectedIndex).toBe(1);
    });

    it("is a no-op with only 1 project", async () => {
      projectState.projects = [threeProjects[0]];
      projectState.currentProject = { id: "project-1" };
      getStatsMock.mockResolvedValue({
        processCount: 0,
        terminalCount: 0,
        estimatedMemoryMB: 0,
        terminalTypes: {},
        processIds: [],
      });
      getForProjectMock.mockResolvedValue([]);

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

    it("wraps to first non-active project when active project not at index 0", async () => {
      const projectsWithActiveNotFirst = [
        {
          id: "project-1",
          name: "Old Project",
          path: "/repo/old",
          emoji: "🌴",
          color: "#00cc00",
          lastOpened: 100,
          status: "active" as const,
        },
        {
          id: "project-2",
          name: "Current Project",
          path: "/repo/current",
          emoji: "🌲",
          color: "#00aa00",
          lastOpened: 300,
          status: "active" as const,
        },
        {
          id: "project-3",
          name: "Recent Project",
          path: "/repo/recent",
          emoji: "🌿",
          color: "#00bb00",
          lastOpened: 200,
          status: "active" as const,
        },
      ];

      projectState.projects = projectsWithActiveNotFirst;
      projectState.currentProject = { id: "project-2" };
      getStatsMock.mockResolvedValue({
        processCount: 0,
        terminalCount: 0,
        estimatedMemoryMB: 0,
        terminalTypes: {},
        processIds: [],
      });
      getForProjectMock.mockResolvedValue([]);

      const { result } = renderHook(() => useProjectSwitcherPalette());

      await act(async () => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results).toHaveLength(3);
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
