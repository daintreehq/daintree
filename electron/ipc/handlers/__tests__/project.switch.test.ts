import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "os";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showErrorBox: vi.fn(),
  },
  shell: {
    openPath: vi.fn(),
    openExternal: vi.fn(),
  },
  app: {
    getPath: vi.fn().mockReturnValue(os.tmpdir()),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

/**
 * The `.git` marker probe the switch/reopen guard runs before activating a
 * git-backed row (#11649). Defaulted to `"present"` so every fixture below —
 * whose paths don't exist on disk — takes the healthy path it was written for.
 */
const probeGitMarkerMock = vi.hoisted(() =>
  vi.fn<(root: string) => Promise<"present" | "missing" | "unknown">>()
);
vi.mock("../../../services/projectOpenPreflight.js", () => ({
  probeGitMarker: (root: string) => probeGitMarkerMock(root),
  assertProjectDirectory: vi.fn(),
  isMissingExecutableError: vi.fn(() => false),
  PROJECT_DIRECTORY_STAT_TIMEOUT_MS: 5_000,
  GIT_MARKER_STAT_TIMEOUT_MS: 1_000,
}));

const projectStoreMock = vi.hoisted(() => {
  const getProjectState = vi.fn<(id: string) => Promise<Record<string, unknown> | null>>();
  const saveProjectState = vi.fn<(id: string, state: unknown) => Promise<void>>();
  return {
    classifyGitBacking:
      vi.fn<(path: string) => Promise<{ gitBacked: boolean; gitRoot?: string }>>(),
    getCurrentProjectId: vi.fn<() => string | null>(),
    getProjectById:
      vi.fn<(id: string) => { id: string; name: string; path: string; status?: string } | null>(),
    setCurrentProject: vi.fn<(id: string, outgoingId?: string | null) => Promise<void>>(),
    getProjectState,
    saveProjectState,
    // Mirrors the real queue contract: read, apply updater, save unless null.
    enqueueProjectStateUpdate: vi.fn(
      async (
        id: string,
        updater: (existing: Record<string, unknown> | null) => Record<string, unknown> | null
      ) => {
        const existing = await getProjectState(id);
        const updated = await updater(existing);
        if (updated !== null) {
          await saveProjectState(id, updated);
        }
      }
    ),
    getAllProjects: vi.fn(() => []),
    getCurrentProject: vi.fn(() => null),
    updateProjectStatus: vi.fn(),
  };
});

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

vi.mock("../../../services/ProjectSwitchService.js", () => ({
  ProjectSwitchService: class MockProjectSwitchService {
    onSwitch = vi.fn();
    switchProject = vi.fn();
    reopenProject = vi.fn();
  },
}));

vi.mock("../../../services/RunCommandDetector.js", () => ({
  runCommandDetector: { detect: vi.fn().mockResolvedValue([]) },
}));

const mockGetWindowForWebContents = vi.fn();
// The sender's view→project binding. Deliberately NOT defaulted to
// getCurrentProjectId(): the handler must never reach for the global pointer to
// answer a per-sender question, so a harness that conflated the two would hide
// the very bug these tests exist to catch (#11101).
const mockGetProjectForWebContents = vi.fn<(webContentsId: number) => string | null>();
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: (...args: unknown[]) => mockGetWindowForWebContents(...args),
  getProjectForWebContents: (webContentsId: number) => mockGetProjectForWebContents(webContentsId),
  // broadcastProjectSwitchUpdates → broadcastToRenderer → getAllAppWebContents.
  // Returning [] keeps the broadcast a no-op in this suite; PROJECT_UPDATED
  // delivery is covered by projectSwitchBroadcast.test.ts.
  getAllAppWebContents: vi.fn(() => []),
}));

// Root hook: runs before every describe's own `clearAllMocks` (which clears call
// history but not return values), so no fixture inherits a previous test's
// binding. Each test declares the project its sender view is displaying.
beforeEach(() => {
  mockGetProjectForWebContents.mockReturnValue(null);
  // Same reason as the binding above: `clearAllMocks` drops call history but not
  // return values, so the repository-intact guard is re-armed per test rather
  // than inheriting whichever answer the previous one installed.
  probeGitMarkerMock.mockResolvedValue("present");
  projectStoreMock.classifyGitBacking.mockResolvedValue({ gitBacked: true });
});

vi.mock("../../../window/portDistribution.js", () => ({
  distributePortsToView: vi.fn(),
}));

// Mocked so the multi-window tests can assert the exact ids the switch
// announces. Row-delivery behavior stays covered by projectSwitchBroadcast.test.ts.
const mockBroadcastProjectSwitchUpdates =
  vi.fn<(previousProjectId: string | null, activeProjectId: string) => void>();
vi.mock("../../projectSwitchBroadcast.js", () => ({
  broadcastProjectSwitchUpdates: (previousProjectId: string | null, activeProjectId: string) =>
    mockBroadcastProjectSwitchUpdates(previousProjectId, activeProjectId),
}));

