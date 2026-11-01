import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    quit: vi.fn(),
    emit: vi.fn(),
    getPath: vi.fn(() => "/tmp"),
    isPackaged: false,
    on: vi.fn(),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []), fromWebContents: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
  Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
  shell: { openExternal: vi.fn() },
  dialog: {},
  session: {},
}));

// Explicit factories: the store reaches better-sqlite3 and the coordinator
// reaches electron's lifecycle, neither of which this suite should load.
vi.mock("../../services/persistence/windowManifestStore.js", () => ({
  writeOpenWindowsManifest: vi.fn(),
}));
vi.mock("../../lifecycle/shutdownCoordinator.js", () => ({ getActiveShutdown: () => null }));
vi.mock("../../services/CrashRecoveryService.js", () => ({
  getCrashRecoveryService: () => ({
    recordRendererGone: vi.fn(),
    getLastBackupTimestamp: () => null,
    getBackupPanelCount: () => null,
  }),
}));
vi.mock("../../ipc/errorHandlers.js", () => ({ notifyError: vi.fn() }));
vi.mock("../../utils/systemMemory.js", () => ({ readAvailableSystemMemoryMb: () => null }));
vi.mock("../../utils/logger.js", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../../utils/openExternal.js", () => ({
  canOpenExternalUrl: vi.fn(() => false),
  openExternalUrl: vi.fn(),
}));
vi.mock("../rendererConsoleCapture.js", () => ({
  attachRendererConsoleCapture: vi.fn(),
  detachRendererConsoleCapture: vi.fn(),
}));
vi.mock("../ProjectViewEvictionController.js", () => ({
  evictDeadView: vi.fn(),
  getAvailableMemoryMb: vi.fn(() => null),
}));
vi.mock("../powerPolicyDelivery.js", () => ({ deliverPowerPolicy: vi.fn() }));

import { attachAppViewRendererGoneHandler } from "../appViewRendererGone.js";
import { setupViewHandlers } from "../ProjectViewHandlers.js";
import { createWindowRecreation, type WindowRecreationDeps } from "../windowRecreation.js";
import { initOpenWindowsTracker, resetOpenWindowsTrackerForTests } from "../openWindowsTracker.js";
import { isWindowRecreating } from "../../lifecycle/windowRecreationState.js";
import type { ProjectViewManager } from "../ProjectViewManager.js";
import type { ViewEntry } from "../ProjectViewManagerTypes.js";
import type { WindowContext, WindowRegistry } from "../WindowRegistry.js";

type GoneHandler = (event: unknown, details: { reason: string; exitCode: number }) => void;

function fakeWebContents(id: number) {
  const gone: GoneHandler[] = [];
  return {
    id,
    gone,
    on: vi.fn((event: string, handler: GoneHandler) => {
      if (event === "render-process-gone") gone.push(handler);
    }),
    removeListener: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    isDestroyed: () => false,
    reload: vi.fn(),
    loadURL: vi.fn(),
  };
}

interface WiredWindow {
  windowId: number;
  destroyed: boolean;
  appWebContents: ReturnType<typeof fakeWebContents>;
  projectWebContents: ReturnType<typeof fakeWebContents>;
  /** The startup app view's renderer dies. */
  appViewGone: (reason: string) => void;
  /** The window's project view renderer dies. */
  projectViewGone: (reason: string) => void;
  /** The window its OOM rebuild opened, once there is one. */
  replacement?: WiredWindow;
}

/**
 * A fleet of windows wired the way main.ts's `createWindow` wires each one:
 * one recreation per window, handed to the real app-view handler and to the
 * real ProjectViewHandlers of its project view, rebuilding through a
 * `createWindow` that wires the replacement the same way with whatever the
 * dying window handed it. Destroying a window unregisters it, as the real
 * registry does at teardown.
 */
