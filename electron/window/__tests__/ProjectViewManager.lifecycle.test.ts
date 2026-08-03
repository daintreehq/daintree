/**
 * ProjectViewManager — lifecycle invariants under adversarial interleavings.
 *
 * Covers the races the other suites leave open: a queued switch superseding an
 * in-flight warm gate, destroyView (the HibernationService path, outside
 * switchChain) racing an open gate, map/registry consistency after a failed
 * cold start, low-memory pressure eviction landing mid-gate, eviction-callback
 * port accounting, and teardown resilience (disposed manager, webContents
 * getter gone per Electron #50249, throwing onViewEvicted).
 *
 * Every settled point is checked with assertLifecycleInvariants so a
 * regression in the cross-referenced manager state (views, webContentsToProject,
 * contentView children) fails loudly instead of leaking a stale view; the
 * WindowRegistry app-view index is asserted directly in the failure-path tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let nextWebContentsId = 500;

type Handler = (...args: unknown[]) => void;

interface MockWebContentsOptions {
  autoFinishLoad?: boolean;
  bootstrapProjectId?: string;
  /** `false` models a committed non-application document (the app:// 404). */
  hasAppRoot?: boolean;
}

function createMockWebContents(options?: MockWebContentsOptions) {
  const id = nextWebContentsId++;
  const autoFinishLoad = options?.autoFinishLoad ?? true;
  const bootstrapProjectId = options?.bootstrapProjectId;
  const hasAppRoot = options?.hasAppRoot ?? true;
  const handlers = new Map<string, Handler[]>();
  const onceHandlers = new Map<string, Handler[]>();
  const ipcOnceHandlers = new Map<string, Handler[]>();

  // close() marks the webContents destroyed so the invariant helper's
  // "no destroyed webContents retained" check has teeth: a regression that
  // leaves a closed view tracked in `views` fails instead of reading as live.
  let destroyed = false;
  const wc = {
    id,
    isDestroyed: vi.fn(() => destroyed),
    executeJavaScript: vi.fn((code: string) => {
      if (typeof code === "string" && code.includes("__DAINTREE_INITIAL_PROJECT__")) {
        // Undefined when no bootstrap id is configured: that is the probe's
        // legacy-mock escape hatch, and most of this suite relies on it to keep
        // the bootstrap check neutral.
        return Promise.resolve(
          bootstrapProjectId === undefined
            ? undefined
            : { projectId: bootstrapProjectId, hasAppRoot }
        );
      }
      return Promise.resolve();
    }),
    loadURL: vi.fn(() => Promise.resolve()),
    focus: vi.fn(),
    invalidate: vi.fn(),
    // Electron 42 tears the native object down synchronously inside close()
    // and emits `destroyed` in the same call — the signal a pending loadView
    // races against, so it has to be modelled here rather than only latched.
    close: vi.fn(() => {
      wc._fire("destroyed");
    }),
    reload: vi.fn(),
    send: vi.fn(),
    session: { flushStorageData: vi.fn() },
    navigationHistory: { clear: vi.fn() },
    ipc: {
      once: vi.fn((event: string, handler: Handler) => {
        const list = ipcOnceHandlers.get(event) ?? [];
        list.push(handler);
        ipcOnceHandlers.set(event, list);
      }),
    },
    on: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    once: vi.fn((event: string, handler: Handler) => {
      const list = onceHandlers.get(event) ?? [];
      list.push(handler);
      onceHandlers.set(event, list);
      if (event === "did-finish-load" && autoFinishLoad) {
        Promise.resolve().then(() => wc._fire("did-finish-load"));
      }
    }),
    removeListener: vi.fn((event: string, handler: Handler) => {
      for (const map of [handlers, onceHandlers]) {
        const list = map.get(event);
        if (!list) continue;
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      }
    }),
    setWindowOpenHandler: vi.fn(),
    setIgnoreMenuShortcuts: vi.fn(),
    // Fire one pending once-handler AND every persistent on-handler, like a
    // real EventEmitter. The persistent leg matters: setupViewHandlers wires
    // handleDidFinishLoad (→ onViewReady, the production port-broker hook)
    // via wc.on, so firing only once-handlers would silently skip it.
    _fire(event: string, ...args: unknown[]) {
      // Latched before dispatch and only ever delivered once, matching close()
      // above, so a directly-fired destruction behaves like a real one.
      if (event === "destroyed") {
        if (destroyed) return;
        destroyed = true;
      }
      const onceList = onceHandlers.get(event);
      const onceHandler = onceList?.shift();
      onceHandler?.(...args);
      for (const persistent of [...(handlers.get(event) ?? [])]) {
        persistent(...args);
      }
    },
  };
  return wc;
}

type MockWc = ReturnType<typeof createMockWebContents>;

const wcQueue = vi.hoisted(() => [] as unknown[]);

