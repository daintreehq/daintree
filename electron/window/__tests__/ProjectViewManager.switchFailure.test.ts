import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let nextWebContentsId = 200;

type Handler = (...args: unknown[]) => void;

interface MockWc {
  id: number;
  isDestroyed: ReturnType<typeof vi.fn>;
  executeJavaScript: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  setIgnoreMenuShortcuts: ReturnType<typeof vi.fn>;
  _handlers: Map<string, Handler[]>;
  _persistentHandlers: Map<string, Handler[]>;
  _fireOnce: (event: string, ...args: unknown[]) => void;
  /** Fire the persistent (`.on`) handlers setupViewHandlers registered. */
  _fireOn: (event: string, ...args: unknown[]) => void;
}

function createMockWebContents(opts?: {
  autoFinishLoad?: boolean;
  bootstrapProjectId?: string | null;
  /** `false` models a committed non-application document (the app:// 404). */
  hasAppRoot?: boolean;
}): MockWc {
  const id = nextWebContentsId++;
  const handlers = new Map<string, Handler[]>();
  const persistentHandlers = new Map<string, Handler[]>();
  const autoFinish = opts?.autoFinishLoad ?? true;
  const bootstrapProjectId = opts?.bootstrapProjectId ?? null;
  const hasAppRoot = opts?.hasAppRoot ?? true;

  // Electron 42: `close()` tears the native object down synchronously and
  // fires `destroyed` inside the call. Modelled here so teardown-during-load
  // is drivable the same way the real webContents drives it (#11458).
  let destroyed = false;

  const wc: MockWc = {
    id,
    isDestroyed: vi.fn(() => destroyed),
    executeJavaScript: vi.fn((code?: string) => {
      const script = String(code ?? "");
      if (!script.includes("__DAINTREE_INITIAL_PROJECT__")) return Promise.resolve();
      // Evaluate the probe for real against stubbed globals rather than
      // returning a hand-built result shape. The DOM lookup IS the fix for
      // #11635, so a fixture that fabricates `hasAppRoot` would keep passing if
      // production stopped asking the document and hardcoded the answer.
      const evaluate = new Function("globalThis", "document", `return ${script};`) as (
        globals: unknown,
        doc: unknown
      ) => unknown;
      return Promise.resolve(
        evaluate(
          { __DAINTREE_INITIAL_PROJECT__: bootstrapProjectId ? { id: bootstrapProjectId } : null },
          { getElementById: (id: string) => (id === "root" && hasAppRoot ? {} : null) }
        )
      );
    }),
    loadURL: vi.fn(() => Promise.resolve()),
    focus: vi.fn(),
    invalidate: vi.fn(),
    close: vi.fn(() => {
      wc._fireOnce("destroyed");
    }),
    reload: vi.fn(),
    send: vi.fn(),
    on: vi.fn((event: string, handler: Handler) => {
      if (!persistentHandlers.has(event)) persistentHandlers.set(event, []);
      persistentHandlers.get(event)!.push(handler);
    }),
    once: vi.fn((event: string, handler: Handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
      if (event === "did-finish-load" && autoFinish) {
        Promise.resolve().then(() => wc._fireOnce("did-finish-load"));
      }
    }),
    removeListener: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      }
    }),
    setWindowOpenHandler: vi.fn(),
    setIgnoreMenuShortcuts: vi.fn(),
    _handlers: handlers,
    _persistentHandlers: persistentHandlers,
    _fireOnce(event: string, ...args: unknown[]) {
      // Destruction is latched before the handlers run so anything they call
      // back into sees the same post-close state the real webContents exposes.
      if (event === "destroyed") {
        if (destroyed) return;
        destroyed = true;
      }
      const list = handlers.get(event);
      if (list && list.length > 0) {
        const h = list.shift()!;
        h(...args);
      }
    },
    _fireOn(event: string, ...args: unknown[]) {
      for (const h of [...(persistentHandlers.get(event) ?? [])]) h(...args);
    },
  };
  return wc;
}

let wcQueue: MockWc[] = [];

vi.mock("electron", () => {
  function MockWebContentsView() {
    const wc = wcQueue.shift();
    return {
      webContents: wc,
      setBounds: vi.fn(),
      setBackgroundColor: vi.fn(),
      setVisible: vi.fn(),
    };
  }
  return {
    app: { isPackaged: false, commandLine: { appendSwitch: vi.fn() } },
    BrowserWindow: vi.fn(),
    WebContentsView: MockWebContentsView,
    session: { fromPartition: vi.fn(() => ({ protocol: { handle: vi.fn() } })) },
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    nativeTheme: { shouldUseDarkColors: true },
  };
});

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
import { notifyError } from "../../ipc/errorHandlers.js";
import { logInfo, logWarn } from "../../utils/logger.js";
import { RESOURCE_PROFILE_CONFIGS } from "../../../shared/types/resourceProfile.js";