const refreshProjectMenuStateMock = vi.hoisted(() => vi.fn());
vi.mock("../../../projectMenuState.js", () => ({
  refreshProjectMenuState: refreshProjectMenuStateMock,
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import { distributePortsToView } from "../../../window/portDistribution.js";
import { registerProjectCrudHandlers } from "../projectCrud/index.js";
import type { HandlerDependencies } from "../../types.js";
import type {
  WindowRegistry,
  WindowContext,
  WindowServices,
} from "../../../window/WindowRegistry.js";
import { DisposableStore } from "../../../utils/lifecycle.js";

function makeWindowContext(
  windowId: number,
  webContentsId: number,
  services: Partial<WindowServices> = {}
): WindowContext {
  return {
    windowId,
    webContentsId,
    browserWindow: { id: windowId, isDestroyed: () => false } as unknown as Electron.BrowserWindow,
    projectPath: null,
    abortController: new AbortController(),
    services: services as WindowServices,
    cleanup: new DisposableStore(),
  };
}

function makeWindowRegistry(contexts: WindowContext[]): WindowRegistry {
  const byWindowId = new Map(contexts.map((c) => [c.windowId, c]));
  const byWebContentsId = new Map(contexts.map((c) => [c.webContentsId, c]));
  return {
    getByWindowId: (id: number) => byWindowId.get(id),
    getByWebContentsId: (id: number) => byWebContentsId.get(id),
    getPrimary: () => contexts[0],
    all: () => contexts,
    get size() {
      return contexts.length;
    },
  } as unknown as WindowRegistry;
}

// #11136: the File-menu "Close Project" / "Project Settings…" gates are computed
// when the menu is built, so every path that opens a project has to refresh them
// or they stay disabled until something unrelated rebuilds the menu.
describe("project switch/reopen refreshes the File-menu project gates (#11136)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWindowForWebContents.mockReturnValue({ id: 1, isDestroyed: () => false });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);
  });

  function handlerFor(channel: string, deps: HandlerDependencies) {
    registerProjectCrudHandlers(deps);
    const call = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === channel
    );
    expect(call).toBeDefined();
    return call![1] as (...args: unknown[]) => Promise<unknown>;
  }

  function depsWith(pvm: unknown | null): HandlerDependencies {
    const ctx = makeWindowContext(
      1,
      10,
      pvm ? { projectViewManager: pvm as never } : {} // no PVM ⇒ legacy path
    );
    return {
      mainWindow: { id: 1 } as unknown,
      windowRegistry: makeWindowRegistry([ctx]),
      ...(pvm ? { projectViewManager: pvm } : {}),
    } as unknown as HandlerDependencies;
  }

  function makePvm() {
    return {
      switchTo: vi.fn().mockResolvedValue({
        view: { webContents: { id: 200, isDestroyed: () => false, send: vi.fn() } },
        isNew: false,
      }),
      getProjectIdForWebContents: vi.fn(),
      setPendingFocusIntent: vi.fn(),
    };
  }

  it("refreshes after a PVM-backed switch", async () => {
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-new",
      name: "New",
      path: "/projects/new",
    });
    const handler = handlerFor(CHANNELS.PROJECT_SWITCH, depsWith(makePvm()));

    await handler({ sender: { id: 10 } }, "proj-new");

    expect(refreshProjectMenuStateMock).toHaveBeenCalled();
  });

  it("refreshes after a legacy (no-PVM) switch", async () => {
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-new",
      name: "New",
      path: "/projects/new",
    });
    const handler = handlerFor(CHANNELS.PROJECT_SWITCH, depsWith(null));

    await handler({ sender: { id: 10 } }, "proj-new");

    expect(refreshProjectMenuStateMock).toHaveBeenCalled();
  });

  it("refreshes after a PVM-backed reopen", async () => {
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-bg",
      name: "Backgrounded",
      path: "/projects/bg",
      status: "background",
    });
    const handler = handlerFor(CHANNELS.PROJECT_REOPEN, depsWith(makePvm()));

    await handler({ sender: { id: 10 } }, "proj-bg");

    expect(refreshProjectMenuStateMock).toHaveBeenCalled();
  });

  it("refreshes after a legacy (no-PVM) reopen", async () => {
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-bg",
      name: "Backgrounded",
      path: "/projects/bg",
      status: "background",
    });
    const handler = handlerFor(CHANNELS.PROJECT_REOPEN, depsWith(null));

    await handler({ sender: { id: 10 } }, "proj-bg");

    expect(refreshProjectMenuStateMock).toHaveBeenCalled();
  });

  it("does not refresh when the switch is rejected for an unknown project", async () => {
    projectStoreMock.getProjectById.mockReturnValue(null);
    const handler = handlerFor(CHANNELS.PROJECT_SWITCH, depsWith(makePvm()));

    await expect(handler({ sender: { id: 10 } }, "ghost")).rejects.toThrow();

    // Rejected before the swap ran, so nothing moved and there is nothing to converge.
    expect(refreshProjectMenuStateMock).not.toHaveBeenCalled();
  });

  it("still refreshes when the swap fails, so a rolled-back binding converges", async () => {
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-new",
      name: "New",
      path: "/projects/new",
    });
    const pvm = makePvm();
    pvm.switchTo.mockRejectedValue(new Error("view failed to load"));
    const handler = handlerFor(CHANNELS.PROJECT_SWITCH, depsWith(pvm));

    await expect(handler({ sender: { id: 10 } }, "proj-new")).rejects.toThrow();

    // Once the swap has run, the PVM binding has moved or been rolled back — the
    // gates must reflect where we actually landed, not stay stale.
    expect(refreshProjectMenuStateMock).toHaveBeenCalled();
  });
});

// #11649: a row recorded as git-backed whose `.git` is gone used to be
// unreachable for demotion — every path-based open (Recents, Dock, Cmd+O, CLI)
// re-runs addProject and lands in the choice dialog, but switch and reopen
// address a project by id and never re-classified, so the row stayed stuck
// claiming worktree capability. These handlers now raise the same
// NOT_A_GIT_REPO the dialog already answers to.
describe("project switch/reopen refuses a row whose repository is gone (#11649)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWindowForWebContents.mockReturnValue({ id: 1, isDestroyed: () => false });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);
  });

  function makePvm() {
    return {
      switchTo: vi.fn().mockResolvedValue({
        view: { webContents: { id: 200, isDestroyed: () => false, send: vi.fn() } },
        isNew: false,
      }),
      getProjectIdForWebContents: vi.fn(),
      setPendingFocusIntent: vi.fn(),
    };
  }

  function handlerFor(channel: string, pvm: unknown) {
    const ctx = makeWindowContext(1, 10, { projectViewManager: pvm as never });
    registerProjectCrudHandlers({
      mainWindow: { id: 1 } as unknown,
      windowRegistry: makeWindowRegistry([ctx]),
      projectViewManager: pvm,
    } as unknown as HandlerDependencies);
    const call = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === channel
    );
    expect(call).toBeDefined();
    return call![1] as (...args: unknown[]) => Promise<unknown>;
  }

  /** `gitBacked` absent is a git-backed row: NULL predates the column. */
  function registerProject(overrides: Record<string, unknown> = {}) {
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-gone",
      name: "Gone",
      path: "/projects/gone",
      status: "background",
      ...overrides,
    } as never);
  }

  const CHANNEL_CASES = [
    [CHANNELS.PROJECT_SWITCH, "switch"],
    [CHANNELS.PROJECT_REOPEN, "reopen"],
  ] as const;

  describe.each(CHANNEL_CASES)("%s", (channel) => {
    it("rejects with NOT_A_GIT_REPO before anything is swapped or marked active", async () => {
      registerProject();
      probeGitMarkerMock.mockResolvedValue("missing");
      projectStoreMock.classifyGitBacking.mockResolvedValue({ gitBacked: false });
      const pvm = makePvm();

      await expect(handlerFor(channel, pvm)({ sender: { id: 10 } }, "proj-gone")).rejects.toThrow(
        expect.objectContaining({ code: "NOT_A_GIT_REPO" })
      );

      // The whole point of rejecting this early: the sender keeps its current
      // project, so declining the dialog is a no-op rather than a half-switch.
      expect(pvm.switchTo).not.toHaveBeenCalled();
      expect(projectStoreMock.setCurrentProject).not.toHaveBeenCalled();
      expect(refreshProjectMenuStateMock).not.toHaveBeenCalled();
    });

    it("activates without consulting git when the marker is there", async () => {
      registerProject();
      probeGitMarkerMock.mockResolvedValue("present");
      const pvm = makePvm();

      await handlerFor(channel, pvm)({ sender: { id: 10 } }, "proj-gone");

      expect(pvm.switchTo).toHaveBeenCalled();
      // A healthy switch must not pay for a git subprocess.
      expect(projectStoreMock.classifyGitBacking).not.toHaveBeenCalled();
    });

    it("activates unchanged when the marker can't be read", async () => {
      // A dead mount or a permissions blip. Demoting on this would be exactly
      // the anomaly the refusal-to-auto-demote rule exists to prevent.
      registerProject();
      probeGitMarkerMock.mockResolvedValue("unknown");
      const pvm = makePvm();

      await handlerFor(channel, pvm)({ sender: { id: 10 } }, "proj-gone");

      expect(pvm.switchTo).toHaveBeenCalled();
      expect(projectStoreMock.classifyGitBacking).not.toHaveBeenCalled();
    });

    it("never probes a row already opened without git", async () => {
      // It has no git identity left to lose, so there is nothing to reconcile.
      registerProject({ gitBacked: false });
      const pvm = makePvm();

      await handlerFor(channel, pvm)({ sender: { id: 10 } }, "proj-gone");

      expect(pvm.switchTo).toHaveBeenCalled();
      expect(probeGitMarkerMock).not.toHaveBeenCalled();
    });

    it("activates when git finds a repository despite the missing marker", async () => {
      registerProject();
      probeGitMarkerMock.mockResolvedValue("missing");
      projectStoreMock.classifyGitBacking.mockResolvedValue({
        gitBacked: true,
        gitRoot: "/projects/gone",
      });
      const pvm = makePvm();

      await handlerFor(channel, pvm)({ sender: { id: 10 } }, "proj-gone");

      expect(pvm.switchTo).toHaveBeenCalled();
    });

    it("surfaces an ambiguous classification under its own code", async () => {
      // Only a positive "not a repository" verdict may reach the demotion
      // dialog; anything else has to keep its own meaning so the user is told
      // what actually went wrong.
      registerProject();
      probeGitMarkerMock.mockResolvedValue("missing");
      projectStoreMock.classifyGitBacking.mockRejectedValue(
        Object.assign(new Error("Permission denied"), { code: "PERMISSION" })
      );
      const pvm = makePvm();

      await expect(handlerFor(channel, pvm)({ sender: { id: 10 } }, "proj-gone")).rejects.toThrow(
        expect.objectContaining({ code: "PERMISSION" })
      );
      expect(pvm.switchTo).not.toHaveBeenCalled();
    });
  });

  it("probes the project's own root", async () => {
    registerProject({ path: "/projects/specific" });
    probeGitMarkerMock.mockResolvedValue("present");

    await handlerFor(CHANNELS.PROJECT_SWITCH, makePvm())({ sender: { id: 10 } }, "proj-gone");

    expect(probeGitMarkerMock).toHaveBeenCalledWith("/projects/specific");
  });

  it("checks reopen's status precondition before touching the filesystem", async () => {
    // A closed project can't be reopened at all, so the guard must not spend a
    // syscall — or blame the repository — for what is a state error.
    registerProject({ status: "closed" });

    await expect(
      handlerFor(CHANNELS.PROJECT_REOPEN, makePvm())({ sender: { id: 10 } }, "proj-gone")
    ).rejects.toThrow(/status/);
    expect(probeGitMarkerMock).not.toHaveBeenCalled();
  });
});

