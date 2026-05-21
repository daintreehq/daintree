import { beforeEach, describe, expect, it, vi } from "vitest";

const projectStoreMock = vi.hoisted(() => ({
  getProjectById:
    vi.fn<(id: string) => { id: string; name: string; path: string; status?: string } | null>(),
  getCurrentProjectId: vi.fn<() => string | null>(),
  setCurrentProject: vi.fn<(id: string) => Promise<void>>(),
  getProjectState: vi.fn<(id: string) => Promise<Record<string, unknown>>>(),
  saveProjectState: vi.fn<(id: string, state: Record<string, unknown>) => Promise<void>>(),
  readInRepoProjectIdentity:
    vi.fn<
      (p: string) => Promise<{ found: boolean; name?: string; emoji?: string; color?: string }>
    >(),
  updateProject: vi.fn<(id: string, updates: Record<string, unknown>) => Record<string, unknown>>(),
}));

const logBufferMock = vi.hoisted(() => ({
  onProjectSwitch: vi.fn(() => undefined),
}));

const gitServiceCacheMock = vi.hoisted(() => ({
  clear: vi.fn(() => undefined),
}));

const sendToRendererMock = vi.hoisted(() => vi.fn());
const randomUUIDMock = vi.hoisted(() => vi.fn(() => "switch-id-1"));

const storeMock = vi.hoisted(() => ({
  get: vi.fn(() => ({
    activeWorktreeId: "wt-old",
    sidebarWidth: 320,
  })),
}));

vi.mock("../ProjectStore.js", () => ({
  projectStore: projectStoreMock,
  DEFAULT_PROJECT_EMOJI: "🌲",
}));

vi.mock("../LogBuffer.js", () => ({
  logBuffer: logBufferMock,
}));

vi.mock("../GitServiceCache.js", () => ({
  gitServiceCache: gitServiceCacheMock,
}));

vi.mock("../ContextInjectionTracker.js", () => ({
  contextInjectionTracker: { onProjectSwitch: vi.fn() },
}));

vi.mock("../../ipc/utils.js", () => ({
  sendToRenderer: sendToRendererMock,
  broadcastToRenderer: sendToRendererMock,
}));

vi.mock("crypto", () => ({
  randomUUID: randomUUIDMock,
}));

vi.mock("../../store.js", () => ({
  store: storeMock,
}));

const buildSwitchHydrateResultMock = vi.hoisted(() =>
  vi.fn(async () => ({
    appState: { terminals: [], sidebarWidth: 350 },
    terminalConfig: {},
    project: { id: "project-new", name: "New Project", path: "/tmp/new" },
    agentSettings: {},
    gpuWebGLHardware: true,
    gpuHardwareAccelerationDisabled: false,
    safeMode: false,
    settingsRecovery: null,
    projectStateRecovery: null,
  }))
);

vi.mock("../AppHydrationService.js", () => ({
  buildSwitchHydrateResult: buildSwitchHydrateResultMock,
}));

import { CHANNELS } from "../../ipc/channels.js";
import { ProjectSwitchService } from "../ProjectSwitchService.js";

