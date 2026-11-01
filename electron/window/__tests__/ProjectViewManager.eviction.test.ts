import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/** Workspaces the user granted residency, read by the mocked preference below. */
const residentWorkspaces = new Set<string>();

let nextWebContentsId = 100;
let nextOsProcessId = 1000;

type Handler = (...args: unknown[]) => void;

function createMockWebContents() {
  const id = nextWebContentsId++;
  const osPid = nextOsProcessId++;
  const handlers = new Map<string, Handler[]>();
  const wc = {
    id,
    osPid,
    isDestroyed: vi.fn(() => false),
    executeJavaScript: vi.fn(() => Promise.resolve()),
    loadURL: vi.fn(() => Promise.resolve()),
    focus: vi.fn(),
    invalidate: vi.fn(),
    close: vi.fn(),
    reload: vi.fn(),
    send: vi.fn(),
    session: { flushStorageData: vi.fn() },
    navigationHistory: { clear: vi.fn() },
    getOSProcessId: vi.fn(() => osPid),
    on: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    once: vi.fn((event: string, handler: Handler) => {
      if (event === "did-finish-load") {
        Promise.resolve().then(() => handler());
      }
    }),
    removeListener: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event);
      if (!list) return;
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    }),
    setWindowOpenHandler: vi.fn(),
    setIgnoreMenuShortcuts: vi.fn(),
    listenerCount: (event: string) => handlers.get(event)?.length ?? 0,
  };
  return wc;
}

const mockGetAppMetrics = vi.fn<() => Electron.ProcessMetric[]>(() => []);
const mockGetAllWebContents = vi.fn<() => unknown[]>(() => []);

vi.mock("electron", () => {
  function MockWebContentsView() {
    const wc = createMockWebContents();
    return {
      webContents: wc,
      setBounds: vi.fn(),
      setBackgroundColor: vi.fn(),
      setVisible: vi.fn(),
    };
  }
  return {
    app: {
      isPackaged: false,
      commandLine: { appendSwitch: vi.fn() },
      getAppMetrics: () => mockGetAppMetrics(),
      quit: vi.fn(),
      emit: vi.fn(),
    },
    // Read after an OOM rebuild settles, to replay a quit the destroy swallowed.
    BrowserWindow: Object.assign(vi.fn(), { getAllWindows: vi.fn(() => []) }),
    WebContentsView: MockWebContentsView,
    session: { fromPartition: vi.fn(() => ({ protocol: { handle: vi.fn() } })) },
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    nativeTheme: { shouldUseDarkColors: true },
    webContents: { getAllWebContents: () => mockGetAllWebContents() },
  };
});

vi.mock("../../services/ProcessMemoryMonitor.js", () => ({
  forgetBlinkSample: vi.fn(),
  forgetEluSample: vi.fn(),
  noteRendererUnresponsive: vi.fn(),
  noteRendererResponsive: vi.fn(),
  forgetRendererDocumentState: vi.fn(),
}));

vi.mock("../webContentsRegistry.js", () => ({
  registerWebContents: vi.fn(),
  registerAppView: vi.fn(),
  unregisterWebContents: vi.fn(),
  registerProjectView: vi.fn(),
  unregisterProjectView: vi.fn(),
  registerCachedViewWebContents: vi.fn(),
  unregisterCachedViewWebContents: vi.fn(),
}));

const residencyLedger = vi.hoisted(() => ({
  recordWorkspaceEviction: vi.fn(),
  clearWorkspaceEviction: vi.fn(),
  notifyWorkspaceViewsChanged: vi.fn(),
}));

vi.mock("../../services/workspaceResidency.js", () => ({
  isWorkspaceKeepResident: (workspaceId: string) => residentWorkspaces.has(workspaceId),
  ...residencyLedger,
}));

vi.mock("../../setup/protocols.js", () => ({
  registerProtocolsForSession: vi.fn(),
  getDistPath: vi.fn(() => "/dist"),
}));

vi.mock("../../setup/environment.js", () => ({
  isDemoMode: false,
  isSmokeTest: false,
}));

vi.mock("../../../shared/config/devServer.js", () => ({
  getDevServerUrl: vi.fn(() => "http://localhost:5173"),
}));

vi.mock("../../../shared/utils/trustedRenderer.js", () => ({
  isTrustedRendererUrl: vi.fn().mockReturnValue(true),
}));

vi.mock("../../../shared/utils/urlUtils.js", () => ({
  isLocalhostUrl: vi.fn().mockReturnValue(true),
}));

vi.mock("../../utils/openExternal.js", () => ({
  canOpenExternalUrl: vi.fn(),
  openExternalUrl: vi.fn(),
}));

vi.mock("../../services/CrashRecoveryService.js", () => ({
  getCrashRecoveryService: vi.fn(() => ({ recordCrash: vi.fn(), recordRendererGone: vi.fn() })),
}));

vi.mock("../../ipc/errorHandlers.js", () => ({
  notifyError: vi.fn(),
}));

vi.mock("../skeletonCss.js", () => ({
  injectSkeletonCss: vi.fn(),
  injectSkeletonProjectIdentity: vi.fn(),
  INITIAL_COLOR_SCHEME_ARG: "--daintree-initial-color-scheme-id",
  INITIAL_PROJECT_ID_ARG: "--daintree-initial-project-id",
  INSTANCE_ROLE_ARG: "--daintree-instance-role",
  resolveInstanceRole: vi.fn(() => "attended"),
  resolveE2EPreloadArgs: vi.fn(() => []),
  resolveInitialColorSchemeId: vi.fn(() => "daintree"),
  resolveInitialCanvasBackgroundColor: vi.fn(() => "#1f1b16"),
}));

// ProjectViewManager imports isDemoMode from setup/environment.js, whose
// module-level side effects (deepLinkUrlQueue app.on, userData setPath) need
// the real electron app API the partial mock above does not provide.
vi.mock("../../setup/environment.js", () => ({
  isDemoMode: false,
  isSmokeTest: false,
}));

vi.mock("../../services/ProjectStore.js", () => ({
  projectStore: { getProjectById: vi.fn(() => null) },
}));

vi.mock("../rendererConsoleCapture.js", () => ({
  attachRendererConsoleCapture: vi.fn(),
  detachRendererConsoleCapture: vi.fn(),
}));

vi.mock("../../utils/webContentsLifecycle.js", () => ({
  purgeMemoryWebContents: vi.fn().mockResolvedValue(undefined),
  freezeWebContents: vi.fn().mockResolvedValue(undefined),
  unfreezeWebContents: vi.fn().mockResolvedValue(undefined),
  unthrottleCpuWebContents: vi.fn().mockResolvedValue(undefined),
}));

// An OOM rebuild saves the window manifest; the real store reaches better-sqlite3.
vi.mock("../../services/persistence/windowManifestStore.js", () => ({
  writeOpenWindowsManifest: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    name: "test-logger",
  })),
}));

// PtyClient-shaped mock injected via initAgentStateCache (#10054). The
// terminal registry lives in the pty-host; hasActiveAgent() reads an
// instance-level cache seeded from this mock, not the dead main-process
// getPtyManager() singleton.
const mockGetAllTerminals = vi.fn<
  () => Promise<Array<{ id: string; projectId?: string; agentState?: string }>>
>(async () => []);
// Capture the latest handler per event so reseed tests can invoke them
// (spawn-result / host-crash). initAgentStateCache overwrites per call, so the
// map holds the current manager's handlers.
const ptyClientHandlers = new Map<string, (...args: unknown[]) => void>();
const mockPtyClient = {
  getAllTerminalsAsync: mockGetAllTerminals,
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    ptyClientHandlers.set(event, handler);
  }),
  off: vi.fn(),
};

// The two halves main.ts injects for the assistant eviction floor (#11157):
// HelpSessionService's projectId → {assistant PTY, pinned view} binding, and
// PtyClient's synchronous liveness registry. They are separate because the
// binding outlives a PTY that exits on its own — a stale binding must not
// protect a view. Tests that never touch these leave them empty, so every
// project reads as assistant-free.
const assistantBackends = new Map<string, { terminalId: string; webContentsId: number }>();
const liveTerminals = new Set<string>();
// Plural since #12108: the manager asks for every lane so a dead one can't
// mask a live sibling. These cases seed at most one, which is the old shape.
const assistantBackendsForProject = (projectId: string) => {
  const backend = assistantBackends.get(projectId);
  return backend ? [backend] : [];
};
const isTerminalLive = (terminalId: string): boolean => liveTerminals.has(terminalId);
// A host project's view is asked of its host instead (#13349): the views whose
// host says a live assistant is pinned to them.
const liveRemoteViews = new Set<number>();
const remoteAssistantLive = (webContentsId: number): boolean => liveRemoteViews.has(webContentsId);
// And the views whose host says an agent in their project is active there (#13359).
const activeRemoteViews = new Set<number>();
const remoteAgentActive = (webContentsId: number): boolean => activeRemoteViews.has(webContentsId);
// And the views whose host says the user granted their project residency there (#13933).
const residentRemoteViews = new Set<number>();
const remoteKeepResident = (webContentsId: number): boolean =>
  residentRemoteViews.has(webContentsId);
// And the views whose host says an MCP session there is bound to their project (#14228).
const boundRemoteViews = new Set<number>();
const remoteMcpBindingLive = (webContentsId: number): boolean =>
  boundRemoteViews.has(webContentsId);

import { ProjectViewManager } from "../ProjectViewManager.js";
import { createWindowRecreation } from "../windowRecreation.js";
import type { WindowContext, WindowRegistry } from "../WindowRegistry.js";
import { events } from "../../services/events.js";
import { logDebug, logInfo } from "../../utils/logger.js";
import { forgetBlinkSample, forgetEluSample } from "../../services/ProcessMemoryMonitor.js";
import { detachRendererConsoleCapture } from "../rendererConsoleCapture.js";
import {
  freezeWebContents,
  unfreezeWebContents,
  purgeMemoryWebContents,
  unthrottleCpuWebContents,
} from "../../utils/webContentsLifecycle.js";
import { resetAppMetricsSnapshotForTesting } from "../../utils/appMetricsSnapshot.js";
import {
  resetPhysFootprintReaderForTesting,
  setPhysFootprintReaderForTesting,
} from "../../utils/processMemory.js";
import {
  IDLE_VIEW_RELEASE_MS,
  MIN_CRITICAL_PRESSURE_EVICTION_AGE_MS,
  MIN_PRESSURE_EVICTION_AGE_MS,
  backgroundRestoreCapacity,
} from "../ProjectViewEvictionController.js";
import { recordSwapPressure, SWAP_PRESSURE_STALE_MS } from "../../services/systemSwapPressure.js";
import {
  recordKernelPressureLevel,
  resetKernelPressureForTesting,
} from "../../services/systemKernelPressure.js";
import { toHostScopedKey } from "../../../shared/types/remoteHosts.js";
import { claimProjectActivation } from "../projectActivationClaims.js";
import {
  _resetPanelRecoveryStateForTests,
  recordPanelRecoveryState,
} from "../../services/panelRecoveryQuery.js";
import {
  _resetDictationViewHoldsForTests,
  holdDictationView,
} from "../../services/voice/dictationViewHold.js";
import {
  _resetCachedViewFlushForTests,
  isCachedViewFlushPending,
  recordCachedViewFlushArmed,
  settleCachedViewFlush,
} from "../../services/cachedViewFlush.js";
import { CHANNELS } from "../../ipc/channels.js";

// The shared snapshot is module-level state; without a reset, a test could be
// served metrics cached by the previous test's differently-mocked sweep.
beforeEach(() => {
  resetAppMetricsSnapshotForTesting();
  mockGetAllWebContents.mockReset();
  mockGetAllWebContents.mockReturnValue([]);
  // This suite tests eviction, not paint-gate policy, and drives cold switches
  // through a zero-length gate. A cold hard timeout now abandons the switch
  // (#11635), so release every gate with the signal these fixtures are standing
  // in for rather than relying on the timeout to wave switches through.
  vi.spyOn(ProjectViewManager.prototype, "waitForPaint").mockResolvedValue("signal");
});

const flushImmediates = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Backdate every view past the pressure ladder's minimum age, keeping their
 * relative LRU order. These fixtures switch milliseconds apart, so without it
 * every gradual pass would defer on a view the user "just left" (#12363).
 */
function ageViewsPastPressureFloor(mgr: ProjectViewManager): void {
  for (const entry of mgr.views.values()) entry.lastUsed -= MIN_PRESSURE_EVICTION_AGE_MS;
}

/**
 * Age the cache and take the one low reading that on its own confirms nothing
 * (#12363), asserting it destroyed nothing — so the ticks that follow exercise a
 * confirmed pass. Call with memory already reading low.
 */
function armPressureLadder(mgr: ProjectViewManager): void {
  ageViewsPastPressureFloor(mgr);
  // From a clean count: the manager's own randomly-phased sampler is live, and
  // may already have taken a low reading while the fixture awaited its switches.
  mgr.pressureSampleStreak = 0;
  const before = mgr.views.size;
  mgr.maybeEvictUnderPressure();
  expect(mgr.views.size).toBe(before);
}

function createMockWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    removeListener: vi.fn(),
    // The background-resize debounce can fire while a test is still running;
    // without this it throws outside any test and fails the whole run.
    isMinimized: vi.fn(() => false),
    getContentBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
    contentView: {
      on: vi.fn(),
      removeListener: vi.fn(),
      children: [] as unknown[],
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    },
    webContents: createMockWebContents(),
  };
}

