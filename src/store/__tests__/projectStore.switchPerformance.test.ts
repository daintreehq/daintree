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
};

const terminalState = {
  terminals: [] as Array<{
    id: string;
    kind?: string;
    type?: string;
    title?: string;
    cwd?: string;
    location?: "grid" | "dock" | "trash";
  }>,
};

const terminalPersistenceMock = {
  whenIdle: vi.fn(),
  setProjectIdGetter: vi.fn(),
};

const terminalToSnapshotMock = vi.fn(
  (terminal: { id: string; cwd?: string; location?: string }) => ({
    id: terminal.id,
    cwd: terminal.cwd ?? "",
    location: terminal.location ?? "grid",
  })
);

vi.mock("@/clients", () => ({
  projectClient: projectClientMock,
}));

vi.mock("../resetStores", () => ({
  resetAllStoresForProjectSwitch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../worktreeDataStore", () => ({
  forceReinitializeWorktreeDataStore: vi.fn(),
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
      },
    ];

    projectClientMock.switch.mockResolvedValue(projectB);
    projectClientMock.setTerminals.mockResolvedValue(undefined);
    projectClientMock.getAll.mockReturnValue(new Promise((_resolve) => {}));
    terminalPersistenceMock.whenIdle.mockReturnValue(new Promise<void>((_resolve) => {}));
  });

  it("does not block switching on persistence idle waits or project-list refresh", async () => {
    let switchResolved = false;
    const switchPromise = useProjectStore
      .getState()
      .switchProject("project-b")
      .then(() => {
        switchResolved = true;
      });

    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }

    expect(projectClientMock.setTerminals).toHaveBeenCalledWith(
      "project-a",
      expect.arrayContaining([expect.objectContaining({ id: "terminal-1" })])
    );
    expect(projectClientMock.switch).toHaveBeenCalledWith("project-b");
    expect(switchResolved).toBe(true);

    await switchPromise;
  });
});
