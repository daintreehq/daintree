import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";

let nextWebContentsId = 100;

function createMockWebContents() {
  const id = nextWebContentsId++;
  return {
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
    on: vi.fn(() => {}),
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "did-finish-load") {
        Promise.resolve().then(() => handler());
      }
    }),
    removeListener: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    setIgnoreMenuShortcuts: vi.fn(),
  };
}

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
  getCrashRecoveryService: vi.fn(() => ({ recordCrash: vi.fn(), recordRendererGone: vi.fn() })),
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
  purgeMemoryWebContents: vi.fn().mockResolvedValue(false),
  readJsHeapUsedBytes: vi.fn().mockResolvedValue(null),
  freezeWebContents: vi.fn().mockResolvedValue(undefined),
  unfreezeWebContents: vi.fn().mockResolvedValue(undefined),
  unthrottleCpuWebContents: vi.fn().mockResolvedValue(undefined),
}));

import { ProjectViewManager } from "../ProjectViewManager.js";
import { events } from "../../services/events.js";
import { CHANNELS } from "../../ipc/channels.js";
import {
  freezeWebContents,
  unfreezeWebContents,
  unthrottleCpuWebContents,
  purgeMemoryWebContents,
  readJsHeapUsedBytes,
} from "../../utils/webContentsLifecycle.js";
import {
  registerCachedViewWebContents,
  unregisterCachedViewWebContents,
} from "../webContentsRegistry.js";
import {
  _resetDictationViewHoldsForTests,
  holdDictationView,
} from "../../services/voice/dictationViewHold.js";
import {
  CACHED_VIEW_FLUSH_TIMEOUT_MS,
  _resetCachedViewFlushForTests,
  recordCachedViewFlushArmed,
  settleCachedViewFlush,
} from "../../services/cachedViewFlush.js";

/** When main last told this renderer it is cached, the edge it schedules its idle GC on. */
function cachedSignalOrder(wc: ReturnType<typeof createMockWebContents>): number | undefined {
  const channels = wc.send.mock.calls.map(([channel]) => channel as unknown);
  const index = channels.lastIndexOf(CHANNELS.APP_VIEW_CACHED);
  return index === -1 ? undefined : wc.send.mock.invocationCallOrder[index];
}

function createMockWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    on: vi.fn(),
    removeListener: vi.fn(),
    getContentBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
    contentView: {
      on: vi.fn(),
      removeListener: vi.fn(),
      children: [] as unknown[],
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    },
    webContents: createMockWebContents(),
  };
}

