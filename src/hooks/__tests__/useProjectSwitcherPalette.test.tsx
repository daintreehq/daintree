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
});
