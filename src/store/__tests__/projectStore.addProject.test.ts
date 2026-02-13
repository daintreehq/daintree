// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const projectClientMock = {
  getAll: vi.fn().mockResolvedValue([]),
  getCurrent: vi.fn().mockResolvedValue(null),
  add: vi.fn(),
  remove: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockResolvedValue(undefined),
  switch: vi.fn().mockResolvedValue(null),
  openDialog: vi.fn(),
  onSwitch: vi.fn(() => () => {}),
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  detectRunners: vi.fn(),
  close: vi.fn(),
  getStats: vi.fn(),
  initGit: vi.fn().mockResolvedValue(undefined),
  initGitGuided: vi.fn().mockResolvedValue({ success: true, completedSteps: [] }),
  onInitGitProgress: vi.fn(() => () => {}),
};

const appClientMock = {
  getState: vi.fn(),
  setState: vi.fn(),
};

const terminalClientMock = {
  getSharedBuffers: vi.fn().mockResolvedValue({ visualBuffers: [], signalBuffer: null }),
};

const addNotificationMock = vi.fn();

vi.mock("@/clients", () => ({
  projectClient: projectClientMock,
  appClient: appClientMock,
  terminalClient: terminalClientMock,
}));

vi.mock("../notificationStore", () => ({
  useNotificationStore: {
    getState: vi.fn(() => ({
      addNotification: addNotificationMock,
    })),
  },
}));

vi.mock("../resetStores", () => ({
  resetAllStoresForProjectSwitch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../worktreeDataStore", () => ({
  forceReinitializeWorktreeDataStore: vi.fn(),
}));

vi.mock("../worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => ({
      activeWorktreeId: null,
    }),
  },
}));

vi.mock("../slices", () => ({
  flushTerminalPersistence: vi.fn(),
  createTerminalRegistrySlice: vi.fn(() => () => ({})),
  createTerminalFocusSlice: vi.fn(() => () => ({})),
  createTerminalCommandQueueSlice: vi.fn(() => () => ({})),
  createTerminalBulkActionsSlice: vi.fn(() => () => ({})),
}));

const { useProjectStore } = await import("../projectStore");

describe("projectStore addProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectStore.setState({
      projects: [],
      currentProject: null,
      isLoading: false,
      error: null,
      gitInitDialogOpen: false,
      gitInitDirectoryPath: null,
    });
  });

  it("opens the guided git init dialog when add fails for non-git directories", async () => {
    projectClientMock.openDialog.mockResolvedValueOnce("/tmp/not-a-repo");
    projectClientMock.add.mockRejectedValueOnce(new Error("Not a git repository: /tmp/not-a-repo"));

    await useProjectStore.getState().addProject();

    expect(addNotificationMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().gitInitDialogOpen).toBe(true);
    expect(useProjectStore.getState().gitInitDirectoryPath).toBe("/tmp/not-a-repo");
    expect(useProjectStore.getState().isLoading).toBe(false);
    expect(useProjectStore.getState().error).toBeNull();
  });

  it("does not notify when the dialog is cancelled", async () => {
    projectClientMock.openDialog.mockResolvedValueOnce(null);

    await useProjectStore.getState().addProject();

    expect(addNotificationMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().gitInitDialogOpen).toBe(false);
    expect(useProjectStore.getState().gitInitDirectoryPath).toBeNull();
    expect(useProjectStore.getState().isLoading).toBe(false);
    expect(useProjectStore.getState().error).toBeNull();
  });

  it("retries adding the project after successful initialization", async () => {
    const addProjectByPathMock = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({
      gitInitDialogOpen: true,
      gitInitDirectoryPath: "/tmp/repo",
      addProjectByPath: addProjectByPathMock as (path: string) => Promise<void>,
    });

    await useProjectStore.getState().handleGitInitSuccess();

    expect(addProjectByPathMock).toHaveBeenCalledWith("/tmp/repo");
    expect(useProjectStore.getState().gitInitDialogOpen).toBe(false);
    expect(useProjectStore.getState().gitInitDirectoryPath).toBeNull();
  });
});