describe("ProjectViewManager — efficiency freeze", () => {
  let manager: ProjectViewManager;
  let win: ReturnType<typeof createMockWindow>;
  let initialWc: ReturnType<typeof createMockWebContents>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    nextWebContentsId = 100;
    win = createMockWindow();
    manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 3,
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
    });
    // Stub the paint gate to resolve immediately — this suite uses fake timers
    // so the gate's setTimeout cannot fire on its own.
    (manager as unknown as { waitForPaint: () => Promise<string> }).waitForPaint = () =>
      Promise.resolve("signal");
    initialWc = createMockWebContents();
    const initialView = { webContents: initialWc, setBounds: vi.fn() };
    manager.registerInitialView(initialView as never, "proj-a", "/path/a");
  });

  afterEach(() => {
    // Every manager subscribes to flush settles, and the next test reuses its webContents ids.
    if (!manager.disposed) manager.dispose();
    _resetCachedViewFlushForTests();
    vi.useRealTimers();
  });

  it("freezes cached views after 500ms debounce", async () => {
    await manager.switchTo("proj-b", "/path/b");
    // proj-a is now cached, proj-b is active.

    manager.setEfficiencyFreeze(true);
    expect(vi.mocked(freezeWebContents)).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(vi.mocked(freezeWebContents)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(freezeWebContents)).toHaveBeenCalledWith(initialWc);
  });

  it("skips the active view when batch-freezing", async () => {
    await manager.switchTo("proj-b", "/path/b");
    const activeWc = manager.getActiveView()!.webContents;

    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);

    const freezeCalls = vi.mocked(freezeWebContents).mock.calls;
    // The active view's wc must never appear in freeze calls.
    expect(freezeCalls.every((call) => call[0] !== activeWc)).toBe(true);
  });

  it("skips destroyed wc when batch-freezing", async () => {
    await manager.switchTo("proj-b", "/path/b");
    initialWc.isDestroyed.mockReturnValue(true);

    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);

    expect(vi.mocked(freezeWebContents)).not.toHaveBeenCalled();
  });

  it("setEfficiencyFreeze(false) unfreezes cached views immediately", async () => {
    await manager.switchTo("proj-b", "/path/b");
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);
    vi.mocked(unfreezeWebContents).mockClear();

    manager.setEfficiencyFreeze(false);
    expect(vi.mocked(unfreezeWebContents)).toHaveBeenCalledWith(initialWc);
  });

  it("setEfficiencyFreeze(false) cancels a pending freeze timer", async () => {
    await manager.switchTo("proj-b", "/path/b");
    manager.setEfficiencyFreeze(true);

    manager.setEfficiencyFreeze(false);
    vi.advanceTimersByTime(500);

    expect(vi.mocked(freezeWebContents)).not.toHaveBeenCalled();
  });

  it("activateView always unfreezes the activating view, even when efficiency is off", async () => {
    await manager.switchTo("proj-b", "/path/b");
    vi.mocked(unfreezeWebContents).mockClear();

    // Switch back to proj-a — its cached view should be unfrozen on activate.
    await manager.switchTo("proj-a", "/path/a");

    expect(vi.mocked(unfreezeWebContents)).toHaveBeenCalledWith(initialWc);
  });

  it("deactivateCurrentView calls freezeWebContents only when efficiency is on, and AFTER the cached signal", async () => {
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);
    vi.mocked(freezeWebContents).mockClear();

    await manager.switchTo("proj-b", "/path/b");

    expect(vi.mocked(freezeWebContents)).toHaveBeenCalledWith(initialWc);
    // The renderer schedules its idle GC on that signal (lesson #4684).
    const freezeOrder = vi.mocked(freezeWebContents).mock.invocationCallOrder[0];
    expect(cachedSignalOrder(initialWc)).toBeLessThan(freezeOrder);
  });

  describe("a view a dictation still needs (#14773)", () => {
    afterEach(() => _resetDictationViewHoldsForTests());

    it("isn't frozen as the user leaves it", async () => {
      manager.setEfficiencyFreeze(true);
      vi.advanceTimersByTime(500);
      vi.mocked(freezeWebContents).mockClear();
      holdDictationView(initialWc.id);

      await manager.switchTo("proj-b", "/path/b");

      expect(vi.mocked(freezeWebContents)).not.toHaveBeenCalled();
    });

    it("is skipped by the batch freeze, and frozen once the dictation lets go", async () => {
      await manager.switchTo("proj-b", "/path/b");
      const release = holdDictationView(initialWc.id);

      manager.setEfficiencyFreeze(true);
      vi.advanceTimersByTime(500);
      expect(vi.mocked(freezeWebContents)).not.toHaveBeenCalled();

      release();
      manager.refreezeUnprotectedCachedViews();
      expect(vi.mocked(freezeWebContents)).toHaveBeenCalledWith(initialWc);
    });
  });

  describe("a view still flushing unsaved edits on its cached edge (#15633)", () => {
    afterEach(() => _resetDictationViewHoldsForTests());

    const flushIdSentTo = (wc: ReturnType<typeof createMockWebContents>) =>
      (
        wc.send.mock.calls.filter(([channel]) => channel === CHANNELS.APP_VIEW_CACHED).at(-1) as
          [string, { flushId?: string }?] | undefined
      )?.[1]?.flushId;
    const frozeInitial = () =>
      vi.mocked(freezeWebContents).mock.calls.some(([wc]) => (wc as unknown) === initialWc);

    beforeEach(() => {
      manager.setEfficiencyFreeze(true);
      vi.advanceTimersByTime(500);
      vi.mocked(freezeWebContents).mockClear();
      // Settings is open in proj-a as the user leaves it.
      recordCachedViewFlushArmed(initialWc as never, true);
    });

    it("isn't frozen until its renderer says the flush reached main", async () => {
      await manager.switchTo("proj-b", "/path/b");
      const flushId = flushIdSentTo(initialWc);
      expect(typeof flushId).toBe("string");
      expect(frozeInitial()).toBe(false);

      // A batch pass landing mid-flush leaves it alone too.
      manager.refreezeUnprotectedCachedViews();
      expect(frozeInitial()).toBe(false);

      settleCachedViewFlush(initialWc as never, flushId);
      vi.advanceTimersByTime(0);
      expect(vi.mocked(freezeWebContents)).toHaveBeenCalledWith(initialWc);

      // Still after the cached signal the renderer schedules its GC on (lesson #4684).
      const freezeOrder = vi.mocked(freezeWebContents).mock.invocationCallOrder.at(-1)!;
      expect(cachedSignalOrder(initialWc)).toBeLessThan(freezeOrder);
    });

    it("is frozen anyway once a renderer that never answers runs out its wait", async () => {
      await manager.switchTo("proj-b", "/path/b");

      vi.advanceTimersByTime(CACHED_VIEW_FLUSH_TIMEOUT_MS - 1);
      expect(frozeInitial()).toBe(false);
      vi.advanceTimersByTime(1);
      // The settle defers its freeze pass by a turn, which the fake clock only
      // runs once it moves on.
      vi.advanceTimersByTime(1);
      expect(vi.mocked(freezeWebContents)).toHaveBeenCalledWith(initialWc);
    });

    it("isn't frozen if it became active again before the flush settled", async () => {
      await manager.switchTo("proj-b", "/path/b");
      const flushId = flushIdSentTo(initialWc);
      await manager.switchTo("proj-a", "/path/a");

      settleCachedViewFlush(initialWc as never, flushId);
      vi.advanceTimersByTime(CACHED_VIEW_FLUSH_TIMEOUT_MS);

      expect(frozeInitial()).toBe(false);
    });

    it("freezes only the view that settled, not every unfrozen cached view", async () => {
      await manager.switchTo("proj-b", "/path/b");
      const flushId = flushIdSentTo(initialWc);
      const wcB = manager.getActiveView()!.webContents;
      // A dictation keeps proj-b unfrozen as the user leaves it; once it lets go,
      // only the periodic pass would freeze it.
      const release = holdDictationView(wcB.id);
      await manager.switchTo("proj-c", "/path/c");
      release();
      vi.mocked(freezeWebContents).mockClear();

      settleCachedViewFlush(initialWc as never, flushId);
      vi.advanceTimersByTime(1);

      const frozen = vi.mocked(freezeWebContents).mock.calls.map(([wc]) => wc as unknown);
      expect(frozen).toHaveLength(1);
      expect(frozen[0]).toBe(initialWc);
    });

    it("is frozen at once, as before, once its renderer has nothing registered", async () => {
      recordCachedViewFlushArmed(initialWc as never, false);

      await manager.switchTo("proj-b", "/path/b");

      expect(flushIdSentTo(initialWc)).toBeUndefined();
      expect(vi.mocked(freezeWebContents)).toHaveBeenCalledWith(initialWc);
    });
  });

  it("deactivateCurrentView does not freeze when efficiency is off", async () => {
    await manager.switchTo("proj-b", "/path/b");
    expect(vi.mocked(freezeWebContents)).not.toHaveBeenCalled();
  });

  it("inline deactivation freeze fires immediately without waiting for the batch debounce", async () => {
    // Enter efficiency but do NOT advance timers — still inside the 500ms debounce.
    manager.setEfficiencyFreeze(true);

    await manager.switchTo("proj-b", "/path/b");

    // The deactivated view (proj-a) must be frozen inline at deactivation time —
    // the debounce only gates the batch sweep of pre-existing cached views.
    expect(vi.mocked(freezeWebContents)).toHaveBeenCalledWith(initialWc);
  });

  it("rapid setEfficiencyFreeze(true) re-arms the debounce window", async () => {
    await manager.switchTo("proj-b", "/path/b");

    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(400);
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(400);
    // 800ms elapsed from the first call, but only 400ms from the second —
    // batch freeze must not have fired yet.
    expect(vi.mocked(freezeWebContents)).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(vi.mocked(freezeWebContents)).toHaveBeenCalledTimes(1);
  });

  it("dispose() clears a pending freeze timer", async () => {
    await manager.switchTo("proj-b", "/path/b");
    manager.setEfficiencyFreeze(true);

    manager.dispose();
    vi.advanceTimersByTime(500);

    expect(vi.mocked(freezeWebContents)).not.toHaveBeenCalled();
  });

  it("deactivation marks the view cached in the broadcast registry", async () => {
    await manager.switchTo("proj-b", "/path/b");

    expect(vi.mocked(registerCachedViewWebContents)).toHaveBeenCalledWith(initialWc);
    // The newly-active view must never be marked cached.
    const activeWc = manager.getActiveView()!.webContents;
    const cachedCalls = vi.mocked(registerCachedViewWebContents).mock.calls;
    expect(cachedCalls.every((call) => call[0] !== activeWc)).toBe(true);
  });

  it("marks the view cached before freezing it", async () => {
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);

    await manager.switchTo("proj-b", "/path/b");

    const markOrder = vi.mocked(registerCachedViewWebContents).mock.invocationCallOrder[0];
    const freezeOrder = vi.mocked(freezeWebContents).mock.invocationCallOrder[0];
    expect(markOrder).toBeDefined();
    expect(freezeOrder).toBeDefined();
    expect(markOrder).toBeLessThan(freezeOrder!);
  });

  it("sends no CPU-rate command when a view is cached (#12456)", async () => {
    vi.mocked(unthrottleCpuWebContents).mockClear();

    await manager.switchTo("proj-b", "/path/b");

    expect(vi.mocked(unthrottleCpuWebContents)).not.toHaveBeenCalledWith(initialWc);
  });

  it("resets the CPU rate BEFORE unfreezing on warm reactivation", async () => {
    await manager.switchTo("proj-b", "/path/b");
    vi.mocked(unthrottleCpuWebContents).mockClear();
    vi.mocked(unfreezeWebContents).mockClear();

    await manager.switchTo("proj-a", "/path/a");

    // The reset only acts on an already-attached debugger session, and the
    // thaw attaches one — so the reset has to go first or it always fires.
    const resetIdx = vi
      .mocked(unthrottleCpuWebContents)
      .mock.calls.findIndex((call) => (call[0] as unknown) === initialWc);
    const unfreezeIdx = vi
      .mocked(unfreezeWebContents)
      .mock.calls.findIndex((call) => (call[0] as unknown) === initialWc);
    expect(resetIdx).toBeGreaterThanOrEqual(0);
    expect(unfreezeIdx).toBeGreaterThanOrEqual(0);
    const resetOrder = vi.mocked(unthrottleCpuWebContents).mock.invocationCallOrder[resetIdx]!;
    const unfreezeOrder = vi.mocked(unfreezeWebContents).mock.invocationCallOrder[unfreezeIdx]!;
    expect(resetOrder).toBeLessThan(unfreezeOrder);
  });

  it("warm reactivation clears the cached mark", async () => {
    await manager.switchTo("proj-b", "/path/b");
    vi.mocked(unregisterCachedViewWebContents).mockClear();

    await manager.switchTo("proj-a", "/path/a");

    expect(vi.mocked(unregisterCachedViewWebContents)).toHaveBeenCalledWith(initialWc.id);
  });

  it("does not mark a destroyed webContents cached on deactivation", async () => {
    initialWc.isDestroyed.mockReturnValue(true);

    await manager.switchTo("proj-b", "/path/b");

    const cachedCalls = vi.mocked(registerCachedViewWebContents).mock.calls;
    expect(cachedCalls.every((call) => (call[0] as unknown) !== initialWc)).toBe(true);
  });

  type VisibleSpy = { setVisible: ReturnType<typeof vi.fn> };

  it("parks the deactivated view invisible AFTER removing it from the hierarchy", async () => {
    // proj-b is a factory-created view (its setVisible is a real spy); proj-a is
    // the initial view. Switch a→b→c so proj-b is deactivated and parked.
    await manager.switchTo("proj-b", "/path/b");
    const viewB = manager.getActiveView()! as unknown as VisibleSpy;
    await manager.switchTo("proj-c", "/path/c");

    expect(viewB.setVisible).toHaveBeenCalledWith(false);

    // setVisible(false) must fire after the view is detached, so the compositor
    // releases the parked view's tile textures rather than a still-attached one.
    const removeIdx = win.contentView.removeChildView.mock.calls.findIndex(
      (call) => (call[0] as unknown) === viewB
    );
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    const removeOrder = win.contentView.removeChildView.mock.invocationCallOrder[removeIdx];
    const visibleOrder = viewB.setVisible.mock.invocationCallOrder[0];
    expect(removeOrder).toBeLessThan(visibleOrder);
  });

  it("restores visibility BEFORE unfreezing on warm reactivation", async () => {
    await manager.switchTo("proj-b", "/path/b");
    const viewB = manager.getActiveView()! as unknown as VisibleSpy & {
      webContents: ReturnType<typeof createMockWebContents>;
    };
    const viewBWc = viewB.webContents;
    await manager.switchTo("proj-c", "/path/c");

    viewB.setVisible.mockClear();
    vi.mocked(unfreezeWebContents).mockClear();

    // Warm reactivation: proj-b is cached (within the cap of 3), so this wakes
    // the existing view rather than cold-starting.
    await manager.switchTo("proj-b", "/path/b");

    expect(viewB.setVisible).toHaveBeenCalledWith(true);

    const unfreezeIdx = vi
      .mocked(unfreezeWebContents)
      .mock.calls.findIndex((call) => (call[0] as unknown) === viewBWc);
    expect(unfreezeIdx).toBeGreaterThanOrEqual(0);
    const unfreezeOrder = vi.mocked(unfreezeWebContents).mock.invocationCallOrder[unfreezeIdx];
    const visibleOrder = viewB.setVisible.mock.invocationCallOrder[0];
    expect(visibleOrder).toBeLessThan(unfreezeOrder);
  });

  function seedActiveAgent(terminalId: string, projectId: string) {
    const priv = manager as unknown as {
      projectByTerminal: Map<string, string>;
      agentStateByTerminal: Map<string, string>;
    };
    priv.projectByTerminal.set(terminalId, projectId);
    priv.agentStateByTerminal.set(terminalId, "working");
  }

  it("does not batch-freeze a cached view whose project has a live agent", async () => {
    await manager.switchTo("proj-b", "/path/b");
    // proj-a is cached and running a working agent — freezing it would strand
    // the queued agent:state-changed event at a renderer that can't run JS.
    seedActiveAgent("t1", "proj-a");

    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);

    const frozeProjA = vi
      .mocked(freezeWebContents)
      .mock.calls.some((call) => (call[0] as unknown) === initialWc);
    expect(frozeProjA).toBe(false);
  });

  it("skips the inline deactivation freeze for a project with a live agent", async () => {
    seedActiveAgent("t1", "proj-a");

    // Enter efficiency but stay inside the debounce window so the inline
    // deactivation path (not the batch sweep) is what would freeze proj-a.
    manager.setEfficiencyFreeze(true);
    await manager.switchTo("proj-b", "/path/b");

    const frozeProjA = vi
      .mocked(freezeWebContents)
      .mock.calls.some((call) => (call[0] as unknown) === initialWc);
    expect(frozeProjA).toBe(false);
  });

  describe("a host's project whose agents are working there (#15879)", () => {
    let activeRemoteViews: Set<number>;
    let localWc: ReturnType<typeof createMockWebContents>;
    let remoteWc: Electron.WebContents;
    const frozeRemote = () =>
      vi.mocked(freezeWebContents).mock.calls.some((call) => call[0] === remoteWc);

    beforeEach(async () => {
      manager.dispose();
      activeRemoteViews = new Set();
      manager = new ProjectViewManager(win as never, {
        dirname: "/test",
        cachedProjectViews: 3,
        paintGateTimeoutMs: 0,
        paintGateHardTimeoutMs: 0,
        remoteAgentActive: (webContentsId) => activeRemoteViews.has(webContentsId),
      });
      (manager as unknown as { waitForPaint: () => Promise<string> }).waitForPaint = () =>
        Promise.resolve("signal");
      localWc = createMockWebContents();
      manager.registerInitialView(
        { webContents: localWc, setBounds: vi.fn() } as never,
        "proj-a",
        "/path/a"
      );
      await manager.switchToHostProject("studio-02", "proj-r", "/srv/r");
      remoteWc = manager.getAllViews().find((v) => v.projectId.startsWith("studio-02"))!.view
        .webContents;
    });

    it("isn't batch-frozen while its host reports an active agent", async () => {
      await manager.switchTo("proj-b", "/path/b");
      activeRemoteViews.add(remoteWc.id);

      manager.setEfficiencyFreeze(true);
      vi.advanceTimersByTime(500);
      expect(frozeRemote()).toBe(false);

      // Once the host says its agents settled, the next pass freezes it like any other.
      activeRemoteViews.clear();
      manager.refreezeUnprotectedCachedViews();
      expect(frozeRemote()).toBe(true);
    });

    it("isn't frozen as the user leaves it while its host reports an active agent", async () => {
      manager.setEfficiencyFreeze(true);
      vi.advanceTimersByTime(500);
      activeRemoteViews.add(remoteWc.id);

      await manager.switchTo("proj-b", "/path/b");

      expect(frozeRemote()).toBe(false);
    });

    it("is frozen as the user leaves it when its host reports no active agent", async () => {
      manager.setEfficiencyFreeze(true);
      vi.advanceTimersByTime(500);

      await manager.switchTo("proj-b", "/path/b");

      expect(frozeRemote()).toBe(true);
    });

    it("wakes from a freeze once its host reports an active agent, and isn't frozen again", async () => {
      await manager.switchTo("proj-b", "/path/b");
      manager.setEfficiencyFreeze(true);
      vi.advanceTimersByTime(500);
      expect(frozeRemote()).toBe(true);
      vi.mocked(freezeWebContents).mockClear();
      vi.mocked(unfreezeWebContents).mockClear();

      activeRemoteViews.add(remoteWc.id);
      manager.unfreezeActiveAgentViews();
      expect(vi.mocked(unfreezeWebContents)).toHaveBeenCalledWith(remoteWc);
      // The idle local view stays frozen: the wake is for active agents only.
      expect(vi.mocked(unfreezeWebContents)).not.toHaveBeenCalledWith(localWc);

      manager.refreezeUnprotectedCachedViews();
      expect(frozeRemote()).toBe(false);
    });

    it("never takes this machine's agents as the host's", async () => {
      await manager.switchTo("proj-b", "/path/b");
      // A local terminal whose project id happens to match the host's.
      seedActiveAgent("t1", "proj-r");

      manager.setEfficiencyFreeze(true);
      vi.advanceTimersByTime(500);

      expect(frozeRemote()).toBe(true);
    });
  });

  it("unfreezeActiveAgentViews wakes a view that was frozen before its agent went active", async () => {
    await manager.switchTo("proj-b", "/path/b");
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);
    // proj-a froze while it had no agent (the seed/state race).
    expect(vi.mocked(freezeWebContents)).toHaveBeenCalledWith(initialWc);
    vi.mocked(unfreezeWebContents).mockClear();

    seedActiveAgent("t1", "proj-a");
    (manager as unknown as { unfreezeActiveAgentViews: () => void }).unfreezeActiveAgentViews();

    expect(vi.mocked(unfreezeWebContents)).toHaveBeenCalledWith(initialWc);
  });

  it("wakes a frozen mapped view when its agent transitions active (agent:state-changed bus)", async () => {
    await manager.switchTo("proj-b", "/path/b");

    const ptyClient = {
      getAllTerminalsAsync: vi.fn(async () => [
        { id: "t1", projectId: "proj-a", agentState: "idle" },
      ]),
      on: vi.fn(),
      off: vi.fn(),
    };
    await manager.initAgentStateCache(ptyClient as never);

    // proj-a is cached with an idle agent → it freezes.
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);
    expect(vi.mocked(freezeWebContents)).toHaveBeenCalledWith(initialWc);
    vi.mocked(unfreezeWebContents).mockClear();

    // The agent goes to "working" — the queued event would be stranded at the
    // frozen renderer, so the real onStateChanged handler must wake proj-a.
    events.emit("agent:state-changed", { terminalId: "t1", state: "working" } as never);

    expect(vi.mocked(unfreezeWebContents)).toHaveBeenCalledWith(initialWc);
    manager.dispose(); // remove the bus listener so it doesn't leak into later tests
  });
});

