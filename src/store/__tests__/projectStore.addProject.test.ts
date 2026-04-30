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

const notifyMock = vi.fn().mockReturnValue("");

const actionServiceDispatchMock = vi.fn().mockResolvedValue({ ok: true });

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: actionServiceDispatchMock },
}));

vi.mock("@/clients", () => ({
  projectClient: projectClientMock,
  appClient: appClientMock,
  terminalClient: terminalClientMock,
}));

vi.mock("@/lib/notify", () => ({
  notify: notifyMock,
}));

vi.mock("../resetStores", () => ({
  resetAllStoresForProjectSwitch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => ({
      activeWorktreeId: null,
    }),
  },
}));

vi.mock("../slices", () => ({
  flushPanelPersistence: vi.fn(),
  createPanelRegistrySlice: vi.fn(() => () => ({})),
  createTerminalFocusSlice: vi.fn(() => () => ({})),
  createTerminalCommandQueueSlice: vi.fn(() => () => ({})),
  createTerminalMruSlice: vi.fn(() => () => ({})),
  createTerminalBulkActionsSlice: vi.fn(() => () => ({})),
  createWatchedPanelsSlice: vi.fn(() => () => ({})),
}));

const { useProjectStore } = await import("../projectStore");

// Capture original action references once — earlier tests replace them via
// setState() which is a merge, so functions leak across tests without this.
const originalAddProjectByPath = useProjectStore.getState().addProjectByPath;
const originalAddProject = useProjectStore.getState().addProject;

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
      addProjectByPath: originalAddProjectByPath,
      addProject: originalAddProject,
    });
  });

  it("opens the guided git init dialog when add fails for non-git directories", async () => {
    projectClientMock.openDialog.mockResolvedValueOnce("/tmp/not-a-repo");
    projectClientMock.add.mockRejectedValueOnce(new Error("Not a git repository: /tmp/not-a-repo"));

    await useProjectStore.getState().addProject();

    expect(notifyMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().gitInitDialogOpen).toBe(true);
    expect(useProjectStore.getState().gitInitDirectoryPath).toBe("/tmp/not-a-repo");
    expect(useProjectStore.getState().isLoading).toBe(false);
    expect(useProjectStore.getState().error).toBeNull();
  });

  it("uses the dialog-resolved absolute path for git init even when error lacks path", async () => {
    projectClientMock.openDialog.mockResolvedValueOnce("/Users/test/empty-folder");
    projectClientMock.add.mockRejectedValueOnce(
      new Error("Not a git repository (or any of the parent directories): .git")
    );

    await useProjectStore.getState().addProject();

    expect(notifyMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().gitInitDialogOpen).toBe(true);
    expect(useProjectStore.getState().gitInitDirectoryPath).toBe("/Users/test/empty-folder");
    expect(useProjectStore.getState().isLoading).toBe(false);
    expect(useProjectStore.getState().error).toBeNull();
  });

  it("does not open git init dialog when resolved path is not absolute", async () => {
    projectClientMock.add.mockRejectedValueOnce(new Error("Not a git repository: relative/path"));

    await useProjectStore.getState().addProjectByPath("relative/path");

    expect(useProjectStore.getState().gitInitDialogOpen).toBe(false);
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  it("does not notify when the dialog is cancelled", async () => {
    projectClientMock.openDialog.mockResolvedValueOnce(null);

    await useProjectStore.getState().addProject();

    expect(notifyMock).not.toHaveBeenCalled();
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

  describe("dubious ownership handling", () => {
    const markSafeDirectoryMock = vi.fn().mockResolvedValue(undefined);

    beforeEach(() => {
      markSafeDirectoryMock.mockClear();
      Object.defineProperty(window, "electron", {
        value: { git: { markSafeDirectory: markSafeDirectoryMock } },
        writable: true,
        configurable: true,
      });
    });

    it("shows an actionable toast with Mark as safe and Open logs", async () => {
      projectClientMock.openDialog.mockResolvedValueOnce("/tmp/dubious-repo");
      projectClientMock.add.mockRejectedValueOnce(
        new Error(
          "Git refused to open this repository due to 'dubious ownership'. Mark it as safe.directory and try again."
        )
      );

      await useProjectStore.getState().addProject();

      expect(notifyMock).toHaveBeenCalledTimes(1);
      const payload = notifyMock.mock.calls[0]![0] as {
        type: string;
        title: string;
        duration: number;
        actions: Array<{ label: string; variant?: string; actionId?: string }>;
      };
      expect(payload.type).toBe("error");
      expect(payload.title).toBe("Repository ownership issue");
      expect(payload.duration).toBe(0);
      expect(payload.actions).toHaveLength(2);
      expect(payload.actions[0]!.label).toBe("Mark as safe");
      expect(payload.actions[0]!.variant).toBe("primary");
      expect(payload.actions[1]!.label).toBe("Open logs");
      expect(payload.actions[1]!.variant).toBe("secondary");
      expect(payload.actions[1]!.actionId).toBe("errors.openLogs");
    });

    it("primary action calls markSafeDirectory and retries addProjectByPath", async () => {
      projectClientMock.openDialog.mockResolvedValueOnce("/tmp/dubious-repo");
      projectClientMock.add.mockRejectedValueOnce(new Error("detected dubious ownership"));

      await useProjectStore.getState().addProject();

      const payload = notifyMock.mock.calls[0]![0] as {
        actions: Array<{ onClick: () => void | Promise<void> }>;
      };

      // Second add (the retry) should succeed
      projectClientMock.add.mockResolvedValueOnce({
        id: "proj-1",
        name: "dubious-repo",
        path: "/tmp/dubious-repo",
        emoji: "📁",
        lastOpened: Date.now(),
      });

      await payload.actions[0]!.onClick();

      expect(markSafeDirectoryMock).toHaveBeenCalledWith("/tmp/dubious-repo");
      expect(projectClientMock.add).toHaveBeenCalledTimes(2);
      expect(projectClientMock.add).toHaveBeenLastCalledWith("/tmp/dubious-repo");
    });

    it("secondary action dispatches the errors.openLogs action", async () => {
      projectClientMock.openDialog.mockResolvedValueOnce("/tmp/dubious-repo");
      projectClientMock.add.mockRejectedValueOnce(
        new Error("fatal: detected dubious ownership in repository at '/tmp/dubious-repo'")
      );

      await useProjectStore.getState().addProject();

      const payload = notifyMock.mock.calls[0]![0] as {
        actions: Array<{ onClick: () => void | Promise<void> }>;
      };
      actionServiceDispatchMock.mockClear();

      await payload.actions[1]!.onClick();

      expect(actionServiceDispatchMock).toHaveBeenCalledWith(
        "errors.openLogs",
        undefined,
        expect.objectContaining({ source: "user" })
      );
    });

    it("falls back to generic error toast when path is not absolute", async () => {
      projectClientMock.add.mockRejectedValueOnce(new Error("detected dubious ownership"));

      await useProjectStore.getState().addProjectByPath("relative/path");

      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Failed to add project" })
      );
    });

    it("shows an error toast when markSafeDirectory fails and does not retry", async () => {
      projectClientMock.openDialog.mockResolvedValueOnce("/tmp/dubious-repo");
      projectClientMock.add.mockRejectedValueOnce(new Error("detected dubious ownership"));
      markSafeDirectoryMock.mockRejectedValueOnce(new Error("git binary not on PATH"));

      await useProjectStore.getState().addProject();
      const payload = notifyMock.mock.calls[0]![0] as {
        actions: Array<{ onClick: () => void | Promise<void> }>;
      };

      const addCallsBefore = projectClientMock.add.mock.calls.length;
      await payload.actions[0]!.onClick();

      expect(markSafeDirectoryMock).toHaveBeenCalledWith("/tmp/dubious-repo");
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: "Failed to mark as safe",
          message: "git binary not on PATH",
        })
      );
      // Retry must NOT happen when the mark-as-safe step failed.
      expect(projectClientMock.add.mock.calls.length).toBe(addCallsBefore);
    });

    it("does not re-show the dubious toast when the retry also fails", async () => {
      projectClientMock.openDialog.mockResolvedValueOnce("/tmp/dubious-repo");
      // First add: dubious ownership → toast
      projectClientMock.add.mockRejectedValueOnce(new Error("detected dubious ownership"));

      await useProjectStore.getState().addProject();
      const payload = notifyMock.mock.calls[0]![0] as {
        actions: Array<{ onClick: () => void | Promise<void> }>;
      };

      // Retry add: same dubious error (symlink case) — must NOT show another
      // "Repository ownership issue" toast; falls through to generic instead.
      projectClientMock.add.mockRejectedValueOnce(new Error("detected dubious ownership"));
      notifyMock.mockClear();

      await payload.actions[0]!.onClick();

      const ownershipToasts = notifyMock.mock.calls.filter(
        (call) => (call[0] as { title?: string }).title === "Repository ownership issue"
      );
      expect(ownershipToasts).toHaveLength(0);
      const genericToasts = notifyMock.mock.calls.filter(
        (call) => (call[0] as { title?: string }).title === "Failed to add project"
      );
      expect(genericToasts.length).toBeGreaterThan(0);
    });
  });
});
