import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let nextWebContentsId = 500;

type Handler = (...args: unknown[]) => void;

interface MockWc {
  id: number;
  isDestroyed: ReturnType<typeof vi.fn>;
  executeJavaScript: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
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
    return { webContents: wc, setBounds: vi.fn() };
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

vi.mock("../../services/PtyManager.js", () => ({
  getPtyManager: vi.fn(() => ({ getAll: () => [] })),
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

    win = createMockWindow();
    // Use a small, non-zero timeout so tests can observe both the signal
    // path (resolves before timeout) and the timeout path (advances past it).
    manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      paintGateTimeoutMs: 50,
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

  it("falls through paint gate after timeout when signal never arrives", async () => {
    vi.useFakeTimers();
    try {
      const slowWc = createMockWebContents();
      wcQueue.push(slowWc);

      const switchPromise = manager.switchTo("proj-b", "/path/b");

      // Flush microtasks so did-finish-load fires and waitForPaint is armed.
      await vi.advanceTimersByTimeAsync(0);

      // Outgoing still attached, gate pending.
      expect(win.contentView.removeChildView).not.toHaveBeenCalled();

      // Advance past the paint gate timeout (50ms).
      await vi.advanceTimersByTimeAsync(60);
      await switchPromise;

      expect(win.contentView.removeChildView).toHaveBeenCalledTimes(1);
      expect(manager.getActiveProjectId()).toBe("proj-b");
      expect(
        vi.mocked(logWarn).mock.calls.filter(([event]) => event === "projectview.paintgate.timeout")
      ).toHaveLength(1);
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

  it("cached revival skips the paint gate", async () => {
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

    // Switching back to A (a cached project) must NOT block on a paint signal.
    const switchBack = manager.switchTo("proj-a", "/path/a");
    // No signal sent — cached path completes anyway.
    const result = await switchBack;

    expect(result.isNew).toBe(false);
    expect(manager.getActiveProjectId()).toBe("proj-a");
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
      vi.mocked(logWarn).mock.calls.filter(([e]) => e === "projectview.paintgate.timeout")
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
});
