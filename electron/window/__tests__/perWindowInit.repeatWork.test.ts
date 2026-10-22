import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  execFileMock,
  findAllOnPathMock,
  pathScanMock,
  createApplicationMenuMock,
  rebuildMenuIfChangedMock,
  getFocusedWindowMock,
  tourListeners,
  pluginInit,
} = vi.hoisted(() => {
  const pluginInit = {
    promise: Promise.resolve(),
    resolve: () => {},
    reset() {
      this.promise = new Promise<void>((resolve) => {
        this.resolve = resolve;
      });
    },
  };
  return {
    execFileMock: vi.fn((...args: unknown[]) => {
      const callback = args.find(
        (a): a is (err: unknown, stdout?: string) => void => typeof a === "function"
      );
      const err = Object.assign(new Error("not found"), { code: "ENOENT" });
      queueMicrotask(() => callback?.(err));
      return {} as never;
    }),
    // POSIX walks PATH in-process; every agent misses.
    findAllOnPathMock: vi.fn(async () => [] as string[]),
    // Windows probes PATH by reading its directories rather than running
    // `where`; every agent misses there too.
    pathScanMock: vi.fn(async () => ({ paths: [] as string[], skipped: [] as string[] })),
    createApplicationMenuMock: vi.fn(),
    rebuildMenuIfChangedMock: vi.fn(),
    getFocusedWindowMock: vi.fn((): unknown => null),
    tourListeners: [] as Array<() => void>,
    pluginInit,
  };
});

vi.mock("child_process", () => ({ execFile: execFileMock, execFileSync: vi.fn() }));
vi.mock("../../utils/findOnPath.js", () => ({
  findAllOnPath: findAllOnPathMock,
  findOnPath: vi.fn(async () => null),
}));
vi.mock("fs/promises", () => ({
  access: vi.fn().mockRejectedValue(new Error("ENOENT")),
  constants: { R_OK: 4, X_OK: 1 },
}));
vi.mock("../../setup/environment.js", () => ({
  refreshPath: vi.fn().mockResolvedValue(undefined),
  expandWindowsEnvVars: (s: string) => s,
  isDemoMode: false,
}));
vi.mock("../../store.js", () => ({
  store: { get: vi.fn(() => undefined), set: vi.fn(), delete: vi.fn() },
}));
vi.mock("../../ipc/utils.js", () => ({ broadcastToRenderer: vi.fn() }));
vi.mock("../../utils/wsl.js", () => ({ getDefaultWslDistro: vi.fn(async () => null) }));
// The host's own PATH never answers a probe: no agent and no npm is found there.
vi.mock("../../utils/windowsExecutable.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/windowsExecutable.js")>()),
  scanWindowsPath: pathScanMock,
  findWindowsCommand: vi.fn(async () => null),
}));

vi.mock("electron", () => ({
  BrowserWindow: { getFocusedWindow: getFocusedWindowMock },
  session: { defaultSession: { clearCache: vi.fn(async () => {}) } },
}));
vi.mock("../../ipc/handlers.js", () => ({ sendToRenderer: vi.fn() }));
vi.mock("../../ipc/errorHandlers.js", () => ({ notifyError: vi.fn() }));
vi.mock("../../services/TelemetryService.js", () => ({ trackEvent: vi.fn() }));
vi.mock("../webContentsRegistry.js", () => ({
  clearPortHolderWebContentsIfCurrent: vi.fn(),
  getAppWebContents: vi.fn(),
  setFallbackEligibleProjectsListener: vi.fn(),
}));
vi.mock("../portDistribution.js", () => ({
  distributePortsToView: vi.fn(),
  releaseAllTerminalWorkerPorts: vi.fn(),
}));
vi.mock("../skeletonCss.js", () => ({ resolveInitialCanvasBackgroundColor: () => "#000000" }));
vi.mock("../../../shared/theme/index.js", () => ({
  resolveAppTheme: () => ({ tokens: { "surface-canvas": "#000" } }),
}));
vi.mock("../../services/PtyClient.js", () => ({ PtyClient: vi.fn() }));
vi.mock("../../services/AgentVersionService.js", () => ({ AgentVersionService: vi.fn() }));
vi.mock("../../services/AgentModelCatalogService.js", () => ({
  AgentModelCatalogService: vi.fn(),
}));
vi.mock("../../services/AgentUpdateHandler.js", () => ({ AgentUpdateHandler: vi.fn() }));
vi.mock("../../services/PortalManager.js", () => ({
  PortalManager: vi.fn(function PortalManager() {}),
}));
vi.mock("../../services/EventBuffer.js", () => ({
  EventBuffer: vi.fn(function EventBuffer(this: { start: () => void }) {
    this.start = () => {};
  }),
}));
vi.mock("../../services/ProjectSwitchService.js", () => ({
  ProjectSwitchService: vi.fn(function ProjectSwitchService() {}),
}));
vi.mock("../../menu.js", () => ({
  createApplicationMenu: createApplicationMenuMock,
  rebuildApplicationMenuIfPluginVisibilityChanged: rebuildMenuIfChangedMock,
}));
vi.mock("../../services/plugin/PluginTourRegistry.js", () => ({
  onPluginToursChanged: vi.fn((listener: () => void) => {
    tourListeners.push(listener);
    return () => {};
  }),
}));
vi.mock("../../services/NotificationService.js", () => ({
  notificationService: { initialize: vi.fn(), detachWindowListeners: vi.fn() },
}));
vi.mock("../../services/ProjectStore.js", () => ({ projectStore: { getProjectById: vi.fn() } }));
vi.mock("../../services/PluginService.js", () => ({
  pluginService: { waitForInit: () => pluginInit.promise },
}));