describe("ProjectViewManager — eviction safety", () => {
  let manager: ProjectViewManager;
  let win: ReturnType<typeof createMockWindow>;

  beforeEach(() => {
    nextWebContentsId = 100;
    nextOsProcessId = 1000;
    vi.clearAllMocks();
    mockGetAllTerminals.mockReset();
    mockGetAllTerminals.mockResolvedValue([]);
    mockGetAppMetrics.mockReset();
    mockGetAppMetrics.mockReturnValue([]);
    assistantBackends.clear();
    liveTerminals.clear();
    liveRemoteViews.clear();
    activeRemoteViews.clear();
    residentRemoteViews.clear();
    boundRemoteViews.clear();
    residentWorkspaces.clear();
    win = createMockWindow();
    manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
      assistantBackendsForProject,
      isTerminalLive,
    });
  });

  describe("dead cached views (render-process-gone)", () => {
    function emitProcessGone(wc: ReturnType<typeof createMockWebContents>, reason: string): void {
      const call = wc.on.mock.calls.find(([event]) => event === "render-process-gone");
      expect(call).toBeDefined();
      (call![1] as Handler)({}, { reason, exitCode: 1 });
    }

    it("memory-eviction of a cached view evicts it instead of reloading in the background", async () => {
      await manager.switchTo("proj-b", "/path/b");
      await flushImmediates();
      const wcB = manager.getAllViews().find((v) => v.projectId === "proj-b")!.view
        .webContents as unknown as ReturnType<typeof createMockWebContents>;
      await manager.switchTo("proj-c", "/path/c");
      await flushImmediates();
      // proj-b is now cached with handlers wired by setupViewHandlers.

      emitProcessGone(wcB, "memory-eviction");
      await flushImmediates();

      expect(wcB.reload).not.toHaveBeenCalled();
      expect(wcB.close).toHaveBeenCalled();
      expect(manager.getAllViews().map((v) => v.projectId)).not.toContain("proj-b");
    });

    it("memory-eviction of the ACTIVE view still reloads it", async () => {
      await manager.switchTo("proj-b", "/path/b");
      await flushImmediates();
      const wcB = manager.getAllViews().find((v) => v.projectId === "proj-b")!.view
        .webContents as unknown as ReturnType<typeof createMockWebContents>;

      emitProcessGone(wcB, "memory-eviction");
      await flushImmediates();

      expect(wcB.reload).toHaveBeenCalledTimes(1);
      expect(wcB.close).not.toHaveBeenCalled();
      expect(manager.getAllViews().map((v) => v.projectId)).toContain("proj-b");
    });

    it("a crashed cached view is evicted instead of auto-reloaded", async () => {
      await manager.switchTo("proj-b", "/path/b");
      await flushImmediates();
      const wcB = manager.getAllViews().find((v) => v.projectId === "proj-b")!.view
        .webContents as unknown as ReturnType<typeof createMockWebContents>;
      await manager.switchTo("proj-c", "/path/c");
      await flushImmediates();

      emitProcessGone(wcB, "crashed");
      await flushImmediates();

      expect(wcB.reload).not.toHaveBeenCalled();
      expect(wcB.close).toHaveBeenCalled();
      expect(manager.getAllViews().map((v) => v.projectId)).not.toContain("proj-b");
    });

    it("a crashed ACTIVE view still auto-reloads", async () => {
      await manager.switchTo("proj-b", "/path/b");
      await flushImmediates();
      const wcB = manager.getAllViews().find((v) => v.projectId === "proj-b")!.view
        .webContents as unknown as ReturnType<typeof createMockWebContents>;

      emitProcessGone(wcB, "crashed");
      await flushImmediates();

      expect(wcB.reload).toHaveBeenCalledTimes(1);
      expect(manager.getAllViews().map((v) => v.projectId)).toContain("proj-b");
    });

    it("rebuilds a window whose view died of OOM onto the project it switched to (#15564)", async () => {
      const createWindow = vi.fn(async () => "ok" as const);
      // Destroying the window disposes its manager, as the registry's teardown does.
      const oomWin = { ...createMockWindow(), destroy: vi.fn(() => oomManager.dispose()) };
      const ctx = {
        windowId: 1,
        browserWindow: { isDestroyed: () => false, isFocused: () => true },
        services: {
          get projectViewManager() {
            return oomManager;
          },
        },
      } as unknown as WindowContext;
      const registry = {
        focusOrder: () => [ctx],
        getByWindowId: (id: number) => (id === 1 ? ctx : undefined),
      } as unknown as WindowRegistry;
      const recreation = createWindowRecreation({
        windowRegistry: registry,
        getWindowId: () => 1,
        createWindow,
      });
      const oomManager: ProjectViewManager = new ProjectViewManager(oomWin as never, {
        dirname: "/test",
        paintGateTimeoutMs: 0,
        paintGateHardTimeoutMs: 0,
        warmPaintGateTimeoutMs: 0,
        warmPaintGateHardTimeoutMs: 0,
        cachedProjectViews: 3,
        assistantBackendsForProject,
        isTerminalLive,
        prepareWindowRecreation: recreation.prepare,
      });

      await oomManager.switchTo("proj-a", "/path/a");
      await flushImmediates();
      await oomManager.switchTo("proj-b", "/path/b");
      await flushImmediates();
      const wcB = oomManager.getAllViews().find((v) => v.projectId === "proj-b")!.view
        .webContents as unknown as ReturnType<typeof createMockWebContents>;

      emitProcessGone(wcB, "oom");
      await flushImmediates();
      await flushImmediates();

      expect(oomWin.destroy).toHaveBeenCalledTimes(1);
      expect(createWindow).toHaveBeenCalledTimes(1);
      expect(createWindow).toHaveBeenCalledWith(
        "proj-b",
        expect.objectContaining({ backgroundProjectIds: ["proj-a"] })
      );
    });
  });

  describe("getViewInventory / getCacheConfig (#10500)", () => {
    it("projects each view to safe scalars with the live webContentsId and lifecycle state", async () => {
      await manager.switchTo("proj-b", "/path/b");
      await flushImmediates();
      await manager.switchTo("proj-c", "/path/c");
      await flushImmediates();

      const inventory = manager.getViewInventory();
      expect(inventory.map((v) => v.projectId).sort()).toEqual(["proj-b", "proj-c"]);

      const liveC = manager.getAllViews().find((v) => v.projectId === "proj-c")!;
      const invC = inventory.find((v) => v.projectId === "proj-c")!;
      // webContentsId must be the real id of the live view, not a placeholder.
      expect(invC.webContentsId).toBe(liveC.view.webContents.id);
      // The just-activated project is active; the previous one is cached.
      expect(invC.state).toBe("active");
      expect(inventory.find((v) => v.projectId === "proj-b")!.state).toBe("cached");
      // Never-evicted views carry no eviction timestamp.
      expect(invC.evictedAt).toBeUndefined();
      // Memory-attribution fields are always present: the pid is the live
      // renderer's OS pid, and guests are an empty list rather than undefined.
      expect(invC.pid).toBe(liveC.view.webContents.getOSProcessId());
      expect(invC.guestPids).toEqual([]);
      // The live WebContentsView must never leak through the projection.
      expect(invC).not.toHaveProperty("view");
    });
  });

  it("evictStaleViews does not evict any view when activeProjectId is null", async () => {
    // Register initial view for proj-a
    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    // Switch to proj-b (now have 2 views, proj-b is active)
    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();

    // Destroy proj-b which sets activeProjectId to null
    manager.destroyView("proj-b");

    // Call setCachedViewLimit(1) which would trigger evictStaleViews
    manager.setCachedViewLimit(1);

    // proj-a view should still be alive
    const views = manager.getAllViews();
    expect(views.length).toBeGreaterThanOrEqual(1);

    // proj-a's webContents.close should NOT have been called
    expect(wcA.close).not.toHaveBeenCalled();
  });

  it("skips LRU candidate when its project has an active agent", async () => {
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    await managerWithLimit.switchTo("proj-b", "/path/b");
    await flushImmediates();

    // proj-a (oldest) has an active agent. Eviction must skip it and evict proj-b instead
    // once we go over the limit with proj-c.
    mockGetAllTerminals.mockResolvedValue([
      { id: "t-a", projectId: "proj-a", agentState: "working" },
      { id: "t-b", projectId: "proj-b", agentState: "idle" },
    ]);
    await managerWithLimit.initAgentStateCache(mockPtyClient as never);

    const wcBEntry = managerWithLimit.getAllViews().find((v) => v.projectId === "proj-b");
    const wcB = wcBEntry?.view.webContents as ReturnType<typeof createMockWebContents> | undefined;

    await managerWithLimit.switchTo("proj-c", "/path/c");
    await flushImmediates();

    const remaining = managerWithLimit.getAllViews().map((v) => v.projectId);
    expect(remaining).toContain("proj-a");
    expect(remaining).toContain("proj-c");
    expect(remaining).not.toContain("proj-b");
    expect(wcA.close).not.toHaveBeenCalled();
    expect(wcB?.close).toHaveBeenCalled();
  });

  it("protects a view after a live agent:state-changed event marks it active (#10054)", async () => {
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    await managerWithLimit.switchTo("proj-b", "/path/b");
    await flushImmediates();

    // Seed proj-a's terminal as idle (so projectByTerminal knows t-a → proj-a),
    // then flip it to "working" purely via the event bus — the path the cache
    // relies on between host re-seeds.
    mockGetAllTerminals.mockResolvedValue([
      { id: "t-a", projectId: "proj-a", agentState: "idle" },
      { id: "t-b", projectId: "proj-b", agentState: "idle" },
    ]);
    await managerWithLimit.initAgentStateCache(mockPtyClient as never);
    events.emit("agent:state-changed", {
      terminalId: "t-a",
      state: "working",
      previousState: "idle",
      trigger: "output",
      confidence: 1,
      timestamp: 0,
    } as never);

    const wcBEntry = managerWithLimit.getAllViews().find((v) => v.projectId === "proj-b");
    const wcB = wcBEntry?.view.webContents as ReturnType<typeof createMockWebContents> | undefined;

    await managerWithLimit.switchTo("proj-c", "/path/c");
    await flushImmediates();

    const remaining = managerWithLimit.getAllViews().map((v) => v.projectId);
    expect(remaining).toContain("proj-a");
    expect(remaining).not.toContain("proj-b");
    expect(wcA.close).not.toHaveBeenCalled();
    expect(wcB?.close).toHaveBeenCalled();
  });

  it("host-crash reseed clears a stale active-agent entry (#10054)", async () => {
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");
    await managerWithLimit.switchTo("proj-b", "/path/b");
    await flushImmediates();

    // Seed proj-a as working, then simulate a host crash that comes back with an
    // empty registry — the reseed must drop the stale "working" entry so proj-a
    // is no longer protected.
    mockGetAllTerminals.mockResolvedValue([
      { id: "t-a", projectId: "proj-a", agentState: "working" },
    ]);
    await managerWithLimit.initAgentStateCache(mockPtyClient as never);

    mockGetAllTerminals.mockResolvedValue([]);
    await ptyClientHandlers.get("host-crash")?.();

    await managerWithLimit.switchTo("proj-c", "/path/c");
    await flushImmediates();

    // proj-a is the LRU and no longer protected, so it is evicted.
    const remaining = managerWithLimit.getAllViews().map((v) => v.projectId);
    expect(remaining).not.toContain("proj-a");
    expect(wcA.close).toHaveBeenCalled();
  });

  it("re-invoking initAgentStateCache tears down prior listeners (#10054)", async () => {
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 2,
    });

    await managerWithLimit.initAgentStateCache(mockPtyClient as never);
    mockPtyClient.off.mockClear();
    await managerWithLimit.initAgentStateCache(mockPtyClient as never);

    // The second call must unsubscribe the first call's PtyClient listeners
    // before re-subscribing, so it doesn't leak or double-fire.
    expect(mockPtyClient.off).toHaveBeenCalledWith("spawn-result", expect.any(Function));
    expect(mockPtyClient.off).toHaveBeenCalledWith("host-crash", expect.any(Function));
  });

  it("falls back to evicting an active-agent view when all candidates are protected", async () => {
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    await managerWithLimit.switchTo("proj-b", "/path/b");
    await flushImmediates();

    // Both background candidates have active agents — fallback must evict the LRU
    // (proj-a) and emit a telemetry event rather than let the pool grow unbounded.
    mockGetAllTerminals.mockResolvedValue([
      { id: "t-a", projectId: "proj-a", agentState: "directing" },
      { id: "t-b", projectId: "proj-b", agentState: "working" },
    ]);
    await managerWithLimit.initAgentStateCache(mockPtyClient as never);

    await managerWithLimit.switchTo("proj-c", "/path/c");
    await flushImmediates();

    const remaining = managerWithLimit.getAllViews().map((v) => v.projectId);
    expect(remaining).not.toContain("proj-a");
    expect(remaining).toContain("proj-b");
    expect(remaining).toContain("proj-c");
    expect(wcA.close).toHaveBeenCalled();
    expect(vi.mocked(logInfo)).toHaveBeenCalledWith(
      "projectview.eviction",
      expect.objectContaining({ projectId: "proj-a", activeAgent: true })
    );
  });

  it("evicts LRU-ordered active-agent views when all candidates are protected", async () => {
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    await managerWithLimit.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await managerWithLimit.switchTo("proj-c", "/path/c");
    await flushImmediates();

    // All three cached projects have active agents.
    mockGetAllTerminals.mockResolvedValue([
      { id: "t-a", projectId: "proj-a", agentState: "working" },
      { id: "t-b", projectId: "proj-b", agentState: "directing" },
      { id: "t-c", projectId: "proj-c", agentState: "waiting" },
    ]);
    await managerWithLimit.initAgentStateCache(mockPtyClient as never);

    // Tightening the limit to 1 must evict the two LRU views (proj-a, then proj-b)
    // in order, and each forced eviction is emitted as a telemetry event.
    managerWithLimit.setCachedViewLimit(1);

    const remaining = managerWithLimit.getAllViews().map((v) => v.projectId);
    expect(remaining).toEqual(["proj-c"]);

    expect(vi.mocked(logInfo)).toHaveBeenCalledWith(
      "projectview.eviction",
      expect.objectContaining({ projectId: "proj-a", activeAgent: true })
    );
    expect(vi.mocked(logInfo)).toHaveBeenCalledWith(
      "projectview.eviction",
      expect.objectContaining({ projectId: "proj-b", activeAgent: true })
    );
  });

  // ── Daintree Assistant backends are a hard floor (issue #11157) ──
  //
  // Evicting a view whose assistant is running destroys its WebContents, which
  // revokes the help session and kills the PTY tree — every sub-agent and
  // background shell the assistant spawned dies with it. Unlike a grid
  // terminal, whose PTY lives in the pty-host and reconnects on switch-back,
  // there is no recovery. So these views leave the routine LRU pool entirely
  // rather than merely sorting last.
  describe("live assistant backends (#11157)", () => {
    function makeManager(cachedProjectViews: number) {
      return new ProjectViewManager(win as never, {
        dirname: "/test",
        paintGateTimeoutMs: 0,
        paintGateHardTimeoutMs: 0,
        warmPaintGateTimeoutMs: 0,
        warmPaintGateHardTimeoutMs: 0,
        cachedProjectViews,
        assistantBackendsForProject,
        isTerminalLive,
        remoteAssistantLive,
        remoteAgentActive,
        remoteKeepResident,
        remoteMcpBindingLive,
      });
    }

    const evictedProjectIds = () =>
      vi
        .mocked(logInfo)
        .mock.calls.filter(([event]) => event === "projectview.eviction")
        .map(([, ctx]) => (ctx as { projectId: string }).projectId);

    /** Bind a running assistant to the project's current view — the view the session pinned. */
    function bindLiveAssistant(mgr: ProjectViewManager, projectId: string, terminalId: string) {
      const wc = mgr.getAllViews().find((v) => v.projectId === projectId)!.view.webContents;
      assistantBackends.set(projectId, { terminalId, webContentsId: wc.id });
      liveTerminals.add(terminalId);
    }

    it("evicts a newer ordinary view rather than the LRU view whose assistant is idle", async () => {
      // The assistant is "idle" — it dispatched a sub-agent or a background
      // shell and is waiting on it. That work is invisible to the agent FSM, so
      // protection cannot key off ACTIVE_AGENT_STATES: an idle assistant with a
      // live PTY is exactly the case the issue reports losing.
      const managerWithLimit = makeManager(2);

      const wcA = createMockWebContents();
      const viewA = { webContents: wcA, setBounds: vi.fn() };
      managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

      await managerWithLimit.switchTo("proj-b", "/path/b");
      await flushImmediates();

      bindLiveAssistant(managerWithLimit, "proj-a", "t-help-a");
      mockGetAllTerminals.mockResolvedValue([
        { id: "t-help-a", projectId: "proj-a", agentState: "idle" },
      ]);
      await managerWithLimit.initAgentStateCache(mockPtyClient as never);

      const wcB = managerWithLimit.getAllViews().find((v) => v.projectId === "proj-b")?.view
        .webContents as ReturnType<typeof createMockWebContents> | undefined;

      // The assistant's allowance keeps one ordinary view warm beside it
      // (#12885), so it takes a second ordinary switch to put one over.
      await managerWithLimit.switchTo("proj-c", "/path/c");
      await flushImmediates();
      await managerWithLimit.switchTo("proj-d", "/path/d");
      await flushImmediates();

      const remaining = managerWithLimit.getAllViews().map((v) => v.projectId);
      expect(remaining).toContain("proj-a");
      expect(remaining).toContain("proj-c");
      expect(remaining).not.toContain("proj-b");
      expect(wcA.close).not.toHaveBeenCalled();
      expect(wcB?.close).toHaveBeenCalled();
    });

    it("holds the cache above its limit rather than evict the only remaining assistant-backed views", async () => {
      // No safe candidate is left. The old policy fell back to evicting a
      // protected view; the assistant floor lets the cache run over instead.
      const managerWithLimit = makeManager(2);

      const wcA = createMockWebContents();
      const viewA = { webContents: wcA, setBounds: vi.fn() };
      managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

      await managerWithLimit.switchTo("proj-b", "/path/b");
      await flushImmediates();

      bindLiveAssistant(managerWithLimit, "proj-a", "t-help-a");
      bindLiveAssistant(managerWithLimit, "proj-b", "t-help-b");
      mockGetAllTerminals.mockResolvedValue([
        { id: "t-help-a", projectId: "proj-a", agentState: "working" },
        { id: "t-help-b", projectId: "proj-b", agentState: "idle" },
      ]);
      await managerWithLimit.initAgentStateCache(mockPtyClient as never);

      const wcB = managerWithLimit.getAllViews().find((v) => v.projectId === "proj-b")?.view
        .webContents as ReturnType<typeof createMockWebContents> | undefined;

      await managerWithLimit.switchTo("proj-c", "/path/c");
      await flushImmediates();

      expect(
        managerWithLimit
          .getAllViews()
          .map((v) => v.projectId)
          .sort()
      ).toEqual(["proj-a", "proj-b", "proj-c"]);
      expect(wcA.close).not.toHaveBeenCalled();
      expect(wcB?.close).not.toHaveBeenCalled();

      // The overflow is deliberate — say so, or it reads as a leak in the logs.
      expect(vi.mocked(logInfo)).toHaveBeenCalledWith(
        "projectview.eviction-skipped",
        expect.objectContaining({
          reason: "lru",
          viewCount: 3,
          baseMax: 2,
          effectiveMax: 4,
          overflow: 1,
          protectedProjectIds: ["proj-a", "proj-b"],
        })
      );
    });

    it("keeps the project the user just left warm beside two running assistants (#12885)", async () => {
      // A cap of three used to be filled by the active view and two pinned
      // assistants, so every ordinary project was evicted on the switch away.
      const managerWithLimit = makeManager(3);
      managerWithLimit.registerInitialView(
        { webContents: createMockWebContents(), setBounds: vi.fn() } as never,
        "proj-a",
        "/path/a"
      );
      await managerWithLimit.switchTo("proj-b", "/path/b");
      await flushImmediates();
      bindLiveAssistant(managerWithLimit, "proj-a", "t-help-a");
      bindLiveAssistant(managerWithLimit, "proj-b", "t-help-b");

      await managerWithLimit.switchTo("proj-c", "/path/c");
      await flushImmediates();
      const wcC = managerWithLimit.getAllViews().find((v) => v.projectId === "proj-c")!.view
        .webContents as unknown as ReturnType<typeof createMockWebContents>;
      await managerWithLimit.switchTo("proj-d", "/path/d");
      await flushImmediates();
      await managerWithLimit.switchTo("proj-c", "/path/c");
      await flushImmediates();

      expect(evictedProjectIds()).toEqual([]);
      expect(
        managerWithLimit.getAllViews().find((v) => v.projectId === "proj-c")!.view.webContents
      ).toBe(wcC);
      // Held at the raised target with an ordinary candidate still queued, and
      // said so — the cache is over the configured cap because of the assistants.
      expect(vi.mocked(logInfo)).toHaveBeenCalledWith(
        "projectview.eviction-skipped",
        expect.objectContaining({
          reason: "lru",
          viewCount: 4,
          baseMax: 3,
          effectiveMax: 4,
          overflow: 1,
          protectedProjectIds: ["proj-a", "proj-b"],
        })
      );
      expect(wcC.close).not.toHaveBeenCalled();

      // One warm ordinary view, not unbounded: the next project displaces the
      // older ordinary view, never an assistant. Backdated so proj-d's stamp
      // cannot tie with the one proj-c gets on the way out — these switches
      // land inside a single millisecond.
      for (const view of managerWithLimit.getAllViews()) view.lastUsed -= 1000;
      await managerWithLimit.switchTo("proj-e", "/path/e");
      await flushImmediates();
      expect(evictedProjectIds()).toEqual(["proj-d"]);
      expect(
        managerWithLimit
          .getAllViews()
          .map((v) => v.projectId)
          .sort()
      ).toEqual(["proj-a", "proj-b", "proj-c", "proj-e"]);
    });

    it("stops protecting a view once its assistant PTY exits", async () => {
      // The binding is not liveness. HelpSessionService holds it until the
      // session is revoked, displaced, or unbound — an assistant the user quit
      // leaves it behind, and the orphan sweep skips bound sessions. Without the
      // liveness half, that stale binding would pin proj-a's view for the rest
      // of the session.
      const managerWithLimit = makeManager(2);

      const wcA = createMockWebContents();
      const viewA = { webContents: wcA, setBounds: vi.fn() };
      managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

      await managerWithLimit.switchTo("proj-b", "/path/b");
      await flushImmediates();

      bindLiveAssistant(managerWithLimit, "proj-a", "t-help-a");

      // The assistant's PTY exits: PtyClient drops it from the spawn registry,
      // while HelpSessionService's binding survives.
      liveTerminals.delete("t-help-a");
      expect(assistantBackendsForProject("proj-a")).not.toHaveLength(0);

      await managerWithLimit.switchTo("proj-c", "/path/c");
      await flushImmediates();

      const remaining = managerWithLimit.getAllViews().map((v) => v.projectId);
      expect(remaining).not.toContain("proj-a");
      expect(wcA.close).toHaveBeenCalled();
    });

    it("protects only the view the session pinned, not another window's view of the same project", async () => {
      // The binding is projectId-scoped but views are per-window. Evicting a
      // non-pinned view kills nothing — revokeByWebContentsId only matches the
      // session's own pinned WebContents — so it stays an ordinary candidate.
      const managerWithLimit = makeManager(2);

      const wcA = createMockWebContents();
      const viewA = { webContents: wcA, setBounds: vi.fn() };
      managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

      await managerWithLimit.switchTo("proj-b", "/path/b");
      await flushImmediates();

      // A live assistant for proj-a, but minted in another window: its pin
      // points at a WebContents this manager doesn't own.
      assistantBackends.set("proj-a", { terminalId: "t-help-a", webContentsId: wcA.id + 5000 });
      liveTerminals.add("t-help-a");

      await managerWithLimit.switchTo("proj-c", "/path/c");
      await flushImmediates();

      const remaining = managerWithLimit.getAllViews().map((v) => v.projectId);
      expect(remaining).not.toContain("proj-a");
      expect(wcA.close).toHaveBeenCalled();
    });

    it("keeps an assistant-backed view through the forced tier-2 reclaim and reports the overflow (#11477)", async () => {
      // The floor no longer yields to pressure at any level. It used to, on the
      // theory that losing the assistant beats an OOM — but that trade never
      // existed: the reclaim is the renderer teardown, and the assistant's PTY
      // lives in the pty-host where no pass here can measure or free it. The
      // forced reclaim strips every ordinary view and stops, over its cap by
      // exactly the protected views, which it must say out loud.
      const managerWithLimit = makeManager(3);

      const wcA = createMockWebContents();
      const viewA = { webContents: wcA, setBounds: vi.fn() };
      managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

      await managerWithLimit.switchTo("proj-b", "/path/b");
      await flushImmediates();
      await managerWithLimit.switchTo("proj-c", "/path/c");
      await flushImmediates();

      bindLiveAssistant(managerWithLimit, "proj-a", "t-help-a");
      mockGetAllTerminals.mockResolvedValue([
        { id: "t-help-a", projectId: "proj-a", agentState: "working" },
        { id: "t-b", projectId: "proj-b", agentState: "idle" },
      ]);
      await managerWithLimit.initAgentStateCache(mockPtyClient as never);

      managerWithLimit.reclaimCachedViewsUnderPressure();

      // proj-a is the LRU view AND the assistant's — pure LRU would take it
      // first, the old critical escape valve would take it last. Neither now.
      expect(
        managerWithLimit
          .getAllViews()
          .map((v) => v.projectId)
          .sort()
      ).toEqual(["proj-a", "proj-c"]);
      expect(evictedProjectIds()).toEqual(["proj-b"]);
      expect(vi.mocked(logInfo)).not.toHaveBeenCalledWith(
        "projectview.eviction",
        expect.objectContaining({ projectId: "proj-a" })
      );
      // Without this the two surviving renderers read as a leak in the logs.
      expect(vi.mocked(logInfo)).toHaveBeenCalledWith(
        "projectview.eviction-skipped",
        expect.objectContaining({
          reason: "pressure",
          forced: true,
          effectiveMax: 1,
          viewCount: 2,
          overflow: 1,
          // What is holding the overflow: a pinned assistant this pass will
          // never take, and no transient paint-gate/cold-switch bridge.
          protectedCount: 1,
          transientlyExcludedCount: 0,
          protectedProjectIds: ["proj-a"],
        })
      );
    });

    it("still reclaims an assistant-backed view in another window, which kills nothing (#11477)", async () => {
      // The floor is keyed to the exact WebContents the session pinned, so it
      // cannot become a blanket per-project pin: a second window's view of the
      // same project has no session bound to it, `revokeByWebContentsId` finds
      // nothing there, and destroying it costs the assistant nothing.
      const managerWithLimit = makeManager(3);

      const wcA = createMockWebContents();
      const viewA = { webContents: wcA, setBounds: vi.fn() };
      managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

      await managerWithLimit.switchTo("proj-b", "/path/b");
      await flushImmediates();

      // Bind the assistant to a DIFFERENT WebContents id than this manager's
      // proj-a view — i.e. the session lives in the other window.
      assistantBackends.set("proj-a", { terminalId: "t-help-a", webContentsId: wcA.id + 1000 });
      liveTerminals.add("t-help-a");

      managerWithLimit.reclaimCachedViewsUnderPressure();

      expect(managerWithLimit.getAllViews().map((v) => v.projectId)).toEqual(["proj-b"]);
      expect(evictedProjectIds()).toEqual(["proj-a"]);
    });

    describe("a view of a host's project (#13349)", () => {
      const remoteKey = toHostScopedKey("studio-02", "proj-r");

      /** proj-a locally, then the host's project, which the user then leaves. */
      async function withRemoteView(mgr: ProjectViewManager) {
        const wcA = createMockWebContents();
        mgr.registerInitialView({ webContents: wcA, setBounds: vi.fn() } as never, "proj-a", "/a");
        await mgr.switchToHostProject("studio-02", "proj-r", "/srv/r");
        await flushImmediates();
        const wcR = mgr.getAllViews().find((v) => v.projectId === remoteKey)!.view
          .webContents as unknown as ReturnType<typeof createMockWebContents>;
        return wcR;
      }

      async function leaveFor(mgr: ProjectViewManager, ...projectIds: string[]) {
        for (const projectId of projectIds) {
          await mgr.switchTo(projectId, `/path/${projectId}`);
          await flushImmediates();
        }
      }

      it("keeps it out of the LRU pool while its host reports a live assistant", async () => {
        // The issue's sequence: the user leaves the host's view and works
        // locally. Its assistant runs on the host, where closing this view
        // would revoke it, so none of this machine's sessions speak for it.
        const managerWithLimit = makeManager(2);
        const wcR = await withRemoteView(managerWithLimit);
        liveRemoteViews.add(wcR.id);

        await leaveFor(managerWithLimit, "proj-b", "proj-c", "proj-d");

        const remaining = managerWithLimit.getAllViews().map((v) => v.projectId);
        expect(remaining).toContain(remoteKey);
        expect(wcR.close).not.toHaveBeenCalled();
        expect(evictedProjectIds()).toEqual(["proj-a", "proj-b"]);
      });

      it("evicts it like any other view when its host reports none", async () => {
        const managerWithLimit = makeManager(2);
        const wcR = await withRemoteView(managerWithLimit);

        await leaveFor(managerWithLimit, "proj-b", "proj-c");

        expect(evictedProjectIds()).toEqual(["proj-a", remoteKey]);
        expect(wcR.close).toHaveBeenCalled();
      });

      it("keeps it through the forced reclaim", async () => {
        const managerWithLimit = makeManager(3);
        const wcR = await withRemoteView(managerWithLimit);
        await leaveFor(managerWithLimit, "proj-b");
        liveRemoteViews.add(wcR.id);

        managerWithLimit.reclaimCachedViewsUnderPressure();

        expect(
          managerWithLimit
            .getAllViews()
            .map((v) => v.projectId)
            .sort()
        ).toEqual(["proj-b", remoteKey]);
        expect(evictedProjectIds()).toEqual(["proj-a"]);
      });

      it("never asks a host about a view of this machine's own project", async () => {
        const askHost = vi.fn(() => true);
        const managerWithLimit = new ProjectViewManager(win as never, {
          dirname: "/test",
          paintGateTimeoutMs: 0,
          paintGateHardTimeoutMs: 0,
          warmPaintGateTimeoutMs: 0,
          warmPaintGateHardTimeoutMs: 0,
          cachedProjectViews: 2,
          assistantBackendsForProject,
          isTerminalLive,
          remoteAssistantLive: askHost,
          remoteAgentActive: askHost,
        });
        const wcA = createMockWebContents();
        managerWithLimit.registerInitialView(
          { webContents: wcA, setBounds: vi.fn() } as never,
          "proj-a",
          "/a"
        );

        await leaveFor(managerWithLimit, "proj-b", "proj-c");

        expect(evictedProjectIds()).toEqual(["proj-a"]);
        expect(askHost).not.toHaveBeenCalled();
      });

      describe("with residency granted on its host (#13933)", () => {
        it("keeps it past a more recently used ordinary local view", async () => {
          const managerWithLimit = makeManager(2);
          const wcR = await withRemoteView(managerWithLimit);
          residentRemoteViews.add(wcR.id);

          await leaveFor(managerWithLimit, "proj-b", "proj-c");

          expect(managerWithLimit.getAllViews().map((v) => v.projectId)).toContain(remoteKey);
          expect(wcR.close).not.toHaveBeenCalled();
          expect(evictedProjectIds()).toEqual(["proj-a", "proj-b"]);
        });

        it("ignores a grant this machine holds for the same key", async () => {
          const managerWithLimit = makeManager(2);
          const wcR = await withRemoteView(managerWithLimit);
          residentWorkspaces.add(remoteKey);

          await leaveFor(managerWithLimit, "proj-b", "proj-c");

          expect(wcR.close).toHaveBeenCalled();
          expect(evictedProjectIds()).toContain(remoteKey);
        });

        it("still yields to the forced reclaim", async () => {
          const managerWithLimit = makeManager(3);
          const wcR = await withRemoteView(managerWithLimit);
          await leaveFor(managerWithLimit, "proj-b");
          residentRemoteViews.add(wcR.id);

          managerWithLimit.reclaimCachedViewsUnderPressure();

          expect(managerWithLimit.getAllViews().map((v) => v.projectId)).toEqual(["proj-b"]);
        });
      });

      describe("with an MCP session bound on its host (#14228)", () => {
        it("keeps it past a more recently used ordinary local view", async () => {
          // This manager wires no local MCP reader: the host's word is enough.
          const managerWithLimit = makeManager(2);
          const wcR = await withRemoteView(managerWithLimit);
          boundRemoteViews.add(wcR.id);

          await leaveFor(managerWithLimit, "proj-b", "proj-c");

          expect(managerWithLimit.getAllViews().map((v) => v.projectId)).toContain(remoteKey);
          expect(wcR.close).not.toHaveBeenCalled();
          expect(evictedProjectIds()).toEqual(["proj-a", "proj-b"]);
        });

        it("ranks it below a view with residency granted on its host", async () => {
          const managerWithLimit = makeManager(4);
          const wcR = await withRemoteView(managerWithLimit);
          await leaveFor(managerWithLimit, "proj-b", "proj-c");
          boundRemoteViews.add(wcR.id);
          residentWorkspaces.add("proj-a");
          residentWorkspaces.add("proj-b");

          managerWithLimit.setCachedViewLimit(2);

          // The bound view goes before either granted one, older or not.
          expect(evictedProjectIds()).toEqual([remoteKey, "proj-a"]);
        });

        it("still yields to the forced reclaim", async () => {
          const managerWithLimit = makeManager(3);
          const wcR = await withRemoteView(managerWithLimit);
          await leaveFor(managerWithLimit, "proj-b");
          boundRemoteViews.add(wcR.id);

          managerWithLimit.reclaimCachedViewsUnderPressure();

          expect(managerWithLimit.getAllViews().map((v) => v.projectId)).toEqual(["proj-b"]);
        });

        it("doesn't count it as a dispatch in flight, so it can still move to another window", async () => {
          const managerWithLimit = makeManager(3);
          const wcR = await withRemoteView(managerWithLimit);
          await leaveFor(managerWithLimit, "proj-b");
          boundRemoteViews.add(wcR.id);

          expect(managerWithLimit.isMcpDispatchProtected(remoteKey)).toBe(false);
          expect(managerWithLimit.canReleaseCachedView(remoteKey)).toBe(true);
        });
      });

      describe("with agents active on its host (#13359)", () => {
        it("ranks it with active-agent views, behind an ordinary local view", async () => {
          // The issue's log: a host view with working agents evicted milliseconds
          // after the user left it, while ordinary local views stayed.
          const managerWithLimit = makeManager(2);
          const wcR = await withRemoteView(managerWithLimit);
          activeRemoteViews.add(wcR.id);

          await leaveFor(managerWithLimit, "proj-b", "proj-c");

          expect(managerWithLimit.getAllViews().map((v) => v.projectId)).toContain(remoteKey);
          expect(wcR.close).not.toHaveBeenCalled();
          expect(evictedProjectIds()).toEqual(["proj-a", "proj-b"]);
        });

        async function withActiveViews(mgr: ProjectViewManager) {
          const wcR = await withRemoteView(mgr);
          await leaveFor(mgr, "proj-b", "proj-c");
          activeRemoteViews.add(wcR.id);
          return wcR;
        }

        it("loses to a more recently used local view with an active agent", async () => {
          const managerWithLimit = makeManager(4);
          await withActiveViews(managerWithLimit);
          mockGetAllTerminals.mockResolvedValue([
            { id: "t-b", projectId: "proj-b", agentState: "working" },
          ]);
          await managerWithLimit.initAgentStateCache(mockPtyClient as never);

          managerWithLimit.setCachedViewLimit(2);

          expect(evictedProjectIds()).toEqual(["proj-a", remoteKey]);
          expect(vi.mocked(logInfo)).toHaveBeenCalledWith(
            "projectview.eviction",
            expect.objectContaining({ projectId: remoteKey, activeAgent: true })
          );
        });

        it("outlasts a less recently used local view with an active agent", async () => {
          const managerWithLimit = makeManager(4);
          await withActiveViews(managerWithLimit);
          mockGetAllTerminals.mockResolvedValue([
            { id: "t-a", projectId: "proj-a", agentState: "working" },
          ]);
          await managerWithLimit.initAgentStateCache(mockPtyClient as never);

          managerWithLimit.setCachedViewLimit(2);

          // proj-b has no agent, so it goes first; then the older active view.
          expect(evictedProjectIds()).toEqual(["proj-b", "proj-a"]);
          expect(managerWithLimit.getAllViews().map((v) => v.projectId)).toContain(remoteKey);
        });

        it("still yields to the forced reclaim, unlike a live assistant", async () => {
          const managerWithLimit = makeManager(3);
          const wcR = await withRemoteView(managerWithLimit);
          await leaveFor(managerWithLimit, "proj-b");
          activeRemoteViews.add(wcR.id);

          managerWithLimit.reclaimCachedViewsUnderPressure();

          expect(managerWithLimit.getAllViews().map((v) => v.projectId)).toEqual(["proj-b"]);
          expect(evictedProjectIds()).toEqual(["proj-a", remoteKey]);
        });
      });

      it("won't give it to another window while its assistant is live (#13274)", async () => {
        const managerWithLimit = makeManager(3);
        const wcR = await withRemoteView(managerWithLimit);
        await leaveFor(managerWithLimit, "proj-b");
        expect(managerWithLimit.canReleaseCachedView(remoteKey)).toBe(true);

        liveRemoteViews.add(wcR.id);
        expect(managerWithLimit.canReleaseCachedView(remoteKey)).toBe(false);
      });
    });

    it("still evicts a crashed cached view that has a live assistant backend", async () => {
      // The renderer is already gone — there is nothing left to protect, and
      // holding the entry would leak a dead view. evictDeadView stays
      // unconditional.
      const managerWithLimit = makeManager(3);

      const wcA = createMockWebContents();
      const viewA = { webContents: wcA, setBounds: vi.fn() };
      managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

      // proj-b's view is created by switchTo, so setupViewHandlers wires its
      // render-process-gone listener — registerInitialView does not.
      await managerWithLimit.switchTo("proj-b", "/path/b");
      await flushImmediates();
      const wcB = managerWithLimit.getAllViews().find((v) => v.projectId === "proj-b")!.view
        .webContents as unknown as ReturnType<typeof createMockWebContents>;

      bindLiveAssistant(managerWithLimit, "proj-b", "t-help-b");

      // Cache proj-b (limit 3 holds all three, so no LRU pass interferes).
      await managerWithLimit.switchTo("proj-c", "/path/c");
      await flushImmediates();

      const goneCall = wcB.on.mock.calls.find(([event]) => event === "render-process-gone");
      expect(goneCall).toBeDefined();
      goneCall![1]({}, { reason: "crashed", exitCode: 1 });
      await flushImmediates();

      expect(wcB.close).toHaveBeenCalled();
      expect(managerWithLimit.getAllViews().map((v) => v.projectId)).not.toContain("proj-b");
    });
  });

  // ── LRU eviction with memory logging (issue #8602) ──

  it("evicts the LRU cached view first, not the largest renderer", async () => {
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    await managerWithLimit.switchTo("proj-b", "/path/b");
    await flushImmediates();

    // proj-a is the LRU view but small; proj-b is the heaviest cached renderer
    // and more recent. Under #8602, size must not promote proj-b ahead of the
    // LRU pick — proj-a is evicted, the large/recently-used proj-b survives.
    const wcBEntry = managerWithLimit.getAllViews().find((v) => v.projectId === "proj-b");
    const wcB = wcBEntry?.view.webContents as unknown as ReturnType<typeof createMockWebContents>;
    mockGetAppMetrics.mockReturnValue([
      { pid: wcA.osPid, memory: { workingSetSize: 50 * 1024, privateBytes: 0 } },
      { pid: wcB.osPid, memory: { workingSetSize: 800 * 1024, privateBytes: 0 } },
    ] as unknown as Electron.ProcessMetric[]);

    await managerWithLimit.switchTo("proj-c", "/path/c");
    await flushImmediates();

    const remaining = managerWithLimit.getAllViews().map((v) => v.projectId);
    expect(remaining).not.toContain("proj-a");
    expect(remaining).toContain("proj-b");
    expect(remaining).toContain("proj-c");
    expect(wcA.close).toHaveBeenCalled();
    expect(wcB.close).not.toHaveBeenCalled();
  });

  it("switching back to a cached view refreshes its LRU stamp", async () => {
    let now = 1_700_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now++);
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
    });

    try {
      const wcA = createMockWebContents();
      const viewA = { webContents: wcA, setBounds: vi.fn() };
      managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

      await managerWithLimit.switchTo("proj-b", "/path/b");
      await flushImmediates();
      await managerWithLimit.switchTo("proj-c", "/path/c");
      await flushImmediates();

      // Re-visit proj-a from cache — its lastUsed must be refreshed so it is
      // no longer the oldest candidate. Without this, the next overflow would
      // wrongly target proj-a.
      await managerWithLimit.switchTo("proj-a", "/path/a");
      await flushImmediates();

      await managerWithLimit.switchTo("proj-d", "/path/d");
      await flushImmediates();

      const remaining = managerWithLimit.getAllViews().map((v) => v.projectId);
      expect(remaining).not.toContain("proj-b");
      expect(remaining).toContain("proj-a");
      expect(remaining).toContain("proj-c");
      expect(remaining).toContain("proj-d");
    } finally {
      // Before the real clock returns: these views are stamped in 2023, so a
      // sampler tick left running would release them as idle mid-way through a
      // later test (#14217).
      managerWithLimit.dispose();
      dateNow.mockRestore();
    }
  });

  it("logs memoryKb in projectview.eviction when measured", async () => {
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    await managerWithLimit.switchTo("proj-b", "/path/b");
    await flushImmediates();

    // macOS/Linux shape: privateBytes is reported as 0 (not undefined) off
    // Windows, so a `privateBytes ?? workingSetSize` read resolves to 0 and
    // silently drops memoryKb from every eviction line (#8646).
    mockGetAppMetrics.mockReturnValue([
      { pid: wcA.osPid, memory: { workingSetSize: 250 * 1024, privateBytes: 0 } },
    ] as unknown as Electron.ProcessMetric[]);

    // Sweep fresh: a background sample timer may have cached empty metrics
    // during the awaits above, and the 5s snapshot TTL would otherwise shadow
    // the mock this eviction must read.
    resetAppMetricsSnapshotForTesting();
    await managerWithLimit.switchTo("proj-c", "/path/c");
    await flushImmediates();

    expect(vi.mocked(logInfo)).toHaveBeenCalledWith(
      "projectview.eviction",
      expect.objectContaining({ projectId: "proj-a", memoryKb: 250 * 1024 })
    );
  });

  it("reports the working set, not privateBytes, when both are populated", async () => {
    // Windows shape: both fields carry distinct non-zero values. The eviction
    // log standardises on the working set across all three platforms, so the
    // divergent privateBytes must not win.
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    await managerWithLimit.switchTo("proj-b", "/path/b");
    await flushImmediates();

    mockGetAppMetrics.mockReturnValue([
      { pid: wcA.osPid, memory: { workingSetSize: 250 * 1024, privateBytes: 900 * 1024 } },
    ] as unknown as Electron.ProcessMetric[]);

    resetAppMetricsSnapshotForTesting();
    await managerWithLimit.switchTo("proj-c", "/path/c");
    await flushImmediates();

    expect(vi.mocked(logInfo)).toHaveBeenCalledWith(
      "projectview.eviction",
      expect.objectContaining({ projectId: "proj-a", memoryKb: 250 * 1024 })
    );
  });

  it("falls back to LRU when app.getAppMetrics() throws", async () => {
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    await managerWithLimit.switchTo("proj-b", "/path/b");
    await flushImmediates();

    mockGetAppMetrics.mockImplementation(() => {
      throw new Error("metrics unavailable");
    });

    // Eviction must still complete without throwing — LRU drives the choice.
    await expect(managerWithLimit.switchTo("proj-c", "/path/c")).resolves.toBeDefined();
    await flushImmediates();

    const remaining = managerWithLimit.getAllViews().map((v) => v.projectId);
    expect(remaining).not.toContain("proj-a");
    expect(remaining).toContain("proj-b");
    expect(remaining).toContain("proj-c");
  });

  it("evicts in LRU order when limit shrinks past multiple views", async () => {
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 4,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    await managerWithLimit.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await managerWithLimit.switchTo("proj-c", "/path/c");
    await flushImmediates();
    await managerWithLimit.switchTo("proj-d", "/path/d");
    await flushImmediates();

    const wcB = managerWithLimit.getAllViews().find((v) => v.projectId === "proj-b")?.view
      .webContents as unknown as ReturnType<typeof createMockWebContents>;
    const wcC = managerWithLimit.getAllViews().find((v) => v.projectId === "proj-c")?.view
      .webContents as unknown as ReturnType<typeof createMockWebContents>;

    // proj-d is active. Among the cached three (a, b, c), LRU order is
    // a → b → c (a was backgrounded first, c most recently). With the limit
    // dropping to 2, the two oldest (a, b) evict and proj-c survives,
    // regardless of their memory footprint.
    mockGetAppMetrics.mockReturnValue([
      { pid: wcA.osPid, memory: { workingSetSize: 800 * 1024, privateBytes: 0 } },
      { pid: wcB.osPid, memory: { workingSetSize: 100 * 1024, privateBytes: 0 } },
      { pid: wcC.osPid, memory: { workingSetSize: 900 * 1024, privateBytes: 0 } },
    ] as unknown as Electron.ProcessMetric[]);

    managerWithLimit.setCachedViewLimit(2);

    const remaining = managerWithLimit.getAllViews().map((v) => v.projectId);
    expect(remaining).toContain("proj-c");
    expect(remaining).toContain("proj-d");
    expect(remaining).not.toContain("proj-a");
    expect(remaining).not.toContain("proj-b");

    // Lock in eviction sequence (not just membership): proj-a evicts before
    // proj-b, matching LRU order. Without this, a reverse-order regression
    // would still produce the same survivor set and silently pass.
    const evictionCalls = vi
      .mocked(logInfo)
      .mock.calls.filter(([event]) => event === "projectview.eviction")
      .map(([, ctx]) => (ctx as { projectId: string }).projectId);
    expect(evictionCalls).toEqual(["proj-a", "proj-b"]);
  });

  it("calls forgetBlinkSample with the evicted webContents id", async () => {
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    await managerWithLimit.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await managerWithLimit.switchTo("proj-c", "/path/c");
    await flushImmediates();

    expect(vi.mocked(forgetBlinkSample)).toHaveBeenCalledWith(wcA.id);
  });

  it("calls forgetEluSample with the evicted webContents id", async () => {
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    await managerWithLimit.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await managerWithLimit.switchTo("proj-c", "/path/c");
    await flushImmediates();

    expect(vi.mocked(forgetEluSample)).toHaveBeenCalledWith(wcA.id);
  });
});

