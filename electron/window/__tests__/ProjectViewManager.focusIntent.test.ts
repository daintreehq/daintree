import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let nextWebContentsId = 800;

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
  session: { flushStorageData: ReturnType<typeof vi.fn> };
  navigationHistory: { clear: ReturnType<typeof vi.fn> };
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  setIgnoreMenuShortcuts: ReturnType<typeof vi.fn>;
  _fireOnce: (event: string, ...args: unknown[]) => void;
}

function createMockWebContents(opts?: { autoFinishLoad?: boolean }): MockWc {
  const id = nextWebContentsId++;
  const handlers = new Map<string, Handler[]>();
  const autoFinish = opts?.autoFinishLoad ?? true;

  const wc: MockWc = {
    id,
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
    app: { isPackaged: false, commandLine: { appendSwitch: vi.fn() }, getAppMetrics: () => [] },
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

vi.mock("../../services/ProcessMemoryMonitor.js", () => ({
  forgetBlinkSample: vi.fn(),
  forgetEluSample: vi.fn(),
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

import { ProjectViewManager } from "../ProjectViewManager.js";
import { CHANNELS } from "../../ipc/channels.js";

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
        // Re-adding a view whose parent is unchanged reorders it rather than
        // duplicating it — the rollback path re-attaches through activateView.
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

describe("ProjectViewManager — pending focus intent", () => {
  let manager: ProjectViewManager;
  let win: ReturnType<typeof createMockWindow>;
  let initialWc: MockWc;

  beforeEach(() => {
    nextWebContentsId = 800;
    wcQueue = [];

    win = createMockWindow();
    manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 50,
      paintGateHardTimeoutMs: 150,
      // Resolve the warm anti-flash bridge immediately — these tests assert
      // focus-intent delivery on reactivation, not the warm gate timing (#9679).
      warmPaintGateTimeoutMs: 0,
      warmPaintGateHardTimeoutMs: 0,
      cachedProjectViews: 3,
    });

    initialWc = createMockWebContents();
    const initialView = { webContents: initialWc, setBounds: vi.fn() };
    win.contentView.addChildView(initialView);
    manager.registerInitialView(initialView as never, "proj-a", "/path/a");
  });

  afterEach(() => {
    manager.dispose();
  });

  it("delivers focus intent to cold-start incoming view after paint signal", async () => {
    const incomingWc = createMockWebContents();
    wcQueue.push(incomingWc);

    manager.setPendingFocusIntent("proj-b", { intent: "focus-next-waiting" });
    const switchPromise = manager.switchTo("proj-b", "/path/b");
    await Promise.resolve();
    await Promise.resolve();

    manager.signalViewPainted(incomingWc.id);
    await switchPromise;

    const focusSends = incomingWc.send.mock.calls.filter(
      ([channel]) => channel === CHANNELS.PROJECT_FOCUS_ON_ACTIVATE
    );
    expect(focusSends).toHaveLength(1);
    expect(focusSends[0][1]).toEqual({ intent: "focus-next-waiting" });
  });

  it("does not deliver focus intent when paint gate hard timeout fires", async () => {
    vi.useFakeTimers();
    try {
      const slowWc = createMockWebContents();
      wcQueue.push(slowWc);

      manager.setPendingFocusIntent("proj-b", { intent: "focus-next-waiting" });
      const switchPromise = manager.switchTo("proj-b", "/path/b");
      // Handler attached in the same tick: the hard timeout abandons the
      // switch (#11635), so this promise rejects rather than resolving.
      const rejection = switchPromise.then(
        () => {
          throw new Error("Expected the switch to reject");
        },
        (err: unknown) => err as Error
      );
      await vi.advanceTimersByTimeAsync(0);

      // Past hard bound (150 ms). The soft bound at 50 ms only warns —
      // intent is dropped on hard fall-through, not on soft warning.
      await vi.advanceTimersByTimeAsync(200);
      await rejection;

      const focusSends = slowWc.send.mock.calls.filter(
        ([channel]) => channel === CHANNELS.PROJECT_FOCUS_ON_ACTIVATE
      );
      expect(focusSends).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not deliver focus intent on cold-start load failure", async () => {
    const failWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(failWc);

    manager.setPendingFocusIntent("proj-b", { intent: "focus-next-waiting" });
    const switchPromise = manager.switchTo("proj-b", "/path/b").catch((err) => err);
    await Promise.resolve();
    failWc._fireOnce("did-fail-load", {}, -3, "ERR_FAILED");
    await switchPromise;

    const focusSends = failWc.send.mock.calls.filter(
      ([channel]) => channel === CHANNELS.PROJECT_FOCUS_ON_ACTIVATE
    );
    expect(focusSends).toHaveLength(0);
  });

  it("delivers focus intent immediately on cached-view reactivation", async () => {
    // Prime B as a cached view.
    const bWc = createMockWebContents();
    wcQueue.push(bWc);
    const firstSwitch = manager.switchTo("proj-b", "/path/b");
    await Promise.resolve();
    await Promise.resolve();
    manager.signalViewPainted(bWc.id);
    await firstSwitch;

    // Switch back to A (cached, since maxCachedViews=3).
    const cachedASwitch = manager.switchTo("proj-a", "/path/a");
    await cachedASwitch;

    initialWc.send.mockClear();

    // Now switch back to B with a pending focus intent. B is in the LRU cache,
    // so the cached fast path fires — must deliver intent synchronously,
    // not via the paint gate (which the cached path skips).
    bWc.send.mockClear();
    manager.setPendingFocusIntent("proj-b", { intent: "focus-next-waiting" });
    const switchBack = manager.switchTo("proj-b", "/path/b");
    await switchBack;

    const focusSends = bWc.send.mock.calls.filter(
      ([channel]) => channel === CHANNELS.PROJECT_FOCUS_ON_ACTIVATE
    );
    expect(focusSends).toHaveLength(1);
    expect(focusSends[0][1]).toEqual({ intent: "focus-next-waiting" });
  });

  it("consumes focus intent exactly once — later unrelated switch does not refire", async () => {
    const incomingWc = createMockWebContents();
    wcQueue.push(incomingWc);

    manager.setPendingFocusIntent("proj-b", { intent: "focus-next-waiting" });
    const switchPromise = manager.switchTo("proj-b", "/path/b");
    await Promise.resolve();
    await Promise.resolve();
    manager.signalViewPainted(incomingWc.id);
    await switchPromise;

    expect(
      incomingWc.send.mock.calls.filter(
        ([channel]) => channel === CHANNELS.PROJECT_FOCUS_ON_ACTIVATE
      )
    ).toHaveLength(1);

    incomingWc.send.mockClear();
    initialWc.send.mockClear();

    // Switch back to A without a pending intent — must not retrigger the
    // focus delivery on either view.
    const back = manager.switchTo("proj-a", "/path/a");
    await back;

    expect(
      incomingWc.send.mock.calls.filter(
        ([channel]) => channel === CHANNELS.PROJECT_FOCUS_ON_ACTIVATE
      )
    ).toHaveLength(0);
    expect(
      initialWc.send.mock.calls.filter(
        ([channel]) => channel === CHANNELS.PROJECT_FOCUS_ON_ACTIVATE
      )
    ).toHaveLength(0);
  });

  it("delivers focus intent when switchTo targets the already-active project", async () => {
    // Same-project switchTo hits the early-return path. The renderer-side
    // action short-circuits before this point, but a race between two
    // concurrent switchTo calls can land here.
    manager.setPendingFocusIntent("proj-a", { intent: "focus-next-waiting" });
    const result = await manager.switchTo("proj-a", "/path/a");

    expect(result.isNew).toBe(false);
    const focusSends = initialWc.send.mock.calls.filter(
      ([channel]) => channel === CHANNELS.PROJECT_FOCUS_ON_ACTIVATE
    );
    expect(focusSends).toHaveLength(1);

    // Intent must be cleared — a later switchTo without a fresh intent must
    // not re-fire.
    initialWc.send.mockClear();
    await manager.switchTo("proj-a", "/path/a");
    expect(
      initialWc.send.mock.calls.filter(([c]) => c === CHANNELS.PROJECT_FOCUS_ON_ACTIVATE)
    ).toHaveLength(0);
  });

  it("does not deliver focus intent for a different projectId than the one switched", async () => {
    const incomingWc = createMockWebContents();
    wcQueue.push(incomingWc);

    // Intent is for "proj-c", but we switch to "proj-b". The intent must
    // not be delivered (different project), and must be cleared so a later
    // unrelated switch can't pick it up.
    manager.setPendingFocusIntent("proj-c", { intent: "focus-next-waiting" });
    const switchPromise = manager.switchTo("proj-b", "/path/b");
    await Promise.resolve();
    await Promise.resolve();
    manager.signalViewPainted(incomingWc.id);
    await switchPromise;

    expect(
      incomingWc.send.mock.calls.filter(
        ([channel]) => channel === CHANNELS.PROJECT_FOCUS_ON_ACTIVATE
      )
    ).toHaveLength(0);

    // Subsequent switch to A (no intent set) — also must not fire, confirming
    // the mismatched intent was discarded rather than queued.
    initialWc.send.mockClear();
    const back = manager.switchTo("proj-a", "/path/a");
    await back;
    expect(
      initialWc.send.mock.calls.filter(
        ([channel]) => channel === CHANNELS.PROJECT_FOCUS_ON_ACTIVATE
      )
    ).toHaveLength(0);
  });
});