describe("ProjectViewManager — memory sampler jitter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    nextWebContentsId = 100;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createManagerWithSampleSpy() {
    const win = createMockWindow();
    const manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 3,
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
    });
    const sample = vi.fn();
    (manager as unknown as { sampleCachedViewMemory: () => void }).sampleCachedViewMemory = sample;
    return { manager, sample };
  }

  it("first sample fires after a random fraction of the interval, then at the fixed cadence", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { sample } = createManagerWithSampleSpy();

    // 0.5 × 30s jitter → first tick at 15s.
    vi.advanceTimersByTime(14_999);
    expect(sample).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(sample).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    expect(sample).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(30_000);
    expect(sample).toHaveBeenCalledTimes(3);
  });

  it("two managers with different jitter do not sample on the same tick", () => {
    const randomSpy = vi.spyOn(Math, "random");
    randomSpy.mockReturnValueOnce(0);
    const first = createManagerWithSampleSpy();
    randomSpy.mockReturnValueOnce(0.5);
    const second = createManagerWithSampleSpy();

    vi.advanceTimersByTime(0);
    expect(first.sample).toHaveBeenCalledTimes(1);
    expect(second.sample).not.toHaveBeenCalled();

    vi.advanceTimersByTime(15_000);
    expect(first.sample).toHaveBeenCalledTimes(1);
    expect(second.sample).toHaveBeenCalledTimes(1);
  });

  it("dispose stops the sampler", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    const { manager, sample } = createManagerWithSampleSpy();

    manager.dispose();
    vi.advanceTimersByTime(120_000);

    expect(sample).not.toHaveBeenCalled();
  });

  it("a sampler tick that throws does not stop subsequent ticks", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { sample } = createManagerWithSampleSpy();
    sample.mockImplementationOnce(() => {
      throw new Error("metrics unavailable");
    });

    vi.advanceTimersByTime(0);
    expect(sample).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    expect(sample).toHaveBeenCalledTimes(2);
  });
});

