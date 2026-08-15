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

import { ProjectViewManager } from "../ProjectViewManager.js";
import { events } from "../../services/events.js";
import {
  freezeWebContents,
  unfreezeWebContents,
  purgeMemoryWebContents,
} from "../../utils/webContentsLifecycle.js";
import {
  registerCachedViewWebContents,
  unregisterCachedViewWebContents,
} from "../webContentsRegistry.js";

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
    vi.useRealTimers();
  });

  it("does not freeze immediately on setEfficiencyFreeze(true) — debounce delays the work", () => {
    manager.setEfficiencyFreeze(true);
    expect(vi.mocked(freezeWebContents)).not.toHaveBeenCalled();
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

  it("rapid setEfficiencyFreeze(true) calls debounce to a single freeze pass", async () => {
    await manager.switchTo("proj-b", "/path/b");
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(100);
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(100);
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);

    expect(vi.mocked(freezeWebContents)).toHaveBeenCalledTimes(1);
  });

  it("activateView always unfreezes the activating view, even when efficiency is off", async () => {
    await manager.switchTo("proj-b", "/path/b");
    vi.mocked(unfreezeWebContents).mockClear();

    // Switch back to proj-a — its cached view should be unfrozen on activate.
    await manager.switchTo("proj-a", "/path/a");

    expect(vi.mocked(unfreezeWebContents)).toHaveBeenCalledWith(initialWc);
  });

  it("deactivateCurrentView calls freezeWebContents only when efficiency is on, and AFTER GC", async () => {
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);
    vi.mocked(freezeWebContents).mockClear();
    initialWc.executeJavaScript.mockClear();

    await manager.switchTo("proj-b", "/path/b");

    expect(initialWc.executeJavaScript).toHaveBeenCalledOnce();
    expect(vi.mocked(freezeWebContents)).toHaveBeenCalledWith(initialWc);

    const gcOrder = initialWc.executeJavaScript.mock.invocationCallOrder[0];
    const freezeOrder = vi.mocked(freezeWebContents).mock.invocationCallOrder[0];
    expect(gcOrder).toBeLessThan(freezeOrder);
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

  it("setEfficiencyFreeze with no cached views is a safe no-op (timer still clears)", () => {
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);
    expect(vi.mocked(freezeWebContents)).not.toHaveBeenCalled();

    // Re-toggle off — no unfreeze call expected (no cached views).
    manager.setEfficiencyFreeze(false);
    expect(vi.mocked(unfreezeWebContents)).not.toHaveBeenCalled();
  });

  it("deactivation marks the view cached in the broadcast registry", async () => {
    await manager.switchTo("proj-b", "/path/b");

    expect(vi.mocked(registerCachedViewWebContents)).toHaveBeenCalledWith(initialWc);
    // The newly-active view must never be marked cached.
    const activeWc = manager.getActiveView()!.webContents;
    const cachedCalls = vi.mocked(registerCachedViewWebContents).mock.calls;
    expect(cachedCalls.every((call) => call[0] !== activeWc)).toBe(true);
  });

  it("marks the view cached before applying the CPU throttle", async () => {
    const { throttleCpuWebContents } = await import("../../utils/webContentsLifecycle.js");

    await manager.switchTo("proj-b", "/path/b");

    const markOrder = vi.mocked(registerCachedViewWebContents).mock.invocationCallOrder[0];
    const throttleOrder = vi.mocked(throttleCpuWebContents).mock.invocationCallOrder[0];
    expect(markOrder).toBeLessThan(throttleOrder);
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

  it("wakes a frozen view on spawn-result reseed when its agent is now active", async () => {
    await manager.switchTo("proj-b", "/path/b");

    const captured: Record<string, (...a: unknown[]) => void> = {};
    let agentState = "idle";
    const ptyClient = {
      getAllTerminalsAsync: vi.fn(async () => [{ id: "t1", projectId: "proj-a", agentState }]),
      on: vi.fn((evt: string, h: (...a: unknown[]) => void) => {
        captured[evt] = h;
      }),
      off: vi.fn(),
    };
    await manager.initAgentStateCache(ptyClient as never);

    // Freeze proj-a while its agent is still idle.
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);
    expect(vi.mocked(freezeWebContents)).toHaveBeenCalledWith(initialWc);
    vi.mocked(unfreezeWebContents).mockClear();

    // Agent became active after the freeze; a spawn-result triggers a reseed
    // that now sees it, and the reseed's unfreezeActiveAgentViews() wakes it.
    agentState = "working";
    captured["spawn-result"]?.();
    await vi.advanceTimersByTimeAsync(0); // flush the async seed()

    expect(vi.mocked(unfreezeWebContents)).toHaveBeenCalledWith(initialWc);
    manager.dispose();
  });

  it("drops a terminal from the freeze-seed maps when it exits", async () => {
    const captured: Record<string, (...a: unknown[]) => void> = {};
    const ptyClient = {
      getAllTerminalsAsync: vi.fn(async () => [
        { id: "t1", projectId: "proj-a", agentState: "working" },
      ]),
      on: vi.fn((evt: string, h: (...a: unknown[]) => void) => {
        captured[evt] = h;
      }),
      off: vi.fn(),
    };
    await manager.initAgentStateCache(ptyClient as never);

    const priv = manager as unknown as {
      projectByTerminal: Map<string, string>;
      agentStateByTerminal: Map<string, string>;
    };
    // Seed populates projectByTerminal; set the agent-state entry explicitly so
    // the test pins the exit handler's cleanup of BOTH maps.
    priv.agentStateByTerminal.set("t1", "working");
    expect(priv.projectByTerminal.has("t1")).toBe(true);

    // The terminal exits → its now-stale entries must be dropped so a dead
    // terminal can't keep hasActiveAgent() reporting a phantom active agent.
    captured["exit"]?.("t1", 0);

    expect(priv.projectByTerminal.has("t1")).toBe(false);
    expect(priv.agentStateByTerminal.has("t1")).toBe(false);
    manager.dispose();
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
    (manager as unknown as { waitForPaint: () => Promise<string> }).waitForPaint = () =>
      Promise.resolve("signal");
    initialWc = createMockWebContents();
    const initialView = { webContents: initialWc, setBounds: vi.fn() };
    manager.registerInitialView(initialView as never, "proj-a", "/path/a");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("purges a cached view only after the delay elapses", async () => {
    await manager.switchTo("proj-b", "/path/b");
    expect(vi.mocked(purgeMemoryWebContents)).not.toHaveBeenCalled();

    vi.advanceTimersByTime(19_999);
    expect(vi.mocked(purgeMemoryWebContents)).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(vi.mocked(purgeMemoryWebContents)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(purgeMemoryWebContents)).toHaveBeenCalledWith(initialWc);
  });

  it("re-purges a long-cached view on the periodic interval", async () => {
    await manager.switchTo("proj-b", "/path/b");
    vi.advanceTimersByTime(20_000);
    expect(vi.mocked(purgeMemoryWebContents)).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    expect(vi.mocked(purgeMemoryWebContents)).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(purgeMemoryWebContents)
        .mock.calls.every((c) => c[0] === (initialWc as unknown as Electron.WebContents))
    ).toBe(true);
  });

  it("never purges a view that was reactivated before the delay", async () => {
    await manager.switchTo("proj-b", "/path/b");
    vi.advanceTimersByTime(10_000);

    await manager.switchTo("proj-a", "/path/a");
    vi.advanceTimersByTime(120_000);

    expect(vi.mocked(purgeMemoryWebContents)).not.toHaveBeenCalledWith(initialWc);
  });

  it("stops purging once the view is torn down", async () => {
    await manager.switchTo("proj-b", "/path/b");
    vi.advanceTimersByTime(20_000);
    expect(vi.mocked(purgeMemoryWebContents)).toHaveBeenCalledTimes(1);

    initialWc.isDestroyed.mockReturnValue(true);
    vi.advanceTimersByTime(120_000);
    expect(vi.mocked(purgeMemoryWebContents)).toHaveBeenCalledTimes(1);
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

  it("asks about the workspace id the view is keyed by", async () => {
    // ProjectViewManager keys views by an opaque WORKSPACE id (a project's hex
    // id or a scratch UUID), which is the same vocabulary the MCP binding
    // stores. Asking with anything else would never match.
    await manager.switchTo("proj-b", "/path/b");
    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);

    expect(mcpViewActivity).toHaveBeenCalledWith("proj-a", initialWc.id);
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

  it("keeps sweeping the rest of the view map after the callback throws", async () => {
    // An exception escaping the accessor would abandon the pass partway
    // through, silently leaving later views unfrozen for an unrelated reason.
    await manager.switchTo("proj-b", "/path/b");
    await manager.switchTo("proj-c", "/path/c");
    mcpViewActivity.mockImplementation(() => {
      throw new Error("MCP service mid-teardown");
    });

    expect(() => {
      manager.setEfficiencyFreeze(true);
      vi.advanceTimersByTime(500);
    }).not.toThrow();
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

  it("never freezes the active view, bound or not", async () => {
    boundWorkspaces.add("proj-b");
    await manager.switchTo("proj-b", "/path/b");
    const activeWc = manager.getActiveView()!.webContents;

    manager.setEfficiencyFreeze(true);
    vi.advanceTimersByTime(500);

    expect(vi.mocked(freezeWebContents).mock.calls.every((call) => call[0] !== activeWc)).toBe(
      true
    );
  });
});
