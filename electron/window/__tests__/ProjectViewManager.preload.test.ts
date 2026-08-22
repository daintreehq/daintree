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

// module-level side effects (deepLinkUrlQueue app.on, userData setPath) need
// the real electron app API the partial mock above does not provide.
vi.mock("../../setup/environment.js", () => ({
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

import { ProjectViewManager } from "../ProjectViewManager.js";
import { logInfo } from "../../utils/logger.js";

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

function webContentsIdFor(manager: ProjectViewManager, projectId: string): number {
  const entry = manager.getAllViews().find((v) => v.projectId === projectId);
  if (!entry) throw new Error(`no view for ${projectId}`);
  return entry.view.webContents.id;
}

function preloadDurationFor(manager: ProjectViewManager, projectId: string): number | undefined {
  return manager.getAllViews().find((v) => v.projectId === projectId)?.preloadEvalDurationMs;
}

describe("ProjectViewManager — preload eval cost (#9770)", () => {
  let manager: ProjectViewManager;
  let win: ReturnType<typeof createMockWindow>;

  beforeEach(() => {
    nextWebContentsId = 100;
    nextOsProcessId = 1000;
    vi.clearAllMocks();
    mockGetAppMetrics.mockReset();
    mockGetAppMetrics.mockReturnValue([]);
    // Preload-cost suite, not paint-gate policy: release every gate with a
    // signal so the zero-length gate can't read as the hard timeout that now
    // abandons a cold switch (#11635).
    vi.spyOn(ProjectViewManager.prototype, "waitForPaint").mockResolvedValue("signal");
    win = createMockWindow();
    manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
    });
  });

  it("records the preload duration on the matching view entry", () => {
    const viewA = { webContents: createMockWebContents(), setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    manager.recordPreloadDuration(webContentsIdFor(manager, "proj-a"), 18.5);

    expect(preloadDurationFor(manager, "proj-a")).toBe(18.5);
  });

  it("keeps the first measurement and ignores later duplicate flushes", () => {
    const viewA = { webContents: createMockWebContents(), setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");
    const wcId = webContentsIdFor(manager, "proj-a");

    manager.recordPreloadDuration(wcId, 18.5);
    manager.recordPreloadDuration(wcId, 999);

    expect(preloadDurationFor(manager, "proj-a")).toBe(18.5);
  });

  it("no-ops for an unknown webContents id", () => {
    const viewA = { webContents: createMockWebContents(), setBounds: vi.fn() };
    manager.registerInitialView(viewA as never, "proj-a", "/path/a");

    expect(() => manager.recordPreloadDuration(999_999, 42)).not.toThrow();
    expect(preloadDurationFor(manager, "proj-a")).toBeUndefined();
  });

  it("no-ops for a flush that races in after the view was evicted", async () => {
    const evictingManager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 2,
    });
    const viewA = { webContents: createMockWebContents(), setBounds: vi.fn() };
    evictingManager.registerInitialView(viewA as never, "proj-a", "/path/a");
    const staleWcId = webContentsIdFor(evictingManager, "proj-a");

    // Evict proj-a (its webContents → project mapping is torn down).
    await evictingManager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await evictingManager.switchTo("proj-c", "/path/c");
    await flushImmediates();

    expect(() => evictingManager.recordPreloadDuration(staleWcId, 42)).not.toThrow();
    expect(evictingManager.getProjectIdForWebContents(staleWcId)).toBeNull();
  });

  // A cache limit of 2 forces proj-a to be evicted (and carry an eviction
  // timestamp), then re-cached, so a later cache hit fires the revival log.
  function makeRevivalManager(): ProjectViewManager {
    return new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 2,
    });
  }

  it("surfaces the preload duration in the projectview.revival log when recorded", async () => {
    const revivalManager = makeRevivalManager();
    const viewA = { webContents: createMockWebContents(), setBounds: vi.fn() };
    revivalManager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await revivalManager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await revivalManager.switchTo("proj-c", "/path/c"); // evicts proj-a (ET set)
    await flushImmediates();
    await revivalManager.switchTo("proj-a", "/path/a"); // cold start — proj-a re-created
    await flushImmediates();

    revivalManager.recordPreloadDuration(webContentsIdFor(revivalManager, "proj-a"), 27.5);

    // A cache hit on proj-a (still carrying its eviction timestamp) fires revival.
    await revivalManager.switchTo("proj-c", "/path/c");
    await flushImmediates();
    await revivalManager.switchTo("proj-a", "/path/a");
    await flushImmediates();

    const revivals = (logInfo as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([event, ctx]) =>
        event === "projectview.revival" && (ctx as { projectId?: string }).projectId === "proj-a"
    );
    expect(revivals).toHaveLength(1);
    expect((revivals[0][1] as Record<string, unknown>).preloadEvalDurationMs).toBe(27.5);
  });

  it("omits preloadEvalDurationMs from the revival log when none was recorded", async () => {
    const revivalManager = makeRevivalManager();
    const viewA = { webContents: createMockWebContents(), setBounds: vi.fn() };
    revivalManager.registerInitialView(viewA as never, "proj-a", "/path/a");

    await revivalManager.switchTo("proj-b", "/path/b");
    await flushImmediates();
    await revivalManager.switchTo("proj-c", "/path/c");
    await flushImmediates();
    await revivalManager.switchTo("proj-a", "/path/a");
    await flushImmediates();
    await revivalManager.switchTo("proj-c", "/path/c");
    await flushImmediates();
    await revivalManager.switchTo("proj-a", "/path/a");
    await flushImmediates();

    const revival = (logInfo as ReturnType<typeof vi.fn>).mock.calls.find(
      ([event, ctx]) =>
        event === "projectview.revival" && (ctx as { projectId?: string }).projectId === "proj-a"
    );
    expect(revival).toBeDefined();
    expect(revival?.[1] as Record<string, unknown>).not.toHaveProperty("preloadEvalDurationMs");
  });
});