describe("ProjectViewManager — cached-view memory purge", () => {
  const MiB = 1024 * 1024;
  let manager: ProjectViewManager;
  let win: ReturnType<typeof createMockWindow>;
  let initialWc: ReturnType<typeof createMockWebContents>;

  const purge = () => vi.mocked(purgeMemoryWebContents);
  const readHeap = () => vi.mocked(readJsHeapUsedBytes);
  const purgesOfA = () => purge().mock.calls.filter((c) => (c[0] as unknown) === initialWc);
  const heapReadsOfA = () => readHeap().mock.calls.filter((c) => (c[0] as unknown) === initialWc);

  /** A purge of proj-a that stays in flight until the test settles it. */
  function holdNextPurgeOfA() {
    let settle!: (collected: boolean) => void;
    let shouldCollect: (() => boolean) | undefined;
    purge().mockImplementation((wc, opts) => {
      if ((wc as unknown) !== initialWc) return Promise.resolve(true);
      shouldCollect = opts?.shouldCollect;
      return new Promise<boolean>((resolve) => {
        settle = resolve;
      });
    });
    return {
      shouldCollect: () => shouldCollect?.(),
      settle: (collected: boolean) => settle(collected),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    purge().mockResolvedValue(true);
    readHeap().mockResolvedValue(100 * MiB);
    nextWebContentsId = 100;
    win = createMockWindow();
    manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 3,
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
    });
    (manager as unknown as { waitForPaint: () => Promise<string> }).waitForPaint = () =>
      Promise.resolve("signal");
    initialWc = createMockWebContents();
    const initialView = { webContents: initialWc, setBounds: vi.fn() };
    manager.registerInitialView(initialView as never, "proj-a", "/path/a");
  });

  afterEach(() => {
    purge().mockReset().mockResolvedValue(false);
    readHeap().mockReset().mockResolvedValue(null);
    vi.useRealTimers();
  });

  it("purges a cached view only after the delay elapses", async () => {
    await manager.switchTo("proj-b", "/path/b");
    expect(purge()).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(19_999);
    expect(purge()).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(purge()).toHaveBeenCalledTimes(1);
    expect(purge()).toHaveBeenCalledWith(initialWc, {
      shouldCollect: expect.any(Function),
    });
  });

  it("collects on the first pass without consulting the heap, then records a baseline", async () => {
    await manager.switchTo("proj-b", "/path/b");
    await vi.advanceTimersByTimeAsync(20_000);

    expect(purgesOfA()).toHaveLength(1);
    expect(heapReadsOfA()).toHaveLength(1);
    expect(purge().mock.invocationCallOrder[0]).toBeLessThan(
      readHeap().mock.invocationCallOrder[0]!
    );
  });

  it("skips later passes while heap growth stays under 32 MiB", async () => {
    readHeap()
      .mockResolvedValueOnce(100 * MiB)
      .mockResolvedValueOnce(131 * MiB)
      .mockResolvedValueOnce(90 * MiB);
    await manager.switchTo("proj-b", "/path/b");

    await vi.advanceTimersByTimeAsync(20_000);
    expect(purgesOfA()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(heapReadsOfA()).toHaveLength(2);
    expect(purgesOfA()).toHaveLength(1);

    // The skipped pass still arms the next one.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heapReadsOfA()).toHaveLength(3);
    expect(purgesOfA()).toHaveLength(1);
  });

  it("collects on a later pass once the heap has grown 32 MiB past the baseline", async () => {
    readHeap()
      .mockResolvedValueOnce(100 * MiB)
      .mockResolvedValueOnce(132 * MiB)
      .mockResolvedValueOnce(104 * MiB)
      .mockResolvedValueOnce(135 * MiB);
    await manager.switchTo("proj-b", "/path/b");

    await vi.advanceTimersByTimeAsync(80_000);
    expect(purgesOfA()).toHaveLength(2);

    // The baseline moved to the post-collection 104 MiB, so 135 MiB is growth
    // of 31 MiB — no collection.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heapReadsOfA()).toHaveLength(4);
    expect(purgesOfA()).toHaveLength(2);
  });

  it("skips a later pass whose heap read fails rather than collecting blind", async () => {
    readHeap()
      .mockResolvedValueOnce(100 * MiB)
      .mockResolvedValue(null);
    await manager.switchTo("proj-b", "/path/b");

    await vi.advanceTimersByTimeAsync(20_000 + 60_000 * 3);

    expect(purgesOfA()).toHaveLength(1);
    expect(heapReadsOfA()).toHaveLength(4);
  });

  it("measures growth from the next read when the post-collection read failed", async () => {
    readHeap()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(200 * MiB)
      .mockResolvedValueOnce(240 * MiB);
    await manager.switchTo("proj-b", "/path/b");

    await vi.advanceTimersByTimeAsync(20_000 + 60_000);
    expect(purgesOfA()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(purgesOfA()).toHaveLength(2);
  });

  it("arms the next pass only after the current one settles", async () => {
    await manager.switchTo("proj-b", "/path/b");
    const pass = holdNextPurgeOfA();

    await vi.advanceTimersByTimeAsync(20_000 + 60_000 * 3);
    expect(purgesOfA()).toHaveLength(1);

    purge().mockResolvedValue(true);
    readHeap().mockResolvedValue(200 * MiB);
    pass.settle(true);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(heapReadsOfA()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(heapReadsOfA()).toHaveLength(2);
  });

  it("does not collect when the view is reactivated mid-pass, and arms no further pass", async () => {
    await manager.switchTo("proj-b", "/path/b");
    const pass = holdNextPurgeOfA();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(purgesOfA()).toHaveLength(1);
    expect(pass.shouldCollect()).toBe(true);

    await manager.switchTo("proj-a", "/path/a");
    expect(pass.shouldCollect()).toBe(false);

    pass.settle(false);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(purgesOfA()).toHaveLength(1);
    expect(heapReadsOfA()).toHaveLength(0);
  });

  it("does not collect when the view is reactivated during a later pass's heap read", async () => {
    await manager.switchTo("proj-b", "/path/b");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(purgesOfA()).toHaveLength(1);

    let settleRead!: (bytes: number) => void;
    readHeap().mockImplementation(
      () =>
        new Promise<number | null>((resolve) => {
          settleRead = resolve;
        })
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heapReadsOfA()).toHaveLength(2);

    await manager.switchTo("proj-a", "/path/a");
    settleRead(1024 * MiB);
    await vi.advanceTimersByTimeAsync(0);

    expect(purgesOfA()).toHaveLength(1);
  });

  it("a pass left over from an earlier cache session neither collects nor re-arms", async () => {
    await manager.switchTo("proj-b", "/path/b");
    const stale = holdNextPurgeOfA();
    await vi.advanceTimersByTimeAsync(20_000);

    await manager.switchTo("proj-a", "/path/a");
    await manager.switchTo("proj-b", "/path/b");
    expect(stale.shouldCollect()).toBe(false);

    stale.settle(false);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(purgesOfA()).toHaveLength(1);

    // The new session's own first pass still lands on its 20 s delay.
    await vi.advanceTimersByTimeAsync(1);
    expect(purgesOfA()).toHaveLength(2);
  });

  it("starts each cache session over with an unconditional collection", async () => {
    await manager.switchTo("proj-b", "/path/b");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(purgesOfA()).toHaveLength(1);

    await manager.switchTo("proj-a", "/path/a");
    await manager.switchTo("proj-b", "/path/b");
    const readsBefore = heapReadsOfA().length;

    // Flat heap: a gated pass would skip, so a collection here is the new
    // session's unconditional first pass.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(purgesOfA()).toHaveLength(2);
    expect(heapReadsOfA()).toHaveLength(readsBefore + 1);
  });

  it("never purges a view that was reactivated before the delay", async () => {
    await manager.switchTo("proj-b", "/path/b");
    await vi.advanceTimersByTimeAsync(10_000);

    await manager.switchTo("proj-a", "/path/a");
    await vi.advanceTimersByTimeAsync(120_000);

    expect(purgesOfA()).toHaveLength(0);
  });

  it("stops purging once the view is torn down", async () => {
    purge().mockResolvedValue(false);
    await manager.switchTo("proj-b", "/path/b");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(purgesOfA()).toHaveLength(1);

    initialWc.isDestroyed.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(purgesOfA()).toHaveLength(1);
    expect(heapReadsOfA()).toHaveLength(0);
  });
});

type McpActivityFn = (
  workspaceId: string,
  webContentsId: number
) => import("../ProjectViewManager.js").McpViewActivity | null;

describe("ProjectViewManager — MCP session bindings stay thawed (#11790)", () => {
  let manager: ProjectViewManager;
  let win: ReturnType<typeof createMockWindow>;
  let initialWc: ReturnType<typeof createMockWebContents>;
  /** Workspaces a live MCP session is bound to, and views with a call in flight. */
  let boundWorkspaces: Set<string>;
  let leasedWebContentsIds: Set<number>;
  let mcpViewActivity: Mock<McpActivityFn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    nextWebContentsId = 300;
    boundWorkspaces = new Set();
    leasedWebContentsIds = new Set();
    mcpViewActivity = vi.fn<McpActivityFn>((workspaceId, webContentsId) => ({
      liveBinding: boundWorkspaces.has(workspaceId),
      dispatchLease: leasedWebContentsIds.has(webContentsId),
    }));
    win = createMockWindow();
    manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 3,
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      mcpViewActivity,
    });
    (manager as unknown as { waitForPaint: () => Promise<string> }).waitForPaint = () =>
      Promise.resolve("signal");
    initialWc = createMockWebContents();
    manager.registerInitialView(
      { webContents: initialWc, setBounds: vi.fn() } as never,
      "proj-a",
      "/path/a"
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const frozeProjA = () =>
    vi.mocked(freezeWebContents).mock.calls.some((call) => (call[0] as unknown) === initialWc);

  it("does not batch-freeze a cached view whose workspace backs a live session", async () => {
    await manager.switchTo("proj-b", "/path/b");
    boundWorkspaces.add("proj-a");

    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);

    expect(frozeProjA()).toBe(false);
  });

  it("freezes inline on deactivation when nothing is bound (positive control)", async () => {
    // Establishes that this setup — efficiency on, still inside the batch
    // sweep's debounce window, so only the deactivation path can freeze —
    // really does freeze. Without it the guard test below would pass just as
    // well if inline freezing were deleted entirely.
    manager.setEfficiencyFreeze(true);
    await manager.switchTo("proj-b", "/path/b");

    expect(frozeProjA()).toBe(true);
  });

  it("skips the inline deactivation freeze for a workspace backing a live session", async () => {
    // Same setup as the control above, one variable changed.
    boundWorkspaces.add("proj-a");

    manager.setEfficiencyFreeze(true);
    await manager.switchTo("proj-b", "/path/b");

    expect(frozeProjA()).toBe(false);
  });

  it("skips the inline deactivation freeze while a dispatch is in flight", async () => {
    leasedWebContentsIds.add(initialWc.id);

    manager.setEfficiencyFreeze(true);
    await manager.switchTo("proj-b", "/path/b");

    expect(frozeProjA()).toBe(false);
  });

  it("does not freeze a view with a dispatch in flight even with no standing binding", async () => {
    // Belt and braces: the lease alone is enough, so a call that outlives its
    // session's liveness record still can't have its renderer suspended.
    await manager.switchTo("proj-b", "/path/b");
    leasedWebContentsIds.add(initialWc.id);

    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);

    expect(frozeProjA()).toBe(false);
  });

  it("freezes the view again once the binding is gone", async () => {
    await manager.switchTo("proj-b", "/path/b");
    boundWorkspaces.add("proj-a");
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);
    expect(frozeProjA()).toBe(false);

    // Protection is only as long-lived as the session: a disconnected client
    // must not cost the efficiency profile a view for the rest of the run.
    boundWorkspaces.clear();
    manager.setEfficiencyFreeze(false);
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);

    expect(frozeProjA()).toBe(true);
  });

  it("still freezes an unbound cached view — protection is not blanket", async () => {
    await manager.switchTo("proj-b", "/path/b");
    boundWorkspaces.add("some-other-workspace");

    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);

    expect(frozeProjA()).toBe(true);
  });

  it("does not freeze when the callback throws — unknown protection resolves as protected here", async () => {
    // The callback reaches a service behind a dynamic import, so a throw means
    // protection state is genuinely unavailable rather than false. Freezing on
    // that would re-create the 30s stranded dispatch for the cost of one
    // missed optimization, so this policy resolves unknown as protected.
    await manager.switchTo("proj-b", "/path/b");
    mcpViewActivity.mockImplementation(() => {
      throw new Error("MCP service mid-teardown");
    });

    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);

    expect(frozeProjA()).toBe(false);
  });

  it("freezes as usual when the callback answers null — MCP simply isn't running", async () => {
    // Distinct from a throw: null is a definite "no server, so no sessions",
    // not an unavailable answer.
    await manager.switchTo("proj-b", "/path/b");
    mcpViewActivity.mockReturnValue(null);

    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);

    expect(frozeProjA()).toBe(true);
  });

  it("never freezes a cached view a host's live assistant runs its tool calls through", async () => {
    const liveAssistantViews = new Set<number>();
    manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 3,
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      mcpViewActivity,
      remoteAssistantLive: (webContentsId) => liveAssistantViews.has(webContentsId),
    });
    (manager as unknown as { waitForPaint: () => Promise<string> }).waitForPaint = () =>
      Promise.resolve("signal");
    initialWc = createMockWebContents();
    manager.registerInitialView(
      { webContents: initialWc, setBounds: vi.fn() } as never,
      "proj-a",
      "/path/a"
    );
    await manager.switchTo("proj-b", "/path/b");
    liveAssistantViews.add(initialWc.id);

    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);
    expect(frozeProjA()).toBe(false);

    // Once that assistant is gone, the next pass freezes the view like any other.
    liveAssistantViews.delete(initialWc.id);
    manager.refreezeUnprotectedCachedViews();
    expect(frozeProjA()).toBe(true);
  });

  it("doesn't freeze a view with a host's live assistant as it's switched away from, either", async () => {
    const liveAssistantViews = new Set<number>();
    manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 3,
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      mcpViewActivity,
      remoteAssistantLive: (webContentsId) => liveAssistantViews.has(webContentsId),
    });
    (manager as unknown as { waitForPaint: () => Promise<string> }).waitForPaint = () =>
      Promise.resolve("signal");
    initialWc = createMockWebContents();
    manager.registerInitialView(
      { webContents: initialWc, setBounds: vi.fn() } as never,
      "proj-a",
      "/path/a"
    );
    // Already in efficiency when the switch happens: deactivation is the freeze.
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);
    liveAssistantViews.add(initialWc.id);

    await manager.switchTo("proj-b", "/path/b");

    expect(frozeProjA()).toBe(false);
  });

  it("never freezes a cached view of a host's project an MCP session there is bound to (#14228)", async () => {
    const boundRemoteViews = new Set<number>();
    manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 3,
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
      remoteMcpBindingLive: (webContentsId) => boundRemoteViews.has(webContentsId),
    });
    (manager as unknown as { waitForPaint: () => Promise<string> }).waitForPaint = () =>
      Promise.resolve("signal");
    manager.registerInitialView(
      { webContents: createMockWebContents(), setBounds: vi.fn() } as never,
      "proj-a",
      "/path/a"
    );
    await manager.switchToHostProject("studio-02", "proj-r", "/srv/r");
    const remoteWc = manager.getAllViews().find((v) => v.projectId.startsWith("studio-02"))!.view
      .webContents;
    await manager.switchTo("proj-b", "/path/b");
    boundRemoteViews.add(remoteWc.id);
    const frozeRemote = () =>
      vi.mocked(freezeWebContents).mock.calls.some((call) => (call[0] as unknown) === remoteWc);

    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);
    expect(frozeRemote()).toBe(false);

    // Once the host says the session dropped, the next pass freezes it like any other.
    boundRemoteViews.clear();
    manager.refreezeUnprotectedCachedViews();
    expect(frozeRemote()).toBe(true);
  });

  it("re-freezes a view thawed for a dispatch once the lease is gone", async () => {
    // The bridge thaws on demand and nothing puts the view back: freezeAllCached
    // runs only on the transition INTO efficiency, and re-entering while already
    // enabled is an early no-op. Without the sampler's re-freeze pass, one
    // dispatch leaves the view running JS for the rest of the profile.
    await manager.switchTo("proj-b", "/path/b");
    leasedWebContentsIds.add(initialWc.id);
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);
    expect(frozeProjA()).toBe(false);

    leasedWebContentsIds.delete(initialWc.id);
    manager.refreezeUnprotectedCachedViews();

    expect(frozeProjA()).toBe(true);
  });

  it("leaves a still-bound view thawed when the re-freeze pass runs", async () => {
    await manager.switchTo("proj-b", "/path/b");
    boundWorkspaces.add("proj-a");
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);

    manager.refreezeUnprotectedCachedViews();

    expect(frozeProjA()).toBe(false);
  });

  it("the re-freeze pass is a no-op outside the efficiency profile", async () => {
    await manager.switchTo("proj-b", "/path/b");

    manager.refreezeUnprotectedCachedViews();

    expect(vi.mocked(freezeWebContents)).not.toHaveBeenCalled();
  });

  it("the re-freeze pass defers to a pending freeze-entry debounce", async () => {
    // The periodic sampler can tick inside the debounce window. Freezing there
    // would defeat the trailing edge, which exists so a profile that flips back
    // within the window freezes nothing at all — and would make every
    // call-count assertion in this file depend on the sampler's random phase.
    await manager.switchTo("proj-b", "/path/b");
    manager.setEfficiencyFreeze(true);

    manager.refreezeUnprotectedCachedViews();
    expect(vi.mocked(freezeWebContents)).not.toHaveBeenCalled();

    manager.setEfficiencyFreeze(false);
    vi.advanceTimersByTime(500);
    expect(vi.mocked(freezeWebContents)).not.toHaveBeenCalled();
  });

  it("never freezes the outgoing bridge view when a sampler tick lands mid-switch", async () => {
    // The re-freeze pass runs on the periodic sampler, so it can tick inside a
    // switch. `activeProjectId` already names the incoming project by then,
    // while the outgoing view is still attached as the anti-flash bridge —
    // freezing it suspends the renderer painting the visible frame.
    await manager.switchTo("proj-b", "/path/b");
    const bridgeWc = manager.getActiveView()!.webContents;
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);
    vi.mocked(freezeWebContents).mockClear();

    const switchPromise = manager.switchTo("proj-c", "/path/c");
    await Promise.resolve();
    expect(manager.getOutgoingBridgeProjectId()).toBe("proj-b");

    manager.refreezeUnprotectedCachedViews();

    expect(vi.mocked(freezeWebContents).mock.calls.some((call) => call[0] === bridgeWc)).toBe(
      false
    );
    // The pass still swept the genuinely cached view — the guard is targeted,
    // not a blanket bail-out on any switch being in flight.
    expect(frozeProjA()).toBe(true);

    await switchPromise;
  });
});