describe("project:switch multi-window PVM routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses window 2's PVM when the IPC sender is window 2", async () => {
    const mockView = {
      webContents: { id: 200, isDestroyed: () => false, send: vi.fn() },
    };

    const pvm1 = {
      switchTo: vi.fn(),
      getProjectIdForWebContents: vi.fn(),
    };
    const pvm2 = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: false }),
      getProjectIdForWebContents: vi.fn(),
    };

    const ctx1 = makeWindowContext(1, 10, { projectViewManager: pvm1 as never });
    const ctx2 = makeWindowContext(2, 20, { projectViewManager: pvm2 as never });
    const registry = makeWindowRegistry([ctx1, ctx2]);

    // Simulate window 2 sending the IPC
    const fakeWindow2 = { id: 2, isDestroyed: () => false };
    mockGetWindowForWebContents.mockReturnValue(fakeWindow2);

    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-new",
      name: "New Project",
      path: "/projects/new",
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);

    const deps = {
      mainWindow: { id: 1 } as unknown,
      windowRegistry: registry,
      projectViewManager: pvm1,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const handler = handleMap.get(CHANNELS.PROJECT_SWITCH);
    expect(handler).toBeDefined();

    const fakeEvent = { sender: { id: 20 } };
    await handler!(fakeEvent, "proj-new");

    // Window 2's PVM should have been called
    expect(pvm2.switchTo).toHaveBeenCalledWith("proj-new", "/projects/new");
    // Window 1's PVM should NOT have been called
    expect(pvm1.switchTo).not.toHaveBeenCalled();
  });

  it("falls back to deps.projectViewManager when windowRegistry lookup fails", async () => {
    const mockView = {
      webContents: { id: 100, isDestroyed: () => false, send: vi.fn() },
    };

    const pvmFallback = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: false }),
      getProjectIdForWebContents: vi.fn(),
    };

    // No window registry — simulates single-window or test scenario
    mockGetWindowForWebContents.mockReturnValue(null);

    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-new",
      name: "New Project",
      path: "/projects/new",
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);

    const deps = {
      mainWindow: { id: 1 } as unknown,
      projectViewManager: pvmFallback,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const handler = handleMap.get(CHANNELS.PROJECT_SWITCH);
    const fakeEvent = { sender: { id: 99 } };
    await handler!(fakeEvent, "proj-new");

    expect(pvmFallback.switchTo).toHaveBeenCalledWith("proj-new", "/projects/new");
  });

  it("resolves correct PVM for handleProjectGetCurrent", async () => {
    const pvm1 = {
      getProjectIdForWebContents: vi.fn().mockReturnValue(null),
    };
    const pvm2 = {
      getProjectIdForWebContents: vi.fn().mockReturnValue("proj-2"),
    };

    const ctx1 = makeWindowContext(1, 10, { projectViewManager: pvm1 as never });
    const ctx2 = makeWindowContext(2, 20, { projectViewManager: pvm2 as never });
    const registry = makeWindowRegistry([ctx1, ctx2]);

    const fakeWindow2 = { id: 2, isDestroyed: () => false };
    mockGetWindowForWebContents.mockReturnValue(fakeWindow2);

    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-2",
      name: "Project 2",
      path: "/projects/2",
    });

    const deps = {
      mainWindow: { id: 1 } as unknown,
      windowRegistry: registry,
      projectViewManager: pvm1,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const handler = handleMap.get(CHANNELS.PROJECT_GET_CURRENT);
    const fakeEvent = { sender: { id: 20 } };
    const result = await handler!(fakeEvent);

    // Window 2's PVM should have been queried
    expect(pvm2.getProjectIdForWebContents).toHaveBeenCalledWith(20);
    // Should return window 2's project
    expect(result).toEqual({ id: "proj-2", name: "Project 2", path: "/projects/2" });
    // Window 1's PVM should NOT have been queried
    expect(pvm1.getProjectIdForWebContents).not.toHaveBeenCalled();
  });

  it("resolves correct PVM for handleProjectReopen", async () => {
    const mockView = {
      webContents: { id: 200, isDestroyed: () => false, send: vi.fn() },
    };

    const pvm1 = {
      switchTo: vi.fn(),
    };
    const pvm2 = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: false }),
    };

    const ctx1 = makeWindowContext(1, 10, { projectViewManager: pvm1 as never });
    const ctx2 = makeWindowContext(2, 20, { projectViewManager: pvm2 as never });
    const registry = makeWindowRegistry([ctx1, ctx2]);

    const fakeWindow2 = { id: 2, isDestroyed: () => false };
    mockGetWindowForWebContents.mockReturnValue(fakeWindow2);

    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-reopen",
      name: "Reopen Project",
      path: "/projects/reopen",
      status: "background",
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);

    const deps = {
      mainWindow: { id: 1 } as unknown,
      windowRegistry: registry,
      projectViewManager: pvm1,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const handler = handleMap.get(CHANNELS.PROJECT_REOPEN);
    const fakeEvent = { sender: { id: 20 } };
    await handler!(fakeEvent, "proj-reopen");

    expect(pvm2.switchTo).toHaveBeenCalledWith("proj-reopen", "/projects/reopen");
    expect(pvm1.switchTo).not.toHaveBeenCalled();
  });
});

