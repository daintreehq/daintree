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
  _fireOnce: (event: string, ...args: unknown[]) => void;
}

function createMockWebContents(opts?: {
  autoFinishLoad?: boolean;
  bootstrapProjectId?: string | null;
}): MockWc {
  const id = nextWebContentsId++;
  const handlers = new Map<string, Handler[]>();
  const autoFinish = opts?.autoFinishLoad ?? true;
  const bootstrapProjectId = opts?.bootstrapProjectId ?? null;

  const wc: MockWc = {
    id,
    isDestroyed: vi.fn(() => false),
    executeJavaScript: vi.fn((code?: string) =>
      String(code ?? "").includes("__DAINTREE_INITIAL_PROJECT__")
        ? Promise.resolve(bootstrapProjectId)
        : Promise.resolve()
    ),
    loadURL: vi.fn(() => Promise.resolve()),
    focus: vi.fn(),
    invalidate: vi.fn(),
    close: vi.fn(),
    reload: vi.fn(),
    send: vi.fn(),
    on: vi.fn((_event: string, _handler: Handler) => {}),
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
    _fireOnce(event: string, ...args: unknown[]) {
      const list = handlers.get(event);
      if (list && list.length > 0) {
        const h = list.shift()!;
        h(...args);
      }
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
async function expectRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
    throw new Error("Expected promise to reject");
  } catch (err) {
    return err as Error;
  }
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

    initialWc = createMockWebContents();
    const initialView = { webContents: initialWc, setBounds: vi.fn() };
    manager.registerInitialView(initialView as never, "proj-a", "/path/a");
  });

  afterEach(() => {
    vi.useRealTimers();
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
    expect(err.message).toBe("View load timed out");
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
    expect(err.message).toBe("View load timed out");
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
    expect(err.message).toBe("View load timed out");
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
});