function backgroundResizeSends(wc: ReturnType<typeof createMockWebContents>) {
  return wc.send.mock.calls.filter(([channel]) => channel === CHANNELS.PROJECT_BACKGROUND_RESIZE);
}

describe("ProjectViewManager — background resize forwarding", () => {
  let manager: ProjectViewManager;
  let win: ReturnType<typeof createMockWindow>;
  let initialWc: ReturnType<typeof createMockWebContents>;
  let fireResize: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    nextWebContentsId = 100;
    win = createMockWindow();
    manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 3,
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
    });
    (manager as unknown as { waitForPaint: () => Promise<string> }).waitForPaint = () =>
      Promise.resolve("signal");
    initialWc = createMockWebContents();
    const initialView = { webContents: initialWc, setBounds: vi.fn() };
    manager.registerInitialView(initialView as never, "proj-a", "/path/a");

    const resizeCall = win.on.mock.calls.find(([event]) => event === "resize");
    if (!resizeCall) throw new Error("resize handler not registered");
    const handler = resizeCall[1] as () => void;
    fireResize = () => handler();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends settled content bounds to cached views after the debounce", async () => {
    await manager.switchTo("proj-b", "/path/b");
    win.getContentBounds.mockReturnValue({ x: 0, y: 0, width: 1440, height: 900 });

    fireResize();
    expect(backgroundResizeSends(initialWc)).toHaveLength(0);

    vi.advanceTimersByTime(300);
    const sends = backgroundResizeSends(initialWc);
    expect(sends).toHaveLength(1);
    expect(sends[0][1]).toEqual({ width: 1440, height: 900 });
  });

  it("forwards nothing while the window is minimized", async () => {
    // A minimized window's content bounds are not a layout to scale against.
    // Forwarding them shrinks every cached pane proportionally, and a pane that
    // bottoms out on the column floor re-wraps its committed scrollback into a
    // strip no later reflow undoes (#11900).
    await manager.switchTo("proj-b", "/path/b");
    win.isMinimized.mockReturnValue(true);
    win.getContentBounds.mockReturnValue({ x: 0, y: 0, width: 63, height: 59 });

    fireResize();
    vi.advanceTimersByTime(300);
    expect(backgroundResizeSends(initialWc)).toHaveLength(0);

    // Restoring re-arms the ordinary path, so nothing is permanently lost.
    win.isMinimized.mockReturnValue(false);
    win.getContentBounds.mockReturnValue({ x: 0, y: 0, width: 1440, height: 900 });
    fireResize();
    vi.advanceTimersByTime(300);

    const sends = backgroundResizeSends(initialWc);
    expect(sends).toHaveLength(1);
    expect(sends[0][1]).toEqual({ width: 1440, height: 900 });
  });

  it("replays the skipped notification on restore, which fires no resize of its own", async () => {
    // Deminiaturizing to the same frame emits `restore` and nothing else, so the
    // notification declined during the minimize has to be re-driven from that
    // event or a cached view keeps its pre-minimize geometry indefinitely.
    await manager.switchTo("proj-b", "/path/b");
    const restoreCall = win.on.mock.calls.find(([event]) => event === "restore");
    if (!restoreCall) throw new Error("restore handler not registered");

    win.isMinimized.mockReturnValue(true);
    fireResize();
    vi.advanceTimersByTime(300);
    expect(backgroundResizeSends(initialWc)).toHaveLength(0);

    win.isMinimized.mockReturnValue(false);
    win.getContentBounds.mockReturnValue({ x: 0, y: 0, width: 1440, height: 900 });
    (restoreCall[1] as () => void)();
    vi.advanceTimersByTime(300);

    const sends = backgroundResizeSends(initialWc);
    expect(sends).toHaveLength(1);
    expect(sends[0][1]).toEqual({ width: 1440, height: 900 });
  });

  it("never sends to the active view", async () => {
    await manager.switchTo("proj-b", "/path/b");
    const activeWc = manager.getActiveView()!.webContents as unknown as ReturnType<
      typeof createMockWebContents
    >;

    fireResize();
    vi.advanceTimersByTime(300);

    expect(backgroundResizeSends(activeWc)).toHaveLength(0);
    expect(backgroundResizeSends(initialWc)).toHaveLength(1);
  });

  it("re-arms the debounce window on each resize event", async () => {
    await manager.switchTo("proj-b", "/path/b");

    fireResize();
    vi.advanceTimersByTime(200);
    fireResize();
    vi.advanceTimersByTime(200);
    expect(backgroundResizeSends(initialWc)).toHaveLength(0);

    vi.advanceTimersByTime(100);
    expect(backgroundResizeSends(initialWc)).toHaveLength(1);
  });

  it("sends the bounds read at fire time, not at schedule time", async () => {
    await manager.switchTo("proj-b", "/path/b");

    win.getContentBounds.mockReturnValue({ x: 0, y: 0, width: 1000, height: 700 });
    fireResize();
    win.getContentBounds.mockReturnValue({ x: 0, y: 0, width: 1280, height: 800 });
    vi.advanceTimersByTime(300);

    const sends = backgroundResizeSends(initialWc);
    expect(sends).toHaveLength(1);
    expect(sends[0][1]).toEqual({ width: 1280, height: 800 });
  });

  it("skips destroyed webContents without throwing", async () => {
    await manager.switchTo("proj-b", "/path/b");
    initialWc.isDestroyed.mockReturnValue(true);

    fireResize();
    expect(() => vi.advanceTimersByTime(300)).not.toThrow();
    expect(backgroundResizeSends(initialWc)).toHaveLength(0);
  });

  it("sends to every cached view, not just the most recent", async () => {
    await manager.switchTo("proj-b", "/path/b");
    const projBWc = manager.getActiveView()!.webContents as unknown as ReturnType<
      typeof createMockWebContents
    >;
    await manager.switchTo("proj-c", "/path/c");
    const projCWc = manager.getActiveView()!.webContents as unknown as ReturnType<
      typeof createMockWebContents
    >;

    fireResize();
    vi.advanceTimersByTime(300);

    expect(backgroundResizeSends(initialWc)).toHaveLength(1);
    expect(backgroundResizeSends(projBWc)).toHaveLength(1);
    expect(backgroundResizeSends(projCWc)).toHaveLength(0);
  });

  it("a view cached mid-debounce receives the send; the newly active view does not", async () => {
    await manager.switchTo("proj-b", "/path/b");
    const projBWc = manager.getActiveView()!.webContents as unknown as ReturnType<
      typeof createMockWebContents
    >;

    fireResize();
    // proj-b backgrounds inside the debounce window; proj-a reactivates.
    await manager.switchTo("proj-a", "/path/a");
    vi.advanceTimersByTime(300);

    expect(backgroundResizeSends(projBWc)).toHaveLength(1);
    expect(backgroundResizeSends(initialWc)).toHaveLength(0);
  });

  it("dispose() cancels a pending notification", async () => {
    await manager.switchTo("proj-b", "/path/b");

    fireResize();
    manager.dispose();
    vi.advanceTimersByTime(300);

    expect(backgroundResizeSends(initialWc)).toHaveLength(0);
  });
});