/**
 * Short stand-ins for the real 10s/30s view-load bounds so the two-phase
 * behaviour can be driven without advancing 30s of fake time. The assertions
 * below key off these, never off the production constants.
 */
const LOAD_SOFT_MS = 100;
const LOAD_HARD_MS = 300;

function softTimeoutWarnings() {
  return vi
    .mocked(logWarn)
    .mock.calls.filter(([event]) => event === "projectview.load.softtimeout");
}

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

/** Await a promise expected to reject, returning the error. Prevents unhandled-rejection noise. */
function expectRejection(promise: Promise<unknown>): Promise<Error> {
  // Two-handler form, not try/catch: catching around an `await` also catches
  // the "expected a rejection" throw itself, so a promise that RESOLVES would
  // be reported as the rejection the caller asked for.
  return promise.then(
    () => {
      throw new Error("Expected promise to reject");
    },
    (err: unknown) => err as Error
  );
}

/** The `code` discriminant a load rejection carries, or undefined for an untyped error. */
function errorCode(err: Error): string | undefined {
  return (err as { code?: string }).code;
}

/** The diagnostic `context` bag a load rejection carries (phase, projectId). */
function errorContext(err: Error): Record<string, unknown> | undefined {
  return (err as { context?: Record<string, unknown> }).context;
}