function createFleet() {
  const contexts = new Map<number, WindowContext>();
  const windows: WiredWindow[] = [];
  let nextWindowId = 1;
  let nextWebContentsId = 100;

  const registry = {
    focusOrder: () => [...contexts.values()],
    all: () => [...contexts.values()],
    getByWindowId: (id: number) => contexts.get(id),
  } as unknown as WindowRegistry;

  const createWindow = vi.fn<WindowRecreationDeps["createWindow"]>(async (_projectId, opts) => {
    const replacement = open({ oomHistory: opts.oomHistory });
    opts.onRegistered(replacement.windowId);
    return "ok" as const;
  });

  function open(init: { oomHistory?: readonly number[] } = {}): WiredWindow {
    const windowId = nextWindowId++;
    const appWebContents = fakeWebContents(nextWebContentsId++);
    const projectWebContents = fakeWebContents(nextWebContentsId++);
    const wired: WiredWindow = {
      windowId,
      destroyed: false,
      appWebContents,
      projectWebContents,
      appViewGone: (reason) => {
        for (const handler of appWebContents.gone) handler({}, { reason, exitCode: 1 });
      },
      projectViewGone: (reason) => {
        for (const handler of projectWebContents.gone) handler({}, { reason, exitCode: 1 });
      },
    };
    windows.push(wired);

    const manager = {
      getActiveProjectId: () => (wired.destroyed ? null : "proj-b"),
      getAllViews: () => (wired.destroyed ? [] : [{ projectId: "proj-b", lastUsed: 1 }]),
    };
    contexts.set(windowId, {
      windowId,
      browserWindow: { isDestroyed: () => wired.destroyed, isFocused: () => true },
      services: { projectViewManager: manager },
    } as unknown as WindowContext);

    const browserWindow = {
      id: windowId,
      isDestroyed: () => wired.destroyed,
      destroy: () => {
        wired.destroyed = true;
        contexts.delete(windowId);
      },
    };

    const recreation = createWindowRecreation({
      windowRegistry: registry,
      getWindowId: () => windowId,
      oomHistory: init.oomHistory,
      createWindow: (projectId, opts) =>
        createWindow(projectId, {
          ...opts,
          onRegistered: (id) => {
            wired.replacement = windows.find((win) => win.windowId === id);
            opts.onRegistered(id);
          },
        }),
    });

    attachAppViewRendererGoneHandler({
      win: browserWindow as never,
      appWebContents: appWebContents as never,
      getProjectViewManager: () =>
        ({
          getProjectIdForWebContents: () => null,
          notifyViewRendererGone: () => {},
          notifyActiveViewCrashed: () => false,
          evictCrashedCachedView: () => false,
          getLowMemoryFreeThresholdMb: () => null,
        }) as unknown as ProjectViewManager,
      getRecoveryUrl: (reason) => `app://daintree/recovery.html?reason=${reason}`,
      prepareWindowRecreation: recreation.prepare,
    });

    const entry = {
      projectId: "proj-b",
      projectPath: "/repos/proj-b",
      state: "active",
      crashTimestamps: [],
      cleanupHandlers: () => {},
    } as unknown as ViewEntry;
    const host = {
      win: browserWindow,
      webContentsToProject: new Map([[projectWebContents.id, "proj-b"]]),
      views: new Map([["proj-b", entry]]),
      activeProjectId: "proj-b",
      pendingColdSwitch: null,
      memoryPressurePolicy: null,
      notifyViewRendererGone: vi.fn(),
      onViewCrashed: vi.fn(),
      prepareWindowRecreation: recreation.prepare,
    } as unknown as ProjectViewManager;
    setupViewHandlers(host, { webContents: projectWebContents } as never, entry);

    return wired;
  }

  return { open, createWindow };
}

function isRecoveryLoad(webContents: ReturnType<typeof fakeWebContents>): boolean {
  return webContents.loadURL.mock.calls.some(([url]) => String(url).includes("recovery.html"));
}