describe("ProjectViewManager — content area changes without a window resize", () => {
  let manager: ProjectViewManager;
  let win: ReturnType<typeof createMockWindow>;
  let view: {
    webContents: ReturnType<typeof createMockWebContents>;
    setBounds: ReturnType<typeof vi.fn>;
    getBounds: () => { x: number; y: number; width: number; height: number };
  };

  const handlerFor = (target: { on: ReturnType<typeof vi.fn> }, event: string) => {
    const call = target.on.mock.calls.find(([name]) => name === event);
    if (!call) throw new Error(`${event} handler not registered`);
    return call[1] as () => void;
  };
  // The Linux menu bar opening or closing re-lays out the content view only.
  const contentAreaChanged = () => handlerFor(win.contentView, "bounds-changed")();
  const windowResized = () => handlerFor(win, "resize")();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    win = createMockWindow();
    manager = new ProjectViewManager(win as never, {
      dirname: "/test",
      cachedProjectViews: 3,
      paintGateTimeoutMs: 0,
      paintGateHardTimeoutMs: 0,
    });
    let bounds = { x: 0, y: 0, width: 800, height: 600 };
    view = {
      webContents: createMockWebContents(),
      setBounds: vi.fn((next: typeof bounds) => {
        bounds = next;
      }),
      getBounds: () => bounds,
    };
    manager.registerInitialView(view as never, "proj-a", "/path/a");
    view.setBounds.mockClear();
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  it("leaves the view at full size while the menu bar is open, rather than resizing every pane", () => {
    win.getContentBounds.mockReturnValue({ x: 0, y: 25, width: 800, height: 575 });
    contentAreaChanged();
    expect(view.setBounds).not.toHaveBeenCalled();

    win.getContentBounds.mockReturnValue({ x: 0, y: 0, width: 800, height: 600 });
    contentAreaChanged();
    expect(view.setBounds).not.toHaveBeenCalled();
  });

  it("grows a view sized while the menu bar was open back over the whole area once it closes", () => {
    win.getContentBounds.mockReturnValue({ x: 0, y: 25, width: 1440, height: 875 });
    windowResized();
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1440, height: 875 });

    win.getContentBounds.mockReturnValue({ x: 0, y: 0, width: 1440, height: 900 });
    contentAreaChanged();
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1440, height: 900 });
  });

  it("stops listening to the content view once disposed", () => {
    const handler = handlerFor(win.contentView, "bounds-changed");
    manager.dispose();
    expect(win.contentView.removeListener).toHaveBeenCalledWith("bounds-changed", handler);
  });
});

