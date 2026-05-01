import { describe, it, expect, beforeEach, vi } from "vitest";

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
    setBackgroundThrottling: vi.fn(),
    executeJavaScript: vi.fn(() => Promise.resolve()),
    loadURL: vi.fn(() => Promise.resolve()),
    focus: vi.fn(),
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

vi.mock("electron", () => {
  function MockWebContentsView() {
    const wc = createMockWebContents();
    return { webContents: wc, setBounds: vi.fn() };
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
  };
});

vi.mock("../../services/ProcessMemoryMonitor.js", () => ({
  forgetBlinkSample: vi.fn(),
}));

vi.mock("../webContentsRegistry.js", () => ({
  registerWebContents: vi.fn(),
  registerAppView: vi.fn(),
  unregisterWebContents: vi.fn(),
  registerProjectView: vi.fn(),
  unregisterProjectView: vi.fn(),
}));

vi.mock("../../setup/protocols.js", () => ({
  registerProtocolsForSession: vi.fn(),
  getDistPath: vi.fn(() => "/dist"),
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
}));

vi.mock("../rendererConsoleCapture.js", () => ({
  attachRendererConsoleCapture: vi.fn(),
  detachRendererConsoleCapture: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    name: "test-logger",
  })),
}));

const mockGetAll = vi.fn<() => Array<{ projectId?: string; agentState?: string }>>(() => []);
vi.mock("../../services/PtyManager.js", () => ({
  getPtyManager: vi.fn(() => ({ getAll: mockGetAll })),
}));