describe("OOM recreation budget across replacement windows (#15647)", () => {
  let fleet: ReturnType<typeof createFleet>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    resetOpenWindowsTrackerForTests();
    fleet = createFleet();
    initOpenWindowsTracker({
      registry: {
        focusOrder: () => [],
        all: () => [],
        getByWindowId: () => undefined,
      } as unknown as WindowRegistry,
      readOnly: true,
    });
  });

  afterEach(() => {
    resetOpenWindowsTrackerForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Runs the crash's recovery to completion; returns the window it leaves standing. */
  async function settle(win: WiredWindow): Promise<WiredWindow> {
    await vi.runAllTimersAsync();
    if (!win.destroyed) return win;
    // A window torn down without a live replacement is a failed rebuild, not
    // a recreation.
    expect(win.replacement?.destroyed).toBe(false);
    return win.replacement!;
  }

  async function appViewOom(win: WiredWindow): Promise<WiredWindow> {
    win.appViewGone("oom");
    return settle(win);
  }

  async function projectViewOom(win: WiredWindow): Promise<WiredWindow> {
    win.projectViewGone("oom");
    return settle(win);
  }

  it("shows the recovery page on the third OOM within a minute, and recreates an isolated OOM after", async () => {
    const first = fleet.open();

    const second = await appViewOom(first);
    expect(second).not.toBe(first);
    await vi.advanceTimersByTimeAsync(20_000);
    const third = await appViewOom(second);
    expect(third).not.toBe(second);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(await appViewOom(third)).toBe(third);
    expect(third.destroyed).toBe(false);
    expect(fleet.createWindow).toHaveBeenCalledTimes(2);
    expect(third.appWebContents.loadURL).toHaveBeenCalledWith(
      "app://daintree/recovery.html?reason=oom"
    );
    expect(isWindowRecreating()).toBe(false);

    // Long after the last one, an OOM is an isolated event again.
    await vi.advanceTimersByTimeAsync(60_001);
    const fourth = await appViewOom(third);

    expect(third.destroyed).toBe(true);
    expect(fourth).not.toBe(third);
    expect(fleet.createWindow).toHaveBeenCalledTimes(3);
  });

  it("counts startup-view and project-view OOMs against the same window", async () => {
    const second = await appViewOom(fleet.open());
    const third = await projectViewOom(second);
    expect(second.destroyed).toBe(true);

    expect(await projectViewOom(third)).toBe(third);
    expect(fleet.createWindow).toHaveBeenCalledTimes(2);
    expect(third.projectWebContents.loadURL).toHaveBeenCalledWith(
      expect.stringMatching(/\/recovery\.html\?reason=oom&exitCode=1&project=proj-b$/)
    );
    expect(third.projectWebContents.reload).not.toHaveBeenCalled();
  });

  it("keeps one window's OOMs off another window's budget, both ways round", async () => {
    let chain = fleet.open();
    let other = fleet.open();

    chain = await appViewOom(chain);
    // One OOM down the chain: two on the other window still recreate it.
    other = await appViewOom(other);
    const otherBefore = other;
    other = await appViewOom(other);
    expect(otherBefore.destroyed).toBe(true);

    // And neither of those spent the chain's second recreation.
    const chainBefore = chain;
    chain = await appViewOom(chain);
    expect(chainBefore.destroyed).toBe(true);
    expect(isRecoveryLoad(chainBefore.appWebContents)).toBe(false);
    expect(fleet.createWindow).toHaveBeenCalledTimes(4);

    // Each is now on its own third.
    expect(await appViewOom(other)).toBe(other);
    expect(isRecoveryLoad(other.appWebContents)).toBe(true);
    expect(await appViewOom(chain)).toBe(chain);
    expect(isRecoveryLoad(chain.appWebContents)).toBe(true);
  });

  it("spends one recreation when two views die under the same pressure", async () => {
    const first = fleet.open();

    first.appViewGone("oom");
    first.projectViewGone("oom");
    await vi.runAllTimersAsync();
    expect(fleet.createWindow).toHaveBeenCalledTimes(1);

    const second = first.replacement!;
    const third = await projectViewOom(second);

    expect(third).not.toBe(second);
    expect(isRecoveryLoad(second.projectWebContents)).toBe(false);
    expect(fleet.createWindow).toHaveBeenCalledTimes(2);
  });

  it("never spends the budget on an OS memory eviction", async () => {
    const second = await appViewOom(fleet.open());

    second.appViewGone("memory-eviction");
    second.projectViewGone("memory-eviction");
    await vi.runAllTimersAsync();
    expect(second.destroyed).toBe(false);

    const third = await projectViewOom(second);

    expect(third).not.toBe(second);
    expect(fleet.createWindow).toHaveBeenCalledTimes(2);
  });

  it("still counts an OOM exactly a minute old", async () => {
    const second = await appViewOom(fleet.open());
    const third = await appViewOom(second);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(await appViewOom(third)).toBe(third);
    expect(isRecoveryLoad(third.appWebContents)).toBe(true);
  });

  it("keeps the window on the recovery page while OOMs keep coming", async () => {
    const second = await appViewOom(fleet.open());
    await vi.advanceTimersByTimeAsync(1_000);
    const third = await appViewOom(second);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await appViewOom(third)).toBe(third);

    // Both recreations are more than a minute old by the last OOM, but the
    // refused ones since are not: the window stays where it is.
    await vi.advanceTimersByTimeAsync(48_000);
    expect(await projectViewOom(third)).toBe(third);
    await vi.advanceTimersByTimeAsync(11_500);
    expect(await appViewOom(third)).toBe(third);

    expect(fleet.createWindow).toHaveBeenCalledTimes(2);
    expect(third.appWebContents.loadURL).toHaveBeenCalledTimes(2);
  });

  it("rebuilds nothing when two views die on a spent budget", async () => {
    const third = await appViewOom(await appViewOom(fleet.open()));

    third.appViewGone("oom");
    third.projectViewGone("oom");
    await vi.runAllTimersAsync();

    expect(third.destroyed).toBe(false);
    expect(fleet.createWindow).toHaveBeenCalledTimes(2);
    expect(isRecoveryLoad(third.appWebContents)).toBe(true);
    expect(isRecoveryLoad(third.projectWebContents)).toBe(true);
    expect(isWindowRecreating()).toBe(false);
  });

  it("lets go of OOMs recorded before the clock was set back", async () => {
    const third = await appViewOom(await appViewOom(fleet.open()));

    vi.setSystemTime(Date.now() - 3_600_000);
    const fourth = await appViewOom(third);

    expect(fourth).not.toBe(third);
    expect(isRecoveryLoad(third.appWebContents)).toBe(false);
    expect(fleet.createWindow).toHaveBeenCalledTimes(3);
  });
});
