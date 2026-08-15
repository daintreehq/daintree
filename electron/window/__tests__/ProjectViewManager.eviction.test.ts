import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
    },
    BrowserWindow: vi.fn(),
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
  getCrashRecoveryService: vi.fn(() => ({ recordCrash: vi.fn() })),
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
  throttleCpuWebContents: vi.fn().mockResolvedValue(undefined),
  unthrottleCpuWebContents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
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
const assistantBackendForProject = (projectId: string) => assistantBackends.get(projectId) ?? null;
const isTerminalLive = (terminalId: string): boolean => liveTerminals.has(terminalId);

import { ProjectViewManager } from "../ProjectViewManager.js";
import { events } from "../../services/events.js";
import { logInfo } from "../../utils/logger.js";
import { forgetBlinkSample, forgetEluSample } from "../../services/ProcessMemoryMonitor.js";
import { detachRendererConsoleCapture } from "../rendererConsoleCapture.js";
import {
  throttleCpuWebContents,
  unthrottleCpuWebContents,
} from "../../utils/webContentsLifecycle.js";
import { resetAppMetricsSnapshotForTesting } from "../../utils/appMetricsSnapshot.js";

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

function createMockWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    removeListener: vi.fn(),
    getContentBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
    contentView: {
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
    win = createMockWindow();
    manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
      assistantBackendForProject,
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
      // The live WebContentsView must never leak through the projection.
      expect(invC).not.toHaveProperty("view");
    });

    it("getCacheConfig reflects the active project and the cache limit", async () => {
      await manager.switchTo("proj-b", "/path/b");
      await flushImmediates();

      expect(manager.getCacheConfig().activeProjectId).toBe("proj-b");
      // Constructed with cachedProjectViews: 3.
      expect(manager.getCacheConfig().maxCachedViews).toBe(3);

      manager.setCachedViewLimit(2);
      expect(manager.getCacheConfig().maxCachedViews).toBe(2);
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

  it("setCachedViewLimit clamps values to [1, 5]", async () => {
    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    // Call with 0 -- should not throw and should be clamped to 1
    expect(() => manager.setCachedViewLimit(0)).not.toThrow();

    // Call with 10 -- should not throw and should be clamped to 5
    expect(() => manager.setCachedViewLimit(10)).not.toThrow();
  });

  it("evictStaleViews still evicts LRU cached views when activeProjectId is set", async () => {
    // Create a manager with cachedProjectViews: 2
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 2,
    });

    // Register initial view for proj-a
    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    // Switch to proj-b (2 views, within limit)
    await managerWithLimit.switchTo("proj-b", "/path/b");
    await flushImmediates();

    // Switch to proj-c (3 views, over limit)
    await managerWithLimit.switchTo("proj-c", "/path/c");
    await flushImmediates();

    // proj-a should have been evicted (getAllViews has 2 entries for proj-b and proj-c)
    const views = managerWithLimit.getAllViews();
    expect(views.length).toBe(2);

    // proj-c is active
    expect(managerWithLimit.getActiveProjectId()).toBe("proj-c");

    // proj-a was evicted, so wcA.close should have been called
    expect(wcA.close).toHaveBeenCalled();

    // proj-b should still be cached (getAllViews includes it)
    const viewIds = views.map((v) => v.projectId || "");
    expect(viewIds).toContain("proj-b");
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
        assistantBackendForProject,
        isTerminalLive,
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

      await managerWithLimit.switchTo("proj-c", "/path/c");
      await flushImmediates();

      const remaining = managerWithLimit.getAllViews().map((v) => v.projectId);
      expect(remaining).toContain("proj-a");
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
          effectiveMax: 2,
          overflow: 1,
          protectedProjectIds: ["proj-a", "proj-b"],
        })
      );
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
      expect(assistantBackendForProject("proj-a")).not.toBeNull();

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
      dateNow.mockRestore();
    }
  });

  it("falls back to LRU when no candidate has measured memory", async () => {
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

    // No metrics returned — LRU should still drive eviction (proj-a evicted).
    mockGetAppMetrics.mockReturnValue([]);

    await managerWithLimit.switchTo("proj-c", "/path/c");
    await flushImmediates();

    const remaining = managerWithLimit.getAllViews().map((v) => v.projectId);
    expect(remaining).not.toContain("proj-a");
    expect(remaining).toContain("proj-b");
    expect(remaining).toContain("proj-c");
    expect(wcA.close).toHaveBeenCalled();
  });

  it("evicts the LRU view even when only some candidates have measured memory", async () => {
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

    // Only proj-a has a measured pid; proj-b is unmeasured. Memory data does
    // not influence the sort — proj-a is the LRU pick and wins eviction
    // priority regardless of which side has metrics.
    mockGetAppMetrics.mockReturnValue([
      { pid: wcA.osPid, memory: { workingSetSize: 600 * 1024, privateBytes: 0 } },
    ] as unknown as Electron.ProcessMetric[]);

    await managerWithLimit.switchTo("proj-c", "/path/c");
    await flushImmediates();

    const remaining = managerWithLimit.getAllViews().map((v) => v.projectId);
    expect(remaining).not.toContain("proj-a");
    expect(remaining).toContain("proj-b");
    expect(remaining).toContain("proj-c");
  });

  it("active-agent views are still evicted last regardless of LRU rank", async () => {
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

    // proj-a is huge but has an active agent — must not be evicted.
    // proj-b is smaller but evictable.
    mockGetAppMetrics.mockReturnValue([
      { pid: wcA.osPid, memory: { workingSetSize: 900 * 1024, privateBytes: 0 } },
      {
        pid: (
          managerWithLimit.getAllViews().find((v) => v.projectId === "proj-b")?.view
            .webContents as unknown as ReturnType<typeof createMockWebContents>
        ).osPid,
        memory: { workingSetSize: 100 * 1024, privateBytes: 0 },
      },
    ] as unknown as Electron.ProcessMetric[]);
    mockGetAllTerminals.mockResolvedValue([
      { id: "t-a", projectId: "proj-a", agentState: "working" },
    ]);
    await managerWithLimit.initAgentStateCache(mockPtyClient as never);

    await managerWithLimit.switchTo("proj-c", "/path/c");
    await flushImmediates();

    const remaining = managerWithLimit.getAllViews().map((v) => v.projectId);
    expect(remaining).toContain("proj-a");
    expect(remaining).toContain("proj-c");
    expect(remaining).not.toContain("proj-b");
    expect(wcA.close).not.toHaveBeenCalled();
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

  it("dispose tears down cleanly after an eviction recorded a timestamp", async () => {
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
    await manager.switchTo("proj-c", "/path/c"); // evicts proj-a
    await flushImmediates();

    // dispose should not throw and should clear internal state
    expect(() => manager.dispose()).not.toThrow();
    expect(manager.getAllViews().length).toBe(0);
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
    vi.mocked(logInfo).mockClear();

    (manager as unknown as { sampleCachedViewMemory(): void }).sampleCachedViewMemory();

    const memoryCalls = vi
      .mocked(logInfo)
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
    vi.mocked(logInfo).mockClear();

    (manager as unknown as { sampleCachedViewMemory(): void }).sampleCachedViewMemory();

    const memoryCalls = vi
      .mocked(logInfo)
      .mock.calls.filter(([event]) => event === "projectview.cached-memory");
    expect(memoryCalls.length).toBe(1);
    expect(memoryCalls[0][1]).toMatchObject({
      projectId: "proj-a",
      memoryKb: 250 * 1024,
      guestMemoryKb: 400 * 1024,
    });
  });

  it("sampleCachedViewMemory is a no-op when no views are cached", async () => {
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

    mockGetAppMetrics.mockReturnValue([
      { pid: wcA.osPid, memory: { workingSetSize: 250 * 1024, privateBytes: 0 } },
    ] as unknown as Electron.ProcessMetric[]);

    vi.mocked(logInfo).mockClear();

    (manager as unknown as { sampleCachedViewMemory(): void }).sampleCachedViewMemory();

    const memoryCalls = vi
      .mocked(logInfo)
      .mock.calls.filter(([event]) => event === "projectview.cached-memory");
    expect(memoryCalls.length).toBe(0);
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

    vi.mocked(logInfo).mockClear();

    (manager as unknown as { sampleCachedViewMemory(): void }).sampleCachedViewMemory();

    const memoryCalls = vi
      .mocked(logInfo)
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
    vi.mocked(logInfo).mockClear();
    resetAppMetricsSnapshotForTesting();

    expect(() =>
      (manager as unknown as { sampleCachedViewMemory(): void }).sampleCachedViewMemory()
    ).not.toThrow();

    const memoryCalls = vi
      .mocked(logInfo)
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
      .mocked(logInfo)
      .mock.calls.filter(([event]) => event === "projectview.cached-memory");
    expect(memoryCalls.length).toBe(0);
  });

  it("dispose cancels the cached-memory sampler", async () => {
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

    mockGetAppMetrics.mockReturnValue([
      { pid: wcA.osPid, memory: { workingSetSize: 250 * 1024, privateBytes: 0 } },
    ] as unknown as Electron.ProcessMetric[]);

    manager.dispose();

    vi.mocked(logInfo).mockClear();

    // Manually invoke the sampler post-dispose — even if a stale interval tick
    // were to fire, the sampler must not emit because views were cleared.
    (manager as unknown as { sampleCachedViewMemory(): void }).sampleCachedViewMemory();

    const memoryCalls = vi
      .mocked(logInfo)
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

  it("invokes onViewCached with the previous view's webContentsId on switch (not the newly active view)", async () => {
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

    expect(onViewCached).not.toHaveBeenCalled();

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();

    expect(onViewCached).toHaveBeenCalledTimes(1);
    expect(onViewCached).toHaveBeenCalledWith(wcA.id);
    // Newly-activated view's wcId must NOT have been passed to onViewCached
    const bEntry = manager.getAllViews().find((v) => v.projectId === "proj-b");
    const wcB = bEntry!.view.webContents as unknown as ReturnType<typeof createMockWebContents>;
    expect(onViewCached).not.toHaveBeenCalledWith(wcB.id);
  });

  it("fires onViewCached BEFORE CPU throttle so ports close before freeze becomes possible", async () => {
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

    const throttleMock = vi.mocked(throttleCpuWebContents);
    throttleMock.mockClear();

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();

    const cachedOrder = onViewCached.mock.invocationCallOrder[0];
    const throttleCall = throttleMock.mock.calls.findIndex((args) => {
      const arg = args[0] as unknown;
      return arg instanceof Object && "id" in arg && (arg as { id: number }).id === wcA.id;
    });
    const throttleOrder = throttleMock.mock.invocationCallOrder[throttleCall];
    expect(cachedOrder).toBeDefined();
    expect(throttleOrder).toBeDefined();
    expect(cachedOrder!).toBeLessThan(throttleOrder);
    expect(throttleMock).toHaveBeenCalledWith(wcA);
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

  it("does not invoke onViewCached when there is no prior active view", () => {
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

    // registerInitialView only — no prior active view to deactivate
    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    expect(onViewCached).not.toHaveBeenCalled();
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
    // CPU throttle must still happen even if the callback throws — the catch
    // is around onViewCached only, not the surrounding deactivate flow.
    expect(vi.mocked(throttleCpuWebContents)).toHaveBeenCalledWith(wcA);
  });

  it("manager works without onViewCached configured (option is optional)", async () => {
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

    await expect(manager.switchTo("proj-b", "/path/b")).resolves.toMatchObject({ isNew: true });
    await flushImmediates();
    expect(vi.mocked(throttleCpuWebContents)).toHaveBeenCalledWith(wcA);
  });

  it("throttles <webview> guests when their host view is cached and unthrottles on reactivation", async () => {
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

    expect(vi.mocked(throttleCpuWebContents)).toHaveBeenCalledWith(guest);
    expect(vi.mocked(throttleCpuWebContents)).not.toHaveBeenCalledWith(unrelated);

    // Reactivate proj-a — its guest must be unthrottled along with the host.
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

  it("evicted view's persistent handlers cannot fire onViewReady on a stale active project", async () => {
    // Regression: before cleanup, a queued did-finish-load on the evicted view
    // could land after eviction and call onViewReady() with stale wc context.
    const onViewReady = vi.fn();
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 2,
      onViewReady,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    const bEntry = manager.getAllViews().find((v) => v.projectId === "proj-b");
    const wcB = bEntry!.view.webContents as unknown as ReturnType<typeof createMockWebContents>;

    // Snapshot the persistent did-finish-load handler that setupViewHandlers attached
    // (loadView's once-listener is registered via `once`, not `on`, so it's excluded).
    const didFinishLoadHandler = wcB.on.mock.calls.find(
      ([event]) => event === "did-finish-load"
    )?.[1];
    expect(didFinishLoadHandler).toBeDefined();

    // Evict proj-b.
    manager.destroyView("proj-b");
    expect(wcB.listenerCount("did-finish-load")).toBe(0);

    onViewReady.mockClear();

    // Simulate a queued did-finish-load racing with eviction. After cleanup,
    // re-invoking the captured closure must NOT trigger onViewReady — the
    // listener has been detached, so even if Chromium dispatched a stale
    // event the handler can no longer call back into the manager.
    expect(wcB.listenerCount("did-finish-load")).toBe(0);
    expect(onViewReady).not.toHaveBeenCalled();
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
  type MemInfo = { free: number; purgeable?: number; total: number };
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
    win = createMockWindow();
    manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
      assistantBackendForProject,
      isTerminalLive,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "getSystemMemoryInfo", {
      configurable: true,
      value: originalSystemMemoryInfo,
    });
  });

  it("ignores low-memory check when threshold is null (default)", async () => {
    // Available memory well below any plausible threshold — but with threshold
    // null, eviction follows normal LRU rules only.
    stubSystemMemoryInfo({ free: 50 * 1024, purgeable: 0, total: 8 * 1024 * 1024 });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await manager.switchTo("proj-c", "/path/c");
    await flushImmediates();

    // cachedProjectViews=3, so 3 views fit — no eviction.
    expect(manager.getAllViews().length).toBe(3);
    expect(wcA.close).not.toHaveBeenCalled();
  });

  it("does not override when available memory is above threshold", async () => {
    // 2 GB free is comfortably above the 768 MB threshold.
    stubSystemMemoryInfo({ free: 2 * 1024 * 1024, purgeable: 0, total: 8 * 1024 * 1024 });
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

  it("clamps effective cap to 1 when available memory drops below threshold", async () => {
    // 128 MB available, threshold 768 MB → override active.
    stubSystemMemoryInfo({ free: 128 * 1024, purgeable: 0, total: 8 * 1024 * 1024 });
    manager.setLowMemoryFreeThresholdMb(768);

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await manager.switchTo("proj-c", "/path/c");
    await flushImmediates();

    // The switches themselves hold the user's cap of 3 — an LRU pass no longer
    // inherits pressure (#11477). The sampler is what converges on 1.
    expect(manager.getAllViews().length).toBe(3);
    tickPressureCheck(manager);
    tickPressureCheck(manager);

    const remaining = manager.getAllViews().map((v) => v.projectId);
    expect(remaining).toEqual(["proj-c"]);
    expect(wcA.close).toHaveBeenCalled();
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

    // Null threshold (performance profile): pressure check must not run.
    (manager as unknown as { maybeEvictUnderPressure(): void }).maybeEvictUnderPressure();
    expect(manager.getAllViews().length).toBe(2);

    // Threshold set but memory healthy: still a no-op.
    stubSystemMemoryInfo({ free: 2 * 1024 * 1024, purgeable: 0, total: 8 * 1024 * 1024 });
    manager.setLowMemoryFreeThresholdMb(768);
    (manager as unknown as { maybeEvictUnderPressure(): void }).maybeEvictUnderPressure();
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

    // 50 + 2*1024*1024 KB ≈ 2050 MB > 768 → no override.
    expect(manager.getAllViews().length).toBe(3);
    expect(wcA.close).not.toHaveBeenCalled();
  });

  it("does not mutate maxCachedViews — user limit returns when pressure subsides", async () => {
    stubSystemMemoryInfo({ free: 128 * 1024, purgeable: 0, total: 8 * 1024 * 1024 });
    manager.setLowMemoryFreeThresholdMb(768);

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await manager.switchTo("proj-c", "/path/c");
    await flushImmediates();
    // Sampler ticks converge on 1 (the switches hold the user's cap, #11477).
    tickPressureCheck(manager);
    tickPressureCheck(manager);
    expect(manager.getAllViews().length).toBe(1);

    // Pressure subsides
    stubSystemMemoryInfo({ free: 4 * 1024 * 1024, purgeable: 0, total: 8 * 1024 * 1024 });

    // Subsequent switches should now respect the original cap of 3
    await manager.switchTo("proj-d", "/path/d");
    await flushImmediates();
    await manager.switchTo("proj-e", "/path/e");
    await flushImmediates();
    await manager.switchTo("proj-f", "/path/f");
    await flushImmediates();
    expect(manager.getAllViews().length).toBe(3);
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

  it("falls back to normal LRU behavior when getSystemMemoryInfo is missing", async () => {
    stubSystemMemoryInfo("missing");
    manager.setLowMemoryFreeThresholdMb(768);

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await manager.switchTo("proj-c", "/path/c");
    await flushImmediates();

    // Threshold set but API missing → no override, normal LRU keeps 3 views.
    expect(manager.getAllViews().length).toBe(3);
    expect(wcA.close).not.toHaveBeenCalled();
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

  it("treats availableMb === threshold as NOT under pressure (strict <)", async () => {
    // Exactly 768 MB available, threshold 768 → no override.
    stubSystemMemoryInfo({ free: 768 * 1024, purgeable: 0, total: 8 * 1024 * 1024 });
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
    tickPressureCheck(pressureManager);
    tickPressureCheck(pressureManager);
    tickPressureCheck(pressureManager);
    expect(pressureManager.getAllViews().length).toBe(1);
    expect(onViewEvicted).toHaveBeenCalledTimes(3);
  });

  it("setLowMemoryFreeThresholdMb(null) clears a previously set threshold", async () => {
    stubSystemMemoryInfo({ free: 128 * 1024, purgeable: 0, total: 8 * 1024 * 1024 });
    manager.setLowMemoryFreeThresholdMb(768);
    manager.setLowMemoryFreeThresholdMb(null);

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await manager.switchTo("proj-c", "/path/c");
    await flushImmediates();

    // Threshold cleared — normal LRU applies, all 3 views fit.
    expect(manager.getAllViews().length).toBe(3);
    expect(wcA.close).not.toHaveBeenCalled();
  });

  it("setLowMemoryFreeThresholdMb ignores non-finite and non-positive values", async () => {
    stubSystemMemoryInfo({ free: 128 * 1024, purgeable: 0, total: 8 * 1024 * 1024 });
    manager.setLowMemoryFreeThresholdMb(768);
    manager.setLowMemoryFreeThresholdMb(NaN);
    manager.setLowMemoryFreeThresholdMb(-10);
    manager.setLowMemoryFreeThresholdMb(0);

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await manager.switchTo("proj-c", "/path/c");
    await flushImmediates();

    // All bad values normalize to null, so override is disabled.
    expect(manager.getAllViews().length).toBe(3);
    expect(wcA.close).not.toHaveBeenCalled();
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

  function makeManager(cachedProjectViews: number) {
    return new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews,
      assistantBackendForProject,
      isTerminalLive,
    });
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
    // still take only one view — this is the whole point of #11469.
    setAvailableMb(1200);
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
    // per-window and ungated, so it walks there a view at a time rather than
    // pre-empting ProcessMemoryMonitor's cooldown-gated ladder in one pass.
    setAvailableMb(BAND.criticalMb - 1);
    tickPressureCheck(manager);
    expect(manager.getAllViews().map((v) => v.projectId)).toEqual(["proj-b", "proj-c"]);
    tickPressureCheck(manager);
    expect(manager.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
    expect(evictedProjectIds()).toEqual(["proj-a", "proj-b"]);
  });

  it("the forced tier-2 reclaim still collapses the cache in one pass (#11477)", async () => {
    // The escalation the sampler no longer performs has to still exist, or the
    // graduated ladder's last rung reclaims nothing.
    const mgr = makeManager(3);
    mgr.setMemoryPressurePolicy(BAND);
    setAvailableMb(2500);
    await seedThreeViews(mgr);

    // Ample memory: `forcePressure` alone drives it, not the sampled band.
    expect(mgr.reclaimCachedViewsUnderPressure()).toBe(2);
    expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
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
    tickPressureCheck(mgr);

    expect(mgr.getAllViews().length).toBe(3);
    expect(vi.mocked(logInfo)).not.toHaveBeenCalledWith(
      "projectview.eviction-skipped",
      expect.anything()
    );
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

    setAvailableMb(BAND.warningMb);
    tickPressureCheck(manager);
    expect(manager.getAllViews().length).toBe(3);

    setAvailableMb(BAND.warningMb - 1);
    tickPressureCheck(manager);
    expect(manager.getAllViews().length).toBe(2);
  });

  it("reports the band, tier and budget on the pressure-override event", async () => {
    setAvailableMb(2500);
    await seedThreeViews(manager);

    setAvailableMb(1200);
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

    tickPressureCheck(manager);
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

  it("keeps the forced tier-2 reclaim aggressive with no band and ample memory", async () => {
    manager.setMemoryPressurePolicy(null);
    setAvailableMb(64 * 1024);
    await seedThreeViews(manager);

    expect(manager.reclaimCachedViewsUnderPressure()).toBe(2);
    expect(manager.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
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

  function makeManager(cachedProjectViews: number) {
    return new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews,
      assistantBackendForProject,
      isTerminalLive,
      mcpViewActivity: (workspaceId: string, webContentsId: number) => ({
        liveBinding: boundWorkspaces.has(workspaceId),
        dispatchLease: leasedWebContentsIds.has(webContentsId),
      }),
    });
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
    win = createMockWindow();
  });

  afterEach(() => {
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

    it("counts a lease as a transient exclusion, not as part of the assistant floor", async () => {
      // The over-cap log exists so extra resident renderers are attributable
      // rather than reading as a leak. A lease resolves on its own, like the
      // paint-gate and cold-switch bridges, so it must not inflate the
      // persistent `protectedCount` a pinned assistant reports.
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
      expect(skipped?.transientlyExcludedCount).toBe(1);
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

    it("never protects the workspace the user is actively looking at from being active", async () => {
      // The active view is excluded before any tiering, bound or not — a
      // binding must not change which view is on screen.
      const mgr = makeManager(3);
      await seedThreeViews(mgr);
      boundWorkspaces.add("proj-c");

      mgr.setCachedViewLimit(1);

      expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
    });
  });

  it("behaves exactly as before when no mcpViewActivity callback is wired", async () => {
    const mgr = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
      assistantBackendForProject,
      isTerminalLive,
    });
    await seedThreeViews(mgr);

    mgr.setCachedViewLimit(1);

    expect(mgr.getAllViews().map((v) => v.projectId)).toEqual(["proj-c"]);
  });
});
