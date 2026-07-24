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
  createFolder: vi.fn(),
  onSwitch: vi.fn(() => () => {}),
  onWorktreeLoadStatus: vi.fn(() => () => {}),
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  detectRunners: vi.fn(),
  close: vi.fn(),
  getStats: vi.fn(),
  initGit: vi.fn().mockResolvedValue(undefined),
  initGitGuided: vi.fn().mockResolvedValue({ outcome: "success", completedSteps: [] }),
  onInitGitProgress: vi.fn(() => () => {}),
};

const appClientMock = {
  getState: vi.fn(),
  setState: vi.fn(),
};

const terminalClientMock = {
  getSharedBuffers: vi.fn().mockResolvedValue({ visualBuffers: [], signalBuffer: null }),
};

const worktreeClientMock = {
  retryProjectLoad: vi.fn().mockResolvedValue(undefined),
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
  worktreeClient: worktreeClientMock,
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

// Exact store signature, so the mock needs no cast (which would trip the
// no-unsafe-type-assertion ratchet).
type AddProjectByPath = ReturnType<typeof useProjectStore.getState>["addProjectByPath"];

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
      gitInitIdentity: null,
      addProjectByPath: originalAddProjectByPath,
      addProject: originalAddProject,
    });
  });

  it("carries the create-flow identity into the git-init dialog it always chains through", async () => {
    projectClientMock.createFolder.mockResolvedValueOnce("/tmp/new-folder");
    projectClientMock.add.mockRejectedValueOnce(new Error("Not a git repository: /tmp/new-folder"));

    await useProjectStore.getState().createProjectFolder("/tmp", "new-folder", "🚀");

    expect(useProjectStore.getState().gitInitDialogOpen).toBe(true);
    expect(useProjectStore.getState().gitInitIdentity).toEqual({
      name: "new-folder",
      emoji: "🚀",
    });
  });

  it("forwards the clone dialog's identity to the add call", async () => {
    projectClientMock.add.mockResolvedValueOnce({ id: "p1", path: "/tmp/cloned" });

    await useProjectStore
      .getState()
      .handleCloneSuccess("/tmp/cloned", { name: "cloned", emoji: "📦" });

    expect(projectClientMock.add).toHaveBeenCalledWith("/tmp/cloned", {
      identity: { name: "cloned", emoji: "📦" },
    });
  });

  it("adds an existing repo with no identity argument", async () => {
    projectClientMock.openDialog.mockResolvedValueOnce("/tmp/existing-repo");
    projectClientMock.add.mockResolvedValueOnce({ id: "p2", path: "/tmp/existing-repo" });

    await useProjectStore.getState().addProject();

    expect(projectClientMock.add).toHaveBeenCalledWith("/tmp/existing-repo", undefined);
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
    const addProjectByPathMock = vi.fn<AddProjectByPath>().mockResolvedValue(undefined);
    useProjectStore.setState({
      gitInitDialogOpen: true,
      gitInitDirectoryPath: "/tmp/repo",
      addProjectByPath: addProjectByPathMock,
    });

    await useProjectStore.getState().handleGitInitSuccess();

    expect(addProjectByPathMock).toHaveBeenCalledWith("/tmp/repo", { identity: undefined });
    expect(useProjectStore.getState().gitInitDialogOpen).toBe(false);
    expect(useProjectStore.getState().gitInitDirectoryPath).toBeNull();
  });

  it("passes the identity supplied at git-init completion through to the add", async () => {
    const addProjectByPathMock = vi.fn<AddProjectByPath>().mockResolvedValue(undefined);
    useProjectStore.setState({
      gitInitDialogOpen: true,
      gitInitDirectoryPath: "/tmp/repo",
      addProjectByPath: addProjectByPathMock,
    });

    await useProjectStore.getState().handleGitInitSuccess({ name: "Edited", emoji: "🚀" });

    expect(addProjectByPathMock).toHaveBeenCalledWith("/tmp/repo", {
      identity: { name: "Edited", emoji: "🚀" },
    });
  });

  it("falls back to the identity carried in from the create-project dialog", async () => {
    const addProjectByPathMock = vi.fn<AddProjectByPath>().mockResolvedValue(undefined);
    useProjectStore.setState({
      gitInitDialogOpen: true,
      gitInitDirectoryPath: "/tmp/repo",
      gitInitIdentity: { name: "Carried", emoji: "📦" },
      addProjectByPath: addProjectByPathMock,
    });

    await useProjectStore.getState().handleGitInitSuccess();

    expect(addProjectByPathMock).toHaveBeenCalledWith("/tmp/repo", {
      identity: { name: "Carried", emoji: "📦" },
    });
  });

  it("clears the carried identity together with the path on close", () => {
    useProjectStore
      .getState()
      .openGitInitDialog("/tmp/repo", { identity: { name: "N", emoji: "🚀" } });
    expect(useProjectStore.getState().gitInitIdentity).toEqual({ name: "N", emoji: "🚀" });

    useProjectStore.getState().closeGitInitDialog();

    expect(useProjectStore.getState().gitInitDirectoryPath).toBeNull();
    expect(useProjectStore.getState().gitInitIdentity).toBeNull();
  });

  it("opens git-init with no identity when the folder was merely opened", () => {
    useProjectStore.getState().openGitInitDialog("/tmp/plain-folder");

    expect(useProjectStore.getState().gitInitIdentity).toBeNull();
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
      expect(projectClientMock.add).toHaveBeenLastCalledWith("/tmp/dubious-repo", undefined);
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
        expect.objectContaining({ title: "Couldn't add project" })
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
          title: "Couldn't mark as safe",
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
        (call) => (call[0] as { title?: string }).title === "Couldn't add project"
      );
      expect(genericToasts.length).toBeGreaterThan(0);
    });
  });

  describe("opening a folder without git (#11405)", () => {
    const LIGHTWEIGHT = { id: "p-light", path: "/tmp/downloads", name: "downloads" };

    beforeEach(() => {
      useProjectStore.setState({ gitInitDirectoryPath: "/tmp/downloads" });
      projectClientMock.add.mockResolvedValue(LIGHTWEIGHT);
      projectClientMock.getAll.mockResolvedValue([LIGHTWEIGHT]);
    });

    it("opens the choice screen first when a folder has no repository", async () => {
      projectClientMock.openDialog.mockResolvedValueOnce("/tmp/not-a-repo");
      projectClientMock.add.mockRejectedValueOnce(
        new Error("Not a git repository: /tmp/not-a-repo")
      );

      await useProjectStore.getState().addProject();

      expect(useProjectStore.getState().gitInitDialogStep).toBe("choice");
    });

    it("asks main to drop the git requirement when the user opens without git", async () => {
      await useProjectStore.getState().openWithoutGit();

      expect(projectClientMock.add).toHaveBeenCalledWith("/tmp/downloads", { gitBacked: false });
      expect(useProjectStore.getState().gitInitDialogOpen).toBe(false);
    });

    it("keeps the git requirement on an ordinary add", async () => {
      await useProjectStore.getState().addProjectByPath("/tmp/some-repo");

      expect(projectClientMock.add).toHaveBeenCalledWith("/tmp/some-repo", undefined);
    });

    it("reloads the workspace after initializing git in the open workspace", async () => {
      useProjectStore.setState({
        currentProject: { ...LIGHTWEIGHT, emoji: "🌳", lastOpened: 0, gitBacked: false },
      });

      await useProjectStore.getState().handleGitInitSuccess();

      // The host loaded this folder with no repository and enumerated nothing;
      // without a reload the sidebar would stay empty until the next switch.
      expect(worktreeClientMock.retryProjectLoad).toHaveBeenCalledTimes(1);
    });

    it("does not reload when git was initialized in some other folder", async () => {
      useProjectStore.setState({ currentProject: null });

      await useProjectStore.getState().handleGitInitSuccess();

      expect(worktreeClientMock.retryProjectLoad).not.toHaveBeenCalled();
    });
  });

  // #11409: classified open failures arrive as AppError codes and must render
  // the shared plain-language copy — not the raw internal text that used to
  // fall through the message matchers.
  describe("classified open failures", () => {
    const FOLDER = "/Volumes/Archive/repos/alpha";

    /**
     * Errors reach the renderer through the preload, which strips custom
     * properties at the contextBridge boundary and re-encodes the code into the
     * message. Rejecting with that exact shape is the only way this asserts the
     * production path rather than a same-realm convenience object.
     */
    function preloadError(code: string, message: string): Error {
      return new Error(`[AppError|${code}] ${message}`);
    }

    function toastPayload(): {
      title: string;
      message: string;
      actions?: Array<{ label: string; onClick: () => Promise<void> }>;
    } {
      expect(notifyMock).toHaveBeenCalledTimes(1);
      const payload: unknown = notifyMock.mock.calls[0]?.[0];
      if (typeof payload !== "object" || payload === null) {
        throw new Error("expected notify to receive a toast payload");
      }
      const actions: unknown = Reflect.get(payload, "actions");
      return {
        title: String(Reflect.get(payload, "title")),
        message: String(Reflect.get(payload, "message")),
        actions: Array.isArray(actions)
          ? actions.map((action: object) => {
              const handler: unknown = Reflect.get(action, "onClick");
              return {
                label: String(Reflect.get(action, "label")),
                onClick: async (): Promise<void> => {
                  if (typeof handler !== "function") throw new Error("action has no onClick");
                  // The store's handlers kick off work fire-and-forget, so let
                  // the queued microtasks drain before asserting on it.
                  Reflect.apply(handler, undefined, []);
                  await new Promise((resolve) => setTimeout(resolve, 0));
                },
              };
            })
          : undefined,
      };
    }

    it.each([
      ["NOT_FOUND"],
      ["NOT_A_DIRECTORY"],
      ["PERMISSION"],
      ["GIT_NOT_INSTALLED"],
      ["PROJECT_OPEN_FAILED"],
      ["INVALID_PATH"],
    ])("renders plain language instead of internals for %s", async (code) => {
      projectClientMock.add.mockRejectedValueOnce(
        preloadError(code, "Git operation failed: getRepositoryRoot")
      );

      await useProjectStore.getState().addProjectByPath(FOLDER);

      const { message } = toastPayload();
      for (const banned of [
        "simple-git",
        "getRepositoryRoot",
        "AppError",
        "[",
        "Git operation failed",
      ]) {
        expect(message).not.toContain(banned);
      }
    });

    it("names the folder the user tried to open", async () => {
      // IPC sanitization scrubs absolute paths out of error messages, so the
      // path has to come from the renderer's own state.
      projectClientMock.add.mockRejectedValueOnce(preloadError("NOT_FOUND", "not found"));

      await useProjectStore.getState().addProjectByPath(FOLDER);

      expect(toastPayload().message).toContain(FOLDER);
    });

    it("distinguishes a missing folder from one that is a file", async () => {
      projectClientMock.add.mockRejectedValueOnce(preloadError("NOT_FOUND", "x"));
      await useProjectStore.getState().addProjectByPath(FOLDER);
      const missing = toastPayload().message;

      notifyMock.mockClear();
      projectClientMock.add.mockRejectedValueOnce(preloadError("NOT_A_DIRECTORY", "x"));
      await useProjectStore.getState().addProjectByPath(FOLDER);
      const notADirectory = toastPayload().message;

      // simple-git reports these two identically; the whole fix is that we no
      // longer do.
      expect(missing).not.toBe(notADirectory);
    });

    it("retries the same folder for a failure that could clear on its own", async () => {
      projectClientMock.add.mockRejectedValueOnce(preloadError("PERMISSION", "denied"));

      await useProjectStore.getState().addProjectByPath(FOLDER);

      const { actions } = toastPayload();
      expect(actions).toHaveLength(1);
      expect(actions?.[0]?.label).toBe("Try again");

      projectClientMock.add.mockResolvedValueOnce({ id: "p1", path: FOLDER });
      await actions?.[0]?.onClick();

      expect(projectClientMock.add).toHaveBeenLastCalledWith(FOLDER);
      expect(projectClientMock.openDialog).not.toHaveBeenCalled();
    });

    it("sends the user to the picker when retrying the same folder can't help", async () => {
      // A folder that's gone stays gone — retrying the identical path would
      // just reproduce the same error.
      projectClientMock.add.mockRejectedValueOnce(preloadError("NOT_FOUND", "gone"));

      await useProjectStore.getState().addProjectByPath(FOLDER);

      const { actions } = toastPayload();
      expect(actions?.[0]?.label).toBe("Choose another folder");

      projectClientMock.openDialog.mockResolvedValueOnce("/repos/elsewhere");
      projectClientMock.add.mockResolvedValueOnce({ id: "p1", path: "/repos/elsewhere" });
      await actions?.[0]?.onClick();

      expect(projectClientMock.openDialog).toHaveBeenCalledTimes(1);
    });

    it("keeps the dedicated dubious-ownership flow working across the typed boundary", async () => {
      // Main now throws this as an AppError rather than a plain Error; the
      // renderer's ownership branch still recognizes it by substring, and that
      // coupling is only load-bearing because the message text was preserved.
      projectClientMock.openDialog.mockResolvedValueOnce("/tmp/dubious-repo");
      projectClientMock.add.mockRejectedValueOnce(
        preloadError(
          "DUBIOUS_OWNERSHIP",
          "Git refused to open this repository due to 'dubious ownership'. Mark it as safe.directory and try again."
        )
      );

      await useProjectStore.getState().addProject();

      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(toastPayload().title).toBe("Repository ownership issue");
    });

    it("leaves the guided git-init path alone", async () => {
      projectClientMock.add.mockRejectedValueOnce(
        preloadError("NOT_A_GIT_REPO", "Not a git repository")
      );

      await useProjectStore.getState().addProjectByPath(FOLDER);

      expect(notifyMock).not.toHaveBeenCalled();
      expect(useProjectStore.getState().gitInitDialogOpen).toBe(true);
    });
  });
});