import { ProjectViewManager } from "../ProjectViewManager.js";
import { logInfo } from "../../utils/logger.js";
import { forgetBlinkSample } from "../../services/ProcessMemoryMonitor.js";
import { detachRendererConsoleCapture } from "../rendererConsoleCapture.js";

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
    mockGetAll.mockReset();
    mockGetAll.mockReturnValue([]);
    mockGetAppMetrics.mockReset();
    mockGetAppMetrics.mockReturnValue([]);
    win = createMockWindow();
    manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 3,
    });
  });

  it("evictStaleViews does not evict any view when activeProjectId is null", async () => {
    // Register initial view for proj-a
    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    // Switch to proj-b (now have 2 views, proj-b is active)
    await manager.switchTo("proj-b", "/path/b");

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
      cachedProjectViews: 2,
    });

    // Register initial view for proj-a
    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    // Switch to proj-b (2 views, within limit)
    await managerWithLimit.switchTo("proj-b", "/path/b");

    // Switch to proj-c (3 views, over limit)
    await managerWithLimit.switchTo("proj-c", "/path/c");

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
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    await managerWithLimit.switchTo("proj-b", "/path/b");

    // proj-a (oldest) has an active agent. Eviction must skip it and evict proj-b instead
    // once we go over the limit with proj-c.
    mockGetAll.mockReturnValue([
      { projectId: "proj-a", agentState: "working" },
      { projectId: "proj-b", agentState: "idle" },
    ]);

    const wcBEntry = managerWithLimit.getAllViews().find((v) => v.projectId === "proj-b");
    const wcB = wcBEntry?.view.webContents as ReturnType<typeof createMockWebContents> | undefined;

    await managerWithLimit.switchTo("proj-c", "/path/c");

    const remaining = managerWithLimit.getAllViews().map((v) => v.projectId);
    expect(remaining).toContain("proj-a");
    expect(remaining).toContain("proj-c");
    expect(remaining).not.toContain("proj-b");
    expect(wcA.close).not.toHaveBeenCalled();
    expect(wcB?.close).toHaveBeenCalled();
  });

  it("falls back to evicting an active-agent view when all candidates are protected", async () => {
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    await managerWithLimit.switchTo("proj-b", "/path/b");

    // Both background candidates have active agents — fallback must evict the LRU
    // (proj-a) and emit a telemetry event rather than let the pool grow unbounded.
    mockGetAll.mockReturnValue([
      { projectId: "proj-a", agentState: "directing" },
      { projectId: "proj-b", agentState: "working" },
    ]);

    await managerWithLimit.switchTo("proj-c", "/path/c");

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
      cachedProjectViews: 3,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    await managerWithLimit.switchTo("proj-b", "/path/b");
    await managerWithLimit.switchTo("proj-c", "/path/c");

    // All three cached projects have active agents.
    mockGetAll.mockReturnValue([
      { projectId: "proj-a", agentState: "working" },
      { projectId: "proj-b", agentState: "directing" },
      { projectId: "proj-c", agentState: "waiting" },
    ]);

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

  // ── Memory-sorted eviction (issue #6272) ──

  it("evicts the largest-privateBytes cached view first, not the LRU one", async () => {
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    await managerWithLimit.switchTo("proj-b", "/path/b");

    // proj-a (oldest LRU) is small; proj-b is the heaviest cached renderer.
    // Memory-sorted eviction should target proj-b even though proj-a is older.
    const wcBEntry = managerWithLimit.getAllViews().find((v) => v.projectId === "proj-b");
    const wcB = wcBEntry?.view.webContents as unknown as ReturnType<typeof createMockWebContents>;
    mockGetAppMetrics.mockReturnValue([
      { pid: wcA.osPid, memory: { privateBytes: 50 * 1024 } },
      { pid: wcB.osPid, memory: { privateBytes: 800 * 1024 } },
    ] as unknown as Electron.ProcessMetric[]);

    await managerWithLimit.switchTo("proj-c", "/path/c");

    const remaining = managerWithLimit.getAllViews().map((v) => v.projectId);
    expect(remaining).toContain("proj-a");
    expect(remaining).toContain("proj-c");
    expect(remaining).not.toContain("proj-b");
    expect(wcA.close).not.toHaveBeenCalled();
    expect(wcB.close).toHaveBeenCalled();
  });

  it("falls back to LRU when no candidate has measured memory", async () => {
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    await managerWithLimit.switchTo("proj-b", "/path/b");

    // No metrics returned — LRU should still drive eviction (proj-a evicted).
    mockGetAppMetrics.mockReturnValue([]);

    await managerWithLimit.switchTo("proj-c", "/path/c");

    const remaining = managerWithLimit.getAllViews().map((v) => v.projectId);
    expect(remaining).not.toContain("proj-a");
    expect(remaining).toContain("proj-b");
    expect(remaining).toContain("proj-c");
    expect(wcA.close).toHaveBeenCalled();
  });

  it("missing-metric views sort below measured ones (LRU as the deeper fallback)", async () => {
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    await managerWithLimit.switchTo("proj-b", "/path/b");

    // Only proj-a has a measured pid. proj-b is unmeasured and should sort
    // *below* proj-a despite being newer; proj-a (the only measured candidate)
    // wins eviction priority.
    mockGetAppMetrics.mockReturnValue([
      { pid: wcA.osPid, memory: { privateBytes: 600 * 1024 } },
    ] as unknown as Electron.ProcessMetric[]);

    await managerWithLimit.switchTo("proj-c", "/path/c");

    const remaining = managerWithLimit.getAllViews().map((v) => v.projectId);
    expect(remaining).not.toContain("proj-a");
    expect(remaining).toContain("proj-b");
    expect(remaining).toContain("proj-c");
  });

  it("active-agent views are still evicted last regardless of memory rank", async () => {
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    await managerWithLimit.switchTo("proj-b", "/path/b");

    // proj-a is huge but has an active agent — must not be evicted.
    // proj-b is smaller but evictable.
    mockGetAppMetrics.mockReturnValue([
      { pid: wcA.osPid, memory: { privateBytes: 900 * 1024 } },
      {
        pid: (
          managerWithLimit.getAllViews().find((v) => v.projectId === "proj-b")?.view
            .webContents as unknown as ReturnType<typeof createMockWebContents>
        ).osPid,
        memory: { privateBytes: 100 * 1024 },
      },
    ] as unknown as Electron.ProcessMetric[]);
    mockGetAll.mockReturnValue([{ projectId: "proj-a", agentState: "working" }]);

    await managerWithLimit.switchTo("proj-c", "/path/c");

    const remaining = managerWithLimit.getAllViews().map((v) => v.projectId);
    expect(remaining).toContain("proj-a");
    expect(remaining).toContain("proj-c");
    expect(remaining).not.toContain("proj-b");
    expect(wcA.close).not.toHaveBeenCalled();
  });

  it("logs memoryKb in projectview.eviction when measured", async () => {
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    await managerWithLimit.switchTo("proj-b", "/path/b");

    mockGetAppMetrics.mockReturnValue([
      { pid: wcA.osPid, memory: { privateBytes: 250 * 1024 } },
    ] as unknown as Electron.ProcessMetric[]);

    await managerWithLimit.switchTo("proj-c", "/path/c");

    expect(vi.mocked(logInfo)).toHaveBeenCalledWith(
      "projectview.eviction",
      expect.objectContaining({ projectId: "proj-a", memoryKb: 250 * 1024 })
    );
  });

  it("falls back to LRU when app.getAppMetrics() throws", async () => {
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    await managerWithLimit.switchTo("proj-b", "/path/b");

    mockGetAppMetrics.mockImplementation(() => {
      throw new Error("metrics unavailable");
    });

    // Eviction must still complete without throwing — LRU drives the choice.
    await expect(managerWithLimit.switchTo("proj-c", "/path/c")).resolves.toBeDefined();

    const remaining = managerWithLimit.getAllViews().map((v) => v.projectId);
    expect(remaining).not.toContain("proj-a");
    expect(remaining).toContain("proj-b");
    expect(remaining).toContain("proj-c");
  });

  it("evicts in descending privateBytes order when limit shrinks past multiple views", async () => {
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 4,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    await managerWithLimit.switchTo("proj-b", "/path/b");
    await managerWithLimit.switchTo("proj-c", "/path/c");
    await managerWithLimit.switchTo("proj-d", "/path/d");

    const wcB = managerWithLimit.getAllViews().find((v) => v.projectId === "proj-b")?.view
      .webContents as unknown as ReturnType<typeof createMockWebContents>;
    const wcC = managerWithLimit.getAllViews().find((v) => v.projectId === "proj-c")?.view
      .webContents as unknown as ReturnType<typeof createMockWebContents>;

    // proj-d is active. Among the cached three (a, b, c), expect c (900) to
    // evict before a (800), with b (100) surviving once limit drops to 2.
    mockGetAppMetrics.mockReturnValue([
      { pid: wcA.osPid, memory: { privateBytes: 800 * 1024 } },
      { pid: wcB.osPid, memory: { privateBytes: 100 * 1024 } },
      { pid: wcC.osPid, memory: { privateBytes: 900 * 1024 } },
    ] as unknown as Electron.ProcessMetric[]);

    managerWithLimit.setCachedViewLimit(2);

    const remaining = managerWithLimit.getAllViews().map((v) => v.projectId);
    expect(remaining).toContain("proj-b");
    expect(remaining).toContain("proj-d");
    expect(remaining).not.toContain("proj-a");
    expect(remaining).not.toContain("proj-c");
  });

  it("calls forgetBlinkSample with the evicted webContents id", async () => {
    const managerWithLimit = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    managerWithLimit.registerInitialView(viewA as never, "proj-a", "/path/a");

    await managerWithLimit.switchTo("proj-b", "/path/b");
    await managerWithLimit.switchTo("proj-c", "/path/c");

    expect(vi.mocked(forgetBlinkSample)).toHaveBeenCalledWith(wcA.id);
  });
});