describe("project:switch activeWorktreeId pre-apply (#5000)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Single-window fixtures: the sender view is the one displaying proj-old.
    // Stated explicitly now that the outgoing id is resolved per-sender rather
    // than from the global pointer (#11101).
    mockGetProjectForWebContents.mockReturnValue("proj-old");
  });

  it("persists activeWorktreeId from outgoingState on project switch", async () => {
    const mockView = {
      webContents: { id: 100, isDestroyed: () => false, send: vi.fn() },
    };

    const pvm = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: false }),
      getProjectIdForWebContents: vi.fn(),
    };

    mockGetWindowForWebContents.mockReturnValue(null);

    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-new",
      name: "New Project",
      path: "/projects/new",
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);
    projectStoreMock.getProjectState.mockResolvedValue(null);
    projectStoreMock.saveProjectState.mockResolvedValue(undefined);

    const deps = {
      mainWindow: { id: 1 } as unknown,
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const handler = handleMap.get(CHANNELS.PROJECT_SWITCH);
    const fakeEvent = { sender: { id: 99 } };
    const outgoingState = {
      draftInputs: {},
      activeWorktreeId: "wt-feature",
    };

    await handler!(fakeEvent, "proj-new", outgoingState);

    expect(projectStoreMock.saveProjectState).toHaveBeenCalledWith(
      "proj-old",
      expect.objectContaining({ activeWorktreeId: "wt-feature" })
    );
  });

  it("clears stale activeWorktreeId when outgoingState sends undefined", async () => {
    const mockView = {
      webContents: { id: 100, isDestroyed: () => false, send: vi.fn() },
    };

    const pvm = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: false }),
      getProjectIdForWebContents: vi.fn(),
    };

    mockGetWindowForWebContents.mockReturnValue(null);

    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-new",
      name: "New Project",
      path: "/projects/new",
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);
    projectStoreMock.getProjectState.mockResolvedValue({
      projectId: "proj-old",
      sidebarWidth: 350,
      terminals: [],
      activeWorktreeId: "wt-stale",
    });
    projectStoreMock.saveProjectState.mockResolvedValue(undefined);

    const deps = {
      mainWindow: { id: 1 } as unknown,
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const handler = handleMap.get(CHANNELS.PROJECT_SWITCH);
    const fakeEvent = { sender: { id: 99 } };
    const outgoingState = {
      draftInputs: {},
      activeWorktreeId: undefined,
    };

    await handler!(fakeEvent, "proj-new", outgoingState);

    const savedState = projectStoreMock.saveProjectState.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(savedState.activeWorktreeId).toBeUndefined();
  });

  it("persists activeWorktreeId from outgoingState on project reopen", async () => {
    const mockView = {
      webContents: { id: 200, isDestroyed: () => false, send: vi.fn() },
    };

    const pvm = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: false }),
    };

    const fakeWindow2 = { id: 2, isDestroyed: () => false };
    mockGetWindowForWebContents.mockReturnValue(fakeWindow2);

    const ctx = makeWindowContext(2, 20, { projectViewManager: pvm as never });
    const registry = makeWindowRegistry([ctx]);

    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-reopen",
      name: "Reopen Project",
      path: "/projects/reopen",
      status: "background",
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);
    projectStoreMock.getProjectState.mockResolvedValue(null);
    projectStoreMock.saveProjectState.mockResolvedValue(undefined);

    const deps = {
      mainWindow: { id: 1 } as unknown,
      windowRegistry: registry,
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const handler = handleMap.get(CHANNELS.PROJECT_REOPEN);
    const fakeEvent = { sender: { id: 20 } };
    const outgoingState = {
      draftInputs: {},
      activeWorktreeId: "wt-reopen",
    };

    await handler!(fakeEvent, "proj-reopen", outgoingState);

    expect(projectStoreMock.saveProjectState).toHaveBeenCalledWith(
      "proj-old",
      expect.objectContaining({ activeWorktreeId: "wt-reopen" })
    );
  });
});

describe("project:switch outgoing tabGroups pre-apply (#5001)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProjectForWebContents.mockReturnValue("proj-old");
  });

  it("persists tabGroups from outgoingState on project switch", async () => {
    const mockView = {
      webContents: { id: 100, isDestroyed: () => false, send: vi.fn() },
    };

    const pvm = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: false }),
      getProjectIdForWebContents: vi.fn(),
    };

    mockGetWindowForWebContents.mockReturnValue(null);

    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-new",
      name: "New Project",
      path: "/projects/new",
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);
    projectStoreMock.getProjectState.mockResolvedValue(null);
    projectStoreMock.saveProjectState.mockResolvedValue(undefined);

    const deps = {
      mainWindow: { id: 1 } as unknown,
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const handler = handleMap.get(CHANNELS.PROJECT_SWITCH);
    const fakeEvent = { sender: { id: 99 } };
    const outgoingState = {
      terminals: [{ id: "t-1", kind: "browser", title: "B", location: "grid" }],
      tabGroups: [{ id: "g1", location: "grid", activeTabId: "t-1", panelIds: ["t-1", "t-2"] }],
      draftInputs: {},
    };

    await handler!(fakeEvent, "proj-new", outgoingState);

    expect(projectStoreMock.saveProjectState).toHaveBeenCalledWith(
      "proj-old",
      expect.objectContaining({
        tabGroups: expect.arrayContaining([
          expect.objectContaining({ id: "g1", panelIds: ["t-1", "t-2"] }),
        ]),
      })
    );
  });

  it("does not include tabGroups when outgoingState has no tabGroups", async () => {
    const mockView = {
      webContents: { id: 100, isDestroyed: () => false, send: vi.fn() },
    };

    const pvm = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: false }),
      getProjectIdForWebContents: vi.fn(),
    };

    mockGetWindowForWebContents.mockReturnValue(null);

    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-new",
      name: "New Project",
      path: "/projects/new",
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);
    projectStoreMock.getProjectState.mockResolvedValue(null);
    projectStoreMock.saveProjectState.mockResolvedValue(undefined);

    const deps = {
      mainWindow: { id: 1 } as unknown,
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const handler = handleMap.get(CHANNELS.PROJECT_SWITCH);
    const fakeEvent = { sender: { id: 99 } };
    const outgoingState = {
      draftInputs: {},
    };

    await handler!(fakeEvent, "proj-new", outgoingState);

    const savedState = projectStoreMock.saveProjectState.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(savedState).not.toHaveProperty("tabGroups");
  });

  it("clears stale tabGroups when outgoingState sends empty array", async () => {
    const mockView = {
      webContents: { id: 100, isDestroyed: () => false, send: vi.fn() },
    };

    const pvm = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: false }),
      getProjectIdForWebContents: vi.fn(),
    };

    mockGetWindowForWebContents.mockReturnValue(null);

    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-new",
      name: "New Project",
      path: "/projects/new",
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);
    // Simulate existing state with stale tab groups
    projectStoreMock.getProjectState.mockResolvedValue({
      projectId: "proj-old",
      sidebarWidth: 350,
      terminals: [],
      tabGroups: [{ id: "stale-g1", location: "grid", activeTabId: "x", panelIds: ["x", "y"] }],
    });
    projectStoreMock.saveProjectState.mockResolvedValue(undefined);

    const deps = {
      mainWindow: { id: 1 } as unknown,
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const handler = handleMap.get(CHANNELS.PROJECT_SWITCH);
    const fakeEvent = { sender: { id: 99 } };
    const outgoingState = {
      terminals: [],
      tabGroups: [],
      draftInputs: {},
    };

    await handler!(fakeEvent, "proj-new", outgoingState);

    const savedState = projectStoreMock.saveProjectState.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(savedState.tabGroups).toEqual([]);
  });
});