describe("ProjectViewManager — telemetry", () => {
  let win: ReturnType<typeof createMockWindow>;

  beforeEach(() => {
    nextWebContentsId = 100;
    nextOsProcessId = 1000;
    vi.clearAllMocks();
    mockGetAllTerminals.mockReset();
    mockGetAllTerminals.mockResolvedValue([]);
    mockGetAppMetrics.mockReset();
    mockGetAppMetrics.mockReturnValue([]);
    win = createMockWindow();
  });

  it("emits projectview.eviction with reason=lru when switch overflows the cache", async () => {
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await manager.switchTo("proj-c", "/path/c");
    await flushImmediates();

    expect(vi.mocked(logInfo)).toHaveBeenCalledWith("projectview.eviction", {
      projectId: "proj-a",
      reason: "lru",
      ageMs: expect.any(Number),
      activeAgent: false,
    });

    const evictionCall = vi
      .mocked(logInfo)
      .mock.calls.find(
        ([event, ctx]) =>
          event === "projectview.eviction" && (ctx as { projectId: string }).projectId === "proj-a"
      );
    expect(evictionCall).toBeDefined();
    const ctx = evictionCall![1] as { ageMs: number };
    expect(ctx.ageMs).toBeGreaterThanOrEqual(0);
  });

  it("emits projectview.eviction with reason=limit-change when setCachedViewLimit shrinks the cache", async () => {
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await manager.switchTo("proj-c", "/path/c");
    await flushImmediates();

    vi.mocked(logInfo).mockClear();

    // Shrink from 3 to 1 — evicts the 2 LRU non-active projects (proj-a, proj-b)
    manager.setCachedViewLimit(1);

    const limitChangeCalls = vi
      .mocked(logInfo)
      .mock.calls.filter(([event]) => event === "projectview.eviction");
    expect(limitChangeCalls.length).toBe(2);

    const evictedIds = limitChangeCalls.map(([, ctx]) => (ctx as { projectId: string }).projectId);
    expect(evictedIds).toContain("proj-a");
    expect(evictedIds).toContain("proj-b");

    for (const [, ctx] of limitChangeCalls) {
      const c = ctx as { reason: string; ageMs: number };
      expect(c.reason).toBe("limit-change");
      expect(c.ageMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("emits projectview.revival exactly once when a previously-evicted project is activated from cache", async () => {
    // Trace (cachedProjectViews=2):
    //   1. register proj-a (active=a)
    //   2. switchTo b   → views: {a, b}, active=b
    //   3. switchTo c   → evicts a (LRU), evictionTimestamps={a: t1}, active=c
    //   4. switchTo a   → cold-start a (a was destroyed), evicts b, active=a
    //   5. switchTo b   → cold-start b (b was destroyed), evicts c, active=b
    //   6. switchTo a   → cache hit on a; evictionTimestamps has {a: t1} → revival fires
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await manager.switchTo("proj-c", "/path/c");
    await flushImmediates();
    await manager.switchTo("proj-a", "/path/a");
    await flushImmediates();
    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();

    vi.mocked(logInfo).mockClear();

    await manager.switchTo("proj-a", "/path/a");
    await flushImmediates();

    const revivalCalls = vi
      .mocked(logInfo)
      .mock.calls.filter(([event]) => event === "projectview.revival");
    expect(revivalCalls.length).toBe(1);
    expect(revivalCalls[0][1]).toMatchObject({
      projectId: "proj-a",
      timeSinceEvictionMs: expect.any(Number),
      visibleMs: expect.any(Number),
    });
    expect(
      (revivalCalls[0][1] as { timeSinceEvictionMs: number }).timeSinceEvictionMs
    ).toBeGreaterThanOrEqual(0);
    expect((revivalCalls[0][1] as { visibleMs: number }).visibleMs).toBeGreaterThanOrEqual(0);
  });

  it("does not emit projectview.revival a second time for the same project without a new eviction (timestamp is consumed on read)", async () => {
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    // Set up a revival for proj-a (same trace as the previous test)
    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await manager.switchTo("proj-c", "/path/c");
    await flushImmediates();
    await manager.switchTo("proj-a", "/path/a");
    await flushImmediates();
    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await manager.switchTo("proj-a", "/path/a"); // revival fires for proj-a — timestamp consumed
    await flushImmediates();

    // Switch away to a fresh cold-started project so the next return to proj-a
    // exercises the cache-hit path without touching any other stale timestamps.
    // proj-d is new; cold-starting it evicts proj-b (LRU), leaving {a, d} cached.
    await manager.switchTo("proj-d", "/path/d");
    await flushImmediates();

    vi.mocked(logInfo).mockClear();

    // Return to proj-a — cache hit, but evictionTimestamps has no entry for proj-a.
    await manager.switchTo("proj-a", "/path/a");
    await flushImmediates();

    const revivalCalls = vi
      .mocked(logInfo)
      .mock.calls.filter(([event]) => event === "projectview.revival");
    expect(revivalCalls.length).toBe(0);
  });

  it("emits projectview.coldstart on successful view creation", async () => {
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    vi.mocked(logInfo).mockClear();

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();

    const coldStartCall = vi
      .mocked(logInfo)
      .mock.calls.find(([event]) => event === "projectview.coldstart");
    expect(coldStartCall).toBeDefined();
    expect(coldStartCall![1]).toMatchObject({
      projectId: "proj-b",
      durationMs: expect.any(Number),
    });
    expect((coldStartCall![1] as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
  });

  it("does not emit projectview.warm-swap on cold-start switches (no prior cached view)", async () => {
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    vi.mocked(logInfo).mockClear();

    // Cold start to proj-b — no cached view exists, so warm-swap must not fire.
    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();

    const warmSwapCalls = vi
      .mocked(logInfo)
      .mock.calls.filter(([event]) => event === "projectview.warm-swap");
    expect(warmSwapCalls.length).toBe(0);
  });

  it("emits projectview.warm-swap on every cache-hit reactivation with visibleMs", async () => {
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();

    vi.mocked(logInfo).mockClear();

    // Cache hit on proj-a — no prior eviction, so revival does NOT fire,
    // but warm-swap MUST fire with the activation latency.
    await manager.switchTo("proj-a", "/path/a");
    await flushImmediates();

    const warmSwapCalls = vi
      .mocked(logInfo)
      .mock.calls.filter(([event]) => event === "projectview.warm-swap");
    const revivalCalls = vi
      .mocked(logInfo)
      .mock.calls.filter(([event]) => event === "projectview.revival");
    expect(warmSwapCalls.length).toBe(1);
    expect(revivalCalls.length).toBe(0);
    expect(warmSwapCalls[0][1]).toMatchObject({
      projectId: "proj-a",
      webContentsId: wcA.id,
      switchId: expect.any(String),
      visibleMs: expect.any(Number),
    });
    expect((warmSwapCalls[0][1] as { visibleMs: number }).visibleMs).toBeGreaterThanOrEqual(0);
  });

  it("sampleCachedViewMemory emits projectview.cached-memory for non-active cached views", async () => {
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    const wcB = manager.getAllViews().find((v) => v.projectId === "proj-b")?.view
      .webContents as unknown as ReturnType<typeof createMockWebContents>;

    // macOS/Linux shape — privateBytes is 0 there, not undefined, so a
    // `privateBytes ?? workingSetSize` read resolves to 0 and this sampler
    // emits nothing at all rather than a zero (#8646).
    mockGetAppMetrics.mockReturnValue([
      { pid: wcA.osPid, memory: { workingSetSize: 250 * 1024, privateBytes: 0 } },
      { pid: wcB.osPid, memory: { workingSetSize: 300 * 1024, privateBytes: 0 } },
    ] as unknown as Electron.ProcessMetric[]);

    // Sweep fresh: a background sample timer may have cached empty metrics
    // during the awaits above, and the 5s snapshot TTL would otherwise shadow
    // the mock this test just set.
    resetAppMetricsSnapshotForTesting();
    vi.mocked(logDebug).mockClear();

    (manager as unknown as { sampleCachedViewMemory(): void }).sampleCachedViewMemory();

    const memoryCalls = vi
      .mocked(logDebug)
      .mock.calls.filter(([event]) => event === "projectview.cached-memory");
    // proj-b is the active view; only proj-a (cached) should be sampled
    expect(memoryCalls.length).toBe(1);
    expect(memoryCalls[0][1]).toMatchObject({
      projectId: "proj-a",
      memoryKb: 250 * 1024,
      pid: wcA.osPid,
    });
  });

  it("sampleCachedViewMemory reports guest footprint separately from the host", async () => {
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();

    // A dev-preview guest hosted by cached proj-a, with its own pid.
    const guestPid = 9_999;
    const guest = {
      isDestroyed: () => false,
      hostWebContents: wcA,
      getOSProcessId: () => guestPid,
    };
    mockGetAllWebContents.mockReturnValue([guest]);

    mockGetAppMetrics.mockReturnValue([
      { pid: wcA.osPid, memory: { workingSetSize: 250 * 1024, privateBytes: 0 } },
      { pid: guestPid, memory: { workingSetSize: 400 * 1024, privateBytes: 0 } },
    ] as unknown as Electron.ProcessMetric[]);

    // Sweep fresh: a background sample timer may have cached empty metrics
    // during the awaits above, and the 5s snapshot TTL would otherwise shadow
    // the mock this test just set.
    resetAppMetricsSnapshotForTesting();
    vi.mocked(logDebug).mockClear();

    (manager as unknown as { sampleCachedViewMemory(): void }).sampleCachedViewMemory();

    const memoryCalls = vi
      .mocked(logDebug)
      .mock.calls.filter(([event]) => event === "projectview.cached-memory");
    expect(memoryCalls.length).toBe(1);
    expect(memoryCalls[0][1]).toMatchObject({
      projectId: "proj-a",
      memoryKb: 250 * 1024,
      guestMemoryKb: 400 * 1024,
    });
  });

  it("sampleCachedViewMemory skips views whose pid lookup is missing", async () => {
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();

    // Metrics return nothing for proj-a's pid — sampler must skip silently.
    mockGetAppMetrics.mockReturnValue([]);

    vi.mocked(logDebug).mockClear();

    (manager as unknown as { sampleCachedViewMemory(): void }).sampleCachedViewMemory();

    const memoryCalls = vi
      .mocked(logDebug)
      .mock.calls.filter(([event]) => event === "projectview.cached-memory");
    expect(memoryCalls.length).toBe(0);
  });

  it("sampleCachedViewMemory keeps sampling remaining views when one per-view call throws", async () => {
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 4,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await manager.switchTo("proj-c", "/path/c");
    await flushImmediates();
    // proj-c is now active; proj-a and proj-b are cached.
    const wcB = manager.getAllViews().find((v) => v.projectId === "proj-b")?.view
      .webContents as unknown as ReturnType<typeof createMockWebContents>;
    const wcBPid = wcB.getOSProcessId();

    // proj-a's getOSProcessId throws — the iteration over proj-a must be skipped,
    // but proj-b must still be sampled.
    wcA.getOSProcessId = vi.fn(() => {
      throw new Error("view glitch");
    });

    mockGetAppMetrics.mockReturnValue([
      { pid: wcBPid, memory: { workingSetSize: 400 * 1024, privateBytes: 0 } },
    ] as unknown as Electron.ProcessMetric[]);

    // Sweep fresh: a background sample timer may have cached empty metrics
    // during the awaits above, and the 5s snapshot TTL would otherwise shadow
    // the mock this test just set.
    resetAppMetricsSnapshotForTesting();
    vi.mocked(logDebug).mockClear();
    resetAppMetricsSnapshotForTesting();

    expect(() =>
      (manager as unknown as { sampleCachedViewMemory(): void }).sampleCachedViewMemory()
    ).not.toThrow();

    const memoryCalls = vi
      .mocked(logDebug)
      .mock.calls.filter(([event]) => event === "projectview.cached-memory");
    expect(memoryCalls.length).toBe(1);
    expect(memoryCalls[0][1]).toMatchObject({
      projectId: "proj-b",
      memoryKb: 400 * 1024,
    });
  });

  it("sampleCachedViewMemory swallows app.getAppMetrics() failures", async () => {
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();

    mockGetAppMetrics.mockImplementation(() => {
      throw new Error("metrics unavailable");
    });

    expect(() =>
      (manager as unknown as { sampleCachedViewMemory(): void }).sampleCachedViewMemory()
    ).not.toThrow();

    const memoryCalls = vi
      .mocked(logDebug)
      .mock.calls.filter(([event]) => event === "projectview.cached-memory");
    expect(memoryCalls.length).toBe(0);
  });
});

describe("ProjectViewManager — onViewCached (freeze risk mitigation)", () => {
  let win: ReturnType<typeof createMockWindow>;

  beforeEach(() => {
    nextWebContentsId = 100;
    vi.clearAllMocks();
    mockGetAllTerminals.mockReset();
    mockGetAllTerminals.mockResolvedValue([]);
    win = createMockWindow();
  });

  it("fires onViewCached BEFORE freezing the outgoing view so ports close first", async () => {
    const onViewCached = vi.fn();
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
      onViewCached,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");
    // Efficiency on: deactivation freezes the outgoing view inline.
    manager.setEfficiencyFreeze(true);

    const freezeMock = vi.mocked(freezeWebContents);
    freezeMock.mockClear();

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();

    const cachedOrder = onViewCached.mock.invocationCallOrder[0];
    const freezeCall = freezeMock.mock.calls.findIndex((args) => (args[0] as unknown) === wcA);
    const freezeOrder = freezeMock.mock.invocationCallOrder[freezeCall];
    expect(cachedOrder).toBeDefined();
    expect(freezeOrder).toBeDefined();
    expect(cachedOrder!).toBeLessThan(freezeOrder!);
    manager.dispose();
  });

  it("invokes onViewCached for each cached view across rapid switches A→B→C (never for the active C)", async () => {
    const onViewCached = vi.fn();
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
      onViewCached,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    const bEntry = manager.getAllViews().find((v) => v.projectId === "proj-b");
    const wcB = bEntry!.view.webContents as unknown as ReturnType<typeof createMockWebContents>;

    await manager.switchTo("proj-c", "/path/c");
    await flushImmediates();
    const cEntry = manager.getAllViews().find((v) => v.projectId === "proj-c");
    const wcC = cEntry!.view.webContents as unknown as ReturnType<typeof createMockWebContents>;

    const calls = onViewCached.mock.calls.map(([id]) => id);
    expect(calls).toEqual([wcA.id, wcB.id]);
    expect(calls).not.toContain(wcC.id);
  });

  it("does not invoke onViewCached when switching to the already-active project", async () => {
    const onViewCached = vi.fn();
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
      onViewCached,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-a", "/path/a");
    await flushImmediates();

    expect(onViewCached).not.toHaveBeenCalled();
  });

  it("does not invoke onViewCached when the previous view's webContents is destroyed", async () => {
    const onViewCached = vi.fn();
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
      onViewCached,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    // Simulate the active view's renderer dying before the switch lands —
    // deactivateCurrentView reaches the destroyed branch and must skip the
    // producer-cleanup callback (no live ports to close, no freeze risk).
    wcA.isDestroyed.mockReturnValue(true);

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();

    expect(onViewCached).not.toHaveBeenCalled();
  });

  it("a throwing onViewCached does not break the switch — switching still works and reaches the new view", async () => {
    const onViewCached = vi.fn(() => {
      throw new Error("simulated downstream cleanup failure");
    });
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
      onViewCached,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await expect(manager.switchTo("proj-b", "/path/b")).resolves.toMatchObject({ isNew: true });
    await flushImmediates();
    expect(manager.getActiveProjectId()).toBe("proj-b");
    expect(onViewCached).toHaveBeenCalledWith(wcA.id);
    // The rest of deactivation must still run even if the callback throws —
    // the catch is around onViewCached only, not the surrounding flow.
    expect(wcA.session.flushStorageData).toHaveBeenCalled();
    expect(manager.getAllViews().find((v) => v.projectId === "proj-a")?.state).toBe("cached");
  });

  it("never CPU-throttles <webview> guests when their host is cached, and resets them on reactivation", async () => {
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    // A dev-preview guest embedded in proj-a, plus an unrelated webContents
    // that must NOT be touched.
    const guest = { isDestroyed: () => false, hostWebContents: wcA };
    const unrelated = { isDestroyed: () => false, hostWebContents: null };
    mockGetAllWebContents.mockReturnValue([guest, unrelated]);

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();

    // CDP CPU throttling busy-spins the renderer it "slows" (#12456): caching
    // the host hands its guests to no lifecycle helper at all.
    for (const helper of [
      unthrottleCpuWebContents,
      freezeWebContents,
      unfreezeWebContents,
      purgeMemoryWebContents,
    ]) {
      expect(vi.mocked(helper)).not.toHaveBeenCalledWith(guest);
    }

    // Reactivate proj-a — its guest's rate is reset along with the host's.
    await manager.switchTo("proj-a", "/path/a");
    await flushImmediates();

    expect(vi.mocked(unthrottleCpuWebContents)).toHaveBeenCalledWith(guest);
    expect(vi.mocked(unthrottleCpuWebContents)).not.toHaveBeenCalledWith(unrelated);
  });
});

describe("ProjectViewManager — listener cleanup", () => {
  const PERSISTENT_EVENTS = [
    "will-navigate",
    "will-redirect",
    "will-attach-webview",
    "before-input-event",
    "did-finish-load",
    "render-process-gone",
    "unresponsive",
    "responsive",
  ] as const;

  let win: ReturnType<typeof createMockWindow>;

  beforeEach(() => {
    nextWebContentsId = 100;
    nextOsProcessId = 1000;
    vi.clearAllMocks();
    mockGetAllTerminals.mockReset();
    mockGetAllTerminals.mockResolvedValue([]);
    mockGetAppMetrics.mockReset();
    mockGetAppMetrics.mockReturnValue([]);
    win = createMockWindow();
  });

  it("cleanupEntry removes all 6 persistent webContents listeners and detaches console capture before close()", async () => {
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    // Cold-start proj-b — setupViewHandlers attaches the 6 persistent listeners.
    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    const bEntry = manager.getAllViews().find((v) => v.projectId === "proj-b");
    expect(bEntry).toBeDefined();
    const wcB = bEntry!.view.webContents as unknown as ReturnType<typeof createMockWebContents>;

    // Sanity: each persistent event should have exactly one listener attached.
    for (const event of PERSISTENT_EVENTS) {
      expect(wcB.listenerCount(event)).toBe(1);
    }

    // Snapshot pre-eviction state so loadView's one-shot teardown calls are excluded
    // from the cleanup-call accounting below.
    const removeCallsBeforeCleanup = wcB.removeListener.mock.calls.length;
    expect(detachRendererConsoleCapture).not.toHaveBeenCalledWith(wcB);

    // Force eviction of proj-b directly (LRU eviction would target proj-a — the
    // initial view — first, but this test is about proj-b's listener cleanup).
    manager.destroyView("proj-b");

    // After cleanup: every persistent listener must have been removed.
    for (const event of PERSISTENT_EVENTS) {
      expect(wcB.listenerCount(event)).toBe(0);
    }
    const cleanupRemoveCalls = wcB.removeListener.mock.calls.slice(removeCallsBeforeCleanup);
    const cleanupEvents = new Set(cleanupRemoveCalls.map(([event]) => event));
    for (const event of PERSISTENT_EVENTS) {
      expect(cleanupEvents.has(event)).toBe(true);
    }

    // Console-message listener must also be detached via the helper.
    expect(detachRendererConsoleCapture).toHaveBeenCalledWith(wcB);

    // Ordering: every cleanup removeListener call must happen before close().
    const closeOrder = wcB.close.mock.invocationCallOrder[0];
    expect(closeOrder).toBeDefined();
    for (const removeCall of wcB.removeListener.mock.invocationCallOrder.slice(
      removeCallsBeforeCleanup
    )) {
      expect(removeCall).toBeLessThan(closeOrder);
    }
  });

  it("cleanupHandlers is idempotent — disposing twice does not throw or double-remove", async () => {
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    const bEntry = manager.getAllViews().find((v) => v.projectId === "proj-b");
    const wcB = bEntry!.view.webContents as unknown as ReturnType<typeof createMockWebContents>;

    // Snapshot loadView's one-shot teardown calls so we can isolate cleanup activity.
    const removeCallsBeforeCleanup = wcB.removeListener.mock.calls.length;

    manager.destroyView("proj-b");

    const cleanupRemoveCallCount = wcB.removeListener.mock.calls.length - removeCallsBeforeCleanup;
    expect(cleanupRemoveCallCount).toBe(PERSISTENT_EVENTS.length);

    // Second dispose() must be safe even though proj-b is already gone.
    expect(() => manager.dispose()).not.toThrow();

    // No additional removeListener calls on wcB — cleanupHandlers is one-shot.
    expect(wcB.removeListener.mock.calls.length - removeCallsBeforeCleanup).toBe(
      PERSISTENT_EVENTS.length
    );
  });

  it("detachRendererConsoleCapture runs before webContents.close()", async () => {
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    const wcB = manager.getAllViews().find((v) => v.projectId === "proj-b")!.view
      .webContents as unknown as ReturnType<typeof createMockWebContents>;

    manager.destroyView("proj-b");

    const detachOrder = vi.mocked(detachRendererConsoleCapture).mock.invocationCallOrder.at(-1);
    const closeOrder = wcB.close.mock.invocationCallOrder[0];
    expect(detachOrder).toBeDefined();
    expect(closeOrder).toBeDefined();
    expect(detachOrder!).toBeLessThan(closeOrder);
  });

  it("dispose() removes listeners from every registered view", async () => {
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await manager.switchTo("proj-c", "/path/c");
    await flushImmediates();

    const wcB = manager.getAllViews().find((v) => v.projectId === "proj-b")!.view
      .webContents as unknown as ReturnType<typeof createMockWebContents>;
    const wcC = manager.getAllViews().find((v) => v.projectId === "proj-c")!.view
      .webContents as unknown as ReturnType<typeof createMockWebContents>;

    manager.dispose();

    // Cold-started views go through setupViewHandlers and should have all 6 listeners removed.
    for (const event of PERSISTENT_EVENTS) {
      expect(wcB.removeListener).toHaveBeenCalledWith(event, expect.any(Function));
      expect(wcC.removeListener).toHaveBeenCalledWith(event, expect.any(Function));
    }
    expect(detachRendererConsoleCapture).toHaveBeenCalledWith(wcB);
    expect(detachRendererConsoleCapture).toHaveBeenCalledWith(wcC);
  });
});

describe("ProjectViewManager — low-memory eviction", () => {
  let manager: ProjectViewManager;
  let win: ReturnType<typeof createMockWindow>;

  // The periodic sampler is the only path that contracts the cache on a memory
  // reading — switch/LRU/limit-change passes no longer inherit pressure
  // (#11477), so these tests drive it explicitly.
  const tickPressureCheck = (mgr: ProjectViewManager) =>
    (mgr as unknown as { maybeEvictUnderPressure(): void }).maybeEvictUnderPressure();

  // Helper for mocking process.getSystemMemoryInfo. Chromium-extended API not in
  // the default Node typings, so spy via a cast and restore in afterEach.
  type MemInfo = { free: number; purgeable?: number; fileBacked?: number; total: number };
  function stubSystemMemoryInfo(info: MemInfo | (() => MemInfo) | "throw" | "missing") {
    const proc = process as unknown as { getSystemMemoryInfo?: () => MemInfo };
    if (info === "missing") {
      Object.defineProperty(proc, "getSystemMemoryInfo", {
        configurable: true,
        value: undefined,
      });
      return;
    }
    const fn =
      info === "throw"
        ? () => {
            throw new Error("boom");
          }
        : typeof info === "function"
          ? info
          : () => info;
    Object.defineProperty(proc, "getSystemMemoryInfo", {
      configurable: true,
      value: fn,
    });
  }

  const originalSystemMemoryInfo = (process as unknown as { getSystemMemoryInfo?: () => MemInfo })
    .getSystemMemoryInfo;

  beforeEach(() => {
    nextWebContentsId = 100;
    nextOsProcessId = 1000;
    vi.clearAllMocks();
    mockGetAllTerminals.mockReset();
    mockGetAllTerminals.mockResolvedValue([]);
    mockGetAppMetrics.mockReset();
    mockGetAppMetrics.mockReturnValue([]);
    assistantBackends.clear();
    liveTerminals.clear();
    liveRemoteViews.clear();
    activeRemoteViews.clear();
    win = createMockWindow();
    manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
      assistantBackendsForProject,
      isTerminalLive,
    });
  });

  afterEach(() => {
    // Stops this manager's randomly-phased sampler from ticking into a later
    // test's memory stub and the shared logInfo mock.
    manager.dispose();
    Object.defineProperty(process, "getSystemMemoryInfo", {
      configurable: true,
      value: originalSystemMemoryInfo,
    });
  });

  it("explicit pressure reclaim clamps to the active view without waiting for the sampler", async () => {
    stubSystemMemoryInfo({ free: 2 * 1024 * 1024, purgeable: 0, total: 8 * 1024 * 1024 });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");
    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await manager.switchTo("proj-c", "/path/c");
    await flushImmediates();

    const evicted = manager.reclaimCachedViewsUnderPressure();

    expect(manager.getAllViews().map((view) => view.projectId)).toEqual(["proj-c"]);
    expect(wcA.close).toHaveBeenCalled();
    // The count is what makes a zero reclaim delta attributable upstream
    // (#11211) — proj-a and proj-b both went.
    expect(evicted).toBe(2);
  });

  it("pressure reclaim reports zero when only the active view is cached", async () => {
    // Nothing is eligible, so the memory-pressure ladder must be able to tell
    // "nothing to evict" apart from "evicted, but the metric saw no drop".
    stubSystemMemoryInfo({ free: 2 * 1024 * 1024, purgeable: 0, total: 8 * 1024 * 1024 });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");
    await flushImmediates();

    expect(manager.reclaimCachedViewsUnderPressure()).toBe(0);
    expect(wcA.close).not.toHaveBeenCalled();
  });

  it("periodic pressure check evicts cached views while idle — no project switch needed", async () => {
    // Healthy at switch time so the switch-driven eviction pass does nothing.
    let freeKb = 2 * 1024 * 1024;
    stubSystemMemoryInfo(() => ({ free: freeKb, purgeable: 0, total: 8 * 1024 * 1024 }));
    manager.setLowMemoryFreeThresholdMb(768);

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await manager.switchTo("proj-c", "/path/c");
    await flushImmediates();
    expect(manager.getAllViews().length).toBe(3);

    // Free RAM drifts below the floor while the session idles. The sampler
    // tick's pressure check must reclaim without waiting for a switch — one
    // view per tick, converging on the active view (#11477).
    freeKb = 128 * 1024;
    armPressureLadder(manager);
    tickPressureCheck(manager);
    expect(manager.getAllViews().map((v) => v.projectId)).toEqual(["proj-b", "proj-c"]);
    expect(wcA.close).toHaveBeenCalled();

    tickPressureCheck(manager);
    expect(manager.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
  });

  it("periodic pressure check is a no-op above the floor or with a null threshold", async () => {
    stubSystemMemoryInfo({ free: 128 * 1024, purgeable: 0, total: 8 * 1024 * 1024 });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");
    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();

    // Aged, and ticked past confirmation, so neither case can pass merely
    // because a single sample never evicts (#12363).
    ageViewsPastPressureFloor(manager);

    // Null threshold (performance profile): pressure check must not run.
    for (let tick = 0; tick < 3; tick++) tickPressureCheck(manager);
    expect(manager.getAllViews().length).toBe(2);

    // Threshold set but memory healthy: still a no-op.
    stubSystemMemoryInfo({ free: 2 * 1024 * 1024, purgeable: 0, total: 8 * 1024 * 1024 });
    manager.setLowMemoryFreeThresholdMb(768);
    for (let tick = 0; tick < 3; tick++) tickPressureCheck(manager);
    expect(manager.getAllViews().length).toBe(2);
    expect(wcA.close).not.toHaveBeenCalled();
  });

  it("uses free + purgeable on macOS so healthy systems do not trigger override", async () => {
    // Mimics a healthy mac: only ~50 MB literal "free" but 2 GB held as purgeable.
    // Without the purgeable adjustment, this would falsely trip every project switch.
    stubSystemMemoryInfo({
      free: 50 * 1024,
      purgeable: 2 * 1024 * 1024,
      total: 8 * 1024 * 1024,
    });
    manager.setLowMemoryFreeThresholdMb(768);

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await manager.switchTo("proj-c", "/path/c");
    await flushImmediates();

    // 50 + 2*1024*1024 KB ≈ 2050 MB > 768 → no override, however long it holds.
    ageViewsPastPressureFloor(manager);
    for (let tick = 0; tick < 3; tick++) tickPressureCheck(manager);
    expect(manager.getAllViews().length).toBe(3);
    expect(wcA.close).not.toHaveBeenCalled();
  });

  it("counts the file cache as available on macOS, so a warm-cache Mac keeps its views (#12363)", async () => {
    // The issue's 64 GB machine and band: ~600 MB free and ~1 GB purgeable
    // beside ~24 GB of file cache. Free + purgeable alone reads inside the band.
    let fileBackedKb = 24 * 1024 * 1024;
    stubSystemMemoryInfo(() => ({
      free: 600 * 1024,
      purgeable: 1024 * 1024,
      fileBacked: fileBackedKb,
      total: 64 * 1024 * 1024,
    }));
    manager.setMemoryPressurePolicy({ criticalMb: 1024, warningMb: 3072 });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");
    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await manager.switchTo("proj-c", "/path/c");
    await flushImmediates();
    ageViewsPastPressureFloor(manager);

    for (let tick = 0; tick < 3; tick++) tickPressureCheck(manager);
    expect(manager.getAllViews().length).toBe(3);

    // The same machine with its cache spent is genuinely short, and the ladder
    // still answers — the fix moved the measurement, not the band. Spent, not
    // zero: a reported zero is an unreadable reading, never a low one (#12517).
    fileBackedKb = 64 * 1024;
    tickPressureCheck(manager);
    tickPressureCheck(manager);
    expect(manager.getAllViews().length).toBe(2);
    expect(wcA.close).toHaveBeenCalled();
  });

  it("logs reason 'pressure' with memoryAvailableMb when override is active", async () => {
    stubSystemMemoryInfo({ free: 256 * 1024, purgeable: 0, total: 8 * 1024 * 1024 });
    manager.setLowMemoryFreeThresholdMb(768);

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await manager.switchTo("proj-c", "/path/c");
    await flushImmediates();
    armPressureLadder(manager);
    tickPressureCheck(manager);

    expect(vi.mocked(logInfo)).toHaveBeenCalledWith(
      "projectview.pressure-override",
      expect.objectContaining({
        availableMb: 256,
        thresholdMb: 768,
        configuredMax: 3,
        effectiveMax: 1,
        // The sampled band and the pass's aggressiveness are now reported
        // separately: a sampler tick reads "critical" but never forces.
        pressureLevel: "critical",
        forced: false,
      })
    );
    expect(vi.mocked(logInfo)).toHaveBeenCalledWith(
      "projectview.eviction",
      expect.objectContaining({
        projectId: "proj-a",
        reason: "pressure",
        memoryAvailableMb: 256,
      })
    );
  });

  it("performs normal LRU eviction when API is missing but cache is over the user cap", async () => {
    stubSystemMemoryInfo("missing");
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 2,
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
    });
    managerWithLimit.setLowMemoryFreeThresholdMb(768);

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    await managerWithLimit.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await managerWithLimit.switchTo("proj-c", "/path/c");
    await flushImmediates();

    // 3 views, cap 2, API missing → normal LRU evicts proj-a with reason "lru".
    expect(managerWithLimit.getAllViews().length).toBe(2);
    expect(wcA.close).toHaveBeenCalled();
    expect(vi.mocked(logInfo)).toHaveBeenCalledWith(
      "projectview.eviction",
      expect.objectContaining({ projectId: "proj-a", reason: "lru" })
    );
    managerWithLimit.dispose();
  });

  it("falls back to normal LRU behavior when getSystemMemoryInfo throws", async () => {
    stubSystemMemoryInfo("throw");
    manager.setLowMemoryFreeThresholdMb(768);

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await manager.switchTo("proj-c", "/path/c");
    await flushImmediates();

    expect(manager.getAllViews().length).toBe(3);
    expect(wcA.close).not.toHaveBeenCalled();
  });

  it("treats availableMb just below threshold as under pressure", async () => {
    // 767.x MB available — barely below the 768 threshold → override active.
    // 786431 KB / 1024 = 767.999 MB, which is < 768.
    stubSystemMemoryInfo({ free: 786_431, purgeable: 0, total: 8 * 1024 * 1024 });
    manager.setLowMemoryFreeThresholdMb(768);

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await manager.switchTo("proj-c", "/path/c");
    await flushImmediates();

    // The reading is what's under test, so drive the sampler — the switches
    // above no longer inherit pressure themselves (#11477).
    armPressureLadder(manager);
    tickPressureCheck(manager);
    expect(manager.getAllViews().length).toBe(2);
    expect(wcA.close).toHaveBeenCalled();
  });

  it("never evicts the active view under pressure", async () => {
    stubSystemMemoryInfo({ free: 64 * 1024, purgeable: 0, total: 8 * 1024 * 1024 });
    manager.setLowMemoryFreeThresholdMb(768);

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await manager.switchTo("proj-c", "/path/c");
    await flushImmediates();

    // Driven to its settled target one view per tick, and then some — however
    // long pressure lasts, the active view is never a candidate.
    armPressureLadder(manager);
    tickPressureCheck(manager);
    tickPressureCheck(manager);
    tickPressureCheck(manager);

    const remaining = manager.getAllViews().map((v) => v.projectId);
    expect(remaining).toEqual(["proj-c"]);
    expect(manager.getActiveProjectId()).toBe("proj-c");
  });

  it("invokes onViewEvicted for every view evicted under pressure", async () => {
    const onViewEvicted = vi.fn<(id: number) => void>();
    const pressureManager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 4,
      onViewEvicted,
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
    });
    stubSystemMemoryInfo({ free: 64 * 1024, purgeable: 0, total: 8 * 1024 * 1024 });
    pressureManager.setLowMemoryFreeThresholdMb(768);

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    pressureManager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await pressureManager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await pressureManager.switchTo("proj-c", "/path/c");
    await flushImmediates();
    await pressureManager.switchTo("proj-d", "/path/d");
    await flushImmediates();

    // 4 views, override targets 1 → 3 evictions, callback fires for each. One
    // per sampler tick since #11477, so drive it to the settled target.
    armPressureLadder(pressureManager);
    tickPressureCheck(pressureManager);
    tickPressureCheck(pressureManager);
    tickPressureCheck(pressureManager);
    expect(pressureManager.getAllViews().length).toBe(1);
    expect(onViewEvicted).toHaveBeenCalledTimes(3);
    pressureManager.dispose();
  });
});

describe("ProjectViewManager — graduated memory reclaim (#11469)", () => {
  let manager: ProjectViewManager;
  let win: ReturnType<typeof createMockWindow>;

  type MemInfo = { free: number; purgeable?: number; total: number };
  const originalSystemMemoryInfo = (process as unknown as { getSystemMemoryInfo?: () => MemInfo })
    .getSystemMemoryInfo;

  /** `availableMb` is reported straight through as free memory (KB on the wire). */
  function setAvailableMb(availableMb: number) {
    Object.defineProperty(process, "getSystemMemoryInfo", {
      configurable: true,
      value: () => ({ free: availableMb * 1024, purgeable: 0, total: 8 * 1024 * 1024 }),
    });
  }

  // 3 cached views over a 1000MB-wide band: one step per 500MB, so 1500MB
  // targets 2 views and 1200MB targets 1 — reached one view per pass.
  const BAND = { criticalMb: 1000, warningMb: 2000 };

  const evictedProjectIds = () =>
    vi
      .mocked(logInfo)
      .mock.calls.filter(([event]) => event === "projectview.eviction")
      .map(([, ctx]) => (ctx as { projectId: string }).projectId);

  const tickPressureCheck = (mgr: ProjectViewManager) =>
    (mgr as unknown as { maybeEvictUnderPressure(): void }).maybeEvictUnderPressure();

  /** Every manager built here, so the randomly-phased sampler each one starts is torn down. */
  const managers: ProjectViewManager[] = [];

  function makeManager(cachedProjectViews: number) {
    const mgr = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews,
      assistantBackendsForProject,
      isTerminalLive,
    });
    managers.push(mgr);
    return mgr;
  }

  /** Three views (proj-a, proj-b oldest-first; proj-c active). */
  async function seedThreeViews(mgr: ProjectViewManager) {
    const wcA = createMockWebContents();
    mgr.registerInitialView({ webContents: wcA, setBounds: vi.fn() } as never, "proj-a", "/path/a");
    await mgr.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await mgr.switchTo("proj-c", "/path/c");
    await flushImmediates();
  }

  beforeEach(() => {
    nextWebContentsId = 100;
    nextOsProcessId = 1000;
    vi.clearAllMocks();
    mockGetAllTerminals.mockReset();
    mockGetAllTerminals.mockResolvedValue([]);
    mockGetAppMetrics.mockReset();
    mockGetAppMetrics.mockReturnValue([]);
    assistantBackends.clear();
    liveTerminals.clear();
    win = createMockWindow();
    manager = makeManager(3);
    manager.setMemoryPressurePolicy(BAND);
  });

  afterEach(() => {
    for (const mgr of managers.splice(0)) mgr.dispose();
    Object.defineProperty(process, "getSystemMemoryInfo", {
      configurable: true,
      value: originalSystemMemoryInfo,
    });
  });

  it("sheds exactly one view per soft-band pass, converging over several ticks", async () => {
    setAvailableMb(2500);
    await seedThreeViews(manager);
    expect(manager.getAllViews().length).toBe(3);

    // Deep in the soft band the settled target is 1, but a single pass must
    // still take only one view — this is the whole point of #11469. Once
    // confirmed the streak holds, so it is one per tick rather than one per
    // confirmation (#12363).
    setAvailableMb(1200);
    armPressureLadder(manager);
    tickPressureCheck(manager);
    expect(manager.getAllViews().map((v) => v.projectId)).toEqual(["proj-b", "proj-c"]);

    tickPressureCheck(manager);
    expect(manager.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);

    // Converged — further ticks have nothing left to take.
    tickPressureCheck(manager);
    expect(manager.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
  });

  it("stops stepping once available memory recovers into a higher band", async () => {
    setAvailableMb(2500);
    await seedThreeViews(manager);

    setAvailableMb(1200);
    armPressureLadder(manager);
    tickPressureCheck(manager);
    expect(manager.getAllViews().length).toBe(2);

    // The freed renderer returned its memory: the next tick sees a target of 2
    // and takes nothing, instead of marching on to 1.
    setAvailableMb(1600);
    tickPressureCheck(manager);
    expect(manager.getAllViews().length).toBe(2);
  });

  it("walks to the active view below the critical edge, but only the forced pass gets there in one (#11477)", async () => {
    setAvailableMb(2500);
    await seedThreeViews(manager);

    // A critical reading targets the active view alone — but the sampler is
    // per-window and holds no cooldown, so it walks there a view at a time
    // rather than pre-empting ProcessMemoryMonitor's cooldown-gated ladder in
    // one pass.
    setAvailableMb(BAND.criticalMb - 1);
    armPressureLadder(manager);
    tickPressureCheck(manager);
    expect(manager.getAllViews().map((v) => v.projectId)).toEqual(["proj-b", "proj-c"]);
    tickPressureCheck(manager);
    expect(manager.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
    expect(evictedProjectIds()).toEqual(["proj-a", "proj-b"]);
  });

  it("does not shed extra views on the switch path under soft pressure", async () => {
    // Only the periodic sweep contracts the cache, so the 30s sampler cadence
    // is the settling interval. A switch enforces the configured cap and no more.
    setAvailableMb(1200);
    await seedThreeViews(manager);

    expect(manager.getAllViews().length).toBe(3);
    expect(evictedProjectIds()).toEqual([]);
  });

  it("cascades a limit change straight to its new cap under soft pressure", async () => {
    // Four views down to one, so the pass must destroy THREE. A one-view budget
    // leaking onto the "limit-change" path would leave three views standing.
    const mgr = makeManager(4);
    mgr.setMemoryPressurePolicy(BAND);
    setAvailableMb(2500);

    const wcA = createMockWebContents();
    mgr.registerInitialView({ webContents: wcA, setBounds: vi.fn() } as never, "proj-a", "/path/a");
    for (const id of ["proj-b", "proj-c", "proj-d"]) {
      await mgr.switchTo(id, `/path/${id}`);
      await flushImmediates();
    }
    expect(mgr.getAllViews().length).toBe(4);

    setAvailableMb(1200);
    mgr.setCachedViewLimit(1);

    expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-d"]);
  });

  it("does not report an assistant-blocked skip while the budget is the limiter", async () => {
    // A soft pass that merely spent its one-view budget still has ordinary
    // candidates queued — reporting that as assistant-blocked would misattribute
    // the overflow in the memory logs.
    const mgr = makeManager(4);
    mgr.setMemoryPressurePolicy(BAND);
    setAvailableMb(2500);

    const wcA = createMockWebContents();
    mgr.registerInitialView({ webContents: wcA, setBounds: vi.fn() } as never, "proj-a", "/path/a");
    for (const id of ["proj-b", "proj-c", "proj-d"]) {
      await mgr.switchTo(id, `/path/${id}`);
      await flushImmediates();
    }

    // proj-a is protected; proj-b and proj-c remain ordinary candidates.
    const wcAssistant = mgr.getAllViews().find((v) => v.projectId === "proj-a")!.view.webContents;
    assistantBackends.set("proj-a", { terminalId: "t-help-a", webContentsId: wcAssistant.id });
    liveTerminals.add("t-help-a");

    setAvailableMb(1200);
    armPressureLadder(mgr);
    tickPressureCheck(mgr);

    expect(mgr.getAllViews().length).toBe(3);
    expect(vi.mocked(logInfo)).not.toHaveBeenCalledWith(
      "projectview.eviction-skipped",
      expect.anything()
    );
  });

  it("reports an assistant-pinned overflow once per episode, not on every tick (#12517)", async () => {
    setAvailableMb(2500);
    await seedThreeViews(manager);
    // Both cached views back a live assistant, so no pressure pass may take either.
    for (const [projectId, terminalId] of [
      ["proj-a", "t-help-a"],
      ["proj-b", "t-help-b"],
    ] as const) {
      const wc = manager.getAllViews().find((v) => v.projectId === projectId)!.view.webContents;
      assistantBackends.set(projectId, { terminalId, webContentsId: wc.id });
      liveTerminals.add(terminalId);
    }
    const logged = (event: string) =>
      vi
        .mocked(logInfo)
        .mock.calls.filter(([name]) => name === event)
        .map(([, ctx]) => ctx as Record<string, unknown>);

    setAvailableMb(1200);
    armPressureLadder(manager);
    // The reading moves every tick, as a real one does, without leaving the band.
    for (const availableMb of [1200, 1350, 1100, 1400, 1250]) {
      setAvailableMb(availableMb);
      tickPressureCheck(manager);
    }

    // Five confirmed passes that can take nothing: one override, reported after
    // the pass found that out, and one account of what is holding the cache.
    expect(manager.getAllViews().length).toBe(3);
    expect(logged("projectview.pressure-override")).toEqual([
      expect.objectContaining({ pressureLevel: "soft", evictedCount: 0 }),
    ]);
    expect(logged("projectview.eviction-skipped")).toEqual([
      expect.objectContaining({ viewCount: 3, protectedProjectIds: ["proj-a", "proj-b"] }),
    ]);

    // proj-b's assistant exits, so the next pass takes its view and says so;
    // what still holds the cache over has changed too.
    liveTerminals.delete("t-help-b");
    tickPressureCheck(manager);
    tickPressureCheck(manager);
    expect(evictedProjectIds()).toEqual(["proj-b"]);
    expect(logged("projectview.pressure-override").map((ctx) => ctx.evictedCount)).toEqual([0, 1]);
    expect(logged("projectview.eviction-skipped").map((ctx) => ctx.protectedProjectIds)).toEqual([
      ["proj-a", "proj-b"],
      ["proj-a"],
    ]);

    // Memory recovers and then runs short again: a new episode, reported afresh.
    setAvailableMb(2500);
    tickPressureCheck(manager);
    setAvailableMb(1200);
    tickPressureCheck(manager);
    tickPressureCheck(manager);
    expect(logged("projectview.pressure-override")).toHaveLength(3);
    expect(logged("projectview.eviction-skipped")).toHaveLength(3);

    // A forced tier-2 reclaim is a different override from the gradual one, so
    // it reports even though it cannot take proj-a either — once.
    manager.reclaimCachedViewsUnderPressure();
    manager.reclaimCachedViewsUnderPressure();
    expect(logged("projectview.pressure-override").at(-1)).toMatchObject({
      forced: true,
      evictedCount: 0,
    });
    expect(logged("projectview.pressure-override")).toHaveLength(4);
    expect(logged("projectview.eviction-skipped")).toHaveLength(4);
    expect(logged("projectview.eviction-skipped").at(-1)).toMatchObject({ forced: true });
  });

  it("takes only one view per pass even when the cache sits above its cap", async () => {
    // A cache above its cap is reachable in production (assistant protection, or
    // a paint-gate exclusion deferring an earlier pass). Deriving the per-pass
    // budget from the cap rather than counting evictions would let a single soft
    // tick destroy three renderers here instead of one.
    const mgr = makeManager(4);
    mgr.setMemoryPressurePolicy(BAND);
    setAvailableMb(2500);

    const wcA = createMockWebContents();
    mgr.registerInitialView({ webContents: wcA, setBounds: vi.fn() } as never, "proj-a", "/path/a");
    for (const id of ["proj-b", "proj-c", "proj-d"]) {
      await mgr.switchTo(id, `/path/${id}`);
      await flushImmediates();
    }
    expect(mgr.getAllViews().length).toBe(4);

    // Drop the cap without going through setCachedViewLimit, whose own
    // "limit-change" pass would trim to the new cap immediately.
    (mgr as unknown as { maxCachedViews: number }).maxCachedViews = 2;

    setAvailableMb(1200);
    armPressureLadder(mgr);
    tickPressureCheck(mgr);

    expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-b", "proj-c", "proj-d"]);
  });

  it("never takes an assistant-backed view, at any band or on the forced pass (#11477)", async () => {
    // Trimming must not cost a running assistant its PTY tree (#11157). The
    // floor used to yield at the critical edge on the theory that it beat an
    // OOM; #11477 established there was no such trade, so nothing admits them.
    const mgr = makeManager(3);
    mgr.setMemoryPressurePolicy(BAND);
    setAvailableMb(2500);
    await seedThreeViews(mgr);

    for (const projectId of ["proj-a", "proj-b"]) {
      const wc = mgr.getAllViews().find((v) => v.projectId === projectId)!.view.webContents;
      assistantBackends.set(projectId, { terminalId: `t-help-${projectId}`, webContentsId: wc.id });
      liveTerminals.add(`t-help-${projectId}`);
    }

    setAvailableMb(1200);
    armPressureLadder(mgr);
    tickPressureCheck(mgr);

    expect(mgr.getAllViews().length).toBe(3);
    expect(evictedProjectIds()).toEqual([]);

    // Critical band: still nothing to take but the protected views.
    setAvailableMb(BAND.criticalMb - 1);
    tickPressureCheck(mgr);
    expect(mgr.getAllViews().length).toBe(3);

    // And the forced tier-2 reclaim — the last rung — leaves them too.
    expect(mgr.reclaimCachedViewsUnderPressure()).toBe(0);
    expect(mgr.getAllViews().length).toBe(3);
    expect(evictedProjectIds()).toEqual([]);
  });

  it("arms the periodic sweep at the warning edge, not the critical one", async () => {
    // Gating the sweep on criticalMb would leave the whole soft band unreachable.
    setAvailableMb(2500);
    await seedThreeViews(manager);

    ageViewsPastPressureFloor(manager);
    setAvailableMb(BAND.warningMb);
    tickPressureCheck(manager);
    tickPressureCheck(manager);
    expect(manager.getAllViews().length).toBe(3);

    setAvailableMb(BAND.warningMb - 1);
    armPressureLadder(manager);
    tickPressureCheck(manager);
    expect(manager.getAllViews().length).toBe(2);
  });

  it("reports the band, tier and budget on the pressure-override event", async () => {
    setAvailableMb(2500);
    await seedThreeViews(manager);

    setAvailableMb(1200);
    armPressureLadder(manager);
    tickPressureCheck(manager);

    expect(vi.mocked(logInfo)).toHaveBeenCalledWith(
      "projectview.pressure-override",
      expect.objectContaining({
        thresholdMb: BAND.criticalMb,
        warningThresholdMb: BAND.warningMb,
        pressureLevel: "soft",
        evictionBudget: 1,
      })
    );
  });

  it("collapses the band to a cliff for the legacy single-floor setter", async () => {
    // The E2E escape hatch and every pre-#11469 caller pass one number; that
    // must keep meaning "target 1 below this", with no soft band. Since #11477
    // the sampler walks to that target one view per tick rather than clearing
    // the cache in a single pass — the target is unchanged, the rate is not.
    manager.setLowMemoryFreeThresholdMb(1500);
    setAvailableMb(2500);
    await seedThreeViews(manager);

    setAvailableMb(1600);
    tickPressureCheck(manager);
    expect(manager.getAllViews().length).toBe(3);

    setAvailableMb(1499);
    armPressureLadder(manager);
    tickPressureCheck(manager);
    expect(manager.getAllViews().map((v) => v.projectId)).toEqual(["proj-b", "proj-c"]);

    tickPressureCheck(manager);
    expect(manager.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
  });

  it("never collapses the cache in one sampler tick, however low memory reads (#11477)", async () => {
    // The regression this issue reports. The per-window sampler fires off an
    // instantaneous reading with no consecutive-poll count, no cooldown, and no
    // view of whether ProcessMemoryMonitor is already mitigating — so it beat an
    // in-flight tier-1 pass by 560ms and destroyed views that pass made
    // unnecessary 2.4s later. One view per tick is the settling interval: the
    // next tick re-reads a genuinely changed availability figure.
    manager.setMemoryPressurePolicy({ criticalMb: 500, warningMb: 2000 });
    setAvailableMb(2500);
    await seedThreeViews(manager);

    // Far below the critical edge — the old code took everything here.
    setAvailableMb(1);
    armPressureLadder(manager);
    tickPressureCheck(manager);
    expect(manager.getAllViews().length).toBe(2);

    // And the pressure clearing between ticks stops the walk where it stands,
    // which is the whole point of making the sampler re-read.
    setAvailableMb(2500);
    tickPressureCheck(manager);
    expect(manager.getAllViews().length).toBe(2);
  });

  it("does not let an LRU or limit-change pass inherit critical pressure (#11477)", async () => {
    // `evictStaleViews` used to compute `criticalPressure` from live memory on
    // EVERY path, so an ordinary project switch or a setCachedViewLimit call
    // landing below the critical edge collapsed the whole cache as a side
    // effect. Critical escalation belongs to the forced tier-2 caller alone.
    manager.setMemoryPressurePolicy({ criticalMb: 500, warningMb: 2000 });
    setAvailableMb(2500);
    await seedThreeViews(manager);

    setAvailableMb(1);
    // A switch to a 4th project: the LRU pass runs at the user's cap of 3.
    await manager.switchTo("proj-d", "/path/d");
    await flushImmediates();
    expect(manager.getAllViews().length).toBe(3);

    // Re-asserting the same cap must not shed anything either.
    manager.setCachedViewLimit(3);
    expect(manager.getAllViews().length).toBe(3);
  });

  it("disables reclaim entirely when the policy is cleared", async () => {
    manager.setMemoryPressurePolicy(null);
    setAvailableMb(50);
    await seedThreeViews(manager);
    ageViewsPastPressureFloor(manager);

    // However long the pressure lasts: a null policy is the E2E escape hatch.
    for (let tick = 0; tick < 3; tick++) tickPressureCheck(manager);
    expect(manager.getAllViews().length).toBe(3);
    expect(manager.getLowMemoryFreeThresholdMb()).toBeNull();
  });

  it.each([
    ["inverted edges", { criticalMb: 2000, warningMb: 1000 }],
    ["non-finite critical", { criticalMb: Number.NaN, warningMb: 2000 }],
    ["non-finite warning", { criticalMb: 1000, warningMb: Number.POSITIVE_INFINITY }],
    ["non-positive critical", { criticalMb: 0, warningMb: 2000 }],
  ])("rejects a %s band rather than half-arming it", (_label, policy) => {
    // Re-armed per case so a rejection can't be mistaken for the previous
    // case's leftover null.
    manager.setMemoryPressurePolicy(BAND);
    expect(manager.getLowMemoryFreeThresholdMb()).toBe(BAND.criticalMb);

    manager.setMemoryPressurePolicy(policy);
    expect(manager.getLowMemoryFreeThresholdMb()).toBeNull();
  });

  it("keeps the forced tier-2 reclaim aggressive under an armed soft band", async () => {
    // The soft one-view budget must not reach the forced path: tier-2 is the
    // OOM escape hatch and has to take everything in one call.
    setAvailableMb(1200);
    await seedThreeViews(manager);
    expect(manager.getAllViews().length).toBe(3);

    expect(manager.reclaimCachedViewsUnderPressure()).toBe(2);
    expect(manager.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
  });

  describe("sustained pressure and the minimum age (#12363)", () => {
    const viewOf = (projectId: string) => manager.views.get(projectId)!;

    const deferredLogs = () =>
      vi
        .mocked(logInfo)
        .mock.calls.filter(([event]) => event === "projectview.eviction-deferred")
        .map(([, ctx]) => ctx as Record<string, unknown>);

    it("destroys nothing on one low reading, however low — it has to hold to the next tick", async () => {
      setAvailableMb(2500);
      await seedThreeViews(manager);
      ageViewsPastPressureFloor(manager);

      setAvailableMb(1);
      tickPressureCheck(manager);
      expect(manager.getAllViews().length).toBe(3);
      expect(evictedProjectIds()).toEqual([]);

      tickPressureCheck(manager);
      expect(evictedProjectIds()).toEqual(["proj-a"]);
    });

    it("starts the count over on a reading at the edge, or one it cannot read", async () => {
      setAvailableMb(2500);
      await seedThreeViews(manager);
      ageViewsPastPressureFloor(manager);

      // Low, then exactly at the edge: the next low reading is a first again.
      setAvailableMb(1200);
      tickPressureCheck(manager);
      setAvailableMb(BAND.warningMb);
      tickPressureCheck(manager);
      setAvailableMb(1200);
      tickPressureCheck(manager);
      expect(manager.getAllViews().length).toBe(3);

      // Low, then unreadable — which is no evidence the pressure persisted.
      Object.defineProperty(process, "getSystemMemoryInfo", {
        configurable: true,
        value: undefined,
      });
      tickPressureCheck(manager);
      setAvailableMb(1200);
      tickPressureCheck(manager);
      expect(manager.getAllViews().length).toBe(3);

      tickPressureCheck(manager);
      expect(manager.getAllViews().length).toBe(2);

      // And from confirmed pressure, not only a pending count: recovery wipes
      // the streak, so the next dip needs two readings of its own.
      setAvailableMb(BAND.warningMb);
      tickPressureCheck(manager);
      setAvailableMb(1200);
      tickPressureCheck(manager);
      expect(manager.getAllViews().length).toBe(2);
      tickPressureCheck(manager);
      expect(manager.getAllViews().length).toBe(1);
    });

    it("needs fresh confirmation once the cache has held only the active view", async () => {
      // With nothing cached to take, a tick has no reading to count, so it
      // cannot carry an old confirmation over to a view cached afterwards.
      setAvailableMb(2500);
      await seedThreeViews(manager);
      setAvailableMb(1200);
      armPressureLadder(manager);
      tickPressureCheck(manager);
      tickPressureCheck(manager);
      expect(manager.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
      tickPressureCheck(manager);
      // Checked here, before any await: a live sampler tick during the switch
      // below would reset the count too, and hide a tick that failed to.
      expect(manager.pressureSampleStreak).toBe(0);

      // Healthy while switching, so a live sampler tick can only reset the count.
      // Sampled explicitly: the two flat-band evictions above latched the soft
      // backoff (#12885), and only a recovered reading releases it.
      setAvailableMb(2500);
      tickPressureCheck(manager);
      expect(manager.softPressureBackoffLatched).toBe(false);
      await manager.switchTo("proj-d", "/path/d");
      await flushImmediates();
      ageViewsPastPressureFloor(manager);

      setAvailableMb(1200);
      tickPressureCheck(manager);
      expect(manager.getAllViews().length).toBe(2);
      tickPressureCheck(manager);
      expect(manager.getAllViews().map((v) => v.projectId)).toEqual(["proj-d"]);
    });

    it("starts the count over when either setter re-arms the band", async () => {
      setAvailableMb(2500);
      await seedThreeViews(manager);
      ageViewsPastPressureFloor(manager);
      setAvailableMb(1200);

      tickPressureCheck(manager);
      manager.setMemoryPressurePolicy(BAND);
      tickPressureCheck(manager);
      expect(manager.getAllViews().length).toBe(3);

      manager.setLowMemoryFreeThresholdMb(BAND.warningMb);
      tickPressureCheck(manager);
      expect(manager.getAllViews().length).toBe(3);

      tickPressureCheck(manager);
      expect(manager.getAllViews().length).toBe(2);
    });

    it("will not take a view the user left inside the soft-band grace, and takes it once it has aged", async () => {
      setAvailableMb(2500);
      await seedThreeViews(manager);
      // proj-a went cold long ago; proj-b was left moments before pressure hit.
      viewOf("proj-a").lastUsed -= MIN_PRESSURE_EVICTION_AGE_MS;

      setAvailableMb(1200);
      tickPressureCheck(manager);
      tickPressureCheck(manager);
      expect(evictedProjectIds()).toEqual(["proj-a"]);

      tickPressureCheck(manager);
      expect(manager.getAllViews().map((v) => v.projectId)).toEqual(["proj-b", "proj-c"]);
      const deferred = deferredLogs();
      expect(deferred.map((ctx) => ctx.projectId)).toEqual(["proj-b"]);
      expect(deferred[0].ageMs as number).toBeLessThan(MIN_PRESSURE_EVICTION_AGE_MS);
      // Held back by age, not by protection — reporting it as the latter would
      // misattribute the over-target cache.
      expect(vi.mocked(logInfo)).not.toHaveBeenCalledWith(
        "projectview.eviction-skipped",
        expect.anything()
      );

      // The boundary, on a pinned clock: a millisecond short still defers, and
      // exactly the grace unused is old enough.
      const leftAt = viewOf("proj-b").lastUsed;
      const clock = vi.spyOn(Date, "now");
      try {
        clock.mockReturnValue(leftAt + MIN_PRESSURE_EVICTION_AGE_MS - 1);
        tickPressureCheck(manager);
        expect(manager.getAllViews().length).toBe(2);
        expect(deferredLogs().at(-1)).toEqual({
          projectId: "proj-b",
          reason: "pressure",
          ageMs: MIN_PRESSURE_EVICTION_AGE_MS - 1,
          minimumAgeMs: MIN_PRESSURE_EVICTION_AGE_MS,
        });

        clock.mockReturnValue(leftAt + MIN_PRESSURE_EVICTION_AGE_MS);
        tickPressureCheck(manager);
        expect(manager.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
      } finally {
        clock.mockRestore();
      }
    });

    it("spares the view the user just left while pressure stays confirmed", async () => {
      // The issue's symptom end to end: a real switch stamps the outgoing view,
      // and a confirmed ladder must not take it on the very next tick.
      setAvailableMb(2500);
      await seedThreeViews(manager);
      setAvailableMb(1200);
      armPressureLadder(manager);
      tickPressureCheck(manager);
      expect(evictedProjectIds()).toEqual(["proj-a"]);

      await manager.switchTo("proj-b", "/path/b");
      await flushImmediates();
      tickPressureCheck(manager);

      expect(
        manager
          .getAllViews()
          .map((v) => v.projectId)
          .sort()
      ).toEqual(["proj-b", "proj-c"]);
      expect(evictedProjectIds()).toEqual(["proj-a"]);
      expect(deferredLogs().at(-1)).toMatchObject({ projectId: "proj-c", reason: "pressure" });
    });

    it("acts on the reading that confirmed the pass, not a second read that crossed back", async () => {
      // Over its cap, a pass that re-read memory and landed above the edge would
      // stop being gradual: an unbudgeted trim to the cap that skips the minimum
      // age. The confirming reading is the one the pass has to act on.
      const mgr = makeManager(4);
      mgr.setMemoryPressurePolicy(BAND);
      setAvailableMb(2500);
      const wcA = createMockWebContents();
      mgr.registerInitialView(
        { webContents: wcA, setBounds: vi.fn() } as never,
        "proj-a",
        "/path/a"
      );
      for (const id of ["proj-b", "proj-c", "proj-d"]) {
        await mgr.switchTo(id, `/path/${id}`);
        await flushImmediates();
      }
      (mgr as unknown as { maxCachedViews: number }).maxCachedViews = 2;
      ageViewsPastPressureFloor(mgr);

      const readingsMb = [1200, 1200, 2500];
      Object.defineProperty(process, "getSystemMemoryInfo", {
        configurable: true,
        value: () => ({
          free: (readingsMb.shift() ?? 2500) * 1024,
          purgeable: 0,
          total: 8 * 1024 * 1024,
        }),
      });
      tickPressureCheck(mgr);
      tickPressureCheck(mgr);

      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-b", "proj-c", "proj-d"]);
    });

    it("holds the pass rather than handing a young view's eviction to an older, costlier one", async () => {
      // An agent's view ranks after ordinary ones. Skipping past a young
      // ordinary view would evict the older agent view in its place, turning
      // the age floor into a way around the tier order.
      setAvailableMb(2500);
      await seedThreeViews(manager);
      mockGetAllTerminals.mockResolvedValue([
        { id: "t-a", projectId: "proj-a", agentState: "working" },
      ]);
      await manager.initAgentStateCache(mockPtyClient as never);
      viewOf("proj-a").lastUsed -= MIN_PRESSURE_EVICTION_AGE_MS;

      setAvailableMb(1200);
      for (let tick = 0; tick < 3; tick++) tickPressureCheck(manager);

      expect(manager.getAllViews().length).toBe(3);
      expect(evictedProjectIds()).toEqual([]);
      expect(deferredLogs().map((ctx) => ctx.projectId)).toEqual(["proj-b", "proj-b"]);
    });

    it("holds a critical-band tick to the shorter grace", async () => {
      expect(MIN_PRESSURE_EVICTION_AGE_MS).toBe(300_000);
      expect(MIN_CRITICAL_PRESSURE_EVICTION_AGE_MS).toBe(60_000);
      setAvailableMb(2500);
      await seedThreeViews(manager);
      viewOf("proj-a").lastUsed -= MIN_CRITICAL_PRESSURE_EVICTION_AGE_MS;

      setAvailableMb(900);
      tickPressureCheck(manager);
      tickPressureCheck(manager);
      expect(evictedProjectIds()).toEqual(["proj-a"]);

      tickPressureCheck(manager);
      expect(deferredLogs().at(-1)).toMatchObject({
        projectId: "proj-b",
        minimumAgeMs: MIN_CRITICAL_PRESSURE_EVICTION_AGE_MS,
      });

      const leftAt = viewOf("proj-b").lastUsed;
      const clock = vi.spyOn(Date, "now");
      try {
        clock.mockReturnValue(leftAt + MIN_CRITICAL_PRESSURE_EVICTION_AGE_MS);
        tickPressureCheck(manager);
        expect(manager.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
      } finally {
        clock.mockRestore();
      }
    });
  });

  describe("soft-pressure backoff (#12885)", () => {
    const logged = (event: string) =>
      vi
        .mocked(logInfo)
        .mock.calls.filter(([name]) => name === event)
        .map(([, ctx]) => ctx as Record<string, unknown>);

    /** Five views (proj-a … proj-d oldest-first; proj-e active) under a cap of five. */
    async function seedFiveViews(): Promise<ProjectViewManager> {
      const mgr = makeManager(5);
      mgr.setMemoryPressurePolicy(BAND);
      mgr.registerInitialView(
        { webContents: createMockWebContents(), setBounds: vi.fn() } as never,
        "proj-a",
        "/path/a"
      );
      for (const id of ["b", "c", "d", "e"]) {
        await mgr.switchTo(`proj-${id}`, `/path/${id}`);
        await flushImmediates();
      }
      return mgr;
    }

    it("stops evicting once evictions stop freeing memory, and resumes only after recovery", async () => {
      setAvailableMb(2500);
      const mgr = await seedFiveViews();
      setAvailableMb(1200);
      armPressureLadder(mgr);

      // Availability never moves: each eviction is judged by the next reading,
      // and the second that freed nothing latches before a third can happen.
      for (let tick = 0; tick < 5; tick++) tickPressureCheck(mgr);
      expect(evictedProjectIds()).toEqual(["proj-a", "proj-b"]);
      expect(mgr.softPressureBackoffLatched).toBe(true);
      expect(logged("projectview.pressure-eviction-outcome").map((ctx) => ctx.outcome)).toEqual([
        "unproductive",
        "unproductive",
      ]);
      expect(logged("projectview.pressure-backoff")).toHaveLength(1);

      // Switching projects is no recovery.
      await mgr.switchTo("proj-c", "/path/c");
      await flushImmediates();
      ageViewsPastPressureFloor(mgr);
      tickPressureCheck(mgr);
      tickPressureCheck(mgr);
      expect(evictedProjectIds()).toEqual(["proj-a", "proj-b"]);

      // An unreadable sample says nothing either way.
      Object.defineProperty(process, "getSystemMemoryInfo", {
        configurable: true,
        value: undefined,
      });
      tickPressureCheck(mgr);
      expect(mgr.softPressureBackoffLatched).toBe(true);

      // A reading at the warning edge releases it; the next dip is a new
      // episode that needs its own confirmation.
      setAvailableMb(BAND.warningMb);
      tickPressureCheck(mgr);
      expect(mgr.softPressureBackoffLatched).toBe(false);
      expect(logged("projectview.pressure-backoff-cleared")).toHaveLength(1);

      setAvailableMb(1200);
      tickPressureCheck(mgr);
      expect(mgr.getAllViews().length).toBe(3);
      tickPressureCheck(mgr);
      expect(evictedProjectIds()).toEqual(["proj-a", "proj-b", "proj-d"]);
    });

    it("keeps shedding while each eviction frees a meaningful amount, and resets on one that does", async () => {
      setAvailableMb(2500);
      const mgr = await seedFiveViews();
      setAvailableMb(1200);
      armPressureLadder(mgr);

      tickPressureCheck(mgr);
      // A token rise is not progress.
      setAvailableMb(1210);
      tickPressureCheck(mgr);
      expect(mgr.softPressureUnproductivePasses).toBe(1);
      // A real one clears the count, so the next flat reading is only the first.
      setAvailableMb(1400);
      tickPressureCheck(mgr);
      expect(mgr.softPressureUnproductivePasses).toBe(0);
      tickPressureCheck(mgr);

      expect(evictedProjectIds()).toEqual(["proj-a", "proj-b", "proj-c"]);
      expect(logged("projectview.pressure-eviction-outcome").map((ctx) => ctx.outcome)).toEqual([
        "unproductive",
        "productive",
        "unproductive",
      ]);
      expect(mgr.softPressureBackoffLatched).toBe(false);
    });

    it("logs a view's footprint but expects a gain from its resident memory", async () => {
      // A cached renderer mostly swapped out: 2000 MB footprint, 800 MB
      // resident. Freeing the swapped share never shows up as available RAM,
      // so the verdict must not demand a quarter of the footprint (#13526).
      setPhysFootprintReaderForTesting({
        readPhysFootprints: (pids) => pids.map(() => 2_000 * 1024 * 1024),
        isAvailable: () => true,
        getLoadError: () => null,
      });
      try {
        setAvailableMb(2500);
        const mgr = await seedFiveViews();
        const pidA = mgr
          .getAllViews()
          .find((v) => v.projectId === "proj-a")!
          .view.webContents.getOSProcessId() as number;
        mockGetAppMetrics.mockReturnValue([
          { pid: pidA, memory: { workingSetSize: 800 * 1024, privateBytes: 0 } },
        ] as unknown as Electron.ProcessMetric[]);
        resetAppMetricsSnapshotForTesting();
        setAvailableMb(1200);
        armPressureLadder(mgr);
        tickPressureCheck(mgr);
        expect(logged("projectview.eviction")[0]).toMatchObject({
          projectId: "proj-a",
          memoryKb: 2_000 * 1024,
        });

        setAvailableMb(1450);
        tickPressureCheck(mgr);
        expect(logged("projectview.pressure-eviction-outcome")[0]).toMatchObject({
          outcome: "productive",
          gainMb: 250,
          requiredGainMb: 200,
          evictedResidentMb: 800,
        });
      } finally {
        resetPhysFootprintReaderForTesting();
      }
    });

    it("scales the gain it needs with the resident memory it destroyed", async () => {
      setAvailableMb(2500);
      const mgr = await seedFiveViews();
      const pidA = mgr
        .getAllViews()
        .find((v) => v.projectId === "proj-a")!
        .view.webContents.getOSProcessId() as number;
      mockGetAppMetrics.mockReturnValue([
        { pid: pidA, memory: { workingSetSize: 800 * 1024, privateBytes: 0 } },
      ] as unknown as Electron.ProcessMetric[]);
      resetAppMetricsSnapshotForTesting();
      setAvailableMb(1200);
      armPressureLadder(mgr);
      tickPressureCheck(mgr);
      expect(evictedProjectIds()).toEqual(["proj-a"]);

      // 100 MB clears the fixed floor but not a quarter of an 800 MB renderer.
      setAvailableMb(1300);
      tickPressureCheck(mgr);
      expect(logged("projectview.pressure-eviction-outcome")[0]).toMatchObject({
        outcome: "unproductive",
        gainMb: 100,
        requiredGainMb: 200,
        evictedResidentMb: 800,
      });
    });

    it("drops a pending judgement another pass has superseded", async () => {
      setAvailableMb(2500);
      const mgr = await seedFiveViews();
      setAvailableMb(1200);
      armPressureLadder(mgr);
      tickPressureCheck(mgr);
      expect(mgr.pendingSoftPressureEviction).not.toBeNull();

      // A limit-change pass evicts too, so the next reading no longer measures
      // the soft eviction alone.
      mgr.setCachedViewLimit(3);
      expect(evictedProjectIds()).toEqual(["proj-a", "proj-b"]);
      expect(mgr.pendingSoftPressureEviction).toBeNull();
      tickPressureCheck(mgr);
      expect(logged("projectview.pressure-eviction-outcome")).toEqual([]);
      expect(mgr.softPressureUnproductivePasses).toBe(0);
    });

    it("clears a partial count on recovery even with nothing left to take", async () => {
      setAvailableMb(2500);
      await seedThreeViews(manager);
      setAvailableMb(1200);
      armPressureLadder(manager);
      tickPressureCheck(manager);
      setAvailableMb(1300);
      tickPressureCheck(manager);
      expect(manager.getAllViews().length).toBe(1);
      // The last eviction freed nothing: one unproductive pass, no latch.
      tickPressureCheck(manager);
      expect(manager.softPressureUnproductivePasses).toBe(1);
      expect(manager.softPressureBackoffLatched).toBe(false);

      // Recovery must still be read, or the next episode would latch after a
      // single unproductive eviction.
      setAvailableMb(2500);
      tickPressureCheck(manager);
      expect(manager.softPressureUnproductivePasses).toBe(0);
    });

    it("sees the recovery that releases the latch once only the active view is left", async () => {
      setAvailableMb(2500);
      await seedThreeViews(manager);
      setAvailableMb(1200);
      armPressureLadder(manager);
      tickPressureCheck(manager);
      tickPressureCheck(manager);
      expect(manager.getAllViews().length).toBe(1);

      // The second eviction is still judged with nothing left to take.
      tickPressureCheck(manager);
      expect(manager.softPressureBackoffLatched).toBe(true);

      setAvailableMb(2500);
      tickPressureCheck(manager);
      expect(manager.softPressureBackoffLatched).toBe(false);
    });

    it("does not hold back a critical reading", async () => {
      setAvailableMb(2500);
      const mgr = await seedFiveViews();
      setAvailableMb(1200);
      armPressureLadder(mgr);
      for (let tick = 0; tick < 3; tick++) tickPressureCheck(mgr);
      expect(mgr.softPressureBackoffLatched).toBe(true);

      setAvailableMb(900);
      tickPressureCheck(mgr);
      expect(evictedProjectIds()).toEqual(["proj-a", "proj-b", "proj-c"]);
    });

    it("forgets the backoff when the band is disarmed, and evicts nothing after", async () => {
      setAvailableMb(2500);
      const mgr = await seedFiveViews();
      setAvailableMb(1200);
      armPressureLadder(mgr);
      for (let tick = 0; tick < 3; tick++) tickPressureCheck(mgr);
      expect(mgr.softPressureBackoffLatched).toBe(true);

      mgr.setLowMemoryFreeThresholdMb(null);
      expect(mgr.softPressureBackoffLatched).toBe(false);
      expect(mgr.softPressureUnproductivePasses).toBe(0);
      for (let tick = 0; tick < 3; tick++) tickPressureCheck(mgr);
      expect(evictedProjectIds()).toEqual(["proj-a", "proj-b"]);
    });
  });

  describe("kernel-plus-swap pressure (#13223)", () => {
    const logged = (event: string) =>
      vi
        .mocked(logInfo)
        .mock.calls.filter(([name]) => name === event)
        .map(([, ctx]) => ctx as Record<string, unknown>);

    afterEach(() => recordSwapPressure(false));

    it("sheds a view per confirmed tick toward the active view while availability reads healthy", async () => {
      setAvailableMb(2500);
      await seedThreeViews(manager);
      ageViewsPastPressureFloor(manager);
      recordSwapPressure(true);

      tickPressureCheck(manager);
      expect(evictedProjectIds()).toEqual([]);
      tickPressureCheck(manager);
      expect(evictedProjectIds()).toEqual(["proj-a"]);
      tickPressureCheck(manager);
      expect(evictedProjectIds()).toEqual(["proj-a", "proj-b"]);

      expect(logged("projectview.pressure-override")[0]).toMatchObject({
        pressureLevel: "critical",
        pressureSource: "kernel-swap",
        forced: false,
        evictionBudget: 1,
      });
    });

    it("targets the critical band from inside the soft band, past the backoff latch", async () => {
      setAvailableMb(2500);
      const mgr = makeManager(5);
      mgr.setMemoryPressurePolicy(BAND);
      mgr.registerInitialView(
        { webContents: createMockWebContents(), setBounds: vi.fn() } as never,
        "proj-a",
        "/path/a"
      );
      for (const id of ["b", "c", "d", "e"]) {
        await mgr.switchTo(`proj-${id}`, `/path/${id}`);
        await flushImmediates();
      }
      // 1800MB is the reporter's reading: soft, with a settled target of four.
      setAvailableMb(1800);
      armPressureLadder(mgr);
      tickPressureCheck(mgr);
      expect(evictedProjectIds()).toEqual(["proj-a"]);
      for (let tick = 0; tick < 3; tick++) tickPressureCheck(mgr);
      expect(evictedProjectIds()).toEqual(["proj-a"]);

      // Lower, still soft: availability alone latches after two flat passes.
      setAvailableMb(1300);
      for (let tick = 0; tick < 4; tick++) tickPressureCheck(mgr);
      expect(mgr.softPressureBackoffLatched).toBe(true);
      const beforeSwap = evictedProjectIds().length;

      recordSwapPressure(true);
      tickPressureCheck(mgr);
      tickPressureCheck(mgr);
      expect(evictedProjectIds().length).toBe(beforeSwap + 2);
      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-e"]);
      // Swap passes leave no availability verdict behind to latch on.
      expect(mgr.pendingSoftPressureEviction).toBeNull();
    });

    it("keeps the soft band's minimum age for a view the user only just left", async () => {
      setAvailableMb(2500);
      await seedThreeViews(manager);
      recordSwapPressure(true);
      tickPressureCheck(manager);
      tickPressureCheck(manager);
      expect(evictedProjectIds()).toEqual([]);
      expect(
        vi
          .mocked(logInfo)
          .mock.calls.filter(([event]) => event === "projectview.eviction-deferred")
          .map(([, ctx]) => (ctx as { minimumAgeMs: number }).minimumAgeMs)
      ).toContain(MIN_PRESSURE_EVICTION_AGE_MS);
    });

    it("stops, and needs a fresh confirmation, once the swap verdict clears", async () => {
      setAvailableMb(2500);
      await seedThreeViews(manager);
      ageViewsPastPressureFloor(manager);
      recordSwapPressure(true);
      tickPressureCheck(manager);
      tickPressureCheck(manager);
      expect(evictedProjectIds()).toEqual(["proj-a"]);

      recordSwapPressure(false);
      tickPressureCheck(manager);
      expect(manager.pressureSampleStreak).toBe(0);
      recordSwapPressure(true);
      tickPressureCheck(manager);
      expect(evictedProjectIds()).toEqual(["proj-a"]);
      tickPressureCheck(manager);
      expect(evictedProjectIds()).toEqual(["proj-a", "proj-b"]);
    });

    it("still sheds on swap alone when availability cannot be read", async () => {
      setAvailableMb(2500);
      await seedThreeViews(manager);
      ageViewsPastPressureFloor(manager);
      Object.defineProperty(process, "getSystemMemoryInfo", {
        configurable: true,
        value: undefined,
      });
      recordSwapPressure(true);
      tickPressureCheck(manager);
      tickPressureCheck(manager);
      expect(evictedProjectIds()).toEqual(["proj-a"]);
      expect(logged("projectview.pressure-override")[0]).toMatchObject({
        availableMb: null,
        pressureSource: "kernel-swap",
      });
    });

    it("acts on the reading it counted rather than reading again", async () => {
      setAvailableMb(2500);
      await seedThreeViews(manager);
      // Past the critical floor, short of the swap one.
      for (const entry of manager.views.values()) {
        entry.lastUsed -= MIN_CRITICAL_PRESSURE_EVICTION_AGE_MS + 30_000;
      }
      // The sampler's own reads fail; a third, fresh read would land critical
      // and swap the five-minute floor for the one-minute one.
      let reads = 0;
      Object.defineProperty(process, "getSystemMemoryInfo", {
        configurable: true,
        value: () => {
          reads++;
          return { free: reads <= 2 ? Number.NaN : 500 * 1024, total: 8 * 1024 * 1024 };
        },
      });
      recordSwapPressure(true);
      tickPressureCheck(manager);
      tickPressureCheck(manager);
      expect(reads).toBe(2);
      expect(evictedProjectIds()).toEqual([]);
    });

    it("ignores a verdict that has gone stale", async () => {
      setAvailableMb(2500);
      await seedThreeViews(manager);
      ageViewsPastPressureFloor(manager);
      recordSwapPressure(true, Date.now() - SWAP_PRESSURE_STALE_MS - 1);
      tickPressureCheck(manager);
      tickPressureCheck(manager);
      expect(evictedProjectIds()).toEqual([]);
    });

    it("refuses a background restore while it holds", async () => {
      setAvailableMb(2500);
      const mgr = makeManager(5);
      mgr.setMemoryPressurePolicy(BAND);
      await seedThreeViews(mgr);
      expect(backgroundRestoreCapacity(mgr)).toBe("available");
      recordSwapPressure(true);
      expect(backgroundRestoreCapacity(mgr)).toBe("pressure");
    });

    it("refuses a background restore at critical kernel pressure alone (#13530)", async () => {
      setAvailableMb(6000);
      const mgr = makeManager(5);
      mgr.setMemoryPressurePolicy(BAND);
      await seedThreeViews(mgr);
      try {
        recordKernelPressureLevel(4);
        expect(backgroundRestoreCapacity(mgr)).toBe("pressure");
        recordKernelPressureLevel(1);
        recordKernelPressureLevel(1);
        expect(backgroundRestoreCapacity(mgr)).toBe("available");
      } finally {
        resetKernelPressureForTesting();
      }
    });
  });
});

describe("ProjectViewManager — MCP bound sessions and dispatch leases (#11790)", () => {
  let win: ReturnType<typeof createMockWindow>;
  /** Workspaces a live MCP session is bound to, and views with a call in flight. */
  let boundWorkspaces: Set<string>;
  let leasedWebContentsIds: Set<number>;

  type MemInfo = { free: number; purgeable?: number; total: number };
  const originalSystemMemoryInfo = (process as unknown as { getSystemMemoryInfo?: () => MemInfo })
    .getSystemMemoryInfo;

  function setAvailableMb(availableMb: number) {
    Object.defineProperty(process, "getSystemMemoryInfo", {
      configurable: true,
      value: () => ({ free: availableMb * 1024, purgeable: 0, total: 8 * 1024 * 1024 }),
    });
  }

  const BAND = { criticalMb: 1000, warningMb: 2000 };

  const evictedProjectIds = () =>
    vi
      .mocked(logInfo)
      .mock.calls.filter(([event]) => event === "projectview.eviction")
      .map(([, ctx]) => (ctx as { projectId: string }).projectId);

  const evictionLogFor = (projectId: string) =>
    vi
      .mocked(logInfo)
      .mock.calls.find(
        ([event, ctx]) =>
          event === "projectview.eviction" && (ctx as { projectId: string }).projectId === projectId
      )?.[1] as Record<string, unknown> | undefined;

  const skippedLog = (): Record<string, unknown> | undefined =>
    vi
      .mocked(logInfo)
      .mock.calls.filter(([event]) => event === "projectview.eviction-skipped")
      .pop()?.[1] as Record<string, unknown> | undefined;

  /** Every manager built here, so the randomized sampler each one starts is torn down. */
  let managers: ProjectViewManager[];
  /** Workspaces the injected activity callback throws for, exercising the unknown path. */
  let activityThrowsFor: Set<string>;

  function makeManager(cachedProjectViews: number) {
    const mgr = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews,
      assistantBackendsForProject,
      isTerminalLive,
      mcpViewActivity: (workspaceId: string, webContentsId: number) => {
        if (activityThrowsFor.has(workspaceId)) throw new Error("MCP service mid-teardown");
        return {
          liveBinding: boundWorkspaces.has(workspaceId),
          dispatchLease: leasedWebContentsIds.has(webContentsId),
        };
      },
    });
    managers.push(mgr);
    return mgr;
  }

  /** Three views: proj-a and proj-b cached (oldest-first), proj-c active. */
  async function seedThreeViews(mgr: ProjectViewManager) {
    const wcA = createMockWebContents();
    mgr.registerInitialView({ webContents: wcA, setBounds: vi.fn() } as never, "proj-a", "/path/a");
    await mgr.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await mgr.switchTo("proj-c", "/path/c");
    await flushImmediates();
  }

  const webContentsIdFor = (mgr: ProjectViewManager, projectId: string): number =>
    mgr.getAllViews().find((v) => v.projectId === projectId)!.view.webContents.id;

  const tickPressureCheck = (mgr: ProjectViewManager) =>
    (mgr as unknown as { maybeEvictUnderPressure(): void }).maybeEvictUnderPressure();

  beforeEach(() => {
    nextWebContentsId = 100;
    nextOsProcessId = 1000;
    vi.clearAllMocks();
    mockGetAllTerminals.mockReset();
    mockGetAllTerminals.mockResolvedValue([]);
    mockGetAppMetrics.mockReset();
    mockGetAppMetrics.mockReturnValue([]);
    assistantBackends.clear();
    liveTerminals.clear();
    boundWorkspaces = new Set();
    leasedWebContentsIds = new Set();
    activityThrowsFor = new Set();
    managers = [];
    win = createMockWindow();
  });

  afterEach(() => {
    // Each manager starts a randomly-phased memory sampler. Left running, a
    // previous test's tick can fire mid-test, write into the shared logInfo
    // mock, and read the sets after they have been rebound for another case.
    for (const mgr of managers) mgr.dispose();
    managers = [];
    Object.defineProperty(process, "getSystemMemoryInfo", {
      configurable: true,
      value: originalSystemMemoryInfo,
    });
  });

  describe("in-flight dispatch leases", () => {
    it("evicts a newer view rather than the LRU one that is answering a dispatch", async () => {
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      leasedWebContentsIds.add(webContentsIdFor(mgr, "proj-a"));

      mgr.setCachedViewLimit(2);

      // Destroying proj-a would strand the in-flight call and leave every later
      // one on that session failing SESSION_BINDING_GONE.
      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-a", "proj-c"]);
      expect(evictedProjectIds()).toEqual(["proj-b"]);
    });

    it("survives the forced tier-2 reclaim, which collapses everything else", async () => {
      // The lease is an absolute exclusion, safe only because it self-expires
      // with the request that owns it.
      const mgr = makeManager(3);
      mgr.setMemoryPressurePolicy(BAND);
      setAvailableMb(2500);
      await seedThreeViews(mgr);
      leasedWebContentsIds.add(webContentsIdFor(mgr, "proj-a"));

      mgr.reclaimCachedViewsUnderPressure();

      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-a", "proj-c"]);
    });

    it("becomes an ordinary candidate again the moment the dispatch settles", async () => {
      const mgr = makeManager(3);
      mgr.setMemoryPressurePolicy(BAND);
      setAvailableMb(2500);
      await seedThreeViews(mgr);
      const wcIdA = webContentsIdFor(mgr, "proj-a");
      leasedWebContentsIds.add(wcIdA);

      mgr.reclaimCachedViewsUnderPressure();
      expect(mgr.getAllViews().map((v) => v.projectId)).toContain("proj-a");

      // Bounded, not permanent: this is the difference from the assistant floor.
      leasedWebContentsIds.delete(wcIdA);
      mgr.reclaimCachedViewsUnderPressure();

      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
    });

    it("reports a lease-only over-cap cache, which nothing else would explain", async () => {
      // A lease is self-expiring per request, but a session dispatching
      // continuously renews one, so this stall can persist. Without the log it
      // reads as a leak in the memory logs.
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      leasedWebContentsIds.add(webContentsIdFor(mgr, "proj-a"));
      leasedWebContentsIds.add(webContentsIdFor(mgr, "proj-b"));

      mgr.setCachedViewLimit(1);

      expect(mgr.getAllViews().length).toBe(3);
      const skipped = skippedLog();
      expect(skipped?.protectedCount).toBe(0);
      expect(skipped?.mcpLeasedCount).toBe(2);
    });

    it("reports a lease separately from the assistant floor holding the same cache open", async () => {
      // The over-cap log exists so extra resident renderers are attributable
      // rather than reading as a leak, which means each count has to mean one
      // thing: a pinned assistant is persistent, a lease is not, and neither
      // may be reported as the other.
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      const wcA = mgr.getAllViews().find((v) => v.projectId === "proj-a")!.view.webContents;
      assistantBackends.set("proj-a", { terminalId: "t-help-a", webContentsId: wcA.id });
      liveTerminals.add("t-help-a");
      leasedWebContentsIds.add(webContentsIdFor(mgr, "proj-b"));

      mgr.setCachedViewLimit(1);

      expect(mgr.getAllViews().length).toBe(3);
      const skipped = skippedLog();
      expect(skipped?.protectedCount).toBe(1);
      expect(skipped?.protectedProjectIds).toEqual(["proj-a"]);
      expect(skipped?.mcpLeasedCount).toBe(1);
      // Paint-gate / cold-switch bridges only — a lease is not one of those.
      expect(skipped?.transientlyExcludedCount).toBe(0);
    });

    it("leases only the exact view, not every view of the workspace's project id", async () => {
      // Keyed by WebContents id because that is what a pending request awaits;
      // a replacement view after a cold start gets a new id and no stale
      // protection.
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      leasedWebContentsIds.add(webContentsIdFor(mgr, "proj-a") + 9999);

      mgr.setCachedViewLimit(1);

      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
    });
  });

  describe("views holding unrecoverable work (#14095)", () => {
    const holdFor = (mgr: ProjectViewManager, projectId: string, holding: boolean) =>
      recordPanelRecoveryState(
        mgr.getAllViews().find((v) => v.projectId === projectId)!.view.webContents,
        holding
      );

    beforeEach(() => _resetPanelRecoveryStateForTests());
    afterEach(() => _resetPanelRecoveryStateForTests());

    it("keeps a view with unsaved work out of a cap the user set", async () => {
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      holdFor(mgr, "proj-a", true);

      mgr.setCachedViewLimit(2);

      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-a", "proj-c"]);
      expect(evictedProjectIds()).toEqual(["proj-b"]);
    });

    it("reports the hold when it is what keeps the cache over its cap", async () => {
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      holdFor(mgr, "proj-a", true);

      mgr.setCachedViewLimit(1);

      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-a", "proj-c"]);
      expect(skippedLog()?.recoveryHeldProjectIds).toEqual(["proj-a"]);
    });

    it("yields to the forced reclaim last of all, and says the work went with it", async () => {
      const mgr = makeManager(3);
      mgr.setMemoryPressurePolicy(BAND);
      setAvailableMb(2500);
      await seedThreeViews(mgr);
      holdFor(mgr, "proj-a", true);

      mgr.reclaimCachedViewsUnderPressure();

      // proj-a is the least recently used, so only its tier puts it second.
      expect(evictedProjectIds()).toEqual(["proj-b", "proj-a"]);
      expect(evictionLogFor("proj-a")?.recoveryHeld).toBe(true);
      expect(evictionLogFor("proj-b")).not.toHaveProperty("recoveryHeld");
      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
    });

    it("becomes an ordinary candidate once the work is saved or persisted", async () => {
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      holdFor(mgr, "proj-a", true);
      holdFor(mgr, "proj-a", false);

      mgr.setCachedViewLimit(1);

      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
    });

    it("brings the cache back under its cap the moment the hold is released", async () => {
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      holdFor(mgr, "proj-a", true);
      mgr.setCachedViewLimit(2);
      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-a", "proj-c"]);
      mgr.setCachedViewLimit(1);
      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-a", "proj-c"]);

      // No limit change, switch or pressure tick: the release alone re-runs the cap.
      holdFor(mgr, "proj-a", false);
      await flushImmediates();

      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
    });

    it("won't hand a held view to another window", async () => {
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      holdFor(mgr, "proj-a", true);

      expect(mgr.canReleaseCachedView("proj-a")).toBe(false);
      expect(mgr.releaseCachedView("proj-a")).toBe(false);
      expect(mgr.getAllViews().map((v) => v.projectId)).toContain("proj-a");
      expect(mgr.canReleaseCachedView("proj-b")).toBe(true);
    });
  });

  describe("views a dictation still needs (#14773)", () => {
    const dictateIn = (mgr: ProjectViewManager, projectId: string) =>
      holdDictationView(webContentsIdFor(mgr, projectId));

    beforeEach(() => _resetDictationViewHoldsForTests());
    afterEach(() => _resetDictationViewHoldsForTests());

    it("keeps the dictating view however small the cap, and reports why", async () => {
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      dictateIn(mgr, "proj-a");

      mgr.setCachedViewLimit(1);

      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-a", "proj-c"]);
      expect(evictedProjectIds()).toEqual(["proj-b"]);
      expect(skippedLog()?.dictationHeldProjectIds).toEqual(["proj-a"]);
    });

    it("keeps it through the forced reclaim, which takes everything else", async () => {
      const mgr = makeManager(3);
      mgr.setMemoryPressurePolicy(BAND);
      setAvailableMb(2500);
      await seedThreeViews(mgr);
      dictateIn(mgr, "proj-a");

      mgr.reclaimCachedViewsUnderPressure();

      expect(evictedProjectIds()).toEqual(["proj-b"]);
      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-a", "proj-c"]);
    });

    it("keeps it while the user clicks through other projects", async () => {
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      dictateIn(mgr, "proj-a");
      mgr.setCachedViewLimit(2);

      await mgr.switchTo("proj-d", "/path/d");
      await flushImmediates();
      await mgr.switchTo("proj-e", "/path/e");
      await flushImmediates();

      expect(mgr.getAllViews().map((v) => v.projectId)).toContain("proj-a");
      expect(mgr.getActiveProjectId()).toBe("proj-e");
    });

    it("holds it until the last of several holds is released", async () => {
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      const session = dictateIn(mgr, "proj-a");
      const cleanup = dictateIn(mgr, "proj-a");
      mgr.setCachedViewLimit(1);

      session();
      session();
      await flushImmediates();
      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-a", "proj-c"]);

      cleanup();
      await flushImmediates();
      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
    });

    it("lets a hold with a deadline lapse on its own", async () => {
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      vi.useFakeTimers();
      try {
        holdDictationView(webContentsIdFor(mgr, "proj-a"), 5_000);
        mgr.setCachedViewLimit(1);
        expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-a", "proj-c"]);

        vi.advanceTimersByTime(5_000);
        vi.runOnlyPendingTimers();
      } finally {
        vi.useRealTimers();
      }
      await flushImmediates();
      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
    });

    it("won't hand the dictating view to another window", async () => {
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      dictateIn(mgr, "proj-a");

      expect(mgr.canReleaseCachedView("proj-a")).toBe(false);
      expect(mgr.releaseCachedView("proj-a")).toBe(false);
      expect(mgr.canReleaseCachedView("proj-b")).toBe(true);
    });

    it("keeps a host's view held by its dictation, apart from another host's view of the same id", async () => {
      const mgr = makeManager(3);
      const wcA = createMockWebContents();
      mgr.registerInitialView({ webContents: wcA, setBounds: vi.fn() } as never, "proj-a", "/a");
      await mgr.switchToHostProject("studio-01", "proj-r", "/srv/r");
      await flushImmediates();
      await mgr.switchToHostProject("studio-02", "proj-r", "/srv/r");
      await flushImmediates();
      await mgr.switchTo("proj-c", "/path/c");
      await flushImmediates();
      holdDictationView(webContentsIdFor(mgr, toHostScopedKey("studio-01", "proj-r")));

      mgr.setCachedViewLimit(1);

      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual([
        toHostScopedKey("studio-01", "proj-r"),
        "proj-c",
      ]);
    });
  });

  describe("views still flushing unsaved edits on their cached edge (#15633)", () => {
    beforeEach(() => _resetCachedViewFlushForTests());
    afterEach(() => _resetCachedViewFlushForTests());

    const wcFor = (mgr: ProjectViewManager, projectId: string) =>
      mgr.getAllViews().find((v) => v.projectId === projectId)!.view.webContents;
    const flushIdSentTo = (wc: Electron.WebContents) =>
      (
        vi
          .mocked(wc.send)
          .mock.calls.filter(([channel]) => channel === CHANNELS.APP_VIEW_CACHED)
          .at(-1)?.[1] as { flushId?: string } | undefined
      )?.flushId;

    /** proj-a and proj-b cached, proj-c active; proj-b was left with Settings open. */
    async function seedWithFlushingView(mgr: ProjectViewManager) {
      const wcA = createMockWebContents();
      mgr.registerInitialView(
        { webContents: wcA, setBounds: vi.fn() } as never,
        "proj-a",
        "/path/a"
      );
      await mgr.switchTo("proj-b", "/path/b");
      await flushImmediates();
      recordCachedViewFlushArmed(wcFor(mgr, "proj-b"), true);
      await mgr.switchTo("proj-c", "/path/c");
      await flushImmediates();
      return wcFor(mgr, "proj-b");
    }

    it("keeps the view until its flush has reached main, then reclaims it", async () => {
      const mgr = makeManager(3);
      const wcB = await seedWithFlushingView(mgr);
      expect(isCachedViewFlushPending(wcB)).toBe(true);

      mgr.setCachedViewLimit(1);

      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-b", "proj-c"]);
      expect(evictedProjectIds()).toEqual(["proj-a"]);
      expect(skippedLog()?.flushHeldProjectIds).toEqual(["proj-b"]);
      expect(wcB.close).not.toHaveBeenCalled();

      // The renderer answers only once its last save step has returned from main.
      settleCachedViewFlush(wcB, flushIdSentTo(wcB));
      await flushImmediates();

      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
      expect(wcB.close).toHaveBeenCalled();
    });

    it("keeps it through the forced reclaim", async () => {
      const mgr = makeManager(3);
      mgr.setMemoryPressurePolicy(BAND);
      setAvailableMb(2500);
      await seedWithFlushingView(mgr);

      mgr.reclaimCachedViewsUnderPressure();

      expect(evictedProjectIds()).toEqual(["proj-a"]);
      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-b", "proj-c"]);
    });

    it("won't hand it to another window mid-flush", async () => {
      const mgr = makeManager(3);
      const wcB = await seedWithFlushingView(mgr);

      expect(mgr.releaseCachedView("proj-b")).toBe(false);
      expect(mgr.canReleaseCachedView("proj-a")).toBe(true);

      settleCachedViewFlush(wcB, flushIdSentTo(wcB));
      expect(mgr.canReleaseCachedView("proj-b")).toBe(true);
    });

    it("holds nothing for a view whose renderer has no flush registered", async () => {
      const mgr = makeManager(3);
      await seedThreeViews(mgr);

      expect(isCachedViewFlushPending(wcFor(mgr, "proj-b"))).toBe(false);
      mgr.setCachedViewLimit(1);
      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
    });
  });

  describe("quiet bound sessions", () => {
    it("evicts an active-agent view before a quiet bound one", async () => {
      // An agent view is cheap to lose — its PTY lives in the pty-host and
      // reconnects on switch-back. A bound view's destruction breaks the
      // session's route with no recovery path, so it goes last.
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      boundWorkspaces.add("proj-a");
      mockGetAllTerminals.mockResolvedValue([
        { id: "t-b", projectId: "proj-b", agentState: "working" },
      ]);
      await mgr.initAgentStateCache(mockPtyClient as never);

      mgr.setCachedViewLimit(2);

      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-a", "proj-c"]);
      expect(evictedProjectIds()).toEqual(["proj-b"]);
    });

    it("evicts an ordinary idle view before a quiet bound one", async () => {
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      // proj-a is the LRU view, so pure LRU would take it first.
      boundWorkspaces.add("proj-a");

      mgr.setCachedViewLimit(2);

      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-a", "proj-c"]);
    });

    it("still evicts a quiet bound view once nothing safer is left", async () => {
      // The issue is explicit that this must NOT become a hard floor: enough
      // concurrent bound sessions would otherwise defeat the pressure policy.
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      boundWorkspaces.add("proj-a");
      boundWorkspaces.add("proj-b");

      mgr.setCachedViewLimit(1);

      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
      expect(evictedProjectIds()).toEqual(["proj-a", "proj-b"]);
    });

    it("yields to the forced tier-2 reclaim", async () => {
      const mgr = makeManager(3);
      mgr.setMemoryPressurePolicy(BAND);
      setAvailableMb(2500);
      await seedThreeViews(mgr);
      boundWorkspaces.add("proj-a");
      boundWorkspaces.add("proj-b");

      mgr.reclaimCachedViewsUnderPressure();

      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
    });

    it("yields one at a time under graduated pressure, bound views last", async () => {
      const mgr = makeManager(3);
      mgr.setMemoryPressurePolicy(BAND);
      setAvailableMb(2500);
      await seedThreeViews(mgr);
      boundWorkspaces.add("proj-a");

      setAvailableMb(1200);
      armPressureLadder(mgr);
      tickPressureCheck(mgr);
      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-a", "proj-c"]);

      tickPressureCheck(mgr);
      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
    });

    it("records the binding on the eviction log line so a broken session is traceable", async () => {
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      boundWorkspaces.add("proj-a");
      boundWorkspaces.add("proj-b");

      mgr.setCachedViewLimit(1);

      expect(evictionLogFor("proj-a")?.boundMcpSession).toBe(true);
    });

    it("leaves the assistant floor above it — a bound view goes first", async () => {
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      const wcA = mgr.getAllViews().find((v) => v.projectId === "proj-a")!.view.webContents;
      assistantBackends.set("proj-a", { terminalId: "t-help-a", webContentsId: wcA.id });
      liveTerminals.add("t-help-a");
      boundWorkspaces.add("proj-b");

      mgr.setCachedViewLimit(1);

      // proj-a holds a live assistant (unconditional floor) so the bound-but-quiet
      // proj-b is what the pass can actually take.
      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-a", "proj-c"]);
      expect(evictedProjectIds()).toEqual(["proj-b"]);
    });
  });

  // `destroyView` was the one teardown that didn't look (#13845): an automatic
  // sleep could take the view a dispatch was waiting on, leaving that session
  // failing SESSION_BINDING_GONE until the project reopened.
  describe("destroying a view for an automatic sleep", () => {
    beforeEach(() => _resetDictationViewHoldsForTests());
    afterEach(() => _resetDictationViewHoldsForTests());

    it("leaves a view alone while a dispatch is in flight against it", async () => {
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      leasedWebContentsIds.add(webContentsIdFor(mgr, "proj-a"));

      expect(mgr.isMcpDispatchProtected("proj-a")).toBe(true);
      expect(mgr.destroyView("proj-a", { protectMcpDispatch: true })).toBe(false);
      expect(mgr.getAllViews().map((v) => v.projectId)).toContain("proj-a");

      // The lease is per-dispatch: once it lapses, the same sleep goes through.
      leasedWebContentsIds.clear();
      expect(mgr.destroyView("proj-a", { protectMcpDispatch: true })).toBe(true);
      expect(mgr.getAllViews().map((v) => v.projectId)).not.toContain("proj-a");
    });

    it("holds a quiet bound session to nothing — only a dispatch protects", async () => {
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      boundWorkspaces.add("proj-a");

      expect(mgr.isMcpDispatchProtected("proj-a")).toBe(false);
      expect(mgr.destroyView("proj-a", { protectMcpDispatch: true })).toBe(true);
    });

    it("waits out activity it can't read, unlike pressure eviction", async () => {
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      activityThrowsFor.add("proj-a");

      expect(mgr.destroyView("proj-a", { protectMcpDispatch: true })).toBe(false);
      expect(mgr.getAllViews().map((v) => v.projectId)).toContain("proj-a");
    });

    it("still destroys a leased view when a user asked", async () => {
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      leasedWebContentsIds.add(webContentsIdFor(mgr, "proj-a"));

      expect(mgr.destroyView("proj-a")).toBe(true);
      expect(mgr.getAllViews().map((v) => v.projectId)).not.toContain("proj-a");
    });

    it("reads a project it holds no view for as unprotected", () => {
      const mgr = makeManager(3);
      expect(mgr.isMcpDispatchProtected("proj-z")).toBe(false);
      expect(mgr.isDictationHeld("proj-z")).toBe(false);
    });

    it("reports a view a dictation still needs until its hold lifts (#15920)", async () => {
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      const release = holdDictationView(webContentsIdFor(mgr, "proj-a"));

      expect(mgr.isDictationHeld("proj-a")).toBe(true);
      expect(mgr.isDictationHeld("proj-b")).toBe(false);

      release();
      expect(mgr.isDictationHeld("proj-a")).toBe(false);
    });
  });

  describe("an activity callback that throws", () => {
    it("never becomes an absolute exclusion — a broken callback must not pin the cache", async () => {
      // The dangerous direction: if unknown granted the lease exclusion, one
      // failing callback would make every cached view unreclaimable straight
      // through critical pressure and turn a wiring bug into an OOM.
      const mgr = makeManager(3);
      mgr.setMemoryPressurePolicy(BAND);
      setAvailableMb(2500);
      await seedThreeViews(mgr);
      activityThrowsFor.add("proj-a");
      activityThrowsFor.add("proj-b");

      mgr.reclaimCachedViewsUnderPressure();

      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
    });

    it("deprioritizes like a quiet binding rather than reading as unprotected", async () => {
      // proj-a is LRU, so pure LRU would take it first. An agent-active proj-b
      // is the cheaper loss, so an unknown proj-a should outlive it. Scoped to
      // one workspace on purpose: if every view read as unknown the tiers would
      // flatten back to plain LRU and there would be no differential to observe.
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      mockGetAllTerminals.mockResolvedValue([
        { id: "t-b", projectId: "proj-b", agentState: "working" },
      ]);
      await mgr.initAgentStateCache(mockPtyClient as never);
      activityThrowsFor.add("proj-a");

      mgr.setCachedViewLimit(2);

      expect(evictedProjectIds()).toEqual(["proj-b"]);
    });
  });
});

describe("ProjectViewManager — user-granted workspace residency (#12313)", () => {
  let win: ReturnType<typeof createMockWindow>;
  let boundWorkspaces: Set<string>;
  let managers: ProjectViewManager[];

  type MemInfo = { free: number; purgeable?: number; total: number };
  const originalSystemMemoryInfo = (process as unknown as { getSystemMemoryInfo?: () => MemInfo })
    .getSystemMemoryInfo;

  function setAvailableMb(availableMb: number) {
    Object.defineProperty(process, "getSystemMemoryInfo", {
      configurable: true,
      value: () => ({ free: availableMb * 1024, purgeable: 0, total: 8 * 1024 * 1024 }),
    });
  }

  const evictionLogFor = (projectId: string) =>
    vi
      .mocked(logInfo)
      .mock.calls.find(
        ([event, ctx]) =>
          event === "projectview.eviction" && (ctx as { projectId: string }).projectId === projectId
      )?.[1] as Record<string, unknown> | undefined;

  function makeManager(cachedProjectViews: number) {
    const mgr = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews,
      assistantBackendsForProject,
      isTerminalLive,
      mcpViewActivity: (workspaceId: string) => ({
        liveBinding: boundWorkspaces.has(workspaceId),
        dispatchLease: false,
      }),
    });
    managers.push(mgr);
    return mgr;
  }

  /** Three views: proj-a and proj-b cached (oldest-first), proj-c active. */
  async function seedThreeViews(mgr: ProjectViewManager) {
    const wcA = createMockWebContents();
    mgr.registerInitialView({ webContents: wcA, setBounds: vi.fn() } as never, "proj-a", "/path/a");
    await mgr.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await mgr.switchTo("proj-c", "/path/c");
    await flushImmediates();
  }

  /** Bind a running assistant to the project's current view — the view the session pinned. */
  function bindLiveAssistant(mgr: ProjectViewManager, projectId: string, terminalId: string) {
    const wc = mgr.getAllViews().find((v) => v.projectId === projectId)!.view.webContents;
    assistantBackends.set(projectId, { terminalId, webContentsId: wc.id });
    liveTerminals.add(terminalId);
  }

  beforeEach(() => {
    nextWebContentsId = 100;
    nextOsProcessId = 1000;
    vi.clearAllMocks();
    mockGetAllTerminals.mockReset();
    mockGetAllTerminals.mockResolvedValue([]);
    mockGetAppMetrics.mockReset();
    mockGetAppMetrics.mockReturnValue([]);
    assistantBackends.clear();
    liveTerminals.clear();
    residentWorkspaces.clear();
    boundWorkspaces = new Set();
    managers = [];
    win = createMockWindow();
  });

  afterEach(() => {
    for (const mgr of managers) mgr.dispose();
    managers = [];
    residentWorkspaces.clear();
    Object.defineProperty(process, "getSystemMemoryInfo", {
      configurable: true,
      value: originalSystemMemoryInfo,
    });
  });

  it("keeps a granted workspace resident even though it is the LRU candidate", async () => {
    // The whole ask: an operator rotating through other projects evicts the one
    // holding their orchestrator's agents, and no cached-view limit makes it
    // reliably resident. proj-a is the oldest, so pure LRU takes it first.
    const mgr = makeManager(3);
    await seedThreeViews(mgr);
    residentWorkspaces.add("proj-a");

    mgr.setCachedViewLimit(2);

    expect(
      mgr
        .getAllViews()
        .map((v) => v.projectId)
        .sort()
    ).toEqual(["proj-a", "proj-c"]);
  });

  it("holds at most one grant fewer than the cap, keeping the most recently used", async () => {
    // Residency spends the user's own budget rather than adding to it. With a
    // cap of 2 the active view takes one slot, so exactly one grant can be held
    // — and it is the workspace they have actually been working in.
    const mgr = makeManager(3);
    await seedThreeViews(mgr);
    residentWorkspaces.add("proj-a");
    residentWorkspaces.add("proj-b");

    mgr.setCachedViewLimit(2);

    expect(
      mgr
        .getAllViews()
        .map((v) => v.projectId)
        .sort()
    ).toEqual(["proj-b", "proj-c"]);
  });

  it("never carries the cache over the configured cap", async () => {
    // The invariant that makes this a grant and not the floor #11790 refused:
    // held grants plus the active view can never exceed `effectiveMax`, so
    // granting every workspace cannot pin the cache.
    const mgr = makeManager(3);
    await seedThreeViews(mgr);
    residentWorkspaces.add("proj-a");
    residentWorkspaces.add("proj-b");
    residentWorkspaces.add("proj-c");

    mgr.setCachedViewLimit(1);

    expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
  });

  it("yields every grant to a forced critical reclaim", async () => {
    // The pressure valve stays working. `effectiveMax` is 1 on a forced pass,
    // so the slot count reaches zero on its own — residency needs no
    // critical-pressure branch to get out of the way.
    const mgr = makeManager(3);
    mgr.setMemoryPressurePolicy({ criticalMb: 1000, warningMb: 2000 });
    setAvailableMb(2500);
    await seedThreeViews(mgr);
    residentWorkspaces.add("proj-a");
    residentWorkspaces.add("proj-b");

    expect(mgr.reclaimCachedViewsUnderPressure()).toBe(2);
    expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
  });

  it("tells the ledger which workspace it took, and why", async () => {
    // Without this the ledger mocks are unchecked and every production call
    // site could be deleted with the suite still green — while a bound session
    // would silently lose the one signal that distinguishes "evicted" from
    // "this id was never right".
    const mgr = makeManager(3);
    await seedThreeViews(mgr);

    mgr.setCachedViewLimit(2);

    expect(residencyLedger.recordWorkspaceEviction).toHaveBeenCalledWith("proj-a", "limit-change");
  });

  it("clears the ledger for a workspace that opens again", async () => {
    // The reopen half (lesson #10821): a ledger only ever written would let a
    // subscribe-then-read client settle on a loss the workspace has recovered
    // from.
    const mgr = makeManager(3);
    await seedThreeViews(mgr);

    expect(residencyLedger.clearWorkspaceEviction).toHaveBeenCalledWith("proj-b");
    expect(residencyLedger.clearWorkspaceEviction).toHaveBeenCalledWith("proj-c");
  });

  it("records the grant on the eviction it was overridden by", async () => {
    // Eviction reported rather than silent. Without this the log reads as if
    // the grant were simply ignored, instead of outranked by the cap.
    const mgr = makeManager(3);
    await seedThreeViews(mgr);
    residentWorkspaces.add("proj-a");
    residentWorkspaces.add("proj-b");

    mgr.setCachedViewLimit(2);

    expect(evictionLogFor("proj-a")).toMatchObject({ keepResident: true });
  });

  it("outranks a quiet bound session, which the client got for free", async () => {
    // `boundMcpSessionFallback` is automatic ordering any connected client
    // earns by existing; a grant is the user spending their own budget. When
    // only one can be held, the user's choice wins.
    const mgr = makeManager(3);
    await seedThreeViews(mgr);
    residentWorkspaces.add("proj-a");
    boundWorkspaces.add("proj-b");

    mgr.setCachedViewLimit(2);

    expect(
      mgr
        .getAllViews()
        .map((v) => v.projectId)
        .sort()
    ).toEqual(["proj-a", "proj-c"]);
  });

  it("does not widen an overflow another protection already caused", async () => {
    // The cap bound only means anything in composition. A live assistant's
    // floor is unconditional and already holds the cache over its cap; a grant
    // that could refuse eviction would hold a third view on top, where without
    // it the pass settles at two. Because `residentGranted` only sits last in
    // `candidates`, the grant is the one thing this pass may still take, so the
    // assistant overflows as it is entitled to and the grant adds nothing.
    // A limit of one, because at two the assistant's allowance (#12885) would
    // hold the grant as the ordinary warm view it reserves.
    const mgr = makeManager(3);
    await seedThreeViews(mgr);
    bindLiveAssistant(mgr, "proj-b", "term-assistant");
    residentWorkspaces.add("proj-a");

    mgr.setCachedViewLimit(1);

    expect(
      mgr
        .getAllViews()
        .map((v) => v.projectId)
        .sort()
    ).toEqual(["proj-b", "proj-c"]);
  });

  it("protects nothing for a grant with no live view", async () => {
    // The preference record is keyed by workspace id and nothing prunes it when
    // a project is deleted or moved, so the grant only ever meets a view that
    // actually exists — a stale row cannot hold the cache open (#11162).
    const mgr = makeManager(3);
    await seedThreeViews(mgr);
    residentWorkspaces.add("proj-never-opened");

    mgr.setCachedViewLimit(2);

    expect(
      mgr
        .getAllViews()
        .map((v) => v.projectId)
        .sort()
    ).toEqual(["proj-b", "proj-c"]);
  });
});

describe("ProjectViewManager — releasing a cached view to another window (#13274)", () => {
  let win: ReturnType<typeof createMockWindow>;
  let mgr: ProjectViewManager;
  let dispatching: Set<string>;
  let bound: Set<string>;
  let mcpBroken: boolean;

  beforeEach(async () => {
    nextWebContentsId = 100;
    nextOsProcessId = 1000;
    vi.clearAllMocks();
    mockGetAllTerminals.mockReset();
    mockGetAllTerminals.mockResolvedValue([]);
    mockGetAppMetrics.mockReset();
    mockGetAppMetrics.mockReturnValue([]);
    assistantBackends.clear();
    liveTerminals.clear();
    dispatching = new Set();
    bound = new Set();
    mcpBroken = false;
    win = createMockWindow();
    mgr = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
      assistantBackendsForProject,
      isTerminalLive,
      mcpViewActivity: (workspaceId: string) => {
        if (mcpBroken) throw new Error("registry gone");
        return {
          liveBinding: bound.has(workspaceId) || dispatching.has(workspaceId),
          dispatchLease: dispatching.has(workspaceId),
        };
      },
    });
    // proj-a cached behind proj-b in front.
    const wcA = createMockWebContents();
    mgr.registerInitialView({ webContents: wcA, setBounds: vi.fn() } as never, "proj-a", "/path/a");
    await mgr.switchTo("proj-b", "/path/b");
    await flushImmediates();
  });

  afterEach(() => {
    mgr.dispose();
  });

  const wcOf = (projectId: string) =>
    mgr.getAllViews().find((v) => v.projectId === projectId)!.view
      .webContents as unknown as ReturnType<typeof createMockWebContents>;

  it("tears down a cached view and leaves the one in front alone", () => {
    const wcA = wcOf("proj-a");

    expect(mgr.releaseCachedView("proj-a")).toBe(true);

    expect(wcA.close).toHaveBeenCalled();
    expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-b"]);
    expect(mgr.getActiveProjectId()).toBe("proj-b");
  });

  it("never releases the view in front, or one it doesn't hold", () => {
    expect(mgr.canReleaseCachedView("proj-b")).toBe(false);
    expect(mgr.releaseCachedView("proj-b")).toBe(false);
    expect(mgr.releaseCachedView("proj-z")).toBe(false);
    expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-a", "proj-b"]);
  });

  it("keeps a cached view backing a running assistant", () => {
    const wcA = wcOf("proj-a");
    assistantBackends.set("proj-a", { terminalId: "t-help-a", webContentsId: wcA.id });
    liveTerminals.add("t-help-a");

    expect(mgr.releaseCachedView("proj-a")).toBe(false);
    expect(wcA.close).not.toHaveBeenCalled();

    // Once that assistant has exited, its binding no longer pins the view.
    liveTerminals.delete("t-help-a");
    expect(mgr.canReleaseCachedView("proj-a")).toBe(true);
  });

  it("keeps a cached view an MCP dispatch is still waiting on", () => {
    // A bound session that is quiet holds nothing.
    bound.add("proj-a");
    expect(mgr.canReleaseCachedView("proj-a")).toBe(true);
    dispatching.add("proj-a");
    expect(mgr.canReleaseCachedView("proj-a")).toBe(false);
  });

  it("keeps a cached view when MCP activity can't be read", () => {
    mcpBroken = true;
    expect(mgr.releaseCachedView("proj-a")).toBe(false);
    expect(mgr.getAllViews().map((v) => v.projectId)).toContain("proj-a");
  });

  it("releases a view whose assistant is pinned to another window's view", () => {
    assistantBackends.set("proj-a", { terminalId: "t-help-a", webContentsId: 9999 });
    liveTerminals.add("t-help-a");
    expect(mgr.canReleaseCachedView("proj-a")).toBe(true);
  });

  it("keeps a cached view still loading", () => {
    mgr.views.get("proj-a")!.state = "loading";
    expect(mgr.canReleaseCachedView("proj-a")).toBe(false);
  });
});