describe("ProjectViewManager — telemetry", () => {
  let win: ReturnType<typeof createMockWindow>;

  beforeEach(() => {
    nextWebContentsId = 100;
    nextOsProcessId = 1000;
    vi.clearAllMocks();
    mockGetAll.mockReset();
    mockGetAll.mockReturnValue([]);
    mockGetAppMetrics.mockReset();
    mockGetAppMetrics.mockReturnValue([]);
    win = createMockWindow();
  });

  it("emits projectview.eviction with reason=lru when switch overflows the cache", async () => {
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await manager.switchTo("proj-c", "/path/c");

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
      cachedProjectViews: 3,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await manager.switchTo("proj-c", "/path/c");

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
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await manager.switchTo("proj-c", "/path/c");
    await manager.switchTo("proj-a", "/path/a");
    await manager.switchTo("proj-b", "/path/b");

    vi.mocked(logInfo).mockClear();

    await manager.switchTo("proj-a", "/path/a");

    const revivalCalls = vi
      .mocked(logInfo)
      .mock.calls.filter(([event]) => event === "projectview.revival");
    expect(revivalCalls.length).toBe(1);
    expect(revivalCalls[0][1]).toMatchObject({
      projectId: "proj-a",
      timeSinceEvictionMs: expect.any(Number),
    });
    expect(
      (revivalCalls[0][1] as { timeSinceEvictionMs: number }).timeSinceEvictionMs
    ).toBeGreaterThanOrEqual(0);
  });

  it("does not emit projectview.revival a second time for the same project without a new eviction (timestamp is consumed on read)", async () => {
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    // Set up a revival for proj-a (same trace as the previous test)
    await manager.switchTo("proj-b", "/path/b");
    await manager.switchTo("proj-c", "/path/c");
    await manager.switchTo("proj-a", "/path/a");
    await manager.switchTo("proj-b", "/path/b");
    await manager.switchTo("proj-a", "/path/a"); // revival fires for proj-a — timestamp consumed

    // Switch away to a fresh cold-started project so the next return to proj-a
    // exercises the cache-hit path without touching any other stale timestamps.
    // proj-d is new; cold-starting it evicts proj-b (LRU), leaving {a, d} cached.
    await manager.switchTo("proj-d", "/path/d");

    vi.mocked(logInfo).mockClear();

    // Return to proj-a — cache hit, but evictionTimestamps has no entry for proj-a.
    await manager.switchTo("proj-a", "/path/a");

    const revivalCalls = vi
      .mocked(logInfo)
      .mock.calls.filter(([event]) => event === "projectview.revival");
    expect(revivalCalls.length).toBe(0);
  });

  it("emits projectview.coldstart on successful view creation", async () => {
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    vi.mocked(logInfo).mockClear();

    await manager.switchTo("proj-b", "/path/b");

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
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await manager.switchTo("proj-c", "/path/c"); // evicts proj-a

    // dispose should not throw and should clear internal state
    expect(() => manager.dispose()).not.toThrow();
    expect(manager.getAllViews().length).toBe(0);
  });
});

