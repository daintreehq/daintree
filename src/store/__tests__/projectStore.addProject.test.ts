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
};

const appClientMock = {
  getState: vi.fn(),
  setState: vi.fn(),
};

const addNotificationMock = vi.fn();

vi.mock("@/clients", () => ({
  projectClient: projectClientMock,
  appClient: appClientMock,
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
    useProjectStore.setState({ projects: [], currentProject: null, isLoading: false, error: null });
  });

  it("shows a warning with action when add fails for non-git directories", async () => {
    projectClientMock.openDialog.mockResolvedValueOnce("/tmp/not-a-repo");
    projectClientMock.add.mockRejectedValueOnce(new Error("Not a git repository: /tmp/not-a-repo"));

    await useProjectStore.getState().addProject();

    expect(addNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        title: "Not a Git repository",
        message: "Would you like to initialize a Git repository in this directory?",
        action: expect.objectContaining({
          label: "Initialize Git",
        }),
      })
    );

    expect(useProjectStore.getState().isLoading).toBe(false);
    expect(useProjectStore.getState().error).toBeNull();
  });

  it("does not notify when the dialog is cancelled", async () => {
    projectClientMock.openDialog.mockResolvedValueOnce(null);

    await useProjectStore.getState().addProject();

    expect(addNotificationMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().isLoading).toBe(false);
    expect(useProjectStore.getState().error).toBeNull();
  });
});