vi.mock("electron", () => {
  function MockWebContentsView() {
    const wc = wcQueue.shift();
    if (!wc) {
      throw new Error("wcQueue empty — push a mock webContents before triggering view creation");
    }
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
      getAppMetrics: vi.fn(() => []),
    },
    BrowserWindow: vi.fn(),
    WebContentsView: MockWebContentsView,
    session: { fromPartition: vi.fn(() => ({ protocol: { handle: vi.fn() } })) },
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    nativeTheme: { shouldUseDarkColors: true },
    webContents: { getAllWebContents: vi.fn(() => []) },
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
import { logWarn } from "../../utils/logger.js";
import { registerCachedViewWebContents } from "../webContentsRegistry.js";
import { resetAppMetricsSnapshotForTesting } from "../../utils/appMetricsSnapshot.js";
import { assertLifecycleInvariants, createPortLedger } from "./helpers/lifecycleInvariants.js";

const flushImmediates = () => new Promise<void>((resolve) => setImmediate(resolve));
const flushMicrotasks = async (n = 10) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

function createMockWindow() {
  const children: unknown[] = [];
  return {
    id: 1,
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    removeListener: vi.fn(),
    getContentBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
    contentView: {
      children,
      addChildView: vi.fn((view: unknown, index?: number) => {
        const existing = children.indexOf(view);
        if (existing >= 0) children.splice(existing, 1);
        if (typeof index === "number") {
          children.splice(index, 0, view);
        } else {
          children.push(view);
        }
      }),
      removeChildView: vi.fn((view: unknown) => {
        const idx = children.indexOf(view);
        if (idx >= 0) children.splice(idx, 1);
      }),
    },
    webContents: createMockWebContents(),
  };
}

function createWindowRegistryMock() {
  return {
    registerAppViewWebContents: vi.fn(),
    unregisterAppViewWebContents: vi.fn(),
  };
}

interface ProcessWithMemInfo {
  getSystemMemoryInfo?: () => { free: number; purgeable?: number; total: number };
}

const originalGetSystemMemoryInfo = (process as ProcessWithMemInfo).getSystemMemoryInfo;

function stubSystemMemoryInfo(info: { free: number; purgeable?: number; total: number }): void {
  (process as ProcessWithMemInfo).getSystemMemoryInfo = () => info;
}

function restoreSystemMemoryInfo(): void {
  if (originalGetSystemMemoryInfo === undefined) {
    delete (process as ProcessWithMemInfo).getSystemMemoryInfo;
  } else {
    (process as ProcessWithMemInfo).getSystemMemoryInfo = originalGetSystemMemoryInfo;
  }
}

interface ManagerSetup {
  manager: ProjectViewManager;
  win: ReturnType<typeof createMockWindow>;
  windowRegistry: ReturnType<typeof createWindowRegistryMock>;
  ledger: ReturnType<typeof createPortLedger>;
  onViewEvicted: ReturnType<typeof vi.fn>;
  onViewCached: ReturnType<typeof vi.fn>;
  onViewReady: ReturnType<typeof vi.fn>;
  initialWc: MockWc;
  initialView: {
    webContents: MockWc;
    setBounds: ReturnType<typeof vi.fn>;
    setVisible: ReturnType<typeof vi.fn>;
  };
}

/**
 * Manager with an initial "proj-a" view registered and attached, gates armed
 * with signal-driven timing: the soft bound fires fast (log-only) and the hard
 * bound is high enough that tests must release gates via signals — the exact
 * production path — while still bounding a missed signal so a bug can't hang
 * the suite.
 */
function createManager(opts?: {
  cachedProjectViews?: number;
  zeroGates?: boolean;
  evictedThrows?: boolean;
}): ManagerSetup {
  const win = createMockWindow();
  const windowRegistry = createWindowRegistryMock();
  const ledger = createPortLedger();
  const onViewEvicted = vi.fn((wcId: number) => {
    ledger.onViewEvicted(wcId);
    if (opts?.evictedThrows) throw new Error("port cleanup exploded");
  });
  const onViewCached = vi.fn((wcId: number) => ledger.onViewCached(wcId));
  // Mirror the main.ts wiring: onViewReady is where the worktree/workspace
  // ports are (re-)brokered for a freshly loaded view, so the ledger opens a
  // port there — during the load, not after the switch settles — which is
  // what makes the destroy-mid-gate port assertions honest.
  const onViewReady = vi.fn((wc: { id: number }) => ledger.openFor(wc.id));
  const gateMs = opts?.zeroGates
    ? { soft: 0, hard: 0 }
    : // Soft fires quickly (observability only); hard is a backstop, not the
      // release mechanism — tests resolve gates with signal* calls.
      { soft: 30, hard: 4_000 };
  const manager = new ProjectViewManager(win as never, {
    dirname: "/test",
    windowRegistry: windowRegistry as never,
    paintGateTimeoutMs: gateMs.soft,
    paintGateHardTimeoutMs: gateMs.hard,
    warmPaintGateTimeoutMs: gateMs.soft,
    warmPaintGateHardTimeoutMs: gateMs.hard,
    cachedProjectViews: opts?.cachedProjectViews ?? 3,
    onViewEvicted: onViewEvicted as never,
    onViewCached: onViewCached as never,
    onViewReady: onViewReady as never,
  });

  const initialWc = createMockWebContents();
  const initialView = { webContents: initialWc, setBounds: vi.fn(), setVisible: vi.fn() };
  win.contentView.addChildView(initialView);
  manager.registerInitialView(initialView as never, "proj-a", "/a");
  ledger.openFor(initialWc.id);

  return {
    manager,
    win,
    windowRegistry,
    ledger,
    onViewEvicted,
    onViewCached,
    onViewReady,
    initialWc,
    initialView,
  };
}

/**
 * Cold-switch and release the gate via the APP_VIEW_PAINTED fallback signal
 * (the skeleton early-reveal channel is exercised by the paintGate suite).
 * The view's port opens through the onViewReady wiring during the load.
 */
async function coldSwitch(
  setup: ManagerSetup,
  projectId: string,
  projectPath: string
): Promise<MockWc> {
  const wc = createMockWebContents();
  wcQueue.push(wc);
  const switchPromise = setup.manager.switchTo(projectId, projectPath);
  await flushMicrotasks();
  setup.manager.signalViewPainted(wc.id);
  await switchPromise;
  await flushImmediates();
  return wc;
}

/**
 * Warm-switch to an already-cached project, releasing the warm gate. The port
 * re-opens manually here because production re-brokers a reactivated view via
 * the project-switch IPC handler, not onViewReady (no reload happens).
 */
async function warmSwitch(setup: ManagerSetup, projectId: string, wc: MockWc): Promise<void> {
  const switchPromise = setup.manager.switchTo(projectId, `/${projectId}`);
  await flushMicrotasks();
  setup.manager.signalWarmViewPainted(wc.id);
  await switchPromise;
  setup.ledger.openFor(wc.id);
  await flushImmediates();
}

describe("ProjectViewManager — lifecycle invariants", () => {
  beforeEach(() => {
    nextWebContentsId = 500;
    wcQueue.length = 0;
    vi.clearAllMocks();
    resetAppMetricsSnapshotForTesting();
  });

  afterEach(() => {
    wcQueue.length = 0;
    restoreSystemMemoryInfo();
  });

  describe("superseding switches", () => {
    it("a queued switch behind an in-flight warm gate settles with the final target active and no orphaned bridge", async () => {
      const setup = createManager();
      const { manager, win, initialWc } = setup;
      const bWc = await coldSwitch(setup, "proj-b", "/b");
      await warmSwitch(setup, "proj-a", initialWc);

      // First warm switch to B opens a gate; the second switch back to A is
      // queued behind switchChain before the first gate releases.
      const first = manager.switchTo("proj-b", "/b");
      const second = manager.switchTo("proj-a", "/a");
      await flushMicrotasks();
      expect(manager.getOutgoingBridgeProjectId()).toBe("proj-a");

      manager.signalWarmViewPainted(bWc.id);
      await first;
      // The queued switch now runs its own warm gate back to A.
      await flushMicrotasks();
      manager.signalWarmViewPainted(initialWc.id);
      await second;
      await flushImmediates();

      expect(manager.getActiveProjectId()).toBe("proj-a");
      const bEntry = manager.getAllViews().find((entry) => entry.projectId === "proj-b");
      expect(bEntry?.state).toBe("cached");
      // Exactly one project view attached — the superseded bridge did not leak.
      const attachedProjectViews = win.contentView.children.filter((child) =>
        manager.getAllViews().some((entry) => entry.view === child)
      );
      expect(attachedProjectViews).toHaveLength(1);
      assertLifecycleInvariants(manager as never, win as never);
      setup.ledger.assertNoPortsForDeadViews(manager as never);
    });

    it("rapid warm A→B→A→B chain settles consistently when every gate resolves by signal", async () => {
      const setup = createManager();
      const { manager, win, initialWc } = setup;
      const bWc = await coldSwitch(setup, "proj-b", "/b");
      await warmSwitch(setup, "proj-a", initialWc);

      const p1 = manager.switchTo("proj-b", "/b");
      const p2 = manager.switchTo("proj-a", "/a");
      const p3 = manager.switchTo("proj-b", "/b");

      // Release each queued warm gate in turn as it arms.
      await flushMicrotasks();
      manager.signalWarmViewPainted(bWc.id);
      await p1;
      await flushMicrotasks();
      manager.signalWarmViewPainted(initialWc.id);
      await p2;
      await flushMicrotasks();
      manager.signalWarmViewPainted(bWc.id);
      await p3;
      await flushImmediates();

      expect(manager.getActiveProjectId()).toBe("proj-b");
      expect(
        manager
          .getAllViews()
          .map((entry) => entry.projectId)
          .sort()
      ).toEqual(["proj-a", "proj-b"]);
      assertLifecycleInvariants(manager as never, win as never);
    });
  });

  describe("destroyView racing an open gate", () => {
    it("destroying the outgoing bridge project mid-warm-gate does not resurrect it as a cached view", async () => {
      const setup = createManager();
      const { manager, win, initialWc, onViewCached } = setup;
      const bWc = await coldSwitch(setup, "proj-b", "/b");
      await warmSwitch(setup, "proj-a", initialWc);

      // Warm switch to B — A is the still-attached outgoing bridge.
      const switchPromise = manager.switchTo("proj-b", "/b");
      await flushMicrotasks();
      expect(manager.getOutgoingBridgeProjectId()).toBe("proj-a");

      // HibernationService destroys the bridge project outside switchChain.
      expect(manager.destroyView("proj-a")).toBe(true);
      expect(setup.onViewEvicted).toHaveBeenCalledWith(initialWc.id);
      onViewCached.mockClear();
      vi.mocked(registerCachedViewWebContents).mockClear();

      manager.signalWarmViewPainted(bWc.id);
      await switchPromise;
      await flushImmediates();

      // The gate's settle path must not deactivate the stale entry: no cached
      // mark for the dead renderer, no onViewCached, no state resurrection.
      expect(onViewCached).not.toHaveBeenCalledWith(initialWc.id);
      expect(vi.mocked(registerCachedViewWebContents)).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: initialWc.id })
      );
      expect(
        vi.mocked(logWarn).mock.calls.some(([event]) => event === "projectview.stale-deactivate")
      ).toBe(true);
      expect(manager.getActiveProjectId()).toBe("proj-b");
      expect(manager.getAllViews().map((entry) => entry.projectId)).toEqual(["proj-b"]);
      assertLifecycleInvariants(manager as never, win as never);
      setup.ledger.assertNoPortsForDeadViews(manager as never);
    });

    it("destroying the incoming project mid-cold-gate leaves consistent maps and closes the dead view's ports", async () => {
      const setup = createManager();
      const { manager, win } = setup;

      const bWc = createMockWebContents();
      wcQueue.push(bWc);
      const switchPromise = manager.switchTo("proj-b", "/b");
      await flushMicrotasks();
      // Load finished, gate open, incoming B is the active project.
      expect(manager.getActiveProjectId()).toBe("proj-b");

      // The load brokered a port for B (onViewReady) — destroy must close it.
      expect(setup.ledger.openIds).toContain(bWc.id);
      expect(manager.destroyView("proj-b")).toBe(true);
      expect(setup.onViewEvicted).toHaveBeenCalledWith(bWc.id);
      expect(setup.ledger.openIds).not.toContain(bWc.id);
      expect(bWc.close).toHaveBeenCalled();

      // A late paint signal from the dead renderer settles the gate without
      // reviving anything.
      manager.signalViewPainted(bWc.id);
      await switchPromise;
      await flushImmediates();

      expect(manager.getProjectIdForWebContents(bWc.id)).toBeNull();
      expect(manager.getAllViews().map((entry) => entry.projectId)).toEqual(["proj-a"]);
      assertLifecycleInvariants(manager as never, win as never);
      setup.ledger.assertNoPortsForDeadViews(manager as never);
    });
  });

  describe("failed cold start consistency", () => {
    it("a load failure after view registration rolls back every map and unregisters the WindowRegistry index", async () => {
      const setup = createManager();
      const { manager, win, windowRegistry, initialWc, onViewReady } = setup;

      const failWc = createMockWebContents({ autoFinishLoad: false });
      wcQueue.push(failWc);
      const switchPromise = manager.switchTo("proj-b", "/b");
      await flushMicrotasks();
      // Registered before the failure: WindowRegistry index saw the new view.
      expect(windowRegistry.registerAppViewWebContents).toHaveBeenCalledWith(1, failWc.id);

      failWc._fire("preload-error", {}, "/preload.cjs", new Error("preload exploded"));
      await expect(switchPromise).rejects.toThrow("preload exploded");
      await flushImmediates();

      expect(manager.getActiveProjectId()).toBe("proj-a");
      // The failed view is gone from every map, its registry index entry is
      // unregistered, and its ports were closed via onViewEvicted.
      expect(manager.getProjectIdForWebContents(failWc.id)).toBeNull();
      expect(manager.getAllViews().map((entry) => entry.projectId)).toEqual(["proj-a"]);
      expect(manager.getAllWebContentsIds()).toEqual([initialWc.id]);
      expect(windowRegistry.unregisterAppViewWebContents).toHaveBeenCalledWith(1, failWc.id);
      expect(setup.onViewEvicted).toHaveBeenCalledWith(failWc.id);
      expect(failWc.close).toHaveBeenCalled();
      // Rollback re-fires onViewReady for the restored view so per-view IPC
      // (PTY port, worktree port re-broker) re-binds to what is on screen.
      expect(onViewReady).toHaveBeenCalledTimes(1);
      expect(onViewReady).toHaveBeenCalledWith(initialWc);
      assertLifecycleInvariants(manager as never, win as never);
      setup.ledger.assertNoPortsForDeadViews(manager as never);
    });

    it("rollback re-attaches a previous view that was already detached when the failure landed", async () => {
      const setup = createManager();
      const { manager, win, initialView } = setup;

      // Model the state deactivateEntry leaves behind — removed from the view
      // tree, not merely marked hidden. The old rollback restored only the
      // app-view registration and the visibility flag, and setVisible(true) on
      // a view that is no longer in the tree composites nothing, so recovery
      // landed on a window with no attached view at all (#11635).
      win.contentView.removeChildView(initialView);
      expect(win.contentView.children).not.toContain(initialView);

      const failWc = createMockWebContents({ autoFinishLoad: false });
      wcQueue.push(failWc);
      const switchPromise = manager.switchTo("proj-b", "/b");
      await flushMicrotasks();
      failWc._fire("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND");
      await expect(switchPromise).rejects.toThrow("ERR_FILE_NOT_FOUND");
      await flushImmediates();

      expect(manager.getActiveProjectId()).toBe("proj-a");
      // Back in the tree, and exactly once — the failed view is gone and the
      // restored one is not stacked twice.
      expect(win.contentView.children).toEqual([initialView]);
      expect(initialView.setVisible).toHaveBeenCalledWith(true);
      assertLifecycleInvariants(manager as never, win as never);
      setup.ledger.assertNoPortsForDeadViews(manager as never);
    });

    it("the switch chain stays usable after a failed cold start", async () => {
      const setup = createManager();
      const { manager, win } = setup;

      const failWc = createMockWebContents({ autoFinishLoad: false });
      wcQueue.push(failWc);
      const failed = manager.switchTo("proj-b", "/b");
      await flushMicrotasks();
      failWc._fire("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND");
      await expect(failed).rejects.toThrow("ERR_FILE_NOT_FOUND");

      const cWc = await coldSwitch(setup, "proj-c", "/c");
      expect(manager.getActiveProjectId()).toBe("proj-c");
      expect(manager.getProjectIdForWebContents(cWc.id)).toBe("proj-c");
      assertLifecycleInvariants(manager as never, win as never);
    });
  });

  describe("low-memory pressure mid-gate", () => {
    it("a pressure pass during an open cold gate spares the outgoing bridge, evicts other cached views, and never mutates the user preference", async () => {
      const setup = createManager({ cachedProjectViews: 3 });
      const { manager, win, initialWc } = setup;
      const bWc = await coldSwitch(setup, "proj-b", "/b");
      const cWc = await coldSwitch(setup, "proj-c", "/c");
      // A and B cached, C active — at the cap of 3, nothing evicted yet.
      expect(manager.getAllViews()).toHaveLength(3);

      // Open a cold gate to D; C becomes the outgoing bridge.
      const dWc = createMockWebContents();
      wcQueue.push(dWc);
      const switchPromise = manager.switchTo("proj-d", "/d");
      await flushMicrotasks();
      expect(manager.getOutgoingBridgeProjectId()).toBe("proj-c");

      // Free RAM collapses below the profile floor while the gate is open.
      manager.setLowMemoryFreeThresholdMb(1024);
      stubSystemMemoryInfo({ free: 100 * 1024, total: 8 * 1024 * 1024 });
      // Two ticks, because the sampler sheds one view per pass at every band
      // since #11477 — what matters here is WHICH views it is willing to take,
      // not how fast, so drive it to its settled target.
      const tick = (manager as unknown as { maybeEvictUnderPressure: () => void })
        .maybeEvictUnderPressure;
      tick.call(manager);
      tick.call(manager);

      // The bridge (C) and the incoming active view (D) survive; A and B go.
      expect(setup.onViewEvicted).toHaveBeenCalledWith(initialWc.id);
      expect(setup.onViewEvicted).toHaveBeenCalledWith(bWc.id);
      expect(setup.onViewEvicted).not.toHaveBeenCalledWith(cWc.id);
      expect(setup.onViewEvicted).not.toHaveBeenCalledWith(dWc.id);
      // effectiveMax clamped for the pass only — the user preference is intact.
      expect(manager.getCacheConfig().maxCachedViews).toBe(3);

      manager.signalViewPainted(dWc.id);
      await switchPromise;
      await flushImmediates();

      expect(manager.getActiveProjectId()).toBe("proj-d");
      assertLifecycleInvariants(manager as never, win as never);
      setup.ledger.assertNoPortsForDeadViews(manager as never);
    });

    it("limit changes 1 → 5 → pressure pass keep the preference authoritative once pressure clears", async () => {
      const setup = createManager({ cachedProjectViews: 3, zeroGates: true });
      const { manager, win } = setup;
      await coldSwitch(setup, "proj-b", "/b");

      manager.setCachedViewLimit(1);
      await flushImmediates();
      expect(manager.getAllViews()).toHaveLength(1);
      expect(manager.getCacheConfig().maxCachedViews).toBe(1);

      manager.setCachedViewLimit(5);
      await coldSwitch(setup, "proj-c", "/c");
      await coldSwitch(setup, "proj-d", "/d");
      expect(manager.getAllViews()).toHaveLength(3);

      // Low-memory passes converge on 1 without rewriting the preference. Two
      // ticks: the sampler sheds one view per pass at every band (#11477).
      manager.setLowMemoryFreeThresholdMb(1024);
      stubSystemMemoryInfo({ free: 100 * 1024, total: 8 * 1024 * 1024 });
      const tick = (manager as unknown as { maybeEvictUnderPressure: () => void })
        .maybeEvictUnderPressure;
      tick.call(manager);
      tick.call(manager);
      expect(manager.getAllViews().map((entry) => entry.projectId)).toEqual(["proj-d"]);
      expect(manager.getCacheConfig().maxCachedViews).toBe(5);

      // Pressure clears — the user's limit of 5 governs again.
      stubSystemMemoryInfo({ free: 4 * 1024 * 1024, total: 8 * 1024 * 1024 });
      await coldSwitch(setup, "proj-e", "/e");
      await coldSwitch(setup, "proj-f", "/f");
      expect(manager.getAllViews()).toHaveLength(3);
      assertLifecycleInvariants(manager as never, win as never);
    });
  });

  describe("eviction callback port accounting", () => {
    it("LRU eviction closes ports for exactly the evicted view, before its webContents closes", async () => {
      const setup = createManager({ cachedProjectViews: 2, zeroGates: true });
      const { manager, win, initialWc, onViewEvicted } = setup;
      await coldSwitch(setup, "proj-b", "/b");
      await coldSwitch(setup, "proj-c", "/c");
      await flushImmediates();

      // Cap 2: the LRU view (initial proj-a) was evicted by the deferred pass.
      expect(onViewEvicted).toHaveBeenCalledTimes(1);
      expect(onViewEvicted).toHaveBeenCalledWith(initialWc.id);
      // Port teardown precedes webContents.close() so no producer posts into
      // a closing renderer.
      expect(onViewEvicted.mock.invocationCallOrder[0]).toBeLessThan(
        initialWc.close.mock.invocationCallOrder[0]
      );
      setup.ledger.assertNoPortsForDeadViews(manager as never);
      assertLifecycleInvariants(manager as never, win as never);
    });

    it("a throwing onViewEvicted does not abort a multi-view eviction pass or strand entries", async () => {
      const setup = createManager({ cachedProjectViews: 3, zeroGates: true, evictedThrows: true });
      const { manager, win, initialWc, onViewEvicted } = setup;
      const bWc = await coldSwitch(setup, "proj-b", "/b");
      await coldSwitch(setup, "proj-c", "/c");

      manager.setCachedViewLimit(1);
      await flushImmediates();

      // Both cached views evicted despite the first callback throwing.
      expect(onViewEvicted).toHaveBeenCalledWith(initialWc.id);
      expect(onViewEvicted).toHaveBeenCalledWith(bWc.id);
      expect(initialWc.close).toHaveBeenCalled();
      expect(bWc.close).toHaveBeenCalled();
      expect(manager.getAllViews().map((entry) => entry.projectId)).toEqual(["proj-c"]);
      assertLifecycleInvariants(manager as never, win as never);
    });
  });

  describe("teardown resilience", () => {
    it("switchTo after dispose rejects without creating a view", async () => {
      const setup = createManager({ zeroGates: true });
      const { manager } = setup;
      manager.dispose();

      const wc = createMockWebContents();
      wcQueue.push(wc);
      await expect(manager.switchTo("proj-b", "/b")).rejects.toThrow("disposed");
      // The queued mock webContents was never consumed — no view was built.
      expect(wcQueue).toHaveLength(1);
      expect(manager.getAllViews()).toEqual([]);
    });

    it("dispose during an open gate settles the in-flight switch and rejects the queued one", async () => {
      const setup = createManager();
      const { manager } = setup;

      const bWc = createMockWebContents();
      wcQueue.push(bWc);
      const inFlight = manager.switchTo("proj-b", "/b");
      const queued = manager.switchTo("proj-c", "/c");
      await flushMicrotasks();

      manager.dispose();

      await expect(inFlight).resolves.toBeDefined();
      await expect(queued).rejects.toThrow("disposed");
      expect(manager.getAllViews()).toEqual([]);
      expect(manager.getActiveProjectId()).toBeNull();
    });

    it("dispose during a pending cold load cancels it and strands nothing", async () => {
      const setup = createManager();
      const { manager, win } = setup;

      // autoFinishLoad: false — the load never completes on its own, so the
      // switch is still awaiting loadView when teardown lands. Before #11458
      // nothing settled that promise: it sat for the full hard timeout and then
      // reported a timeout that never happened.
      const bWc = createMockWebContents({ autoFinishLoad: false });
      wcQueue.push(bWc);
      const inFlight = manager.switchTo("proj-b", "/b");
      await flushMicrotasks();

      manager.dispose();

      const err = await inFlight.then(
        () => new Error("expected the in-flight switch to reject"),
        (e: unknown) => e
      );
      expect((err as { code?: string }).code).toBe("CANCELLED");
      // The cancellation branch skips rollback, so this is where a stranded
      // entry or a resurrected pointer would show up.
      expect(manager.getAllViews()).toEqual([]);
      expect(manager.getAllWebContentsIds()).toEqual([]);
      expect(manager.getActiveProjectId()).toBeNull();
      assertLifecycleInvariants(manager as never, win as never);
    });

    it("destroyView survives a view whose webContents getter is already gone (Electron #50249)", async () => {
      const setup = createManager({ zeroGates: true });
      const { manager, win, windowRegistry } = setup;
      const bWc = await coldSwitch(setup, "proj-b", "/b");
      await warmSwitch(setup, "proj-a", setup.initialWc);

      const bEntry = manager.getAllViews().find((entry) => entry.projectId === "proj-b");
      expect(bEntry).toBeDefined();
      // Simulate the destroyed-view getter: Electron 41 returns undefined.
      (bEntry!.view as unknown as { webContents?: unknown }).webContents = undefined;

      expect(manager.destroyView("proj-b")).toBe(true);

      // Cleanup still ran with the last-known id via the reverse map.
      expect(manager.getProjectIdForWebContents(bWc.id)).toBeNull();
      expect(manager.getAllWebContentsIds()).not.toContain(bWc.id);
      expect(windowRegistry.unregisterAppViewWebContents).toHaveBeenCalledWith(1, bWc.id);
      expect(setup.onViewEvicted).toHaveBeenCalledWith(bWc.id);
      expect(manager.getAllViews().map((entry) => entry.projectId)).toEqual(["proj-a"]);
      assertLifecycleInvariants(manager as never, win as never);
      setup.ledger.assertNoPortsForDeadViews(manager as never);
    });

    it("dispose cleans every view even when one entry's webContents getter is gone", async () => {
      const setup = createManager({ zeroGates: true });
      const { manager } = setup;
      const bWc = await coldSwitch(setup, "proj-b", "/b");
      const cWc = await coldSwitch(setup, "proj-c", "/c");

      const bEntry = manager.getAllViews().find((entry) => entry.projectId === "proj-b");
      (bEntry!.view as unknown as { webContents?: unknown }).webContents = undefined;

      manager.dispose();

      expect(manager.getAllViews()).toEqual([]);
      expect(manager.getAllWebContentsIds()).toEqual([]);
      // The healthy views were still closed — the broken entry didn't abort
      // the dispose loop partway.
      expect(cWc.close).toHaveBeenCalled();
      expect(setup.onViewEvicted).toHaveBeenCalledWith(bWc.id);
      expect(setup.onViewEvicted).toHaveBeenCalledWith(cWc.id);
    });
  });

  describe("multi-window isolation", () => {
    it("two managers hosting the same project keep independent views, callbacks, and teardown", async () => {
      const setupOne = createManager({ zeroGates: true });
      const setupTwo = createManager({ zeroGates: true });

      const sharedWcOne = await coldSwitch(setupOne, "proj-shared", "/shared");
      const sharedWcTwo = await coldSwitch(setupTwo, "proj-shared", "/shared");

      expect(sharedWcOne.id).not.toBe(sharedWcTwo.id);
      expect(setupOne.manager.getProjectIdForWebContents(sharedWcTwo.id)).toBeNull();
      expect(setupTwo.manager.getProjectIdForWebContents(sharedWcOne.id)).toBeNull();

      // Disposing window one leaves window two's view of the same project live.
      setupOne.manager.dispose();
      expect(setupOne.onViewEvicted).toHaveBeenCalledWith(sharedWcOne.id);
      expect(setupTwo.onViewEvicted).not.toHaveBeenCalledWith(sharedWcTwo.id);
      expect(setupTwo.manager.getActiveProjectId()).toBe("proj-shared");
      expect(sharedWcTwo.isDestroyed()).toBe(false);
      assertLifecycleInvariants(setupTwo.manager as never, setupTwo.win as never);
      setupTwo.ledger.assertNoPortsForDeadViews(setupTwo.manager as never);
    });
  });

  describe("getWorkspaceRefForWebContents (#11536)", () => {
    // Every manager here schedules a recurring memory sampler and window
    // listeners; dispose() is what clears them, so a leaked manager can fire
    // into later tests.
    const managers: ManagerSetup[] = [];
    const track = (setup: ManagerSetup): ManagerSetup => {
      managers.push(setup);
      return setup;
    };

    afterEach(() => {
      for (const setup of managers.splice(0)) {
        setup.manager.dispose();
      }
    });

    it("reports the id and path of the workspace a view belongs to", async () => {
      const setup = track(createManager());
      const bWc = await coldSwitch(setup, "proj-b", "/b");

      expect(setup.manager.getWorkspaceRefForWebContents(bWc.id)).toEqual({
        kind: "project",
        workspaceId: "proj-b",
        workspacePath: "/b",
      });
    });

    it("marks a scratch workspace as a scratch, not a project", async () => {
      // A scratch id is a dashed UUID and has no Project row, so a caller must
      // not try to resolve it through project APIs.
      const scratchId = "6f1c9d2e-4a7b-4c3d-9e8f-1a2b3c4d5e6f";
      const setup = track(createManager());
      const scratchWc = await coldSwitch(setup, scratchId, "/scratch/one");

      expect(setup.manager.getWorkspaceRefForWebContents(scratchWc.id)).toEqual({
        kind: "scratch",
        workspaceId: scratchId,
        workspacePath: "/scratch/one",
      });
    });

    it("reports a cached (deactivated) view's own workspace, not the active one", async () => {
      const setup = track(createManager());
      // Switching away leaves proj-a's view cached but still registered — an
      // in-flight MCP dispatch can settle against it after the user moves on.
      const bWc = await coldSwitch(setup, "proj-b", "/b");

      expect(setup.manager.getActiveProjectId()).toBe("proj-b");
      expect(setup.manager.getWorkspaceRefForWebContents(setup.initialWc.id)).toMatchObject({
        workspaceId: "proj-a",
        workspacePath: "/a",
      });
      expect(setup.manager.getWorkspaceRefForWebContents(bWc.id)).toMatchObject({
        workspaceId: "proj-b",
        workspacePath: "/b",
      });
    });

    it("reflects a rebound path rather than the registration-time one", async () => {
      const setup = track(createManager());
      const bWc = await coldSwitch(setup, "proj-b", "/b");

      await setup.manager.rebindProjectPath("proj-b", "/moved/b");

      expect(setup.manager.getWorkspaceRefForWebContents(bWc.id)).toMatchObject({
        workspaceId: "proj-b",
        workspacePath: "/moved/b",
      });
    });

    it("returns null for an unknown id, a foreign window's view, and after teardown", async () => {
      const setup = track(createManager());
      const other = track(createManager());
      const bWc = await coldSwitch(setup, "proj-b", "/b");

      // Positive control, so the null assertions below can't pass vacuously.
      expect(setup.manager.getWorkspaceRefForWebContents(bWc.id)).not.toBeNull();

      expect(setup.manager.getWorkspaceRefForWebContents(999_999)).toBeNull();
      // Sender-scoped: one window's manager must not answer for another's view.
      expect(other.manager.getWorkspaceRefForWebContents(bWc.id)).toBeNull();

      setup.manager.dispose();
      expect(setup.manager.getWorkspaceRefForWebContents(bWc.id)).toBeNull();
    });

    it("returns null once the view's webContents is destroyed", async () => {
      const setup = track(createManager());
      const bWc = await coldSwitch(setup, "proj-b", "/b");
      expect(setup.manager.getWorkspaceRefForWebContents(bWc.id)).not.toBeNull();

      bWc.isDestroyed.mockReturnValue(true);

      expect(setup.manager.getWorkspaceRefForWebContents(bWc.id)).toBeNull();
    });

    it("returns null when the entry no longer owns the requested webContents", async () => {
      // Pins the ownership guard: a stale reverse mapping must not attribute an
      // old webContents id to whatever view now holds that project entry.
      const setup = track(createManager());
      const bWc = await coldSwitch(setup, "proj-b", "/b");
      const staleId = bWc.id;
      expect(setup.manager.getWorkspaceRefForWebContents(staleId)).not.toBeNull();

      bWc.id = staleId + 1_000;

      expect(setup.manager.getWorkspaceRefForWebContents(staleId)).toBeNull();
    });

    it("returns null when the webContents getter is gone (Electron #50249)", async () => {
      const setup = track(createManager());
      const bWc = await coldSwitch(setup, "proj-b", "/b");
      expect(setup.manager.getWorkspaceRefForWebContents(bWc.id)).not.toBeNull();

      const entry = setup.manager.getAllViews().find((e) => e.projectId === "proj-b");
      Object.defineProperty(entry!.view, "webContents", {
        get() {
          throw new Error("webContents getter gone");
        },
      });

      expect(setup.manager.getWorkspaceRefForWebContents(bWc.id)).toBeNull();
    });
  });
});