describe("project:switch outgoing draftInputs merge (#11352)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProjectForWebContents.mockReturnValue("proj-old");
  });

  async function runSwitchWithDrafts(
    existingDrafts: Record<string, string>,
    outgoingState: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const mockView = {
      webContents: { id: 100, isDestroyed: () => false, send: vi.fn() },
    };
    const pvm = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: false }),
      getProjectIdForWebContents: vi.fn(),
    };
    mockGetWindowForWebContents.mockReturnValue(null);
    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-new",
      name: "New Project",
      path: "/projects/new",
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);
    projectStoreMock.getProjectState.mockResolvedValue({
      projectId: "proj-old",
      sidebarWidth: 350,
      terminals: [],
      tabGroups: [],
      draftInputs: existingDrafts,
    });
    projectStoreMock.saveProjectState.mockResolvedValue(undefined);

    const deps = {
      mainWindow: { id: 1 } as unknown,
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;
    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }
    const handler = handleMap.get(CHANNELS.PROJECT_SWITCH);
    await handler!({ sender: { id: 99 } }, "proj-new", outgoingState);
    return projectStoreMock.saveProjectState.mock.calls[0]?.[1] as Record<string, unknown>;
  }

  it("merges draftInputs by terminal id, preserving a sibling window's draft", async () => {
    const saved = await runSwitchWithDrafts(
      { t1: "old", sib: "sibling draft" },
      {
        draftInputs: { t1: "new" },
        draftDelta: { changedIds: ["t1"], removedIds: [] },
      }
    );
    expect(saved.draftInputs).toEqual({ t1: "new", sib: "sibling draft" });
  });

  it("tombstones a cleared draft via draftDelta without wiping siblings", async () => {
    const saved = await runSwitchWithDrafts(
      { t1: "gone", sib: "keep" },
      {
        draftInputs: {},
        draftDelta: { changedIds: [], removedIds: ["t1"] },
      }
    );
    expect(saved.draftInputs).toEqual({ sib: "keep" });
  });

  it("falls back to a full replace when no draftDelta is present (legacy)", async () => {
    const saved = await runSwitchWithDrafts(
      { t1: "old", sib: "would be lost" },
      { draftInputs: { t1: "new" } }
    );
    expect(saved.draftInputs).toEqual({ t1: "new" });
  });
});

describe("project:switch outgoing agentSessionId field merge (#11461)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProjectForWebContents.mockReturnValue("proj-old");
  });

  async function runSwitchWithTerminals(
    existingTerminals: Record<string, unknown>[],
    outgoingState: Record<string, unknown>
  ): Promise<{ id: string; agentSessionId?: string }[]> {
    const mockView = {
      webContents: { id: 100, isDestroyed: () => false, send: vi.fn() },
    };
    const pvm = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: false }),
      getProjectIdForWebContents: vi.fn(),
    };
    mockGetWindowForWebContents.mockReturnValue(null);
    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-new",
      name: "New Project",
      path: "/projects/new",
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);
    projectStoreMock.getProjectState.mockResolvedValue({
      projectId: "proj-old",
      sidebarWidth: 350,
      terminals: existingTerminals,
      tabGroups: [],
    });
    projectStoreMock.saveProjectState.mockResolvedValue(undefined);

    const deps = {
      mainWindow: { id: 1 } as unknown,
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;
    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }
    const handler = handleMap.get(CHANNELS.PROJECT_SWITCH);
    await handler!({ sender: { id: 99 } }, "proj-new", outgoingState);
    const state = projectStoreMock.saveProjectState.mock.calls[0]?.[1] as {
      terminals?: { id: string; agentSessionId?: string }[];
    };
    return state.terminals ?? [];
  }

  const pane = (extra: Record<string, unknown> = {}) => ({
    id: "t1",
    title: "Codex",
    kind: "terminal",
    cwd: "/proj",
    location: "grid",
    launchAgentId: "codex",
    ...extra,
  });

  it("keeps a shutdown-captured session id the outgoing snapshot omits", async () => {
    const terminals = await runSwitchWithTerminals([pane({ agentSessionId: "captured" })], {
      terminals: [pane({ agentState: "exited" })],
      terminalDelta: { changedIds: ["t1"], removedIds: [] },
    });

    expect(terminals.find((t) => t.id === "t1")?.agentSessionId).toBe("captured");
  });

  it("clears it when the outgoing delta claims the change", async () => {
    const terminals = await runSwitchWithTerminals([pane({ agentSessionId: "consumed" })], {
      terminals: [pane()],
      terminalDelta: {
        changedIds: ["t1"],
        removedIds: [],
        fieldEdits: [{ id: "t1", fields: ["agentSessionId"] }],
      },
    });

    expect(terminals.find((t) => t.id === "t1")?.agentSessionId).toBeUndefined();
  });
});

describe("project:switch worktree-load-status (#8400)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runSwitch(loadProject: () => Promise<void>) {
    const sendMock = vi.fn();
    const mockView = {
      webContents: { id: 300, isDestroyed: () => false, send: sendMock },
    };
    const pvm = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: false }),
      getProjectIdForWebContents: vi.fn(),
    };

    mockGetWindowForWebContents.mockReturnValue({ id: 7, isDestroyed: () => false });

    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-new",
      name: "New Project",
      path: "/projects/new",
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);

    const worktreeService = {
      loadProject: vi.fn(loadProject),
      attachDirectPort: vi.fn(),
      getHostForProject: vi.fn(() => null),
      resumeProject: vi.fn(),
      pauseProject: vi.fn(),
    };

    const deps = {
      mainWindow: { id: 7 } as unknown,
      projectViewManager: pvm,
      worktreeService: worktreeService as never,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    await handleMap.get(CHANNELS.PROJECT_SWITCH)!({ sender: { id: 300 } }, "proj-new");
    return sendMock;
  }

  it("sends the error targeted to the activated view when loadProject throws", async () => {
    const sendMock = await runSwitch(async () => {
      throw new Error("Not a git repository");
    });

    expect(sendMock).toHaveBeenCalledWith(CHANNELS.PROJECT_WORKTREE_LOAD_STATUS, {
      projectId: "proj-new",
      worktreeLoadError: "Not a git repository",
    });
  });

  it("sends a null status on success so a stale banner clears", async () => {
    const sendMock = await runSwitch(async () => undefined);

    expect(sendMock).toHaveBeenCalledWith(CHANNELS.PROJECT_WORKTREE_LOAD_STATUS, {
      projectId: "proj-new",
      worktreeLoadError: null,
    });
  });
});