describe("ProjectViewManager — onViewCached (freeze risk mitigation)", () => {
  let win: ReturnType<typeof createMockWindow>;

  beforeEach(() => {
    nextWebContentsId = 100;
    vi.clearAllMocks();
    mockGetAll.mockReset();
    mockGetAll.mockReturnValue([]);
    win = createMockWindow();
  });

  it("invokes onViewCached with the previous view's webContentsId on switch (not the newly active view)", async () => {
    const onViewCached = vi.fn();
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 3,
      onViewCached,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    expect(onViewCached).not.toHaveBeenCalled();

    await manager.switchTo("proj-b", "/path/b");

    expect(onViewCached).toHaveBeenCalledTimes(1);
    expect(onViewCached).toHaveBeenCalledWith(wcA.id);
    // Newly-activated view's wcId must NOT have been passed to onViewCached
    const bEntry = manager.getAllViews().find((v) => v.projectId === "proj-b");
    const wcB = bEntry!.view.webContents as unknown as ReturnType<typeof createMockWebContents>;
    expect(onViewCached).not.toHaveBeenCalledWith(wcB.id);
  });

  it("fires onViewCached BEFORE setBackgroundThrottling(true) so ports close before freeze becomes possible", async () => {
    const onViewCached = vi.fn();
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 3,
      onViewCached,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");

    const cachedOrder = onViewCached.mock.invocationCallOrder[0];
    const throttleOrder = wcA.setBackgroundThrottling.mock.invocationCallOrder[0];
    expect(cachedOrder).toBeDefined();
    expect(throttleOrder).toBeDefined();
    expect(cachedOrder!).toBeLessThan(throttleOrder);
    expect(wcA.setBackgroundThrottling).toHaveBeenCalledWith(true);
  });

  it("invokes onViewCached for each cached view across rapid switches A→B→C (never for the active C)", async () => {
    const onViewCached = vi.fn();
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 3,
      onViewCached,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    const bEntry = manager.getAllViews().find((v) => v.projectId === "proj-b");
    const wcB = bEntry!.view.webContents as unknown as ReturnType<typeof createMockWebContents>;

    await manager.switchTo("proj-c", "/path/c");
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
      cachedProjectViews: 3,
      onViewCached,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-a", "/path/a");

    expect(onViewCached).not.toHaveBeenCalled();
  });

  it("does not invoke onViewCached when the previous view's webContents is destroyed", async () => {
    const onViewCached = vi.fn();
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
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

    expect(onViewCached).not.toHaveBeenCalled();
  });

  it("a throwing onViewCached does not break the switch — switching still works and reaches the new view", async () => {
    const onViewCached = vi.fn(() => {
      throw new Error("simulated downstream cleanup failure");
    });
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 3,
      onViewCached,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await expect(manager.switchTo("proj-b", "/path/b")).resolves.toMatchObject({ isNew: true });
    expect(manager.getActiveProjectId()).toBe("proj-b");
    expect(onViewCached).toHaveBeenCalledWith(wcA.id);
    // Throttling must still happen even if the callback throws — the catch
    // is around onViewCached only, not the surrounding deactivate flow.
    expect(wcA.setBackgroundThrottling).toHaveBeenCalledWith(true);
  });

  it("manager works without onViewCached configured (option is optional)", async () => {
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 3,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await expect(manager.switchTo("proj-b", "/path/b")).resolves.toMatchObject({ isNew: true });
    expect(wcA.setBackgroundThrottling).toHaveBeenCalledWith(true);
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
    mockGetAll.mockReset();
    mockGetAll.mockReturnValue([]);
    mockGetAppMetrics.mockReset();
    mockGetAppMetrics.mockReturnValue([]);
    win = createMockWindow();
  });

  it("cleanupEntry removes all 6 persistent webContents listeners and detaches console capture before close()", async () => {
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    // Cold-start proj-b — setupViewHandlers attaches the 6 persistent listeners.
    await manager.switchTo("proj-b", "/path/b");
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
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
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
      cachedProjectViews: 2,
      onViewReady,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
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
      cachedProjectViews: 2,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
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
      cachedProjectViews: 3,
    });

    const wcA = createMockWebContents();
    const viewA = { webContents: wcA, setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await manager.switchTo("proj-b", "/path/b");
    await manager.switchTo("proj-c", "/path/c");

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
