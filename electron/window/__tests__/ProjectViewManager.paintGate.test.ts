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
  // WebContents-scoped ipc receiver (Electron `webContents.ipc`). Production
  // registers the cold-start skeleton-parsed listener here; the real renderer
  // `send` is simulated via `_emitIpcOnce`.
  ipc: {
    once: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
  };
  _fireOnce: (event: string, ...args: unknown[]) => void;
  _emitIpcOnce: (channel: string, ...args: unknown[]) => void;
}

function createMockWebContents(opts?: { autoFinishLoad?: boolean }): MockWc {
  const id = nextWebContentsId++;
  const handlers = new Map<string, Handler[]>();
  const ipcHandlers = new Map<string, Handler[]>();
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
    ipc: {
      once: vi.fn((channel: string, handler: Handler) => {
        if (!ipcHandlers.has(channel)) ipcHandlers.set(channel, []);
        ipcHandlers.get(channel)!.push(handler);
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    _fireOnce(event: string, ...args: unknown[]) {
      const list = handlers.get(event);
      if (list && list.length > 0) {
        const h = list.shift()!;
        h(...args);
      }
    },
    _emitIpcOnce(channel: string, ...args: unknown[]) {
      const list = ipcHandlers.get(channel);
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
        // Re-adding a view whose parent is unchanged reorders it rather than
        // duplicating it. Modelled because the rollback path now re-attaches
        // through activateView, which can land on a still-attached view.
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
  return win;
}

/**
 * Attach the rejection handler in the same tick the switch is started, so a
 * fake-timer test can advance past the gate without tripping an unhandled
 * rejection.
 */
function expectRejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("Expected the switch to reject");
    },
    (err: unknown) => err as Error
  );
}

describe("ProjectViewManager — paint gate (cold-start visible swap)", () => {
  // Small, non-zero bounds so each phase is observable. Named because the
  // timeout telemetry asserts against them: comparing a reported bound to the
  // fixture's own input is the only way to catch it reporting the wrong one.
  const PAINT_SOFT_MS = 50;
  const PAINT_HARD_MS = 150;

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
      paintGateTimeoutMs: PAINT_SOFT_MS,
      paintGateHardTimeoutMs: PAINT_HARD_MS,
      // Compressed onto the same scale: the focus-intent (`painted`) channel
      // stretches its hard bound to this value, and the hard-timeout tests
      // below are written against the 150 ms bound.
      viewLoadTimeoutMs: 100,
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

  it("abandons the switch at hard timeout when the signal never arrives", async () => {
    // Both release signals are document-owned, so exhausting the budget means
    // the incoming view produced no evidence it can render. Committing anyway
    // is what stranded users on a frame with no in-app recovery (#11635). This
    // load settles immediately, so the retimed window (#11765) opens at once
    // and the bound behaves exactly as it did before it moved.
    vi.useFakeTimers();
    try {
      const slowWc = createMockWebContents();
      wcQueue.push(slowWc);

      const switchPromise = manager.switchTo("proj-b", "/path/b");
      const rejection = expectRejection(switchPromise);

      // Flush microtasks so did-finish-load fires and waitForPaint is armed.
      await vi.advanceTimersByTimeAsync(0);

      // Cross the soft bound (50 ms) — outgoing still attached.
      await vi.advanceTimersByTimeAsync(60);
      expect(win.contentView.removeChildView).not.toHaveBeenCalled();

      // Cross the hard bound (150 ms total) — switch abandoned, not committed.
      await vi.advanceTimersByTimeAsync(100);
      const err = await rejection;

      expect(err.message).toContain("View never painted");
      expect((err as { context?: Record<string, unknown> }).context).toMatchObject({
        phase: "paint",
        projectId: "proj-b",
      });
      // The healthy outgoing view is still the attached, active one — and it
      // was never detached in the first place. Asserting only that it ends up
      // attached would also pass if the branch detached it and the rollback put
      // it back, which still fires the cache/throttle/freeze side effects and
      // flashes the blank frame this whole path exists to prevent.
      expect(manager.getActiveProjectId()).toBe("proj-a");
      const outgoing = manager.getActiveView();
      expect(win.contentView.removeChildView).not.toHaveBeenCalledWith(outgoing);
      expect(initialWc.send).not.toHaveBeenCalledWith(CHANNELS.APP_VIEW_CACHED);
      // The failed view is gone rather than left stacked behind the outgoing one.
      expect(win.contentView.children).toEqual([outgoing]);
      expect(slowWc.close).toHaveBeenCalled();
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
      // Telemetry must not go dark on the failure the gate exists to measure.
      const rejected = vi
        .mocked(logInfo)
        .mock.calls.filter(([event]) => event === "projectview.coldstart.rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.[1]).toMatchObject({
        projectId: "proj-b",
        paintGateOutcome: "hard-timeout",
        rollbackProjectId: "proj-a",
      });
      // ...and the success event must not also claim this switch landed.
      expect(
        vi.mocked(logInfo).mock.calls.filter(([event]) => event === "projectview.coldstart")
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a slow cold load outlive the skeleton paint bound", async () => {
    // #11765: the gate is armed before `loadView` starts, so its bound used to
    // be spent on renderer spawn, preload eval and the load itself. A cold load
    // slower than the paint bound but well inside the load budget expired the
    // gate mid-flight and the switch was abandoned — a rollback and an error
    // toast for a switch that was about to succeed. Slow is not broken.
    vi.useFakeTimers();
    try {
      const slowWc = createMockWebContents({ autoFinishLoad: false });
      wcQueue.push(slowWc);

      // Compress the load ceiling onto the same scale as the paint bounds, so
      // "the gate outlasts the load" is measured against the load's own budget
      // rather than against some arbitrary larger number. Without this the
      // default 30 s ceiling makes any widened bound pass.
      const loadHardMs = 1_000;
      manager.setViewLoadHardTimeoutMs(loadHardMs);

      const switchPromise = manager.switchTo("proj-b", "/path/b");
      await vi.advanceTimersByTimeAsync(0);

      // Right up to the load's own fatal ceiling — the whole window in which a
      // legitimately slow load can still settle. The gate must survive all of
      // it: until the load settles nothing has been learned about this view.
      // (The old bound expired at 150 ms, a fraction of the way in.)
      await vi.advanceTimersByTimeAsync(loadHardMs - 1);
      expect(manager.pendingPaintGate).not.toBeNull();
      expect(win.contentView.removeChildView).not.toHaveBeenCalled();

      // The real renderer fires the parse-time skeleton signal during the load,
      // so drive that ordering rather than a post-settle signal.
      slowWc._emitIpcOnce(CHANNELS.APP_SKELETON_PARSED);
      slowWc._fireOnce("did-finish-load");
      await switchPromise;

      expect(manager.getActiveProjectId()).toBe("proj-b");
      expect(
        vi
          .mocked(logWarn)
          .mock.calls.filter(([event]) => event === "projectview.paintgate.hardtimeout")
      ).toHaveLength(0);
      expect(
        vi
          .mocked(logInfo)
          .mock.calls.filter(([event]) => event === "projectview.coldstart.rejected")
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spends the skeleton paint bound from load settle, not from gate arm", async () => {
    // The other half of #11765: widening the bound must not also slow the
    // abandon of a view that genuinely never renders. A load that settles late
    // and then never signals still gets the same tight paint window it always
    // had — just measured from the settle rather than from before the load.
    vi.useFakeTimers();
    try {
      const slowWc = createMockWebContents({ autoFinishLoad: false });
      wcQueue.push(slowWc);

      const switchPromise = manager.switchTo("proj-b", "/path/b");
      const rejection = expectRejection(switchPromise);
      await vi.advanceTimersByTimeAsync(0);

      // Hold the load past the paint bound with no signal at all, then settle.
      await vi.advanceTimersByTimeAsync(400);
      slowWc._fireOnce("did-finish-load");
      // Flush the bootstrap probe so the retime has actually run.
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.pendingPaintGate).not.toBeNull();

      // Just short of the paint bound measured from the settle — still waiting.
      await vi.advanceTimersByTimeAsync(140);
      expect(manager.pendingPaintGate).not.toBeNull();

      // Crossing it abandons, exactly as it did before this window moved.
      await vi.advanceTimersByTimeAsync(20);
      const err = await rejection;
      expect(err.message).toContain("View never painted");
      expect(manager.getActiveProjectId()).toBe("proj-a");

      // The retimed bound is what expired, and both the log and the error must
      // say so rather than reporting the provisional ceiling the gate was armed
      // with — that one outlasts the load, so it would overstate the wait by
      // the whole load. PAINT_HARD_MS is this fixture's own input, not a
      // production literal.
      const hardTimeouts = vi
        .mocked(logWarn)
        .mock.calls.filter(([event]) => event === "projectview.paintgate.hardtimeout");
      expect(hardTimeouts).toHaveLength(1);
      expect(hardTimeouts[0]?.[1]).toMatchObject({
        projectId: "proj-b",
        releaseChannel: "skeleton-painted",
        hardTimeoutOrigin: "load-finished",
        waitedMs: PAINT_HARD_MS,
      });
      expect((err as { context?: Record<string, unknown> }).context).toMatchObject({
        phase: "paint",
        waitedMs: PAINT_HARD_MS,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces the provisional hard timer rather than leaving it armed", async () => {
    // The retime swaps `gate.hardTimeout` in place, so the old handle is the
    // only reference that can cancel the provisional timer. Dropping it without
    // clearing is invisible from behaviour alone: the orphan fires ~30 s later,
    // hits the `settled` latch and changes nothing observable, while its
    // closure pins the gate and the views it captures for that whole window.
    // Only a timer inventory catches it — same reason the load-timer test does
    // this. Counting rather than advancing is also what keeps this honest: an
    // orphan that never fires still fails here.
    vi.useFakeTimers();
    try {
      const slowWc = createMockWebContents({ autoFinishLoad: false });
      wcQueue.push(slowWc);

      const switchPromise = manager.switchTo("proj-b", "/path/b");
      await vi.advanceTimersByTimeAsync(0);

      const gate = manager.pendingPaintGate;
      expect(gate).not.toBeNull();
      const provisionalHandle = gate?.hardTimeout;

      // Measured around the retime alone, with the load deliberately still in
      // flight. Straddling the load settle instead would net this against
      // loadView's own two timers clearing, and the swap would vanish into
      // that noise.
      const armedCount = vi.getTimerCount();
      expect(manager.retimeSkeletonPaintGateHardTimeout(slowWc.id, PAINT_HARD_MS)).toBe(true);

      // A different handle proves the swap happened; an unchanged total proves
      // the one it replaced was cancelled rather than orphaned.
      expect(manager.pendingPaintGate).toBe(gate);
      expect(gate?.hardTimeout).not.toBe(provisionalHandle);
      expect(vi.getTimerCount()).toBe(armedCount);

      slowWc._fireOnce("did-finish-load");
      await vi.advanceTimersByTimeAsync(0);
      manager.signalSkeletonPainted(slowWc.id);
      await switchPromise;

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

  it("retime is a no-op for a gate that is missing, superseded or on another channel", async () => {
    // The retime lands after an await, so by the time it runs the gate it was
    // meant for may be gone, replaced, or waiting on a different channel. Every
    // mismatch must leave the pending gate's timer alone — a late call from a
    // superseded switch must never retime whatever replaced it.
    vi.useFakeTimers();
    try {
      // No gate at all — the shape suites that stub `waitForPaint` produce.
      expect(manager.retimeSkeletonPaintGateHardTimeout(999, 150)).toBe(false);

      const slowWc = createMockWebContents({ autoFinishLoad: false });
      wcQueue.push(slowWc);
      const switchPromise = manager.switchTo("proj-b", "/path/b");
      await vi.advanceTimersByTimeAsync(0);

      const gate = manager.pendingPaintGate;
      expect(gate?.releaseChannel).toBe("skeleton-painted");

      // A rejected call must leave the timer alone, not just the pointer: the
      // retime mutates `hardTimeout` in place, so an implementation that
      // retimed and *then* returned false would keep gate identity and slip
      // past a pointer-only assertion.
      const untouched = gate?.hardTimeout;

      // Wrong webContents — a stale call from an earlier switch.
      expect(manager.retimeSkeletonPaintGateHardTimeout(slowWc.id + 1, PAINT_HARD_MS)).toBe(false);
      expect(manager.pendingPaintGate).toBe(gate);
      expect(gate?.hardTimeout).toBe(untouched);

      // Matching open skeleton gate — the only case that retimes.
      expect(manager.retimeSkeletonPaintGateHardTimeout(slowWc.id, PAINT_HARD_MS)).toBe(true);
      expect(manager.pendingPaintGate).toBe(gate);
      expect(gate?.hardTimeout).not.toBe(untouched);

      manager.signalSkeletonPainted(slowWc.id);
      slowWc._fireOnce("did-finish-load");
      await switchPromise;

      // Released gate — the common fast path's result.
      expect(manager.retimeSkeletonPaintGateHardTimeout(slowWc.id, PAINT_HARD_MS)).toBe(false);

      // Wrong channel: a warm gate on the very same webContents. Only the
      // skeleton channel is spent from before its load, so retiming any other
      // would shorten a bound that was never oversized to begin with.
      const warmGatePromise = manager.waitForPaint(slowWc.id, null, null, undefined, {
        releaseChannel: "warm-painted",
      });
      const warmGate = manager.pendingPaintGate;
      const warmHandle = warmGate?.hardTimeout;
      expect(manager.retimeSkeletonPaintGateHardTimeout(slowWc.id, PAINT_HARD_MS)).toBe(false);
      expect(warmGate?.hardTimeout).toBe(warmHandle);
      manager.clearPaintGate();
      await warmGatePromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("abandons a painted-channel switch whose gate expired while the load ran", async () => {
    // Only the skeleton channel's bound moved (#11765); the focus-intent
    // `"painted"` gate is still spent from arm time, so it can still expire
    // with the load in flight. Nothing acts on that until the load settles —
    // the gate is awaited after it — and the verdict when it does is abandon
    // and roll back, never a commit onto a view that never painted (#11635).
    vi.useFakeTimers();
    try {
      const slowWc = createMockWebContents({ autoFinishLoad: false });
      wcQueue.push(slowWc);

      manager.setPendingFocusIntent("proj-b", { intent: "focus-next-waiting" });

      const switchPromise = manager.switchTo("proj-b", "/path/b");
      const rejection = expectRejection(switchPromise);
      await vi.advanceTimersByTimeAsync(0);

      // Gate expires mid-load. The outgoing view stays attached and is still
      // reported as the on-screen bridge across that boundary — from
      // `pendingColdSwitch` now that the gate has dropped itself.
      await vi.advanceTimersByTimeAsync(PAINT_HARD_MS + 10);
      expect(manager.pendingPaintGate).toBeNull();
      expect(manager.getOutgoingBridgeProjectId()).toBe("proj-a");
      expect(win.contentView.removeChildView).not.toHaveBeenCalled();

      // The load settles successfully — and the already-expired gate still
      // abandons, because a load that finished is not a view that painted.
      slowWc._fireOnce("did-finish-load");
      await vi.advanceTimersByTimeAsync(0);
      const err = await rejection;

      expect(err.message).toContain("View never painted");
      expect(manager.getActiveProjectId()).toBe("proj-a");
      expect(manager.getOutgoingBridgeProjectId()).toBeNull();

      // The non-retimed regime: this bound really was spent from the arm, and
      // the telemetry has to name that clock rather than implying the
      // post-load window the skeleton channel now gets.
      const hardTimeouts = vi
        .mocked(logWarn)
        .mock.calls.filter(([event]) => event === "projectview.paintgate.hardtimeout");
      expect(hardTimeouts).toHaveLength(1);
      expect(hardTimeouts[0]?.[1]).toMatchObject({
        releaseChannel: "painted",
        hardTimeoutOrigin: "gate-armed",
        waitedMs: PAINT_HARD_MS,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("hard timeout drops the pending focus intent", async () => {
    vi.useFakeTimers();
    try {
      const slowWc = createMockWebContents();
      wcQueue.push(slowWc);

      manager.setPendingFocusIntent("proj-b", { intent: "focus-next-waiting" });

      const switchPromise = manager.switchTo("proj-b", "/path/b");
      const rejection = expectRejection(switchPromise);
      await vi.advanceTimersByTimeAsync(0);
      // Past hard bound — switch abandoned, intent dropped rather than
      // delivered into a view that never proved it could render.
      await vi.advanceTimersByTimeAsync(200);
      await rejection;

      expect(slowWc.send).not.toHaveBeenCalledWith("project:focus-on-activate", expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the focus-intent gate past the skeleton bound for a slow-but-correct cold boot", async () => {
    // The `"painted"` channel waits for the full React cold boot, not the
    // parse-time skeleton, so its budget must outlast a boot that would blow
    // the skeleton channel's bound — otherwise a cold focus-next-waiting
    // (agentActions) or focus-panel (projectActions) rejects the whole switch
    // and shows an error toast. Slow is not the same failure as wrong document;
    // the abandon tests above still hold for the skeleton channel, whose signal
    // lands during the load rather than after it.
    vi.useFakeTimers();
    try {
      const slowWc = createMockWebContents();
      wcQueue.push(slowWc);

      manager.setViewLoadTimeoutMs(1_000);
      manager.setPendingFocusIntent("proj-b", { intent: "focus-next-waiting" });

      const switchPromise = manager.switchTo("proj-b", "/path/b");
      await vi.advanceTimersByTimeAsync(0);

      // Well past the skeleton channel's hard bound: this gate is still open
      // and the outgoing view is still bridging.
      await vi.advanceTimersByTimeAsync(400);
      expect(win.contentView.removeChildView).not.toHaveBeenCalled();

      // React finally commits — the switch lands and the intent is delivered.
      manager.signalViewPainted(slowWc.id);
      await switchPromise;

      expect(manager.getActiveProjectId()).toBe("proj-b");
      expect(slowWc.send).toHaveBeenCalledWith(CHANNELS.PROJECT_FOCUS_ON_ACTIVATE, {
        intent: "focus-next-waiting",
      });
      expect(
        vi
          .mocked(logWarn)
          .mock.calls.filter(([event]) => event === "projectview.paintgate.hardtimeout")
      ).toHaveLength(0);
      expect(
        vi
          .mocked(logInfo)
          .mock.calls.filter(([event]) => event === "projectview.coldstart.rejected")
      ).toHaveLength(0);
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
      const rejection = expectRejection(switchPromise);
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

      // Cross the original hard bound — the gate settles on the captured value
      // rather than the bumped one, so the switch is abandoned here.
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      expect(
        vi
          .mocked(logWarn)
          .mock.calls.filter(([event]) => event === "projectview.paintgate.hardtimeout")
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

  it("early-reveals on the real skeleton-parsed IPC signal (before React paints)", async () => {
    const incomingWc = createMockWebContents();
    wcQueue.push(incomingWc);

    const switchPromise = manager.switchTo("proj-b", "/path/b");
    await Promise.resolve();
    await Promise.resolve();

    // The cold path must register a scoped skeleton-parsed listener on the
    // incoming view's webContents — this is the real production wiring, not the
    // test calling signalSkeletonPainted() directly.
    expect(incomingWc.ipc.once).toHaveBeenCalledWith(
      CHANNELS.APP_SKELETON_PARSED,
      expect.any(Function)
    );

    // Bridge armed: incoming behind outgoing, outgoing still attached.
    expect(win.contentView.removeChildView).not.toHaveBeenCalled();

    // Fire the renderer's skeleton-parsed send (well before any APP_VIEW_PAINTED)
    // through the real listener — the outgoing view detaches and the branded
    // skeleton reveals on the fast path.
    incomingWc._emitIpcOnce(CHANNELS.APP_SKELETON_PARSED);
    await switchPromise;

    expect(win.contentView.removeChildView).toHaveBeenCalledTimes(1);
    expect(manager.getActiveProjectId()).toBe("proj-b");
    // Telemetry records the fast-path strategy.
    const cold = vi.mocked(logInfo).mock.calls.find(([e]) => e === "projectview.coldstart");
    expect(cold?.[1]).toMatchObject({
      gateChannel: "skeleton-painted",
      paintGateOutcome: "signal",
    });
    // Released cleanly by the early signal — no timeout warnings.
    expect(
      vi
        .mocked(logWarn)
        .mock.calls.filter(
          ([e]) =>
            e === "projectview.paintgate.softtimeout" || e === "projectview.paintgate.hardtimeout"
        )
    ).toHaveLength(0);
  });

  it("arms the skeleton listener before loadURL so the parse-time send can't be missed", async () => {
    const incomingWc = createMockWebContents();
    wcQueue.push(incomingWc);

    const switchPromise = manager.switchTo("proj-b", "/path/b");
    await Promise.resolve();
    await Promise.resolve();

    // The listener must be armed before navigation — skeleton-ready.js fires
    // during HTML parse, so a listener registered after loadURL could miss it.
    const onceOrder = incomingWc.ipc.once.mock.invocationCallOrder[0];
    const loadOrder = incomingWc.loadURL.mock.invocationCallOrder[0];
    expect(onceOrder).toBeDefined();
    expect(loadOrder).toBeDefined();
    expect(onceOrder).toBeLessThan(loadOrder);

    incomingWc._emitIpcOnce(CHANNELS.APP_SKELETON_PARSED);
    await switchPromise;
    expect(manager.getActiveProjectId()).toBe("proj-b");
  });

  it("does not arm the skeleton listener (or early-reveal) when a focus intent is pending", async () => {
    const incomingWc = createMockWebContents();
    wcQueue.push(incomingWc);

    // A pending focus intent forces the legacy "painted" gating: the focus IPC
    // listener isn't mounted until React commits, so the gate must wait for the
    // real paint rather than the bare pre-React skeleton (#4670).
    manager.setPendingFocusIntent("proj-b", { intent: "focus-next-waiting" });

    const switchPromise = manager.switchTo("proj-b", "/path/b");
    await Promise.resolve();
    await Promise.resolve();

    // The focus-intent path must NOT register a skeleton listener at all.
    expect(incomingWc.ipc.once).not.toHaveBeenCalledWith(
      CHANNELS.APP_SKELETON_PARSED,
      expect.anything()
    );

    // Even a (defensively) injected skeleton signal must NOT release the gate.
    manager.signalSkeletonPainted(incomingWc.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(win.contentView.removeChildView).not.toHaveBeenCalled();
    expect(incomingWc.send).not.toHaveBeenCalledWith(
      "project:focus-on-activate",
      expect.anything()
    );

    // The real React paint releases the gate AND delivers the focus intent.
    manager.signalViewPainted(incomingWc.id);
    await switchPromise;

    expect(win.contentView.removeChildView).toHaveBeenCalledTimes(1);
    expect(manager.getActiveProjectId()).toBe("proj-b");
    expect(incomingWc.send).toHaveBeenCalledWith("project:focus-on-activate", {
      intent: "focus-next-waiting",
    });
    const cold = vi.mocked(logInfo).mock.calls.find(([e]) => e === "projectview.coldstart");
    expect(cold?.[1]).toMatchObject({ gateChannel: "painted" });
  });

  it("does NOT consume a focus intent that arrives mid-flight on the fast skeleton path", async () => {
    // Regression: a repeated focusNextWaitingGlobal can set a focus intent AFTER
    // a skeleton-gated switch armed (when no intent existed). The fast path must
    // not consume-and-drop it — it must leave it pending for the next
    // same-project switch to deliver once React is mounted.
    const incomingWc = createMockWebContents();
    wcQueue.push(incomingWc);

    const switchPromise = manager.switchTo("proj-b", "/path/b");
    await Promise.resolve();
    await Promise.resolve();

    // Intent set mid-flight (after the gate was armed for the skeleton channel).
    manager.setPendingFocusIntent("proj-b", { intent: "focus-next-waiting" });

    incomingWc._emitIpcOnce(CHANNELS.APP_SKELETON_PARSED);
    await switchPromise;

    // Revealed fast; the mid-flight intent was NOT delivered into the bare
    // pre-React skeleton.
    expect(incomingWc.send).not.toHaveBeenCalledWith(
      "project:focus-on-activate",
      expect.anything()
    );

    // …and crucially it was NOT consumed/dropped. A follow-up switch to the
    // (now active) same project takes the active-project path, which consumes
    // and delivers the surviving intent — proving it outlived the fast reveal.
    await manager.switchTo("proj-b", "/path/b");
    expect(incomingWc.send).toHaveBeenCalledWith("project:focus-on-activate", {
      intent: "focus-next-waiting",
    });
  });

  it("captures a skeleton signal that arrives before did-finish-load resolves", async () => {
    // The gate (and its scoped skeleton listener) is armed BEFORE awaiting
    // loadView, so a skeleton-ready send firing during parse — possibly before
    // did-finish-load resolves — is captured, not dropped to the timeout.
    const incomingWc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(incomingWc);

    const switchPromise = manager.switchTo("proj-b", "/path/b");
    await Promise.resolve();

    // Skeleton parses first — captured by the pre-armed listener.
    incomingWc._emitIpcOnce(CHANNELS.APP_SKELETON_PARSED);
    // Outgoing stays attached until loadView resolves (the swap runs after the
    // awaited load, not on the bare signal).
    expect(win.contentView.removeChildView).not.toHaveBeenCalled();

    // Now let did-finish-load resolve — the captured signal drives a clean swap.
    incomingWc._fireOnce("did-finish-load");
    await switchPromise;

    expect(manager.getActiveProjectId()).toBe("proj-b");
    expect(win.contentView.removeChildView).toHaveBeenCalledTimes(1);
    expect(
      vi
        .mocked(logWarn)
        .mock.calls.filter(
          ([e]) =>
            e === "projectview.paintgate.softtimeout" || e === "projectview.paintgate.hardtimeout"
        )
    ).toHaveLength(0);
  });

  it("treats a later view-painted as an idempotent no-op after the skeleton already revealed", async () => {
    vi.useFakeTimers();
    try {
      const incomingWc = createMockWebContents();
      wcQueue.push(incomingWc);

      const switchPromise = manager.switchTo("proj-b", "/path/b");
      await vi.advanceTimersByTimeAsync(0);

      // Fast reveal on the skeleton signal.
      incomingWc._emitIpcOnce(CHANNELS.APP_SKELETON_PARSED);
      await switchPromise;
      expect(win.contentView.removeChildView).toHaveBeenCalledTimes(1);

      // React paints later (the normal real sequence). The gate is already
      // settled, so this is a no-op — no second detach, one coldstart log, no
      // timeout warnings.
      manager.signalViewPainted(incomingWc.id);
      await vi.advanceTimersByTimeAsync(500);

      expect(win.contentView.removeChildView).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(logInfo).mock.calls.filter(([e]) => e === "projectview.coldstart")
      ).toHaveLength(1);
      expect(
        vi
          .mocked(logWarn)
          .mock.calls.filter(
            ([e]) =>
              e === "projectview.paintgate.softtimeout" || e === "projectview.paintgate.hardtimeout"
          )
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a skeleton gate via the view-painted fallback when the skeleton signal never arrives", async () => {
    const incomingWc = createMockWebContents();
    wcQueue.push(incomingWc);

    const switchPromise = manager.switchTo("proj-b", "/path/b");
    await Promise.resolve();
    await Promise.resolve();
    expect(win.contentView.removeChildView).not.toHaveBeenCalled();

    // No skeleton signal arrives (e.g. the classic skeleton-ready script raced a
    // navigation). The later React paint must still detach the bridge, so an
    // early-reveal switch can never hang worse than the legacy behaviour.
    manager.signalViewPainted(incomingWc.id);
    await switchPromise;

    expect(win.contentView.removeChildView).toHaveBeenCalledTimes(1);
    expect(manager.getActiveProjectId()).toBe("proj-b");
    // Still recorded as the fast-path strategy (the channel reflects the
    // strategy chosen, not which signal ultimately fired).
    const cold = vi.mocked(logInfo).mock.calls.find(([e]) => e === "projectview.coldstart");
    expect(cold?.[1]).toMatchObject({ gateChannel: "skeleton-painted" });
  });

  it("ignores a skeleton signal from an unknown webContentsId", async () => {
    const incomingWc = createMockWebContents();
    wcQueue.push(incomingWc);

    const switchPromise = manager.switchTo("proj-b", "/path/b");
    await Promise.resolve();
    await Promise.resolve();

    // Bogus skeleton signal — gate stays open.
    manager.signalSkeletonPainted(99_999);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(win.contentView.removeChildView).not.toHaveBeenCalled();

    // Correct skeleton signal — releases.
    manager.signalSkeletonPainted(incomingWc.id);
    await switchPromise;
    expect(win.contentView.removeChildView).toHaveBeenCalledTimes(1);
  });

  it("a skeleton signal does not release a warm bridge gate", async () => {
    const incomingWc = createMockWebContents();
    wcQueue.push(incomingWc);

    // Prime B in the cache via the fast skeleton path.
    const firstSwitch = manager.switchTo("proj-b", "/path/b");
    await Promise.resolve();
    await Promise.resolve();
    manager.signalSkeletonPainted(incomingWc.id);
    await firstSwitch;

    win.contentView.removeChildView.mockClear();

    // Switch back to A (cached) — this opens a WARM gate, not a cold one.
    const switchBack = manager.switchTo("proj-a", "/path/a");
    for (let i = 0; i < 6; i++) await Promise.resolve();

    // The cold skeleton channel must not satisfy the warm gate (different
    // releaseChannel), even with a matching webContentsId.
    manager.signalSkeletonPainted(initialWc.id);
    await Promise.resolve();
    expect(win.contentView.removeChildView).not.toHaveBeenCalled();

    manager.signalWarmViewPainted(initialWc.id);
    await switchBack;
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

  it("warm reactivation sends the wake trigger to the cached view while the bridge is up", async () => {
    const incomingWc = createMockWebContents();
    wcQueue.push(incomingWc);

    const firstSwitch = manager.switchTo("proj-b", "/path/b");
    await Promise.resolve();
    await Promise.resolve();
    manager.signalViewPainted(incomingWc.id);
    await firstSwitch;

    win.contentView.removeChildView.mockClear();
    initialWc.send.mockClear();

    const switchBack = manager.switchTo("proj-a", "/path/a");
    for (let i = 0; i < 6; i++) await Promise.resolve();

    // The explicit wake trigger is the renderer's only reliable signal to run
    // its wake fan-out (a detached setVisible(false) view gets no
    // visibilitychange/resume on reattach), so it must arrive while the bridge
    // is still up — before the gate resolves — or the fan-out that releases
    // the gate never runs and every warm swap rides the hard timeout.
    expect(
      initialWc.send.mock.calls.filter(([c]) => c === CHANNELS.APP_VIEW_WARM_ACTIVATED)
    ).toHaveLength(1);
    expect(win.contentView.removeChildView).not.toHaveBeenCalled();

    manager.signalWarmViewPainted(initialWc.id);
    await switchBack;
    expect(win.contentView.removeChildView).toHaveBeenCalledTimes(1);
  });

  it("does not send the warm wake trigger on a cold switch", async () => {
    const incomingWc = createMockWebContents();
    wcQueue.push(incomingWc);

    const switchPromise = manager.switchTo("proj-b", "/path/b");
    await Promise.resolve();
    await Promise.resolve();
    manager.signalViewPainted(incomingWc.id);
    await switchPromise;

    // Cold-started renderers drive their own boot-time wake; the warm trigger
    // targeting them would be meaningless (no cached terminals to refit).
    expect(
      incomingWc.send.mock.calls.filter(([c]) => c === CHANNELS.APP_VIEW_WARM_ACTIVATED)
    ).toHaveLength(0);
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
      (() => void) | undefined;
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

  it("keeps the unbound welcome view when the first project view never paints", async () => {
    // Same abandon policy on the first-run window, where the outgoing view is
    // the welcome view rather than a project entry: it is closed for good once
    // detached, so committing a view that never painted would leave the window
    // with nothing recoverable on screen.
    manager.dispose();
    vi.useFakeTimers();
    try {
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

      const slowWc = createMockWebContents();
      wcQueue.push(slowWc);
      vi.mocked(registerAppView).mockClear();

      const rejection = expectRejection(manager.switchTo("proj-first", "/path/first"));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(200);
      await rejection;

      expect(win.contentView.removeChildView).not.toHaveBeenCalledWith(welcomeView);
      expect(welcomeWc.close).not.toHaveBeenCalled();
      expect(slowWc.close).toHaveBeenCalled();
      expect(manager.getActiveProjectId()).toBeNull();

      const registerCalls = vi.mocked(registerAppView).mock.calls;
      expect(registerCalls[registerCalls.length - 1]?.[1]).toBe(welcomeView);
    } finally {
      vi.useRealTimers();
    }
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