describe("project:switch concurrent worktree load", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setup(opts: {
    switchTo: () => Promise<{ view: unknown; isNew: boolean }>;
    loadProject?: () => Promise<void>;
    previousProject?: { id: string; name: string; path: string } | null;
  }) {
    const previous =
      opts.previousProject === undefined
        ? { id: "proj-old", name: "Old Project", path: "/projects/old" }
        : opts.previousProject;

    const pvm = {
      switchTo: vi.fn(opts.switchTo),
      getProjectIdForWebContents: vi.fn(),
    };

    mockGetWindowForWebContents.mockReturnValue({ id: 7, isDestroyed: () => false });
    projectStoreMock.getCurrentProjectId.mockReturnValue(previous?.id ?? null);
    // The sender view displays the previous project (null models the welcome
    // view, which is bound to no project at all).
    mockGetProjectForWebContents.mockReturnValue(previous?.id ?? null);
    projectStoreMock.getProjectById.mockImplementation((id: string) => {
      if (id === "proj-new") {
        return { id: "proj-new", name: "New Project", path: "/projects/new" };
      }
      if (previous && id === previous.id) return previous;
      return null;
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);

    const worktreeService = {
      loadProject: vi.fn(opts.loadProject ?? (async () => undefined)),
      attachDirectPort: vi.fn(),
      getHostForProject: vi.fn(() => null),
      resumeProject: vi.fn(),
      pauseProject: vi.fn(),
      unregisterWindow: vi.fn(),
    };

    const deps = {
      mainWindow: { id: 7 } as unknown,
      projectViewManager: pvm,
      worktreeService: worktreeService as never,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const invoke = () =>
      handleMap.get(CHANNELS.PROJECT_SWITCH)!({ sender: { id: 300 } }, "proj-new");

    return { invoke, pvm, worktreeService };
  }

  it("starts the worktree git load before the view swap resolves", async () => {
    let resolveSwap: (v: { view: unknown; isNew: boolean }) => void = () => {};
    const swapGate = new Promise<{ view: unknown; isNew: boolean }>((resolve) => {
      resolveSwap = resolve;
    });
    const { invoke, worktreeService } = setup({ switchTo: () => swapGate });

    const handlerPromise = invoke();

    // The load must be in flight while the swap still is — running them
    // serially re-adds the full host-spawn + git-enumeration time (hundreds of
    // ms on a cold host) to every switch's resolve time.
    await vi.waitFor(() => expect(worktreeService.loadProject).toHaveBeenCalled());
    expect(worktreeService.loadProject).toHaveBeenCalledWith("/projects/new", 7);
    expect(worktreeService.resumeProject).toHaveBeenCalledWith("/projects/new");

    resolveSwap({
      view: { webContents: { id: 300, isDestroyed: () => false, send: vi.fn() } },
      isNew: false,
    });
    await handlerPromise;
  });

  it("re-points the worktree mapping at the previous project when the swap fails", async () => {
    const { invoke, worktreeService } = setup({
      switchTo: async () => {
        throw new Error("load timeout");
      },
    });

    await expect(invoke()).rejects.toThrow("load timeout");

    // The early load already flipped windowToProject to the failed target while
    // the previous view stays visible — exactly the cross-project contamination
    // loadProject exists to prevent. The handler must restore the mapping.
    await vi.waitFor(() =>
      expect(worktreeService.loadProject).toHaveBeenCalledWith("/projects/old", 7)
    );
  });

  it("releases the window mapping when the swap fails with no previous project", async () => {
    const { invoke, worktreeService } = setup({
      switchTo: async () => {
        throw new Error("load timeout");
      },
      previousProject: null,
    });

    await expect(invoke()).rejects.toThrow("load timeout");

    // First switch from the welcome view: there is nothing to restore, so the
    // early load's attachment (and windowToProject mapping) must be released —
    // pausing alone would leave the window routed at the failed target.
    await vi.waitFor(() => expect(worktreeService.unregisterWindow).toHaveBeenCalledWith(7));
    // With nothing to restore, the mapping must not be re-loaded anywhere else.
    expect(worktreeService.loadProject).toHaveBeenCalledTimes(1);
  });

  it("skips the failure restore when a newer switch claimed the window meanwhile", async () => {
    let rejectSwap: (err: Error) => void = () => {};
    const failingSwap = new Promise<{ view: unknown; isNew: boolean }>((_resolve, reject) => {
      rejectSwap = reject;
    });
    let call = 0;
    const { invoke, worktreeService } = setup({
      switchTo: () => {
        call++;
        if (call === 1) return failingSwap;
        return Promise.resolve({
          view: { webContents: { id: 300, isDestroyed: () => false, send: vi.fn() } },
          isNew: false,
        });
      },
    });

    const first = invoke();
    // Let the first handler reach its awaited swap before the second starts.
    await vi.waitFor(() => expect(worktreeService.loadProject).toHaveBeenCalledTimes(1));

    // A second switch claims the window (bumps the epoch) and completes.
    await invoke();

    // Now the first swap fails. Its deferred restore must see the stale epoch
    // and do nothing — re-loading the old project here would clobber the
    // mapping the second switch just established.
    rejectSwap(new Error("load timeout"));
    await expect(first).rejects.toThrow("load timeout");
    await new Promise((r) => setTimeout(r, 10));

    expect(worktreeService.loadProject).not.toHaveBeenCalledWith("/projects/old", 7);
    expect(worktreeService.unregisterWindow).not.toHaveBeenCalled();
  });

  it("does not surface a worktree load failure through a successful swap", async () => {
    const sendMock = vi.fn();
    const { invoke } = setup({
      switchTo: async () => ({
        view: { webContents: { id: 300, isDestroyed: () => false, send: sendMock } },
        isNew: false,
      }),
      loadProject: async () => {
        throw new Error("Not a git repository");
      },
    });

    // Forward-fail (#8400): the load rejection — even though it now starts
    // before the swap — must resolve the switch and surface as the targeted
    // worktree-load-status, not reject the handler.
    await invoke();

    expect(sendMock).toHaveBeenCalledWith(CHANNELS.PROJECT_WORKTREE_LOAD_STATUS, {
      projectId: "proj-new",
      worktreeLoadError: "Not a git repository",
    });
  });
});

describe("project:switch PROJECT_ON_SWITCH notification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runActivation(channel: string, projectOverrides: Record<string, unknown> = {}) {
    const sendMock = vi.fn();
    const mockView = {
      webContents: { id: 300, isDestroyed: () => false, send: sendMock },
    };
    const pvm = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: false }),
      getProjectIdForWebContents: vi.fn(),
    };

    mockGetWindowForWebContents.mockReturnValue(null);

    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-new",
      name: "New Project",
      path: "/projects/new",
      ...projectOverrides,
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);

    const deps = {
      mainWindow: { id: 1 } as unknown,
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    await handleMap.get(channel)!({ sender: { id: 99 } }, "proj-new");
    return sendMock;
  }

  it("emits PROJECT_ON_SWITCH with a string switchId to the activated view on switch", async () => {
    const sendMock = await runActivation(CHANNELS.PROJECT_SWITCH);

    const call = sendMock.mock.calls.find((c) => c[0] === CHANNELS.PROJECT_ON_SWITCH);
    expect(call).toBeDefined();
    const payload = call![1] as { project: { id: string }; switchId: string };
    expect(payload.project).toEqual(expect.objectContaining({ id: "proj-new" }));
    // Behavior, not a fixed literal: switchId must be a non-empty string so
    // repeat activations are distinguishable (asserted below).
    expect(typeof payload.switchId).toBe("string");
    expect(payload.switchId.length).toBeGreaterThan(0);
  });

  it("emits a fresh switchId on each switch so repeat activations are distinguishable", async () => {
    const first = await runActivation(CHANNELS.PROJECT_SWITCH);
    const second = await runActivation(CHANNELS.PROJECT_SWITCH);

    const idOf = (mock: ReturnType<typeof vi.fn>) =>
      (mock.mock.calls.find((c) => c[0] === CHANNELS.PROJECT_ON_SWITCH)![1] as { switchId: string })
        .switchId;
    expect(idOf(first)).not.toBe(idOf(second));
  });

  it("emits PROJECT_ON_SWITCH on reopen as well", async () => {
    const sendMock = await runActivation(CHANNELS.PROJECT_REOPEN, { status: "background" });

    const call = sendMock.mock.calls.find((c) => c[0] === CHANNELS.PROJECT_ON_SWITCH);
    expect(call).toBeDefined();
    const switchId = (call![1] as { switchId: string }).switchId;
    expect(typeof switchId).toBe("string");
    expect(switchId.length).toBeGreaterThan(0);
  });
});