describe("ProjectSwitchService", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    projectStoreMock.getCurrentProjectId.mockReturnValue("project-old");
    projectStoreMock.getProjectById.mockImplementation((id: string) => {
      if (id === "project-new") {
        return { id, name: "New Project", path: "/tmp/new", status: "active" };
      }
      if (id === "project-old") {
        return { id, name: "Old Project", path: "/tmp/old", status: "active" };
      }
      return null;
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);
    projectStoreMock.getProjectState.mockResolvedValue({
      projectId: "project-old",
      sidebarWidth: 350,
      terminals: [],
    });
    projectStoreMock.saveProjectState.mockResolvedValue(undefined);
    projectStoreMock.readInRepoProjectIdentity.mockResolvedValue({ found: false });
    projectStoreMock.updateProject.mockImplementation(
      (id: string, updates: Record<string, unknown>) => ({ id, ...updates })
    );

    logBufferMock.onProjectSwitch.mockImplementation(() => undefined);
    gitServiceCacheMock.clear.mockImplementation(() => undefined);
  });

  const MOCK_WINDOW_ID = 42;

  function createService(overrides?: {
    ptyClient?: Partial<{
      onProjectSwitch: (projectId: string | null) => unknown;
      setActiveProject: (projectId: string | null) => unknown;
    }>;
    worktreeService?: Partial<{
      onProjectSwitch: (windowId: number) => unknown;
      loadProject: (path: string, windowId: number) => Promise<void>;
    }>;
    eventBuffer?: Partial<{
      onProjectSwitch: () => unknown;
    }>;
  }) {
    const ptyClient = {
      onProjectSwitch: vi.fn(() => undefined),
      setActiveProject: vi.fn(() => undefined),
      ...(overrides?.ptyClient ?? {}),
    };

    const worktreeService =
      overrides?.worktreeService === undefined
        ? {
            onProjectSwitch: vi.fn(() => undefined),
            loadProject: vi.fn(async () => undefined),
          }
        : (overrides.worktreeService as {
            onProjectSwitch: (windowId: number) => unknown;
            loadProject: (path: string, windowId: number) => Promise<void>;
          });

    const eventBuffer = {
      onProjectSwitch: vi.fn(() => undefined),
      ...(overrides?.eventBuffer ?? {}),
    };

    const service = new ProjectSwitchService({
      mainWindow: {
        id: MOCK_WINDOW_ID,
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: vi.fn(),
        },
      } as never,
      ptyClient: ptyClient as never,
      worktreeService: worktreeService as never,
      eventBuffer: eventBuffer as never,
    });

    return { service, ptyClient, worktreeService, eventBuffer };
  }

  it("switches projects successfully and emits switch event", async () => {
    const { service, ptyClient, worktreeService, eventBuffer } = createService();

    const result = await service.switchProject("project-new");

    expect(result.id).toBe("project-new");
    expect(projectStoreMock.setCurrentProject).toHaveBeenCalledWith("project-new");
    expect(projectStoreMock.saveProjectState).toHaveBeenCalledWith(
      "project-old",
      expect.objectContaining({
        projectId: "project-old",
        activeWorktreeId: "wt-old",
      })
    );
    expect(ptyClient.onProjectSwitch).toHaveBeenCalledWith(
      MOCK_WINDOW_ID,
      "project-new",
      "/tmp/new"
    );
    expect(worktreeService.loadProject).toHaveBeenCalledWith("/tmp/new", MOCK_WINDOW_ID);
    // onProjectSwitch is no longer called — blue-green swap in loadProject handles release
    expect(worktreeService.onProjectSwitch).not.toHaveBeenCalled();
    expect(eventBuffer.onProjectSwitch).toHaveBeenCalled();
    expect(sendToRendererMock).toHaveBeenCalledWith(
      CHANNELS.PROJECT_ON_SWITCH,
      expect.objectContaining({
        project: expect.objectContaining({ id: "project-new" }),
        switchId: "switch-id-1",
      })
    );
  });

  it("skips outgoing project state persist when active worktree did not change", async () => {
    projectStoreMock.getProjectState.mockResolvedValue({
      projectId: "project-old",
      activeWorktreeId: "wt-old",
      sidebarWidth: 350,
      terminals: [],
    });

    const { service } = createService();
    await service.switchProject("project-new");

    expect(projectStoreMock.saveProjectState).not.toHaveBeenCalled();
  });

  it("continues switch even when cleanup services throw synchronously", async () => {
    const { service } = createService({
      ptyClient: {
        onProjectSwitch: () => {
          throw new Error("pty sync throw");
        },
      },
      worktreeService: {
        onProjectSwitch: vi.fn(() => undefined),
        loadProject: async () => undefined,
      },
      eventBuffer: {
        onProjectSwitch: () => {
          throw new Error("eventBuffer sync throw");
        },
      },
    });
    logBufferMock.onProjectSwitch.mockImplementation(() => {
      throw new Error("logBuffer sync throw");
    });
    gitServiceCacheMock.clear.mockImplementation(() => {
      throw new Error("gitServiceCache sync throw");
    });

    await expect(service.switchProject("project-new")).resolves.toMatchObject({
      id: "project-new",
    });
    expect(projectStoreMock.setCurrentProject).toHaveBeenCalledWith("project-new");
  });

  it("short-circuits when switching to the already active project", async () => {
    projectStoreMock.getCurrentProjectId.mockReturnValue("project-new");

    const { service, ptyClient, worktreeService, eventBuffer } = createService();
    const result = await service.switchProject("project-new");

    expect(result).toMatchObject({ id: "project-new" });
    expect(projectStoreMock.saveProjectState).not.toHaveBeenCalled();
    expect(projectStoreMock.setCurrentProject).not.toHaveBeenCalled();
    expect(worktreeService.onProjectSwitch).not.toHaveBeenCalled();
    expect(worktreeService.loadProject).not.toHaveBeenCalled();
    expect(eventBuffer.onProjectSwitch).not.toHaveBeenCalled();
    expect(ptyClient.onProjectSwitch).not.toHaveBeenCalled();
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it("starts loading new project in parallel with supporting cleanup", async () => {
    const loadProjectMock = vi.fn(async () => undefined);
    const { service } = createService({
      worktreeService: {
        onProjectSwitch: vi.fn(() => undefined),
        loadProject: loadProjectMock,
      },
    });

    const switchPromise = service.switchProject("project-new");
    for (let i = 0; i < 20 && loadProjectMock.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }

    expect(loadProjectMock).toHaveBeenCalledWith("/tmp/new", MOCK_WINDOW_ID);

    await expect(switchPromise).resolves.toMatchObject({ id: "project-new" });
  });

  it("includes worktreeLoadError in switch payload when loadProject fails", async () => {
    const { service } = createService({
      worktreeService: {
        onProjectSwitch: vi.fn(() => undefined),
        loadProject: vi.fn(async () => {
          throw new Error("Not a git repository");
        }),
      },
    });

    await service.switchProject("project-new");

    expect(sendToRendererMock).toHaveBeenCalledWith(
      CHANNELS.PROJECT_ON_SWITCH,
      expect.objectContaining({
        project: expect.objectContaining({ id: "project-new" }),
        switchId: "switch-id-1",
        worktreeLoadError: "Not a git repository",
      })
    );
    // Dedicated load-status event the renderer banner listens on (#8400).
    expect(sendToRendererMock).toHaveBeenCalledWith(CHANNELS.PROJECT_WORKTREE_LOAD_STATUS, {
      projectId: "project-new",
      worktreeLoadError: "Not a git repository",
    });
  });

  it("does not include worktreeLoadError when loadProject succeeds", async () => {
    const { service } = createService();

    await service.switchProject("project-new");

    const onSwitchPayload = sendToRendererMock.mock.calls.find(
      (c: unknown[]) => c[0] === CHANNELS.PROJECT_ON_SWITCH
    )?.[1];
    expect(onSwitchPayload).not.toHaveProperty("worktreeLoadError");
    // The load-status event still fires, with a null error so a stale banner
    // on a reactivated view clears.
    expect(sendToRendererMock).toHaveBeenCalledWith(CHANNELS.PROJECT_WORKTREE_LOAD_STATUS, {
      projectId: "project-new",
      worktreeLoadError: null,
    });
  });

  it("includes pre-built hydrateResult in switch payload", async () => {
    const { service } = createService();

    await service.switchProject("project-new");

    // Use channel-aware lookup: broadcastProjectSwitchUpdates now fires
    // PROJECT_UPDATED for the departing project before PROJECT_ON_SWITCH,
    // so index 0 is no longer the switch payload.
    const payload = sendToRendererMock.mock.calls.find(
      (c: unknown[]) => c[0] === CHANNELS.PROJECT_ON_SWITCH
    )?.[1];
    expect(payload).toBeDefined();
    expect(payload.hydrateResult).toBeDefined();
    expect(payload.hydrateResult.settingsRecovery).toBeNull();
    expect(buildSwitchHydrateResultMock).toHaveBeenCalledWith("project-new");
  });

  it("broadcasts without hydrateResult when builder throws", async () => {
    buildSwitchHydrateResultMock.mockRejectedValueOnce(new Error("builder failed"));
    const { service } = createService();

    await service.switchProject("project-new");

    const payload = sendToRendererMock.mock.calls.find(
      (c: unknown[]) => c[0] === CHANNELS.PROJECT_ON_SWITCH
    )?.[1];
    expect(payload).toBeDefined();
    expect(payload).not.toHaveProperty("hydrateResult");
    expect(payload.project).toMatchObject({ id: "project-new" });
    expect(payload.switchId).toBe("switch-id-1");
  });

  it("initiates outgoing project state save before setCurrentProject completes", async () => {
    let resolveSave!: () => void;
    const savePromise = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    projectStoreMock.saveProjectState.mockReturnValueOnce(savePromise);

    const { service } = createService();

    const switchPromise = service.switchProject("project-new");

    for (let i = 0; i < 20 && projectStoreMock.setCurrentProject.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }

    expect(projectStoreMock.setCurrentProject).toHaveBeenCalledWith("project-new");

    resolveSave();
    await expect(switchPromise).resolves.toMatchObject({ id: "project-new" });
  });

  it("does not resolve switch before outgoing project state save completes", async () => {
    let resolveSave!: () => void;
    const savePromise = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    projectStoreMock.saveProjectState.mockReturnValueOnce(savePromise);

    const { service } = createService();

    let resolved = false;
    const switchPromise = service.switchProject("project-new");
    const trackedPromise = switchPromise.then((result) => {
      resolved = true;
      return result;
    });

    for (let i = 0; i < 50; i += 1) {
      await Promise.resolve();
    }

    expect(resolved).toBe(false);

    resolveSave();
    await expect(trackedPromise).resolves.toMatchObject({ id: "project-new" });
    expect(resolved).toBe(true);
  });

  it("applies in-repo project identity during switch", async () => {
    projectStoreMock.readInRepoProjectIdentity.mockResolvedValue({
      found: true,
      name: "Repo Name",
      emoji: "📦",
    });
    // Set the project name to the default (path.basename) so the identity
    // override fires: inRepo.name is set above and project.name === "new"
    projectStoreMock.getProjectById.mockImplementation((id: string) => {
      if (id === "project-new") {
        return { id, name: "new", path: "/tmp/new", status: "active", emoji: "🌲" };
      }
      if (id === "project-old") {
        return { id, name: "Old Project", path: "/tmp/old", status: "active" };
      }
      return null;
    });

    const { service } = createService();
    await service.switchProject("project-new");

    expect(projectStoreMock.readInRepoProjectIdentity).toHaveBeenCalledWith("/tmp/new");
    expect(projectStoreMock.updateProject).toHaveBeenCalledWith(
      "project-new",
      expect.objectContaining({ name: "Repo Name", emoji: "📦" })
    );
  });

  it("proves save initiation precedes setCurrentProject via call-order log", async () => {
    const callLog: string[] = [];
    const getProjectStateOrig = projectStoreMock.getProjectState.getMockImplementation();
    projectStoreMock.getProjectState.mockImplementation(async (id: string) => {
      callLog.push("getProjectState");
      return getProjectStateOrig!(id);
    });
    projectStoreMock.saveProjectState.mockImplementation(async () => {
      callLog.push("saveProjectState");
    });
    projectStoreMock.setCurrentProject.mockImplementation(async () => {
      callLog.push("setCurrentProject");
    });

    const { service } = createService();
    await service.switchProject("project-new");

    const getIdx = callLog.indexOf("getProjectState");
    const setIdx = callLog.indexOf("setCurrentProject");
    expect(getIdx).toBeLessThan(setIdx);
    // saveProjectState fires in a microtask after getProjectState resolves;
    // the key invariant is that save initiation (getProjectState) precedes setCurrentProject.
  });

  it("holds switchChain until pending save drains on failure path", async () => {
    let resolveSave!: () => void;
    const savePromise = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    projectStoreMock.saveProjectState.mockReturnValueOnce(savePromise);
    projectStoreMock.setCurrentProject.mockRejectedValueOnce(new Error("setCurrent failed"));

    const { service } = createService();

    // First switch fails — catch block should await saveOutgoingPromise
    const firstSwitch = service.switchProject("project-new");

    // Give the catch block time to enter its await
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }

    // Second switch queues behind switchChain, which is held by the
    // catch block's await on saveOutgoingPromise
    projectStoreMock.getCurrentProjectId.mockReturnValue("project-new");
    const secondSwitch = service.switchProject("project-old");

    let secondResolved = false;
    secondSwitch.then(
      () => {
        secondResolved = true;
      },
      () => {
        secondResolved = true;
      }
    );

    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
    expect(secondResolved).toBe(false);

    // Drain the save → catch block finishes → switchChain unblocks → second switch runs
    resolveSave();
    await firstSwitch.catch(() => {});
    await secondSwitch;
    expect(secondResolved).toBe(true);
  });

  it("propagates the switch error without attempting a PTY rollback (#8400)", async () => {
    const originalError = new Error("setCurrent failed");
    projectStoreMock.setCurrentProject.mockRejectedValue(originalError);

    const { service, ptyClient } = createService();

    await expect(service.switchProject("project-new")).rejects.toThrow("setCurrent failed");

    // The catch branch no longer reverts the PTY to the previous project —
    // the forward-cleanup call targets the *new* project, never "project-old",
    // and setActiveProject(null) is never used as a fallback rollback.
    expect(ptyClient.onProjectSwitch).not.toHaveBeenCalledWith(
      MOCK_WINDOW_ID,
      "project-old",
      expect.anything()
    );
    expect(ptyClient.setActiveProject).not.toHaveBeenCalled();
  });
});