describe("ProjectViewManager — releasing views that sit unused (#14217)", () => {
  const WINDOW_ID = 7;
  let win: ReturnType<typeof createMockWindow> & { id: number };
  let boundWorkspaces: Set<string>;
  let leasedWebContentsIds: Set<number>;
  let managers: ProjectViewManager[];

  const evictionLogs = () =>
    vi
      .mocked(logInfo)
      .mock.calls.filter(([event]) => event === "projectview.eviction")
      .map(([, ctx]) => ctx as { projectId: string; reason: string; activeAgent: boolean });

  function makeManager() {
    const mgr = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      // Well above what the fixtures open, so nothing here is the cap's doing.
      cachedProjectViews: 5,
      assistantBackendsForProject,
      isTerminalLive,
      remoteAssistantLive,
      remoteAgentActive,
      remoteKeepResident,
      remoteMcpBindingLive,
      mcpViewActivity: (workspaceId: string, webContentsId: number) => ({
        liveBinding: boundWorkspaces.has(workspaceId),
        dispatchLease: leasedWebContentsIds.has(webContentsId),
      }),
    });
    managers.push(mgr);
    return mgr;
  }

  /** Three views: proj-a and proj-b cached (oldest-first), proj-c active. */
  async function seedThreeViews(mgr: ProjectViewManager) {
    const wcA = createMockWebContents();
    mgr.registerInitialView({ webContents: wcA, setBounds: vi.fn() } as never, "proj-a", "/path/a");
    await mgr.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await mgr.switchTo("proj-c", "/path/c");
    await flushImmediates();
  }

  const entryOf = (mgr: ProjectViewManager, projectId: string) => mgr.views.get(projectId)!;
  const projectIds = (mgr: ProjectViewManager) => mgr.getAllViews().map((v) => v.projectId);

  /** Leave every view, the active one included, unshown for `ms`. */
  function ageAll(mgr: ProjectViewManager, ms = IDLE_VIEW_RELEASE_MS) {
    for (const entry of mgr.views.values()) entry.lastUsed -= ms;
  }

  beforeEach(() => {
    nextWebContentsId = 100;
    nextOsProcessId = 1000;
    vi.clearAllMocks();
    mockGetAllTerminals.mockReset();
    mockGetAllTerminals.mockResolvedValue([]);
    mockGetAppMetrics.mockReset();
    mockGetAppMetrics.mockReturnValue([]);
    assistantBackends.clear();
    liveTerminals.clear();
    liveRemoteViews.clear();
    activeRemoteViews.clear();
    residentRemoteViews.clear();
    boundRemoteViews.clear();
    residentWorkspaces.clear();
    boundWorkspaces = new Set();
    leasedWebContentsIds = new Set();
    managers = [];
    _resetPanelRecoveryStateForTests();
    win = { ...createMockWindow(), id: WINDOW_ID };
  });

  afterEach(() => {
    for (const mgr of managers) mgr.dispose();
    managers = [];
    _resetPanelRecoveryStateForTests();
    vi.useRealTimers();
  });

  it("releases cached views left unshown past the threshold while the cache is under its cap", async () => {
    const mgr = makeManager();
    await seedThreeViews(mgr);
    const wcA = entryOf(mgr, "proj-a").view.webContents;
    entryOf(mgr, "proj-a").lastUsed -= IDLE_VIEW_RELEASE_MS;
    entryOf(mgr, "proj-b").lastUsed -= IDLE_VIEW_RELEASE_MS - 60_000;

    expect(mgr.evictIdleViews()).toBe(1);

    expect(projectIds(mgr)).toEqual(["proj-b", "proj-c"]);
    expect(wcA.close).toHaveBeenCalled();
    expect(evictionLogs()).toEqual([
      expect.objectContaining({ projectId: "proj-a", reason: "idle" }),
    ]);
    // The ledger an MCP session reads learns why its workspace went away.
    expect(residencyLedger.recordWorkspaceEviction).toHaveBeenCalledWith("proj-a", "idle");
  });

  it("never releases the view in front, however long it has been up", async () => {
    const mgr = makeManager();
    await seedThreeViews(mgr);
    ageAll(mgr);

    expect(mgr.evictIdleViews()).toBe(2);
    expect(projectIds(mgr)).toEqual(["proj-c"]);
  });

  it("releases views with a working agent after the ordinary ones", async () => {
    const mgr = makeManager();
    await seedThreeViews(mgr);
    mockGetAllTerminals.mockResolvedValue([
      { id: "t-a", projectId: "proj-a", agentState: "working" },
    ]);
    await mgr.initAgentStateCache(mockPtyClient as never);
    ageAll(mgr);

    mgr.evictIdleViews();

    // proj-a is the older of the two; only its agent puts it second.
    expect(evictionLogs().map(({ projectId, activeAgent }) => [projectId, activeAgent])).toEqual([
      ["proj-b", false],
      ["proj-a", true],
    ]);
  });

  describe("keeps a view the cap would only rank", () => {
    it("with a running Daintree Assistant (#11157)", async () => {
      const mgr = makeManager();
      await seedThreeViews(mgr);
      const wcA = entryOf(mgr, "proj-a").view.webContents;
      assistantBackends.set("proj-a", { terminalId: "t-help-a", webContentsId: wcA.id });
      liveTerminals.add("t-help-a");
      ageAll(mgr);

      mgr.evictIdleViews();
      expect(projectIds(mgr)).toEqual(["proj-a", "proj-c"]);
    });

    it("with a bound MCP session", async () => {
      const mgr = makeManager();
      await seedThreeViews(mgr);
      boundWorkspaces.add("proj-a");
      ageAll(mgr);

      mgr.evictIdleViews();
      expect(projectIds(mgr)).toEqual(["proj-a", "proj-c"]);
    });

    it("with an MCP dispatch in flight", async () => {
      const mgr = makeManager();
      await seedThreeViews(mgr);
      leasedWebContentsIds.add(entryOf(mgr, "proj-a").view.webContents.id);
      ageAll(mgr);

      mgr.evictIdleViews();
      expect(projectIds(mgr)).toEqual(["proj-a", "proj-c"]);
    });

    it("granted residency by the user", async () => {
      const mgr = makeManager();
      await seedThreeViews(mgr);
      residentWorkspaces.add("proj-a");
      ageAll(mgr);

      mgr.evictIdleViews();
      expect(projectIds(mgr)).toEqual(["proj-a", "proj-c"]);
    });

    it("holding work it could not recover (#14095)", async () => {
      const mgr = makeManager();
      await seedThreeViews(mgr);
      recordPanelRecoveryState(entryOf(mgr, "proj-a").view.webContents, true);
      ageAll(mgr);

      mgr.evictIdleViews();
      expect(projectIds(mgr)).toEqual(["proj-a", "proj-c"]);
    });

    it("that a dictation still needs (#14773)", async () => {
      const mgr = makeManager();
      await seedThreeViews(mgr);
      const release = holdDictationView(entryOf(mgr, "proj-a").view.webContents.id);
      ageAll(mgr);

      try {
        mgr.evictIdleViews();
        expect(projectIds(mgr)).toEqual(["proj-a", "proj-c"]);
      } finally {
        release();
      }
    });
  });

  describe("a view of a host's project", () => {
    const remoteKey = toHostScopedKey("studio-02", "proj-r");

    async function seedWithRemote(mgr: ProjectViewManager) {
      const wcA = createMockWebContents();
      mgr.registerInitialView({ webContents: wcA, setBounds: vi.fn() } as never, "proj-a", "/a");
      await mgr.switchToHostProject("studio-02", "proj-r", "/srv/r");
      await flushImmediates();
      await mgr.switchTo("proj-c", "/path/c");
      await flushImmediates();
      return entryOf(mgr, remoteKey).view.webContents;
    }

    it("is released like a local one", async () => {
      const mgr = makeManager();
      await seedWithRemote(mgr);
      ageAll(mgr);

      mgr.evictIdleViews();
      expect(projectIds(mgr)).toEqual(["proj-c"]);
      // Its residency is its host's, so this machine's ledger stays out of it.
      expect(residencyLedger.recordWorkspaceEviction).not.toHaveBeenCalledWith(
        remoteKey,
        expect.anything()
      );
    });

    it("is kept while its host reports a live assistant or a residency grant", async () => {
      const mgr = makeManager();
      const wcR = await seedWithRemote(mgr);
      ageAll(mgr);

      liveRemoteViews.add(wcR.id);
      mgr.evictIdleViews();
      expect(projectIds(mgr)).toContain(remoteKey);

      liveRemoteViews.clear();
      residentRemoteViews.add(wcR.id);
      mgr.evictIdleViews();
      expect(projectIds(mgr)).toContain(remoteKey);
    });

    it("is kept while its host reports a bound MCP session, and released once it drops (#14228)", async () => {
      const mgr = makeManager();
      const wcR = await seedWithRemote(mgr);
      ageAll(mgr);
      boundRemoteViews.add(wcR.id);

      mgr.evictIdleViews();
      expect(projectIds(mgr)).toContain(remoteKey);

      boundRemoteViews.clear();
      mgr.evictIdleViews();
      expect(projectIds(mgr)).not.toContain(remoteKey);
    });
  });

  it("waits out a switch already queued, which wins the view it is heading to", async () => {
    const mgr = makeManager();
    await seedThreeViews(mgr);
    ageAll(mgr);

    const heading = mgr.switchTo("proj-a", "/path/a");
    expect(mgr.evictIdleViews()).toBe(0);
    expect(projectIds(mgr)).toEqual(["proj-a", "proj-b", "proj-c"]);

    await heading;
    // proj-a is in front now, and proj-c was shown moments ago; only proj-b sat unused.
    expect(mgr.evictIdleViews()).toBe(1);
    expect(projectIds(mgr)).toEqual(["proj-a", "proj-c"]);
  });

  it("keeps a view a switch has claimed before it reaches the manager's queue", async () => {
    const mgr = makeManager();
    await seedThreeViews(mgr);
    ageAll(mgr);
    // The IPC switch claims its target, then awaits repository checks and the
    // pending persist before it calls `switchTo`.
    const releaseClaim = claimProjectActivation("proj-a", WINDOW_ID);

    try {
      mgr.evictIdleViews();
      expect(projectIds(mgr)).toEqual(["proj-a", "proj-c"]);
    } finally {
      releaseClaim();
    }
    mgr.evictIdleViews();
    expect(projectIds(mgr)).toEqual(["proj-c"]);
  });

  it("drops a pending soft-pressure judgement it would otherwise skew", async () => {
    const mgr = makeManager();
    await seedThreeViews(mgr);
    mgr.pendingSoftPressureEviction = { availableMbBefore: 1500, evictedResidentMb: 300 };

    mgr.evictIdleViews();
    expect(mgr.pendingSoftPressureEviction).not.toBeNull();

    ageAll(mgr);
    mgr.evictIdleViews();
    expect(mgr.pendingSoftPressureEviction).toBeNull();
  });

  it("runs on the cached-view sampler's own tick", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const mgr = makeManager();
    await seedThreeViews(mgr);
    ageAll(mgr);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(projectIds(mgr)).toEqual(["proj-c"]);
    expect(evictionLogs().every(({ reason }) => reason === "idle")).toBe(true);
  });
});