describe("project:switch PTY port ordering (#10075)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setup(opts: { isNew: boolean; loadProject: () => Promise<void> }) {
    const sendMock = vi.fn();
    const mockView = {
      webContents: { id: 300, isDestroyed: () => false, send: sendMock },
    };
    const pvm = {
      switchTo: vi.fn().mockResolvedValue({ view: mockView, isNew: opts.isNew }),
      getProjectIdForWebContents: vi.fn(),
    };

    mockGetWindowForWebContents.mockReturnValue({ id: 7, isDestroyed: () => false });

    projectStoreMock.getCurrentProjectId.mockReturnValue("proj-old");
    projectStoreMock.getProjectById.mockReturnValue({
      id: "proj-new",
      name: "New Project",
      path: "/projects/new",
    });
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);

    const ptyClient = { onProjectSwitch: vi.fn() };
    const worktreeService = {
      loadProject: vi.fn(opts.loadProject),
      attachDirectPort: vi.fn(),
      getHostForProject: vi.fn(() => null),
      resumeProject: vi.fn(),
      pauseProject: vi.fn(),
    };
    const windowRegistry = makeWindowRegistry([makeWindowContext(7, 300)]);
    (
      windowRegistry as unknown as { registerAppViewWebContents: unknown }
    ).registerAppViewWebContents = vi.fn();

    const deps = {
      mainWindow: { id: 7 } as unknown,
      projectViewManager: pvm,
      worktreeService: worktreeService as never,
      ptyClient: ptyClient as never,
      windowRegistry,
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const invoke = () =>
      handleMap.get(CHANNELS.PROJECT_SWITCH)!({ sender: { id: 300 } }, "proj-new");

    return { invoke, ptyClient, worktreeService };
  }

  it("rebrokers the PTY port before the worktree git load resolves on a warm switch", async () => {
    // A deferred loadProject lets us observe state at the moment the handler
    // reaches the (slow) git-load await — the PTY work must already be done by
    // then, otherwise terminal output would queue behind the load (#10075).
    let resolveLoad: () => void = () => {};
    const loadGate = new Promise<void>((resolve) => {
      resolveLoad = resolve;
    });

    const { invoke, ptyClient, worktreeService } = setup({
      isNew: false,
      loadProject: () => loadGate,
    });
    const distributeMock = vi.mocked(distributePortsToView);

    const handlerPromise = invoke();

    await vi.waitFor(() => expect(worktreeService.loadProject).toHaveBeenCalled());

    expect(ptyClient.onProjectSwitch).toHaveBeenCalledWith(7, "proj-new", "/projects/new");
    expect(distributeMock).toHaveBeenCalledTimes(1);
    // Port goes to the sender's window/context and carries the live ptyClient —
    // routing to the wrong window would silently drop terminal data.
    expect(distributeMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      expect.any(Object),
      expect.objectContaining({ id: 300 }),
      ptyClient
    );
    // PTY-host routing must be updated before the renderer port opens, else the
    // port is connected while the host still points at the old project.
    expect(ptyClient.onProjectSwitch.mock.invocationCallOrder[0]).toBeLessThan(
      distributeMock.mock.invocationCallOrder[0]
    );

    resolveLoad();
    await handlerPromise;
  });

  it("still rebrokers the PTY port even when the worktree load rejects", async () => {
    const { invoke, ptyClient } = setup({
      isNew: false,
      loadProject: async () => {
        throw new Error("Not a git repository");
      },
    });
    const distributeMock = vi.mocked(distributePortsToView);

    await invoke();

    // The reorder runs PTY work before loadProject, so a git-load failure must
    // not retroactively undo terminal connectivity (#10075).
    expect(ptyClient.onProjectSwitch).toHaveBeenCalledWith(7, "proj-new", "/projects/new");
    expect(distributeMock).toHaveBeenCalledTimes(1);
  });

  it("does not redistribute the PTY port for a cold-started view (isNew guard)", async () => {
    const { invoke, ptyClient } = setup({
      isNew: true,
      loadProject: async () => undefined,
    });
    const distributeMock = vi.mocked(distributePortsToView);

    await invoke();

    // Cold-start views get their first PTY port from
    // ProjectViewManager.onViewReady; redistributing here would race it.
    expect(distributeMock).not.toHaveBeenCalled();
    // onProjectSwitch still fires regardless of new/warm.
    expect(ptyClient.onProjectSwitch).toHaveBeenCalledWith(7, "proj-new", "/projects/new");
  });

  it("resumes the incoming project's workspace host on switch (#10743)", async () => {
    const { invoke, worktreeService } = setup({
      isNew: false,
      loadProject: async () => undefined,
    });

    await invoke();

    // Switching TO a project must foreground its host so a previously
    // backgrounded project resumes full-rate polling for fresh state.
    expect(worktreeService.resumeProject).toHaveBeenCalledWith("/projects/new");
  });
});