import { initPerWindowServices, __resetPerWindowInitForTests } from "../perWindowInit.js";
import { notifyProjectPresenceChanged } from "../projectPresenceChanges.js";
import { __resetDeferredQueueForTests, signalFirstInteractive } from "../deferredInitQueue.js";
import {
  getCliAvailabilityServiceRef,
  setCliAvailabilityServiceRef,
  setPtyClientRef,
} from "../serviceRefs.js";
import { getEffectiveRegistry } from "../../../shared/config/agentRegistry.js";
import type { BrowserWindow } from "electron";
import type { WindowContext } from "../WindowRegistry.js";
import type { PtyClient } from "../../services/PtyClient.js";

function fakeWindow(id: number): BrowserWindow {
  return {
    id,
    isDestroyed: () => false,
    isFocused: () => false,
    once: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as BrowserWindow;
}

function fakeContext(id: number): WindowContext {
  return {
    windowId: id,
    services: {},
    cleanup: { add: vi.fn() },
  } as unknown as WindowContext;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

interface WindowWork {
  probes: number;
  menus: number;
  menuWindowIds: number[];
}

/**
 * CLI PATH probes so far: in-process walks on POSIX, PATH directory scans on
 * Windows, plus any subprocess probe that still spawns.
 */
function probeCount(): number {
  return (
    execFileMock.mock.calls.length +
    findAllOnPathMock.mock.calls.length +
    pathScanMock.mock.calls.length
  );
}

async function openWindow(id: number, opts: { settlePlugins?: boolean } = {}): Promise<WindowWork> {
  const probesBefore = probeCount();
  const menusBefore = createApplicationMenuMock.mock.calls.length;
  await initPerWindowServices(fakeWindow(id), fakeContext(id), undefined);
  if (id === 1) {
    signalFirstInteractive(1);
    await settle();
  }
  if (opts.settlePlugins) pluginInit.resolve();
  await settle();
  return {
    probes: probeCount() - probesBefore,
    menus: createApplicationMenuMock.mock.calls.length - menusBefore,
    menuWindowIds: createApplicationMenuMock.mock.calls
      .slice(menusBefore)
      .map(([win]) => (win as BrowserWindow).id),
  };
}

describe("initPerWindowServices repeated work across windows", () => {
  const agentCount = Object.keys(getEffectiveRegistry()).length;

  beforeEach(() => {
    vi.useRealTimers();
    __resetDeferredQueueForTests();
    __resetPerWindowInitForTests();
    pluginInit.reset();
    setCliAvailabilityServiceRef(null);
    setPtyClientRef({} as PtyClient);
    execFileMock.mockClear();
    findAllOnPathMock.mockClear();
    pathScanMock.mockClear();
    createApplicationMenuMock.mockClear();
  });

  it("probes every agent CLI and rebuilds the menu twice for the first window only", async () => {
    const first = await openWindow(1, { settlePlugins: true });
    const second = await openWindow(2);
    const third = await openWindow(3);

    expect(first.probes).toBeGreaterThanOrEqual(agentCount);
    expect(first.menuWindowIds).toEqual([1, 1]);
    expect(second).toEqual({ probes: 0, menus: 0, menuWindowIds: [] });
    expect(third).toEqual({ probes: 0, menus: 0, menuWindowIds: [] });
  });

  it("still rebuilds a later window's menu when plugin init has not settled yet", async () => {
    await openWindow(1);
    const second = await openWindow(2, { settlePlugins: true });

    // Window 1's pending rebuild and window 2's own both land once init settles.
    expect(second.probes).toBe(0);
    expect(second.menuWindowIds).toEqual([1, 2]);
    const third = await openWindow(3);
    expect(third.menus).toBe(0);
  });

  it("re-probes for a window opened after the reuse window has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const first = await openWindow(1, { settlePlugins: true });
    vi.setSystemTime(Date.now() + 5 * 60 * 1000);
    const second = await openWindow(2);

    expect(first.probes).toBeGreaterThanOrEqual(agentCount);
    expect(second.probes).toBeGreaterThanOrEqual(agentCount);
    expect(second.menuWindowIds).toEqual([2]);
  });

  it("keeps explicit refresh a full re-probe on the shared service", async () => {
    await openWindow(1, { settlePlugins: true });
    const probesBefore = probeCount();
    await getCliAvailabilityServiceRef()!.refresh();
    expect(probeCount() - probesBefore).toBeGreaterThanOrEqual(agentCount);
  });

  it("joins a refresh in flight and rebuilds the menu from its result", async () => {
    await openWindow(1, { settlePlugins: true });
    const refreshPromise = getCliAvailabilityServiceRef()!.refresh();
    const second = await openWindow(2);
    await refreshPromise;
    await settle();

    expect(second.menuWindowIds).toEqual([2]);
  });
});

describe("initPerWindowServices plugin menu context (#13765)", () => {
  const debounce = () => new Promise((r) => setTimeout(r, 80));

  async function openFocusableWindow(id: number): Promise<{
    win: BrowserWindow;
    focus: () => void;
    close: () => void;
  }> {
    const win = fakeWindow(id);
    await initPerWindowServices(win, fakeContext(id), undefined);
    signalFirstInteractive(id);
    pluginInit.resolve();
    await settle();
    const handler = (event: string) =>
      vi
        .mocked(win.on)
        .mock.calls.concat(vi.mocked(win.once).mock.calls)
        .filter(([name]) => name === event)
        .map(([, listener]) => listener as () => void);
    return {
      win,
      focus: () => handler("focus").forEach((listener) => listener()),
      close: () => handler("closed").forEach((listener) => listener()),
    };
  }

  beforeEach(() => {
    vi.useRealTimers();
    __resetDeferredQueueForTests();
    __resetPerWindowInitForTests();
    pluginInit.reset();
    setCliAvailabilityServiceRef(null);
    setPtyClientRef({} as PtyClient);
    tourListeners.length = 0;
    getFocusedWindowMock.mockReturnValue(null);
  });

  it("checks the focused window's menu on a project switch or focus, and only rebuilds outright for tours", async () => {
    const { win, focus, close } = await openFocusableWindow(1);
    getFocusedWindowMock.mockReturnValue(win);
    createApplicationMenuMock.mockClear();
    rebuildMenuIfChangedMock.mockClear();

    try {
      notifyProjectPresenceChanged();
      notifyProjectPresenceChanged();
      await debounce();
      expect(rebuildMenuIfChangedMock.mock.calls.map(([w]) => w)).toEqual([win]);

      focus();
      await debounce();
      expect(rebuildMenuIfChangedMock).toHaveBeenCalledTimes(2);

      // A tour change alongside a context change in the same tick still
      // rebuilds outright: the tour set itself moved.
      notifyProjectPresenceChanged();
      tourListeners.forEach((listener) => listener());
      await debounce();
      expect(rebuildMenuIfChangedMock).toHaveBeenCalledTimes(2);
      expect(createApplicationMenuMock.mock.calls.map(([w]) => w)).toEqual([win]);
    } finally {
      close();
    }
  });

  it("leaves the menu alone on a context change while no window is focused", async () => {
    const { close } = await openFocusableWindow(1);
    createApplicationMenuMock.mockClear();
    rebuildMenuIfChangedMock.mockClear();

    try {
      notifyProjectPresenceChanged();
      await debounce();
      expect(rebuildMenuIfChangedMock).not.toHaveBeenCalled();
      expect(createApplicationMenuMock).not.toHaveBeenCalled();
    } finally {
      close();
    }
  });

  it("stops listening once the window closes", async () => {
    const { win, close } = await openFocusableWindow(1);
    getFocusedWindowMock.mockReturnValue(win);
    rebuildMenuIfChangedMock.mockClear();

    close();
    notifyProjectPresenceChanged();
    await debounce();
    expect(rebuildMenuIfChangedMock).not.toHaveBeenCalled();
    expect(win.removeListener).toHaveBeenCalledWith("focus", expect.any(Function));
  });
});