describe("ProjectViewManager — cap across windows (#14218)", () => {
  type MemInfo = { free: number; purgeable?: number; total: number };
  const originalSystemMemoryInfo = (process as unknown as { getSystemMemoryInfo?: () => MemInfo })
    .getSystemMemoryInfo;
  const stubSystemMemoryInfo = (info: MemInfo) =>
    Object.defineProperty(process, "getSystemMemoryInfo", {
      configurable: true,
      value: () => info,
    });

  let nextWindowId = 1;
  let managers: ProjectViewManager[] = [];
  let registry: {
    contexts: Array<{ services: { projectViewManager?: ProjectViewManager } }>;
    all: () => Array<{ services: { projectViewManager?: ProjectViewManager } }>;
    registerAppViewWebContents: ReturnType<typeof vi.fn>;
    unregisterAppViewWebContents: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    nextWebContentsId = 100;
    nextOsProcessId = 1000;
    vi.clearAllMocks();
    mockGetAllTerminals.mockReset();
    mockGetAllTerminals.mockResolvedValue([]);
    mockGetAppMetrics.mockReset();
    mockGetAppMetrics.mockReturnValue([]);
    assistantBackends.clear();
    liveTerminals.clear();
    managers = [];
    registry = {
      contexts: [],
      all: () => registry.contexts,
      registerAppViewWebContents: vi.fn(),
      unregisterAppViewWebContents: vi.fn(),
    };
  });

  afterEach(() => {
    for (const mgr of managers) mgr.dispose();
    Object.defineProperty(process, "getSystemMemoryInfo", {
      configurable: true,
      value: originalSystemMemoryInfo,
    });
  });

  /** A window registered in the shared registry, showing `initial` (or no project). */
  async function openWindow(initial: string | null, cap = 5) {
    const win = { ...createMockWindow(), id: nextWindowId++ };
    const mgr = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: cap,
      assistantBackendsForProject,
      isTerminalLive,
      windowRegistry: registry as never,
    });
    managers.push(mgr);
    registry.contexts.push({ services: { projectViewManager: mgr } });
    if (initial !== null) {
      const wc = createMockWebContents();
      mgr.registerInitialView(
        { webContents: wc, setBounds: vi.fn() } as never,
        initial,
        `/p/${initial}`
      );
    }
    await flushImmediates();
    return mgr;
  }

  async function show(mgr: ProjectViewManager, projectId: string) {
    await mgr.switchTo(projectId, `/p/${projectId}`);
    await flushImmediates();
  }

  const ids = (mgr: ProjectViewManager) => [...mgr.views.keys()].sort();
  const wcOf = (mgr: ProjectViewManager, projectId: string) =>
    mgr.views.get(projectId)!.view.webContents as unknown as ReturnType<
      typeof createMockWebContents
    >;

  it("evicts the oldest cached view in any window once the windows together exceed the cap", async () => {
    const a = await openWindow("a1", 4);
    await show(a, "a2");
    await show(a, "a3");
    const b = await openWindow("b1", 4);
    expect(ids(a)).toEqual(["a1", "a2", "a3"]);
    const wcA1 = wcOf(a, "a1");

    // Each window alone is well inside a cap of 4; together they reach 5.
    await show(b, "b2");

    expect(wcA1.close).toHaveBeenCalled();
    expect(ids(a)).toEqual(["a2", "a3"]);
    expect(ids(b)).toEqual(["b1", "b2"]);
  });

  it("keeps every window's current view when there are more windows than the cap", async () => {
    const a = await openWindow("a1");
    await show(a, "a2");
    const b = await openWindow("b1");
    await show(b, "b2");
    const c = await openWindow("c1");

    a.setCachedViewLimit(1);
    b.setCachedViewLimit(1);
    c.setCachedViewLimit(1);

    expect(ids(a)).toEqual(["a2"]);
    expect(ids(b)).toEqual(["b2"]);
    expect(ids(c)).toEqual(["c1"]);
  });

  it("applies the protection tiers across windows before recency", async () => {
    const a = await openWindow("a1");
    await show(a, "a2");
    const b = await openWindow("b1");
    await show(b, "b2");
    // a1 is the oldest cached view, but a working agent ranks it behind b1.
    mockGetAllTerminals.mockResolvedValue([{ id: "t-a1", projectId: "a1", agentState: "working" }]);
    await a.initAgentStateCache(mockPtyClient as never);

    b.setCachedViewLimit(3);

    expect(ids(a)).toEqual(["a1", "a2"]);
    expect(ids(b)).toEqual(["b2"]);
  });

  it("counts a project open in two windows twice, and evicts only the cached instance", async () => {
    const a = await openWindow("shared", 2);
    const b = await openWindow("shared", 2);
    const wcAShared = wcOf(a, "shared");
    const wcBShared = wcOf(b, "shared");

    await show(b, "other");

    expect(wcBShared.close).toHaveBeenCalled();
    expect(wcAShared.close).not.toHaveBeenCalled();
    expect(ids(a)).toEqual(["shared"]);
    expect(ids(b)).toEqual(["other"]);
  });

  it("admits a background restore against every window's views", async () => {
    const a = await openWindow("a1", 3);
    await show(a, "a2");
    expect(backgroundRestoreCapacity(a)).toBe("available");

    await openWindow("b1", 3);

    expect(backgroundRestoreCapacity(a)).toBe("capacity");
  });

  it("answers each memory reading once for the whole app, through the oldest window", async () => {
    // Soft band: ~2 GB available against a 3 GB warning edge.
    stubSystemMemoryInfo({ free: 2 * 1024 * 1024, purgeable: 0, total: 8 * 1024 * 1024 });
    const a = await openWindow("a1");
    await show(a, "a2");
    const b = await openWindow("b1");
    await show(b, "b2");
    for (const mgr of [a, b]) {
      mgr.setMemoryPressurePolicy({ criticalMb: 1024, warningMb: 3072 });
      mgr.pressureSampleStreak = 0;
      ageViewsPastPressureFloor(mgr);
    }
    // The other window's cached view is the app's oldest.
    b.views.get("b1")!.lastUsed -= 60_000;

    // The newer window's sampler never acts, however many readings it takes.
    for (let tick = 0; tick < 4; tick++) b.maybeEvictUnderPressure();
    expect(ids(a)).toEqual(["a1", "a2"]);
    expect(ids(b)).toEqual(["b1", "b2"]);

    // The leader confirms on its second reading and sheds one view app-wide.
    a.maybeEvictUnderPressure();
    a.maybeEvictUnderPressure();
    b.maybeEvictUnderPressure();
    expect(ids(a)).toEqual(["a1", "a2"]);
    expect(ids(b)).toEqual(["b2"]);
  });

  it("keeps reclaiming when the oldest window shows no project", async () => {
    stubSystemMemoryInfo({ free: 1100 * 1024, purgeable: 0, total: 8 * 1024 * 1024 });
    const picker = await openWindow(null);
    const b = await openWindow("b1");
    await show(b, "b2");
    for (const mgr of [picker, b]) {
      mgr.setMemoryPressurePolicy({ criticalMb: 1024, warningMb: 3072 });
      mgr.pressureSampleStreak = 0;
    }
    ageViewsPastPressureFloor(b);

    picker.maybeEvictUnderPressure();
    picker.maybeEvictUnderPressure();
    expect(ids(b)).toEqual(["b2"]);
  });

  it("leads pressure from the oldest window that has a pressure policy", async () => {
    stubSystemMemoryInfo({ free: 1100 * 1024, purgeable: 0, total: 8 * 1024 * 1024 });
    const a = await openWindow("a1");
    const b = await openWindow("b1");
    await show(b, "b2");
    b.setMemoryPressurePolicy({ criticalMb: 1024, warningMb: 3072 });
    b.pressureSampleStreak = 0;
    ageViewsPastPressureFloor(b);

    a.maybeEvictUnderPressure();
    b.maybeEvictUnderPressure();
    b.maybeEvictUnderPressure();
    expect(ids(a)).toEqual(["a1"]);
    expect(ids(b)).toEqual(["b2"]);
  });

  it("drops a demoted leader's pressure episode, backoff included", async () => {
    stubSystemMemoryInfo({ free: 1100 * 1024, purgeable: 0, total: 8 * 1024 * 1024 });
    const a = await openWindow("a1");
    const b = await openWindow("b1");
    await show(b, "b2");
    b.setMemoryPressurePolicy({ criticalMb: 1024, warningMb: 3072 });
    b.pressureSampleStreak = 1;
    b.softPressureUnproductivePasses = 2;
    b.softPressureBackoffLatched = true;

    a.setMemoryPressurePolicy({ criticalMb: 1024, warningMb: 3072 });
    b.maybeEvictUnderPressure();

    expect(b.pressureSampleStreak).toBe(0);
    expect(b.softPressureUnproductivePasses).toBe(0);
    expect(b.softPressureBackoffLatched).toBe(false);
  });

  it("hands pressure leadership to the next window when the leader closes", async () => {
    // Just inside the soft band, where its target is the current view alone.
    stubSystemMemoryInfo({ free: 1100 * 1024, purgeable: 0, total: 8 * 1024 * 1024 });
    const a = await openWindow("a1");
    const b = await openWindow("b1");
    await show(b, "b2");
    for (const mgr of [a, b]) {
      mgr.setMemoryPressurePolicy({ criticalMb: 1024, warningMb: 3072 });
      mgr.pressureSampleStreak = 0;
    }
    ageViewsPastPressureFloor(b);

    b.maybeEvictUnderPressure();
    b.maybeEvictUnderPressure();
    expect(ids(b)).toEqual(["b1", "b2"]);

    a.dispose();
    b.maybeEvictUnderPressure();
    b.maybeEvictUnderPressure();
    expect(ids(b)).toEqual(["b2"]);
  });
});