describe("project:switch outgoing project is the sender's, not the global (#11101)", () => {
  const PROJECTS: Record<string, { id: string; name: string; path: string; status?: string }> = {
    p1: { id: "p1", name: "Window A project", path: "/projects/p1", status: "active" },
    p2: { id: "p2", name: "Window B project", path: "/projects/p2", status: "active" },
    p3: { id: "p3", name: "Target", path: "/projects/p3", status: "background" },
  };

  const WINDOW_B = 2;
  const SENDER_B = 20;

  beforeEach(() => {
    vi.clearAllMocks();
    projectStoreMock.getProjectById.mockImplementation((id: string) => PROJECTS[id] ?? null);
    projectStoreMock.setCurrentProject.mockResolvedValue(undefined);
    projectStoreMock.getProjectState.mockResolvedValue(null);
    projectStoreMock.saveProjectState.mockResolvedValue(undefined);
  });

  /**
   * Window A displays p1 and is the globally-current project. Window B displays
   * p2 and is the one switching. Anything the handler derives from the global
   * pointer therefore comes back as window A's project — which is the bug.
   */
  function setup(
    opts: {
      senderProjectId?: string | null;
      senderUrl?: string;
      withPvm?: boolean;
      switchTo?: () => Promise<{ view: unknown; isNew: boolean }>;
      worktree?: boolean;
    } = {}
  ) {
    const view = { webContents: { id: 210, isDestroyed: () => false, send: vi.fn() } };
    const pvm = {
      switchTo: vi.fn(opts.switchTo ?? (async () => ({ view, isNew: false }))),
      getProjectIdForWebContents: vi.fn(),
      setPendingFocusIntent: vi.fn(),
    };

    mockGetWindowForWebContents.mockReturnValue({ id: WINDOW_B, isDestroyed: () => false });
    mockGetProjectForWebContents.mockImplementation((id: number) =>
      id === SENDER_B ? (opts.senderProjectId ?? null) : null
    );
    // The global pointer is window A's project throughout.
    projectStoreMock.getCurrentProjectId.mockReturnValue("p1");

    const worktreeService = {
      loadProject: vi.fn(async () => undefined),
      attachDirectPort: vi.fn(),
      getHostForProject: vi.fn(() => null),
      resumeProject: vi.fn(),
      pauseProject: vi.fn(),
      unregisterWindow: vi.fn(),
    };

    const withPvm = opts.withPvm ?? true;
    const ctxB = makeWindowContext(
      WINDOW_B,
      SENDER_B,
      withPvm ? { projectViewManager: pvm as never } : {}
    );
    const deps = {
      mainWindow: { id: 1 } as unknown,
      windowRegistry: makeWindowRegistry([ctxB]),
      ...(withPvm ? { projectViewManager: pvm } : {}),
      ...(opts.worktree ? { worktreeService: worktreeService as never } : {}),
    } as unknown as HandlerDependencies;

    registerProjectCrudHandlers(deps);

    const handleMap = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls) {
      handleMap.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }

    const sender: Record<string, unknown> = { id: SENDER_B };
    if (opts.senderUrl) sender.getURL = () => opts.senderUrl;

    const invoke = (channel: string, targetId: string, outgoingState?: unknown) =>
      handleMap.get(channel)!({ sender }, targetId, outgoingState);

    return { invoke, pvm, worktreeService, view };
  }

  const OUTGOING = {
    terminals: [],
    activeWorktreeId: "wt-from-window-b",
    draftInputs: { "wt-from-window-b": "half-typed prompt" },
  };

  it("persists the sender window's layout under ITS project, not the global one", async () => {
    const { invoke } = setup({ senderProjectId: "p2" });

    await invoke(CHANNELS.PROJECT_SWITCH, "p3", OUTGOING);

    // The whole bug: window B's terminals/drafts/worktree landing on p1 would
    // silently overwrite window A's saved layout, discovered only on reopen.
    expect(projectStoreMock.enqueueProjectStateUpdate).toHaveBeenCalledTimes(1);
    expect(projectStoreMock.enqueueProjectStateUpdate.mock.calls[0][0]).toBe("p2");
    expect(projectStoreMock.saveProjectState).toHaveBeenCalledWith(
      "p2",
      expect.objectContaining({ projectId: "p2", activeWorktreeId: "wt-from-window-b" })
    );
    expect(projectStoreMock.saveProjectState).not.toHaveBeenCalledWith("p1", expect.anything());
  });

  it("backgrounds and announces the sender's project, leaving the other window's alone", async () => {
    const { invoke } = setup({ senderProjectId: "p2" });

    await invoke(CHANNELS.PROJECT_SWITCH, "p3", OUTGOING);

    // Passing p2 explicitly is what stops the store backgrounding + MRU-bumping
    // p1, which window A is still displaying.
    expect(projectStoreMock.setCurrentProject).toHaveBeenCalledWith("p3", "p2");
    // The broadcast must mirror the same rows the transaction wrote (#8563).
    expect(mockBroadcastProjectSwitchUpdates).toHaveBeenCalledWith("p2", "p3");
  });

  it("keeps the captured outgoing project across the switchTo await", async () => {
    // switchTo flips the PVM's active project to the incoming one, and another
    // window can move the global pointer meanwhile. A handler that re-derived
    // the outgoing id after the swap would read p3/whatever and persist there.
    const { invoke } = setup({
      senderProjectId: "p2",
      switchTo: async () => {
        mockGetProjectForWebContents.mockReturnValue("p3");
        projectStoreMock.getCurrentProjectId.mockReturnValue("p3");
        return {
          view: { webContents: { id: 210, isDestroyed: () => false, send: vi.fn() } },
          isNew: false,
        };
      },
    });

    await invoke(CHANNELS.PROJECT_SWITCH, "p3", OUTGOING);

    expect(projectStoreMock.saveProjectState).toHaveBeenCalledWith("p2", expect.anything());
    expect(projectStoreMock.setCurrentProject).toHaveBeenCalledWith("p3", "p2");
    expect(mockBroadcastProjectSwitchUpdates).toHaveBeenCalledWith("p2", "p3");
  });

  it("reopen persists the sender's layout even when the global already equals the target", async () => {
    // Global pointer is p1... but make it p3 (the reopen target) to prove the
    // no-op check is asking about the SENDER, not the global.
    const { invoke } = setup({ senderProjectId: "p2" });
    projectStoreMock.getCurrentProjectId.mockReturnValue("p3");

    await invoke(CHANNELS.PROJECT_REOPEN, "p3", OUTGOING);

    // The old global-based check (`global !== target`) would short-circuit here
    // and drop window B's outgoing layout on the floor entirely.
    expect(projectStoreMock.saveProjectState).toHaveBeenCalledWith("p2", expect.anything());
    expect(projectStoreMock.setCurrentProject).toHaveBeenCalledWith("p3", "p2");
  });

  it("reopen skips the persist when the sender already displays the target", async () => {
    const { invoke } = setup({ senderProjectId: "p2" });

    await invoke(CHANNELS.PROJECT_REOPEN, "p2", OUTGOING);

    expect(projectStoreMock.enqueueProjectStateUpdate).not.toHaveBeenCalled();
  });

  it("falls back to the sender URL while the restored view is not yet bound", async () => {
    // loadRenderer() sends the initial view its `?projectId=` and can serve IPC
    // before registerInitialView() binds it in the project maps.
    const { invoke } = setup({ senderProjectId: null, senderUrl: "app://index.html?projectId=p2" });

    await invoke(CHANNELS.PROJECT_SWITCH, "p3", OUTGOING);

    expect(projectStoreMock.saveProjectState).toHaveBeenCalledWith("p2", expect.anything());
    expect(projectStoreMock.setCurrentProject).toHaveBeenCalledWith("p3", "p2");
  });

  it("persists nothing for an unbound welcome view instead of stealing the global project", async () => {
    const { invoke } = setup({ senderProjectId: null });

    await invoke(CHANNELS.PROJECT_SWITCH, "p3", OUTGOING);

    // A fresh Cmd+N window has no layout of its own. Falling back to the global
    // here would write window B's empty state over window A's p1 (#6016).
    expect(projectStoreMock.enqueueProjectStateUpdate).not.toHaveBeenCalled();
    // Explicit null, not undefined: undefined would let the store infer p1 and
    // background a project another window is still showing.
    expect(projectStoreMock.setCurrentProject).toHaveBeenCalledWith("p3", null);
    expect(mockBroadcastProjectSwitchUpdates).toHaveBeenCalledWith(null, "p3");
  });

  it("still uses the global pointer on the legacy non-PVM path", async () => {
    // No ProjectViewManager anywhere means a single shared renderer, where the
    // global pointer IS this window's project. The sender URL is deliberately
    // not consulted there — that renderer never reloads, so its query string
    // goes stale after the first switch.
    const { invoke } = setup({
      senderProjectId: null,
      senderUrl: "app://index.html?projectId=p2",
      withPvm: false,
    });

    await invoke(CHANNELS.PROJECT_SWITCH, "p3", OUTGOING);

    expect(projectStoreMock.saveProjectState).toHaveBeenCalledWith("p1", expect.anything());
  });

  it("restores the sender's own project when the swap fails", async () => {
    const { invoke, worktreeService } = setup({
      senderProjectId: "p2",
      worktree: true,
      switchTo: async () => {
        throw new Error("paint gate timeout");
      },
    });

    await expect(invoke(CHANNELS.PROJECT_SWITCH, "p3", OUTGOING)).rejects.toThrow(
      "paint gate timeout"
    );

    // The early load already pointed window B at the failed p3. Restoring from
    // the global would re-point window B at p1 — window A's project — which is
    // the cross-project contamination loadProject exists to prevent.
    await vi.waitFor(() =>
      expect(worktreeService.loadProject).toHaveBeenCalledWith("/projects/p2", WINDOW_B)
    );
    expect(worktreeService.loadProject).not.toHaveBeenCalledWith("/projects/p1", WINDOW_B);
  });
});