describe("ProjectViewManager — switch failure rollback", () => {
  let manager: ProjectViewManager;
  let win: ReturnType<typeof createMockWindow>;
  let initialWc: MockWc;

  beforeEach(() => {
    vi.useFakeTimers();
    nextWebContentsId = 200;
    wcQueue = [];
    vi.mocked(notifyError).mockClear();
    vi.mocked(logInfo).mockClear();
    vi.mocked(logWarn).mockClear();

    win = createMockWindow();
    manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 3,
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      viewLoadTimeoutMs: LOAD_SOFT_MS,
      viewLoadHardTimeoutMs: LOAD_HARD_MS,
    });
    // This suite exercises load failure and rollback, not paint-gate policy,
    // and drives its switches through a zero-length gate. A cold hard timeout
    // now abandons the switch (#11635), so release the gate with the signal
    // these fixtures stand in for — otherwise every test that expects the load
    // to land fails on the gate instead. The managers built inside individual
    // tests keep their real gates; `startBridgedSwitch` depends on one.
    (manager as unknown as { waitForPaint: () => Promise<string> }).waitForPaint = () =>
      Promise.resolve("signal");

    initialWc = createMockWebContents();
    const initialView = { webContents: initialWc, setBounds: vi.fn() };
    manager.registerInitialView(initialView as never, "proj-a", "/path/a");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to the balanced profile's view-load bounds", () => {
    // The manager constants are the fallback until the first resource-profile
    // push lands, so a drift between them and the balanced profile would
    // silently change cold-switch behaviour for the window's first switch.
    const defaultManager = new ProjectViewManager(win as never, { dirname: "/test" });
    expect(defaultManager.viewLoadTimeoutMs).toBe(
      RESOURCE_PROFILE_CONFIGS.balanced.viewLoadTimeoutMs
    );
    expect(defaultManager.viewLoadHardTimeoutMs).toBe(
      RESOURCE_PROFILE_CONFIGS.balanced.viewLoadHardTimeoutMs
    );
  });

  it("leaves no load timer armed once the load settles", async () => {
    // Both timers must be cleared on settle. Without an explicit inventory
    // check a leaked hard timer is invisible: its callback just hits the
    // `settled` guard, so nothing observable changes while the closure and
    // the view it captures stay alive for the rest of the ceiling.
    const wc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(wc);

    const baseline = vi.getTimerCount();

    const p = manager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);
    await vi.advanceTimersByTimeAsync(0);
    // Soft + hard are both armed while the load is in flight. (The paint-gate
    // timers are configured to 0ms and have already fired by now.)
    expect(vi.getTimerCount()).toBe(baseline + 2);

    // Settle well before either bound. The rollback path is used deliberately:
    // a successful switch caches the outgoing view, which starts the periodic
    // cached-view memory sampler and would confound the count.
    wc._fireOnce("preload-error", {}, "/test/preload.cjs", new Error("Cannot find module"));
    await errPromise;

    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("records a non-negative timer lateness on the soft warning", async () => {
    const wc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(wc);

    const p = manager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(LOAD_SOFT_MS + 1);

    const [, payload] = softTimeoutWarnings()[0] as [string, Record<string, unknown>];
    expect(payload.waitedMs).toBe(LOAD_SOFT_MS);
    expect(payload.hardMs).toBe(LOAD_HARD_MS);
    // The stall-vs-slow-renderer diagnostic must always be a usable number —
    // a NaN or negative here would silently poison the telemetry it exists for.
    expect(Number.isFinite(payload.timerLateByMs)).toBe(true);
    expect(payload.timerLateByMs as number).toBeGreaterThanOrEqual(0);

    await vi.advanceTimersByTimeAsync(LOAD_HARD_MS);
    await errPromise;
  });

  it("applies bounds pushed through the runtime setters to the next load", async () => {
    // The resource-profile push goes through these setters, so a no-op setter
    // would silently strand every window on the default bounds.
    const setterManager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
    });
    setterManager.setViewLoadTimeoutMs(LOAD_SOFT_MS);
    setterManager.setViewLoadHardTimeoutMs(LOAD_HARD_MS);

    const failWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(failWc);

    const p = setterManager.switchTo("proj-z", "/path/z");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(LOAD_SOFT_MS + 1);
    expect(softTimeoutWarnings()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(LOAD_HARD_MS);
    const err = await errPromise;
    expect(err.message).toContain("View load timed out");
  });

  it("ignores non-finite and negative bounds from the setters", async () => {
    const setterManager = new ProjectViewManager(win as never, {
      dirname: "/test",
      viewLoadTimeoutMs: LOAD_SOFT_MS,
      viewLoadHardTimeoutMs: LOAD_HARD_MS,
    });

    setterManager.setViewLoadTimeoutMs(Number.NaN);
    setterManager.setViewLoadHardTimeoutMs(-1);
    expect(setterManager.viewLoadTimeoutMs).toBe(LOAD_SOFT_MS);
    expect(setterManager.viewLoadHardTimeoutMs).toBe(LOAD_HARD_MS);

    setterManager.setViewLoadHardTimeoutMs(Number.POSITIVE_INFINITY);
    expect(setterManager.viewLoadHardTimeoutMs).toBe(LOAD_HARD_MS);
  });

  it("keeps the in-flight load on its captured bounds when the setters move", async () => {
    const failWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(failWc);

    const p = manager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);
    await vi.advanceTimersByTimeAsync(0);

    // A resource-profile transition landing mid-load must not retime it.
    manager.setViewLoadTimeoutMs(5_000);
    manager.setViewLoadHardTimeoutMs(9_000);

    await vi.advanceTimersByTimeAsync(LOAD_HARD_MS + 1);
    const err = await errPromise;
    expect(err.message).toContain("View load timed out");
  });

  it("does not run crash recovery for a renderer that dies mid-load", async () => {
    // The persistent crash handler and loadView's one-shot handler both see
    // render-process-gone. Only the latter should act: the former would tear
    // down ports and reload a view the rollback is about to destroy.
    const onViewCrashed = vi.fn();
    const crashManager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      viewLoadTimeoutMs: LOAD_SOFT_MS,
      viewLoadHardTimeoutMs: LOAD_HARD_MS,
      onViewCrashed,
    });

    const crashWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(crashWc);

    const p = crashManager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);
    await vi.advanceTimersByTimeAsync(0);

    // Persistent handler first (registered before loadView's one-shot), then
    // the one-shot that actually owns the failure.
    crashWc._fireOn("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    crashWc._fireOnce("render-process-gone", {}, { reason: "crashed", exitCode: 1 });

    const err = await errPromise;
    expect(err.message).toBe("Renderer process gone during load: crashed");
    expect(onViewCrashed).not.toHaveBeenCalled();
    expect(crashWc.reload).not.toHaveBeenCalled();
  });

  it("shields the still-visible outgoing view from eviction while the load runs", async () => {
    // The paint gate resolves on the incoming skeleton signal, but the
    // outgoing view stays on screen until the load finishes. A pressure pass
    // in that gap must not destroy it — doing so leaves a blank window if the
    // load then fails, since rollback has no live view to restore.
    const bWc = createMockWebContents({ autoFinishLoad: true, bootstrapProjectId: "proj-b" });
    wcQueue.push(bWc);
    const firstSwitch = manager.switchTo("proj-b", "/path/b");
    await vi.advanceTimersByTimeAsync(1);
    await firstSwitch;

    const slowWc = createMockWebContents({ autoFinishLoad: false, bootstrapProjectId: "proj-c" });
    wcQueue.push(slowWc);
    const p = manager.switchTo("proj-c", "/path/c");
    await vi.advanceTimersByTimeAsync(0);

    // Mid-load pressure reclaim: proj-a is a genuine cached view and may go;
    // proj-b is the visible bridge and must not.
    manager.reclaimCachedViewsUnderPressure();
    expect(bWc.close).not.toHaveBeenCalled();

    slowWc._fireOnce("did-finish-load");
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(manager.getActiveProjectId()).toBe("proj-c");
  });

  /**
   * A manager whose paint gate expires strictly inside the load window, so the
   * gap between "gate gone" and "load settled" can be observed on both sides.
   */
  const GATE_HARD_MS = 50;
  function startBridgedSwitch() {
    const bridgeManager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 3,
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: GATE_HARD_MS,
      viewLoadTimeoutMs: LOAD_SOFT_MS,
      viewLoadHardTimeoutMs: LOAD_HARD_MS,
    });
    bridgeManager.registerInitialView(
      { webContents: createMockWebContents(), setBounds: vi.fn() } as never,
      "bridge-a",
      "/path/bridge-a"
    );

    const slowWc = createMockWebContents({
      autoFinishLoad: false,
      bootstrapProjectId: "bridge-b",
    });
    wcQueue.push(slowWc);
    return {
      bridgeManager,
      slowWc,
      switchPromise: bridgeManager.switchTo("bridge-b", "/path/bridge-b"),
    };
  }

  it("keeps reporting the outgoing bridge after the paint gate clears mid-load", async () => {
    // The gate resolves on the incoming skeleton signal — or its own hard
    // timeout — and nulls itself, while the outgoing view stays attached and
    // visible until the load settles. Answering from the gate alone left every
    // consumer (hibernation, idle auto-close, relocation, menu state) blind for
    // that whole gap, free to destroy the view rollback needs and strand the
    // window on a project with no live entry (#11459).
    const { bridgeManager, slowWc, switchPromise } = startBridgedSwitch();

    // Gate still open: this is the case that passed before the fix too.
    await vi.advanceTimersByTimeAsync(1);
    expect(bridgeManager.pendingPaintGate).not.toBeNull();
    const whileGateOpen = bridgeManager.getOutgoingBridgeProjectId();
    expect(whileGateOpen).toBe("bridge-a");

    // Gate hard-times-out and drops itself; the load is still in flight.
    await vi.advanceTimersByTimeAsync(GATE_HARD_MS);
    expect(bridgeManager.pendingPaintGate).toBeNull();
    expect(bridgeManager.pendingColdSwitch?.projectId).toBe("bridge-b");

    // The answer must not change across that boundary — the outgoing view is
    // still the painted frame.
    expect(bridgeManager.getOutgoingBridgeProjectId()).toBe(whileGateOpen);

    // Only once the load settles is the bridge genuinely gone. The already-
    // expired gate abandons this switch the moment the load resolves (#11635),
    // so the bridge clears via the rollback rather than via a commit — either
    // way no view is left reported as on screen.
    const rejection = expectRejection(switchPromise);
    slowWc._fireOnce("did-finish-load");
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(bridgeManager.getOutgoingBridgeProjectId()).toBeNull();
    expect(bridgeManager.getActiveProjectId()).toBe("bridge-a");
  });

  it("stops reporting an outgoing bridge once the manager is disposed", async () => {
    // dispose() clears the paint gate, so the cold switch has to go with it:
    // otherwise a manager torn down mid-load keeps naming a project as on
    // screen for the rest of the load ceiling, pinning it against hibernation
    // and idle auto-close long after its window is gone.
    const { bridgeManager, switchPromise } = startBridgedSwitch();
    const errPromise = expectRejection(switchPromise);

    await vi.advanceTimersByTimeAsync(GATE_HARD_MS + 1);
    expect(bridgeManager.pendingPaintGate).toBeNull();
    expect(bridgeManager.getOutgoingBridgeProjectId()).toBe("bridge-a");

    bridgeManager.dispose();
    expect(bridgeManager.getOutgoingBridgeProjectId()).toBeNull();

    await vi.advanceTimersByTimeAsync(LOAD_HARD_MS);
    await errPromise;
  });

  it("rolls back to previous view when preload-error fires", async () => {
    const failWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(failWc);

    // Attach .catch immediately to prevent unhandled rejection warning
    const p = manager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(0);
    failWc._fireOnce("preload-error", {}, "/test/preload.cjs", new Error("Cannot find module"));

    const err = await errPromise;
    expect(err.message).toBe("Cannot find module");
    expect(manager.getActiveProjectId()).toBe("proj-a");
    // With the deferred-deactivation cold-start path the outgoing view was
    // never detached, so the rollback path doesn't need to re-add it.
    expect(win.contentView.removeChildView).not.toHaveBeenCalledWith(
      expect.objectContaining({ webContents: initialWc })
    );
    expect(failWc.close).toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: "project-switch" })
    );
    expect(
      vi.mocked(logInfo).mock.calls.filter(([e]) => e === "projectview.coldstart")
    ).toHaveLength(0);
  });

  it("rolls back when did-fail-load fires", async () => {
    const failWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(failWc);

    const p = manager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(0);
    failWc._fireOnce("did-fail-load", {}, -3, "ERR_ABORTED");

    const err = await errPromise;
    expect(err.message).toBe("View load failed: ERR_ABORTED (-3)");
    expect(manager.getActiveProjectId()).toBe("proj-a");
    expect(failWc.close).toHaveBeenCalled();
    expect(
      vi.mocked(logInfo).mock.calls.filter(([e]) => e === "projectview.coldstart")
    ).toHaveLength(0);
  });

  it("rolls back when render-process-gone fires during load", async () => {
    const failWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(failWc);

    const p = manager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(0);
    failWc._fireOnce("render-process-gone", {}, { reason: "crashed", exitCode: 1 });

    const err = await errPromise;
    expect(err.message).toBe("Renderer process gone during load: crashed");
    expect(manager.getActiveProjectId()).toBe("proj-a");
    expect(
      vi.mocked(logInfo).mock.calls.filter(([e]) => e === "projectview.coldstart")
    ).toHaveLength(0);
  });

  it("keeps the load alive past the soft timeout and only rolls back at the hard timeout", async () => {
    const failWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(failWc);

    const p = manager.switchTo("proj-b", "/path/b");
    let rejected = false;
    const errPromise = expectRejection(p).then((err) => {
      rejected = true;
      return err;
    });

    // Past the soft bound: the slow load is reported, but nothing is torn
    // down — this is the window in which #11459 used to lose the switch.
    await vi.advanceTimersByTimeAsync(LOAD_SOFT_MS + 1);
    expect(rejected).toBe(false);
    expect(softTimeoutWarnings()).toHaveLength(1);
    expect(failWc.close).not.toHaveBeenCalled();
    expect(notifyError).not.toHaveBeenCalled();
    expect(manager.getActiveProjectId()).toBe("proj-b");

    // Past the hard bound: now the load is presumed wedged and rolled back.
    await vi.advanceTimersByTimeAsync(LOAD_HARD_MS - LOAD_SOFT_MS);

    const err = await errPromise;
    // Timing out before did-finish-load is the navigation phase. The phase is
    // what makes a production timeout report actionable — it tells "the page
    // never navigated" apart from "the renderer loaded but never answered the
    // bootstrap eval", which one shared hard budget otherwise conflates (#11458).
    expect(errorCode(err)).toBe("INTERNAL");
    expect(errorContext(err)).toMatchObject({ phase: "navigation", projectId: "proj-b" });
    expect(manager.getActiveProjectId()).toBe("proj-a");
    expect(failWc.close).toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: "project-switch" })
    );
    expect(
      vi.mocked(logInfo).mock.calls.filter(([e]) => e === "projectview.coldstart")
    ).toHaveLength(0);
    // The soft bound warns once, not once per elapsed interval.
    expect(softTimeoutWarnings()).toHaveLength(1);
  });

  it("completes the switch when the load finishes between the soft and hard timeouts", async () => {
    const slowWc = createMockWebContents({
      autoFinishLoad: false,
      bootstrapProjectId: "proj-b",
    });
    wcQueue.push(slowWc);

    const p = manager.switchTo("proj-b", "/path/b");

    // Cross the soft bound without finishing — previously fatal at 10s.
    await vi.advanceTimersByTimeAsync(LOAD_SOFT_MS + 1);
    expect(softTimeoutWarnings()).toHaveLength(1);

    // The renderer catches up before the hard ceiling.
    slowWc._fireOnce("did-finish-load");
    await vi.advanceTimersByTimeAsync(1);

    const result = await p;
    expect(result.isNew).toBe(true);
    expect(manager.getActiveProjectId()).toBe("proj-b");
    expect(slowWc.close).not.toHaveBeenCalled();
    expect(notifyError).not.toHaveBeenCalled();

    // The hard timer was cleared on settle: advancing well past it must not
    // retroactively roll back a switch that already succeeded.
    await vi.advanceTimersByTimeAsync(LOAD_HARD_MS * 2);
    expect(manager.getActiveProjectId()).toBe("proj-b");
    expect(notifyError).not.toHaveBeenCalled();
  });

  it("clears both load timers when an event-driven failure settles first", async () => {
    const failWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(failWc);

    const p = manager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(0);
    failWc._fireOnce("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    await errPromise;

    vi.mocked(notifyError).mockClear();

    // Deterministic failures must not inherit the hard delay, and neither
    // timer may fire after the promise already settled.
    await vi.advanceTimersByTimeAsync(LOAD_HARD_MS * 2);
    expect(softTimeoutWarnings()).toHaveLength(0);
    expect(notifyError).not.toHaveBeenCalled();
  });

  it("detaches the dom-ready listener when the load fails before dom-ready", async () => {
    const failWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(failWc);

    const p = manager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(0);
    expect(failWc._handlers.get("dom-ready") ?? []).toHaveLength(1);

    failWc._fireOnce("preload-error", {}, "/test/preload.cjs", new Error("Cannot find module"));
    await errPromise;

    // `webContents.close()` does not remove JS listeners, so settle() has to
    // detach this one itself or it stays bound to a torn-down view.
    expect(failWc._handlers.get("dom-ready") ?? []).toHaveLength(0);
  });

  it("attributes a timeout after did-finish-load to the bootstrap phase", async () => {
    // Renderer navigates fine but never answers the bootstrap eval — the same
    // hard budget expires, but in a different phase than the case above.
    const stalledWc = createMockWebContents({ autoFinishLoad: false });
    stalledWc.executeJavaScript.mockImplementation(() => new Promise(() => {}));
    wcQueue.push(stalledWc);

    const p = manager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(0);
    stalledWc._fireOnce("did-finish-load");
    await vi.advanceTimersByTimeAsync(LOAD_HARD_MS + 1);

    const err = await errPromise;
    expect(errorCode(err)).toBe("INTERNAL");
    expect(errorContext(err)).toMatchObject({ phase: "bootstrap", projectId: "proj-b" });
    expect(manager.getActiveProjectId()).toBe("proj-a");
  });

  it("sets activeProjectId to null when no previous view exists", async () => {
    const freshManager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      viewLoadTimeoutMs: LOAD_SOFT_MS,
      viewLoadHardTimeoutMs: LOAD_HARD_MS,
    });

    const failWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(failWc);

    const p = freshManager.switchTo("proj-x", "/path/x");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(LOAD_HARD_MS + 1);

    const err = await errPromise;
    expect(errorContext(err)).toMatchObject({ phase: "navigation" });
    expect(freshManager.getActiveProjectId()).toBeNull();
    expect(notifyError).toHaveBeenCalled();
  });

  it("normalizes a hard bound below the soft bound so soft never outlives hard", async () => {
    const invertedManager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      viewLoadTimeoutMs: LOAD_HARD_MS,
      viewLoadHardTimeoutMs: LOAD_SOFT_MS,
    });

    const failWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(failWc);

    const p = invertedManager.switchTo("proj-y", "/path/y");
    const errPromise = expectRejection(p);

    // hard is clamped up to soft, so nothing rejects at the smaller value.
    await vi.advanceTimersByTimeAsync(LOAD_SOFT_MS + 1);
    expect(notifyError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(LOAD_HARD_MS);
    const err = await errPromise;
    expect(err.message).toContain("View load timed out");
  });

  it("switchChain continues after rollback — second switch succeeds", async () => {
    const failWc = createMockWebContents({ autoFinishLoad: false });
    const succeedWc = createMockWebContents({
      autoFinishLoad: true,
      bootstrapProjectId: "proj-c",
    });
    wcQueue.push(failWc, succeedWc);

    const first = manager.switchTo("proj-b", "/path/b");
    const firstErr = expectRejection(first);

    await vi.advanceTimersByTimeAsync(LOAD_HARD_MS + 1);
    await firstErr;

    const second = manager.switchTo("proj-c", "/path/c");
    // Flush did-finish-load and the paint gate (timeout: 0).
    await vi.advanceTimersByTimeAsync(1);

    const result = await second;
    expect(result.isNew).toBe(true);
    expect(manager.getActiveProjectId()).toBe("proj-c");
  });

  it("only settles once when multiple events fire", async () => {
    const wc = createMockWebContents({ autoFinishLoad: false, bootstrapProjectId: "proj-b" });
    wcQueue.push(wc);

    const p = manager.switchTo("proj-b", "/path/b");
    await vi.advanceTimersByTimeAsync(0);

    // Fire did-finish-load first (success), then let the async bootstrap check settle.
    wc._fireOnce("did-finish-load");
    await vi.advanceTimersByTimeAsync(0);

    // Then fire preload-error (should be ignored by settle guard)
    wc._fireOnce("preload-error", {}, "/test/preload.cjs", new Error("Should be ignored"));

    // Release the paint gate (timeout: 0) so the switch can resolve.
    await vi.advanceTimersByTimeAsync(1);
    const result = await p;
    expect(result.isNew).toBe(true);
  });

  it("rejects when the renderer finishes on the wrong internal page without project bootstrap", async () => {
    const wrongPageWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(wrongPageWc);

    const p = manager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(0);
    wrongPageWc._fireOnce("did-finish-load");

    const err = await errPromise;
    expect(err.message).toContain("Project view loaded without project bootstrap");
    expect(manager.getActiveProjectId()).toBe("proj-a");
    expect(wrongPageWc.close).toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: "project-switch" })
    );
  });

  it("rejects a committed non-application document even when the preload id matches", async () => {
    // The app:// 404 regression (#11635). A `Response` with status 404 is a
    // transport-complete navigation: it commits, fires did-finish-load, never
    // fires did-fail-load, and still carries the preload — so the bootstrap id
    // is exactly the one requested. Only the document itself can disprove it.
    const notFoundPageWc = createMockWebContents({
      autoFinishLoad: false,
      bootstrapProjectId: "proj-b",
      hasAppRoot: false,
    });
    wcQueue.push(notFoundPageWc);

    const p = manager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(0);
    notFoundPageWc._fireOnce("did-finish-load");

    const err = await errPromise;
    // Attributed to the document, not to the project plumbing — the id matched.
    expect(err.message).toContain("non-application document");
    expect(err.message).not.toContain("without project bootstrap");
    expect(manager.getActiveProjectId()).toBe("proj-a");
    expect(notFoundPageWc.close).toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: "project-switch" })
    );
  });

  it("treats a null probe result as a failure but an undefined one as an unmodelled mock", async () => {
    // The escape hatch keys on `undefined` ALONE. Widening it to a nullish
    // check would silently re-open the hole this fix closed, since a frame that
    // is gone or never ran the expression answers `null`, not `undefined`.
    const nullProbeWc = createMockWebContents({ autoFinishLoad: false });
    nullProbeWc.executeJavaScript.mockResolvedValue(null);
    wcQueue.push(nullProbeWc);

    const nullErr = expectRejection(manager.switchTo("proj-b", "/path/b"));
    await vi.advanceTimersByTimeAsync(0);
    nullProbeWc._fireOnce("did-finish-load");
    expect((await nullErr).message).toContain("non-application document");
    expect(manager.getActiveProjectId()).toBe("proj-a");

    const legacyMockWc = createMockWebContents({ autoFinishLoad: false });
    legacyMockWc.executeJavaScript.mockResolvedValue(undefined);
    wcQueue.push(legacyMockWc);

    const p = manager.switchTo("proj-c", "/path/c");
    await vi.advanceTimersByTimeAsync(0);
    legacyMockWc._fireOnce("did-finish-load");
    await p;
    expect(manager.getActiveProjectId()).toBe("proj-c");
  });

  it("blames the document, not the project, when neither the id nor the document matches", async () => {
    // Both facts are wrong at once, so this pins the precedence rather than
    // just the message: a wrong document explains a wrong id, and reporting the
    // id first would send diagnosis to the project plumbing instead of to the
    // asset read that actually failed.
    const wrongEverythingWc = createMockWebContents({
      autoFinishLoad: false,
      bootstrapProjectId: null,
      hasAppRoot: false,
    });
    wcQueue.push(wrongEverythingWc);

    const p = manager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(0);
    wrongEverythingWc._fireOnce("did-finish-load");

    const err = await errPromise;
    expect(err.message).toContain("non-application document");
    expect(err.message).not.toContain("without project bootstrap");
  });

  it("rejects when the renderer bootstraps a different project than requested", async () => {
    const wrongProjectWc = createMockWebContents({
      autoFinishLoad: false,
      bootstrapProjectId: "proj-c",
    });
    wcQueue.push(wrongProjectWc);

    const p = manager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(0);
    wrongProjectWc._fireOnce("did-finish-load");

    const err = await errPromise;
    expect(err.message).toContain("Project view loaded without project bootstrap");
    expect(err.message).toContain("got proj-c");
    expect(manager.getActiveProjectId()).toBe("proj-a");
    expect(wrongProjectWc.close).toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: "project-switch" })
    );
  });

  it("rolls back when the bootstrap check rejects (webContents destroyed mid-verify)", async () => {
    const destroyedWc = createMockWebContents({ autoFinishLoad: false });
    // The bootstrap probe rejects rather than resolving — mirrors executeJavaScript
    // throwing "Object has been destroyed" if the view is torn down mid-check.
    destroyedWc.executeJavaScript.mockImplementation((code?: string) =>
      String(code ?? "").includes("__DAINTREE_INITIAL_PROJECT__")
        ? Promise.reject(new Error("Object has been destroyed"))
        : Promise.resolve()
    );
    wcQueue.push(destroyedWc);

    const p = manager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(0);
    destroyedWc._fireOnce("did-finish-load");

    const err = await errPromise;
    expect(err.message).toBe("Object has been destroyed");
    expect(manager.getActiveProjectId()).toBe("proj-a");
    expect(destroyedWc.close).toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: "project-switch" })
    );
  });

  it("cancels a pending cold load when the manager is disposed mid-load", async () => {
    const pendingWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(pendingWc);

    const p = manager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(0);

    // Window close / app quit: dispose() closes every view, which fires
    // `destroyed` — the teardown signal none of the four load events deliver.
    manager.dispose();

    // Settles on microtasks alone. No timer is advanced here, so if the load
    // promise still hung on the hard deadline this would never resolve — which
    // is exactly the stall that produced the phantom timeout (#11458).
    const err = await errPromise;
    expect(errorCode(err)).toBe("CANCELLED");
    expect(errorContext(err)).toMatchObject({ projectId: "proj-b" });
    // An ordinary teardown is not a user-facing failure.
    expect(notifyError).not.toHaveBeenCalled();
    // Rollback skipped: dispose() already cleared the pointer and tore down
    // proj-a's view, so restoring it would resurrect state teardown cleared.
    expect(manager.getActiveProjectId()).toBeNull();
  });

  it("skips rollback during teardown even when the load failed before it", async () => {
    const failWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(failWc);

    const p = manager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(0);
    // Closing the webContents aborts the in-flight navigation, so teardown
    // routinely surfaces as ERR_ABORTED settling the load FIRST — which
    // deregisters the destroyed listener, so the rejection is an ordinary load
    // failure, not a cancellation. Gating the teardown branch on the error
    // class would let this ordering roll back against dead state and report.
    failWc._fireOnce("did-fail-load", {}, -3, "ERR_ABORTED");
    manager.dispose();

    const err = await errPromise;
    // The rejection keeps its truthful classification...
    expect(errorCode(err)).toBe("INTERNAL");
    // ...but the host is gone, so nothing is restored and nobody is told.
    expect(notifyError).not.toHaveBeenCalled();
    expect(manager.getActiveProjectId()).toBeNull();
  });

  it("cancels during the bootstrap phase and reports that phase", async () => {
    const pendingWc = createMockWebContents({ autoFinishLoad: false });
    // Navigation completes; the bootstrap eval never answers, so teardown
    // lands while the promise is parked mid-verify.
    pendingWc.executeJavaScript.mockImplementation(() => new Promise(() => {}));
    wcQueue.push(pendingWc);

    const p = manager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(0);
    pendingWc._fireOnce("did-finish-load");
    await vi.advanceTimersByTimeAsync(0);
    manager.dispose();

    const err = await errPromise;
    expect(errorCode(err)).toBe("CANCELLED");
    // Cancellation records which stage it interrupted, not just that it happened.
    expect(errorContext(err)).toMatchObject({ phase: "bootstrap", projectId: "proj-b" });
    expect(notifyError).not.toHaveBeenCalled();
  });

  it("wraps a preload failure with the load phase while preserving the original", async () => {
    const failWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(failWc);
    const original = new Error("Cannot find module");

    const p = manager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(0);
    failWc._fireOnce("preload-error", {}, "/test/preload.cjs", original);

    const err = await errPromise;
    // Rewrapped for the phase context, with the original kept as the cause —
    // the message alone would look identical if it were passed through.
    expect(errorCode(err)).toBe("INTERNAL");
    expect(errorContext(err)).toMatchObject({ phase: "navigation" });
    expect((err as { cause?: unknown }).cause).toBe(original);
    expect(err.message).toBe(original.message);
  });

  it("still settles when listener cleanup throws on the destroyed webContents", async () => {
    const pendingWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(pendingWc);

    const p = manager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(0);

    // Electron throws from removeListener on a torn-down webContents — the
    // hazard webContentsRegistry already guards. Teardown is the one settle
    // path that always cleans up against a destroyed webContents, so a throw
    // escaping there would strand the promise pending forever, with `settled`
    // latched so nothing could ever settle it again.
    pendingWc.removeListener.mockImplementation(() => {
      throw new Error("Object has been destroyed");
    });
    manager.dispose();

    const err = await errPromise;
    expect(errorCode(err)).toBe("CANCELLED");
  });

  it("settles promptly but still rolls back when the view dies and the manager lives", async () => {
    const doomedWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(doomedWc);

    const p = manager.switchTo("proj-b", "/path/b");
    const errPromise = expectRejection(p);

    await vi.advanceTimersByTimeAsync(0);
    doomedWc._fireOnce("destroyed");

    const err = await errPromise;
    expect(errorCode(err)).toBe("CANCELLED");
    // The outgoing view is still attached and visible, so the pointer has to
    // follow it back rather than linger on the destroyed project.
    expect(manager.getActiveProjectId()).toBe("proj-a");
    expect(notifyError).toHaveBeenCalled();
  });

  it("ignores a destroyed event that lands after the load already settled", async () => {
    const wc = createMockWebContents({ autoFinishLoad: false, bootstrapProjectId: "proj-b" });
    wcQueue.push(wc);

    const p = manager.switchTo("proj-b", "/path/b");
    await vi.advanceTimersByTimeAsync(0);
    wc._fireOnce("did-finish-load");
    await vi.advanceTimersByTimeAsync(1);

    await expect(p).resolves.toMatchObject({ isNew: true });

    // Deregistered on every settle path, so the eventual close during normal
    // eviction has no cancellation handler left to run against a switch that
    // already succeeded.
    expect(wc._handlers.get("destroyed") ?? []).toHaveLength(0);
    wc._fireOnce("destroyed");
    expect(notifyError).not.toHaveBeenCalled();
  });
});
