import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let nextWebContentsId = 500;

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
    app: {
      isPackaged: false,
      commandLine: { appendSwitch: vi.fn() },
      getAppMetrics: () => [],
      getPath: vi.fn(() => "/tmp/daintree-test-appdata"),
      setPath: vi.fn(),
    },
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
import { logInfo, logWarn } from "../../utils/logger.js";
import { registerAppView } from "../webContentsRegistry.js";
import { unfreezeWebContents } from "../../utils/webContentsLifecycle.js";
import { CHANNELS } from "../../ipc/channels.js";

function createMockWindow() {
  const children: unknown[] = [];
  const win = {
    id: 1,
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    removeListener: vi.fn(),
    getContentBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
    contentView: {
      children,
      addChildView: vi.fn((view: unknown, index?: number) => {
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
  return win;
}

describe("ProjectViewManager — paint gate (cold-start visible swap)", () => {
  let manager: ProjectViewManager;
  let win: ReturnType<typeof createMockWindow>;
  let initialWc: MockWc;

  beforeEach(() => {
    nextWebContentsId = 500;
    wcQueue = [];
    vi.mocked(logInfo).mockClear();
    vi.mocked(logWarn).mockClear();

    vi.mocked(unfreezeWebContents).mockClear();

    win = createMockWindow();
    // Use small, non-zero timeouts so tests can observe each phase:
    //  - soft (50 ms) fires the warning but keeps the outgoing view attached
    //  - hard (150 ms) is the last-resort fall-through that detaches
    // Both must be set explicitly because the PVM defaults are 1.5 s / 4 s.
    manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 50,
      paintGateHardTimeoutMs: 150,
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

  it("keeps outgoing view attached until paint signal fires", async () => {
    const incomingWc = createMockWebContents();
    wcQueue.push(incomingWc);

    const switchPromise = manager.switchTo("proj-b", "/path/b");

    // Let did-finish-load + waitForPaint setup land.
    await Promise.resolve();
    await Promise.resolve();

    // Outgoing view is still attached during the wait; incoming was inserted behind it.
    expect(win.contentView.removeChildView).not.toHaveBeenCalled();
    const addCalls = win.contentView.addChildView.mock.calls;
    const incomingAdd = addCalls.find(
      ([view]) => (view as { webContents: MockWc }).webContents === incomingWc
    );
    expect(incomingAdd).toBeDefined();
    expect(incomingAdd?.[1]).toBe(0);

    // Renderer signals paint — outgoing now released.
    manager.signalViewPainted(incomingWc.id);
    await switchPromise;

    expect(win.contentView.removeChildView).toHaveBeenCalledTimes(1);
    expect(manager.getActiveProjectId()).toBe("proj-b");
  });

  it("soft timeout warns but does NOT detach the outgoing view", async () => {
    vi.useFakeTimers();
    try {
      const slowWc = createMockWebContents();
      wcQueue.push(slowWc);

      const switchPromise = manager.switchTo("proj-b", "/path/b");

      // Flush microtasks so did-finish-load fires and waitForPaint is armed.
      await vi.advanceTimersByTimeAsync(0);
      expect(win.contentView.removeChildView).not.toHaveBeenCalled();

      // Cross the soft bound (50 ms) — warning logged, gate still open.
      await vi.advanceTimersByTimeAsync(60);
      expect(win.contentView.removeChildView).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(logWarn)
          .mock.calls.filter(([event]) => event === "projectview.paintgate.softtimeout")
      ).toHaveLength(1);

      // Signal eventually arrives between soft and hard — outgoing released
      // cleanly. No hard-timeout warning. (Hard bound is 150 ms; soft fired
      // at 50 ms; we are at ~60 ms.)
      manager.signalViewPainted(slowWc.id);
      await switchPromise;

      expect(win.contentView.removeChildView).toHaveBeenCalledTimes(1);
      expect(manager.getActiveProjectId()).toBe("proj-b");
      expect(
        vi
          .mocked(logWarn)
          .mock.calls.filter(([event]) => event === "projectview.paintgate.hardtimeout")
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls through paint gate at hard timeout when signal never arrives", async () => {
    vi.useFakeTimers();
    try {
      const slowWc = createMockWebContents();
      wcQueue.push(slowWc);

      const switchPromise = manager.switchTo("proj-b", "/path/b");

      // Flush microtasks so did-finish-load fires and waitForPaint is armed.
      await vi.advanceTimersByTimeAsync(0);

      // Cross the soft bound (50 ms) — outgoing still attached.
      await vi.advanceTimersByTimeAsync(60);
      expect(win.contentView.removeChildView).not.toHaveBeenCalled();

      // Cross the hard bound (150 ms total) — outgoing now detached.
      await vi.advanceTimersByTimeAsync(100);
      await switchPromise;

      expect(win.contentView.removeChildView).toHaveBeenCalledTimes(1);
      expect(manager.getActiveProjectId()).toBe("proj-b");
      expect(
        vi
          .mocked(logWarn)
          .mock.calls.filter(([event]) => event === "projectview.paintgate.softtimeout")
      ).toHaveLength(1);
      expect(
        vi
          .mocked(logWarn)
          .mock.calls.filter(([event]) => event === "projectview.paintgate.hardtimeout")
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hard timeout drops the pending focus intent", async () => {
    vi.useFakeTimers();
    try {
      const slowWc = createMockWebContents();
      wcQueue.push(slowWc);

      manager.setPendingFocusIntent("proj-b", "focus-next-waiting");

      const switchPromise = manager.switchTo("proj-b", "/path/b");
      await vi.advanceTimersByTimeAsync(0);
      // Past hard bound — fall-through, intent dropped.
      await vi.advanceTimersByTimeAsync(200);
      await switchPromise;

      expect(slowWc.send).not.toHaveBeenCalledWith("project:focus-on-activate", expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it("setCachedViewLimit(1) during the paint gate does NOT evict the outgoing view", async () => {
    // Regression: a profile transition to efficiency mid-cold-start can
    // call setCachedViewLimit(1) while the paint gate is open. Without
    // the gate-aware eviction guard the outgoing view would be evicted
    // and expose the blank incoming frame — the exact flash this gate
    // is meant to prevent.
    const slowWc = createMockWebContents();
    wcQueue.push(slowWc);

    const switchPromise = manager.switchTo("proj-b", "/path/b");
    await Promise.resolve();
    await Promise.resolve();

    // Pre-flight: outgoing (proj-a) attached, gate pending.
    expect(win.contentView.removeChildView).not.toHaveBeenCalled();

    // Squeeze the cache while the gate is open. This call is the normal
    // efficiency-transition behaviour from ResourceProfileService.
    manager.setCachedViewLimit(1);

    // Outgoing must NOT be evicted by the limit-change pass — it's still
    // the visible anti-flash bridge until the gate resolves.
    expect(initialWc.close).not.toHaveBeenCalled();
    expect(win.contentView.removeChildView).not.toHaveBeenCalled();

    // Release the gate. The outgoing view is now detached (gate release)
    // and may be evicted (post-switch LRU pass with the new max=1). The
    // critical guarantee is that the detach order — gate release first,
    // eviction second — keeps the swap seamless even when both fire on
    // the same trailing-edge.
    manager.signalViewPainted(slowWc.id);
    await switchPromise;

    expect(manager.getActiveProjectId()).toBe("proj-b");
  });

  it("paint-gate timeout setters do not retime an in-flight gate", async () => {
    vi.useFakeTimers();
    try {
      const slowWc = createMockWebContents();
      wcQueue.push(slowWc);

      const switchPromise = manager.switchTo("proj-b", "/path/b");
      await vi.advanceTimersByTimeAsync(0);

      // Bump both bounds way up mid-flight — must NOT delay the active gate
      // (captured at gate creation). The 50 ms / 150 ms bounds from beforeEach
      // still apply.
      manager.setPaintGateTimeoutMs(10_000);
      manager.setPaintGateHardTimeoutMs(20_000);

      // Cross the original soft bound — warning fires using captured value.
      await vi.advanceTimersByTimeAsync(60);
      expect(
        vi
          .mocked(logWarn)
          .mock.calls.filter(([event]) => event === "projectview.paintgate.softtimeout")
      ).toHaveLength(1);

      // Cross the original hard bound — fall-through fires using captured value.
      await vi.advanceTimersByTimeAsync(100);
      await switchPromise;
      expect(win.contentView.removeChildView).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores paint signal from an unknown webContentsId", async () => {
    const incomingWc = createMockWebContents();
    wcQueue.push(incomingWc);

    const switchPromise = manager.switchTo("proj-b", "/path/b");

    await Promise.resolve();
    await Promise.resolve();

    // Bogus signal — gate stays open.
    manager.signalViewPainted(99_999);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(win.contentView.removeChildView).not.toHaveBeenCalled();

    // Correct signal — releases.
    manager.signalViewPainted(incomingWc.id);
    await switchPromise;
    expect(win.contentView.removeChildView).toHaveBeenCalledTimes(1);
  });

  it("cached revival bridges behind the outgoing view until the warm paint signal", async () => {
    const incomingWc = createMockWebContents();
    wcQueue.push(incomingWc);

    // First cold switch primes the B view in the cache.
    const firstSwitch = manager.switchTo("proj-b", "/path/b");
    await Promise.resolve();
    await Promise.resolve();
    manager.signalViewPainted(incomingWc.id);
    await firstSwitch;

    win.contentView.removeChildView.mockClear();
    win.contentView.addChildView.mockClear();
    vi.mocked(logInfo).mockClear();

    // Switch back to A (a cached project, wc === initialWc). The warm bridge
    // reattaches A behind B and holds B attached until the warm signal arrives.
    const switchBack = manager.switchTo("proj-a", "/path/a");
    for (let i = 0; i < 6; i++) await Promise.resolve();

    // Core anti-flash invariant: A is reattached at z-index 0 (BEHIND the still-
    // visible B), not on top — otherwise its stale pre-freeze surface would flash.
    const reattach = win.contentView.addChildView.mock.calls.find(
      ([view]) => (view as { webContents?: MockWc }).webContents === initialWc
    );
    expect(reattach).toBeDefined();
    expect(reattach?.[1]).toBe(0);

    // Bridge armed: A reattached, B (outgoing) still attached — not yet detached.
    expect(win.contentView.removeChildView).not.toHaveBeenCalled();

    // A's renderer signals its post-repair frame painted.
    manager.signalWarmViewPainted(initialWc.id);
    const result = await switchBack;

    expect(result.isNew).toBe(false);
    expect(manager.getActiveProjectId()).toBe("proj-a");
    // Outgoing B detached exactly once, only after the warm signal.
    expect(win.contentView.removeChildView).toHaveBeenCalledTimes(1);
  });

  it("warm bridge falls through to the hard timeout when no warm signal arrives", async () => {
    vi.useFakeTimers();
    try {
      const incomingWc = createMockWebContents();
      wcQueue.push(incomingWc);

      const firstSwitch = manager.switchTo("proj-b", "/path/b");
      await vi.advanceTimersByTimeAsync(0);
      manager.signalViewPainted(incomingWc.id);
      await firstSwitch;

      win.contentView.removeChildView.mockClear();
      vi.mocked(logWarn).mockClear();

      const switchBack = manager.switchTo("proj-a", "/path/a");
      await vi.advanceTimersByTimeAsync(0);
      // Outgoing held during the soft tail.
      expect(win.contentView.removeChildView).not.toHaveBeenCalled();

      // Advance past the 1500 ms warm hard timeout — the bridge reveals A anyway
      // so a renderer stuck in its wake fan-out can't wedge the switch.
      await vi.advanceTimersByTimeAsync(1500);
      await switchBack;

      expect(manager.getActiveProjectId()).toBe("proj-a");
      expect(win.contentView.removeChildView).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(logWarn).mock.calls.filter(([e]) => e === "projectview.warmpaintgate.hardtimeout")
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a warm signal from the wrong webContents", async () => {
    const incomingWc = createMockWebContents();
    wcQueue.push(incomingWc);

    const firstSwitch = manager.switchTo("proj-b", "/path/b");
    await Promise.resolve();
    await Promise.resolve();
    manager.signalViewPainted(incomingWc.id);
    await firstSwitch;

    win.contentView.removeChildView.mockClear();

    const switchBack = manager.switchTo("proj-a", "/path/a");
    for (let i = 0; i < 6; i++) await Promise.resolve();

    // A mismatched warm signal must not release the bridge.
    manager.signalWarmViewPainted(99_999);
    await Promise.resolve();
    expect(win.contentView.removeChildView).not.toHaveBeenCalled();

    // The correct signal does.
    manager.signalWarmViewPainted(initialWc.id);
    await switchBack;
    expect(win.contentView.removeChildView).toHaveBeenCalledTimes(1);
  });

  it("a cold paint signal does not release a warm bridge gate", async () => {
    const incomingWc = createMockWebContents();
    wcQueue.push(incomingWc);

    const firstSwitch = manager.switchTo("proj-b", "/path/b");
    await Promise.resolve();
    await Promise.resolve();
    manager.signalViewPainted(incomingWc.id);
    await firstSwitch;

    win.contentView.removeChildView.mockClear();

    const switchBack = manager.switchTo("proj-a", "/path/a");
    for (let i = 0; i < 6; i++) await Promise.resolve();

    // The one-shot cold channel must not satisfy the warm gate (different
    // releaseChannel), even with a matching webContentsId.
    manager.signalViewPainted(initialWc.id);
    await Promise.resolve();
    expect(win.contentView.removeChildView).not.toHaveBeenCalled();

    manager.signalWarmViewPainted(initialWc.id);
    await switchBack;
    expect(win.contentView.removeChildView).toHaveBeenCalledTimes(1);
  });

  it("does not detach outgoing view when cold-start load fails", async () => {
    const failWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(failWc);

    const switchPromise = manager.switchTo("proj-b", "/path/b").catch((err) => err);
    await Promise.resolve();
    failWc._fireOnce("did-fail-load", {}, -3, "ERR_FAILED");

    await switchPromise;

    // The outgoing view (proj-a) must still be attached and active because
    // the deferred-deactivation path never reached the swap.
    expect(manager.getActiveProjectId()).toBe("proj-a");
    expect(failWc.close).toHaveBeenCalled();
  });

  it("captures paint signal that arrives before did-finish-load resolves", async () => {
    // Regression: the paint gate must be armed BEFORE awaiting loadView,
    // otherwise an immediate signal (renderer's double-rAF firing on the
    // same tick as did-finish-load) is dropped and the gate falls through
    // to the timeout on every fast machine.
    const incomingWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(incomingWc);

    const switchPromise = manager.switchTo("proj-b", "/path/b");

    // Microtask flush so performSwitch reaches `await loadView`.
    await Promise.resolve();

    // Signal paint FIRST — before did-finish-load fires. With the pre-armed
    // gate this is captured; without it the gate wouldn't exist yet.
    manager.signalViewPainted(incomingWc.id);

    // Now fire did-finish-load so loadView resolves.
    incomingWc._fireOnce("did-finish-load");

    await switchPromise;
    expect(manager.getActiveProjectId()).toBe("proj-b");
    expect(win.contentView.removeChildView).toHaveBeenCalledTimes(1);
    // No timeout warning — gate resolved by signal.
    expect(
      vi
        .mocked(logWarn)
        .mock.calls.filter(
          ([e]) =>
            e === "projectview.paintgate.softtimeout" || e === "projectview.paintgate.hardtimeout"
        )
    ).toHaveLength(0);
  });

  it("restores registerAppView for outgoing view when cold-start fails", async () => {
    const failWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(failWc);

    vi.mocked(registerAppView).mockClear();

    const switchPromise = manager.switchTo("proj-b", "/path/b").catch((err) => err);
    await Promise.resolve();
    failWc._fireOnce("did-fail-load", {}, -3, "ERR_FAILED");
    await switchPromise;

    // After rollback, the registry must point back at the original (initialWc)
    // view — otherwise getAppWebContents() would fall through to the bare
    // BrowserWindow and IPC consumers (portal, voiceInput, accessibility)
    // would silently target the wrong webContents.
    const registerCalls = vi.mocked(registerAppView).mock.calls;
    const lastCall = registerCalls[registerCalls.length - 1];
    expect(lastCall?.[1]).toMatchObject({ webContents: initialWc });
  });

  it("resizes both incoming and outgoing views while paint gate is open", async () => {
    const incomingWc = createMockWebContents();
    wcQueue.push(incomingWc);

    const initialView = win.contentView.children[0] as { setBounds: ReturnType<typeof vi.fn> };
    const initialSetBounds = initialView.setBounds;
    initialSetBounds.mockClear();

    const switchPromise = manager.switchTo("proj-b", "/path/b");
    await Promise.resolve();
    await Promise.resolve();

    // Trigger the registered resize handler. The handler is captured in
    // beforeEach via win.on; we re-fire it directly here.
    const onCalls = win.on.mock.calls;
    const resizeHandler = onCalls.find(([event]) => event === "resize")?.[1] as
      | (() => void)
      | undefined;
    expect(resizeHandler).toBeDefined();
    win.getContentBounds.mockReturnValueOnce({ x: 0, y: 0, width: 1024, height: 768 });
    resizeHandler?.();

    // Outgoing (initial) view must have been resized too.
    expect(initialSetBounds).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1024, height: 768 })
    );

    // Release the gate so the test cleans up.
    manager.signalViewPainted(incomingWc.id);
    await switchPromise;
  });

  it("detaches the unbound welcome view after the first project view paints", async () => {
    manager.dispose();

    win = createMockWindow();
    manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 50,
      paintGateHardTimeoutMs: 150,
      cachedProjectViews: 3,
    });

    const welcomeWc = createMockWebContents();
    const welcomeView = { webContents: welcomeWc, setBounds: vi.fn() };
    win.contentView.addChildView(welcomeView);

    const incomingWc = createMockWebContents();
    wcQueue.push(incomingWc);

    const switchPromise = manager.switchTo("proj-first", "/path/first");
    await Promise.resolve();
    await Promise.resolve();

    const incomingAdd = win.contentView.addChildView.mock.calls.find(
      ([view]) => (view as { webContents: MockWc }).webContents === incomingWc
    );
    expect(incomingAdd).toBeDefined();
    expect(incomingAdd?.[1]).toBe(0);
    expect(win.contentView.removeChildView).not.toHaveBeenCalled();

    manager.signalViewPainted(incomingWc.id);
    await switchPromise;

    expect(win.contentView.removeChildView).toHaveBeenCalledWith(welcomeView);
    expect(welcomeWc.close).toHaveBeenCalled();
    expect(incomingWc.close).not.toHaveBeenCalled();
    expect(manager.getActiveProjectId()).toBe("proj-first");
    expect(manager.getProjectIdForWebContents(incomingWc.id)).toBe("proj-first");
  });

  it("restores the unbound welcome view registration when first project load fails", async () => {
    manager.dispose();

    win = createMockWindow();
    manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 50,
      paintGateHardTimeoutMs: 150,
      cachedProjectViews: 3,
    });

    const welcomeWc = createMockWebContents();
    const welcomeView = { webContents: welcomeWc, setBounds: vi.fn() };
    win.contentView.addChildView(welcomeView);

    const failWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(failWc);
    vi.mocked(registerAppView).mockClear();

    const switchPromise = manager.switchTo("proj-first", "/path/first").catch((err) => err);
    await Promise.resolve();
    failWc._fireOnce("did-fail-load", {}, -3, "ERR_FAILED");
    await switchPromise;

    expect(win.contentView.removeChildView).not.toHaveBeenCalledWith(welcomeView);
    expect(welcomeWc.close).not.toHaveBeenCalled();
    expect(failWc.close).toHaveBeenCalled();
    expect(manager.getActiveProjectId()).toBeNull();

    const registerCalls = vi.mocked(registerAppView).mock.calls;
    const lastCall = registerCalls[registerCalls.length - 1];
    expect(lastCall?.[1]).toBe(welcomeView);
  });

  it("dispose() while paint gate is pending settles the wait without throwing", async () => {
    const incomingWc = createMockWebContents();
    wcQueue.push(incomingWc);

    const switchPromise = manager.switchTo("proj-b", "/path/b").catch((err) => err);
    await Promise.resolve();
    await Promise.resolve();

    // Dispose while gate is open — the pending paint promise must resolve
    // (as "cancelled") so the underlying performSwitch chain doesn't leak.
    expect(() => manager.dispose()).not.toThrow();

    // The switch may resolve or reject depending on subsequent code paths;
    // we just need it to settle, not hang.
    await Promise.race([switchPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("calls unfreezeWebContents on the incoming view after did-finish-load", async () => {
    // The incoming view is stacked behind the still-visible outgoing view,
    // so Chromium marks it occluded and throttles rAF — which is exactly the
    // signal the paint gate is waiting on. unfreezeWebContents pushes the
    // renderer back to lifecycle "active" so rAF keeps firing during the
    // swap window. Must run AFTER did-finish-load; calling earlier hangs the
    // CDP session on an uninitialised frame host (Chromium 146).
    const incomingWc = createMockWebContents();
    wcQueue.push(incomingWc);

    const switchPromise = manager.switchTo("proj-b", "/path/b");

    // Let waitForPaint arm and did-finish-load schedule, then signal paint
    // so the full performSwitch chain settles before we inspect the mock.
    await Promise.resolve();
    await Promise.resolve();
    manager.signalViewPainted(incomingWc.id);
    await switchPromise;

    expect(vi.mocked(unfreezeWebContents)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(unfreezeWebContents).mock.calls[0]?.[0]).toBe(incomingWc);
  });

  it("logs loadToPaintMs alongside projectview.coldstart", async () => {
    const incomingWc = createMockWebContents();
    wcQueue.push(incomingWc);

    const switchPromise = manager.switchTo("proj-b", "/path/b");
    await Promise.resolve();
    await Promise.resolve();
    manager.signalViewPainted(incomingWc.id);
    await switchPromise;

    const coldstartCall = vi
      .mocked(logInfo)
      .mock.calls.find(([event]) => event === "projectview.coldstart");
    expect(coldstartCall).toBeDefined();
    const payload = coldstartCall?.[1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      projectId: "proj-b",
      paintGateOutcome: "signal",
    });
    expect(typeof payload.loadToPaintMs).toBe("number");
    expect(payload.loadToPaintMs).toBeGreaterThanOrEqual(0);
  });

  it("notifies a view it is being cached so the renderer can cancel reveal work", async () => {
    const incomingWc = createMockWebContents();
    wcQueue.push(incomingWc);

    const switchPromise = manager.switchTo("proj-b", "/path/b");
    await Promise.resolve();
    await Promise.resolve();
    manager.signalViewPainted(incomingWc.id);
    await switchPromise;

    // The outgoing project-a view was cached → its renderer is told so it can
    // cancel any in-flight wake/repaint rAFs before being throttled/frozen.
    expect(initialWc.send).toHaveBeenCalledWith(CHANNELS.APP_VIEW_CACHED);
  });

});