describe("ProjectViewManager — GC on deactivate", () => {
  let manager: ProjectViewManager;
  let win: ReturnType<typeof createMockWindow>;
  let initialWc: ReturnType<typeof createMockWebContents>;

  beforeEach(() => {
    nextWebContentsId = 100;
    // GC-on-deactivate suite, not paint-gate policy: release every gate with a
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
      cachedProjectViews: 2,
    });

    // Create the initial view with a known webContents mock
    initialWc = createMockWebContents();
    const initialView = { webContents: initialWc, setBounds: vi.fn() };
    manager.registerInitialView(initialView as never, "proj-a", "/path/a");
  });

  // Real timers here: an efficiency debounce or purge left armed would fire after the test.
  afterEach(() => manager.dispose());

  it("leaves the cached-time GC to the renderer, injecting nothing that could outlive activation (#15680)", async () => {
    await manager.switchTo("proj-b", "/path/b");

    expect(cachedSignalOrder(initialWc)).toBeDefined();
    expect(initialWc.executeJavaScript).not.toHaveBeenCalled();

    // Coming back injects nothing either: the renderer cancels its own GC.
    await manager.switchTo("proj-a", "/path/a");
    expect(initialWc.executeJavaScript).not.toHaveBeenCalled();
  });

  it("flushes storage and clears navigation history on deactivation", async () => {
    await manager.switchTo("proj-b", "/path/b");

    expect(initialWc.session.flushStorageData).toHaveBeenCalledOnce();
    expect(initialWc.navigationHistory.clear).toHaveBeenCalledOnce();
  });

  it("does not throw when flushStorageData throws", async () => {
    initialWc.session.flushStorageData.mockImplementation(() => {
      throw new Error("session gone");
    });

    await expect(manager.switchTo("proj-b", "/path/b")).resolves.toBeDefined();
    expect(initialWc.session.flushStorageData).toHaveBeenCalledOnce();
    // navigationHistory.clear should still fire despite flushStorageData throwing
    expect(initialWc.navigationHistory.clear).toHaveBeenCalledOnce();
  });

  it("does not throw when navigationHistory.clear throws (TOCTOU renderer crash)", async () => {
    initialWc.navigationHistory.clear.mockImplementation(() => {
      throw new Error("renderer gone");
    });

    manager.setEfficiencyFreeze(true);
    vi.mocked(freezeWebContents).mockClear();

    await expect(manager.switchTo("proj-b", "/path/b")).resolves.toBeDefined();
    expect(initialWc.navigationHistory.clear).toHaveBeenCalledOnce();
    // The freeze after it should still land despite clear() throwing
    expect(vi.mocked(freezeWebContents)).toHaveBeenCalledWith(initialWc);
  });

  it("skips flushStorageData, clearHistory, and the cached signal when webContents is destroyed at outer guard", async () => {
    initialWc.isDestroyed.mockReturnValue(true);
    await manager.switchTo("proj-b", "/path/b");

    expect(initialWc.session.flushStorageData).not.toHaveBeenCalled();
    expect(initialWc.navigationHistory.clear).not.toHaveBeenCalled();
    expect(cachedSignalOrder(initialWc)).toBeUndefined();
  });
});
