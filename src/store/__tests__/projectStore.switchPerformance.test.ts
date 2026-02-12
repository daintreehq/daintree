// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const projectClientMock = {
  getAll: vi.fn(),
  getCurrent: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  switch: vi.fn(),
  reopen: vi.fn(),
  openDialog: vi.fn(),
  onSwitch: vi.fn(() => () => {}),
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  detectRunners: vi.fn(),
  close: vi.fn(),
  getStats: vi.fn(),
  setTerminals: vi.fn(),
  setTerminalSizes: vi.fn(),
};

const terminalState = {
  terminals: [] as Array<{
    id: string;
    kind?: string;
    type?: string;
    title?: string;
    cwd?: string;
    location?: "grid" | "dock" | "trash";
    worktreeId?: string;
  }>,
};

const terminalPersistenceMock = {
  whenIdle: vi.fn(),
  setProjectIdGetter: vi.fn(),
};
const resetAllStoresForProjectSwitchMock = vi.fn().mockResolvedValue(undefined);

const terminalToSnapshotMock = vi.fn(
  (terminal: { id: string; cwd?: string; location?: string; worktreeId?: string }) => ({
    id: terminal.id,
    cwd: terminal.cwd ?? "",
    location: terminal.location ?? "grid",
    worktreeId: terminal.worktreeId,
  })
);

vi.mock("@/clients", () => ({
  projectClient: projectClientMock,
}));

vi.mock("../resetStores", () => ({
  resetAllStoresForProjectSwitch: resetAllStoresForProjectSwitchMock,
}));

vi.mock("../worktreeDataStore", () => ({
  forceReinitializeWorktreeDataStore: vi.fn(),
}));

vi.mock("../worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => ({
      activeWorktreeId: "wt-a",
    }),
  },
}));

vi.mock("../terminalStore", () => ({
  useTerminalStore: {
    getState: () => terminalState,
  },
}));

vi.mock("../projectSettingsStore", () => ({
  useProjectSettingsStore: {
    getState: () => ({
      reset: vi.fn(),
      loadSettings: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

vi.mock("../notificationStore", () => ({
  useNotificationStore: {
    getState: () => ({
      addNotification: vi.fn(),
    }),
  },
}));

vi.mock("../slices", () => ({
  flushTerminalPersistence: vi.fn(),
}));

vi.mock("../persistence/terminalPersistence", () => ({
  terminalPersistence: terminalPersistenceMock,
  terminalToSnapshot: terminalToSnapshotMock,
}));

vi.mock("@/utils/errorContext", () => ({
  logErrorWithContext: vi.fn(),
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    get: vi.fn().mockReturnValue(null),
  },
}));

const { useProjectStore } = await import("../projectStore");

describe("projectStore switch performance", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const projectA = {
      id: "project-a",
      name: "Project A",
      path: "/project-a",
      emoji: "folder",
      lastOpened: Date.now() - 1000,
    };
    const projectB = {
      id: "project-b",
      name: "Project B",
      path: "/project-b",
      emoji: "folder",
      lastOpened: Date.now(),
    };

    useProjectStore.setState({
      projects: [projectA, projectB],
      currentProject: projectA,
      isLoading: false,
      isSwitching: false,
      switchingToProjectName: null,
      error: null,
    });

    terminalState.terminals = [
      {
        id: "terminal-1",
        kind: "terminal",
        cwd: "/project-a",
        location: "grid",
        worktreeId: "wt-a",
      },
      {
        id: "terminal-2",
        kind: "terminal",
        cwd: "/project-a/other",
        location: "grid",
        worktreeId: "wt-other",
      },
      {
        id: "terminal-global",
        kind: "terminal",
        cwd: "/project-a",
        location: "dock",
      },
    ];

    projectClientMock.switch.mockResolvedValue(projectB);
    projectClientMock.setTerminals.mockResolvedValue(undefined);
    projectClientMock.setTerminalSizes.mockResolvedValue(undefined);
    projectClientMock.getAll.mockReturnValue(new Promise((_resolve) => {}));
    terminalPersistenceMock.whenIdle.mockReturnValue(new Promise<void>((_resolve) => {}));
  });

  it("does not block switching on persistence idle waits or project-list refresh", async () => {
    const switchPromise = useProjectStore.getState().switchProject("project-b");

    expect(terminalToSnapshotMock).toHaveBeenCalledTimes(3);

    await switchPromise;
  });
});
