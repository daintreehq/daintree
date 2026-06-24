import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
  freezeWebContents: vi.fn().mockResolvedValue(undefined),
  unfreezeWebContents: vi.fn().mockResolvedValue(undefined),
  throttleCpuWebContents: vi.fn().mockResolvedValue(undefined),
  unthrottleCpuWebContents: vi.fn().mockResolvedValue(undefined),
}));

import { ProjectViewManager } from "../ProjectViewManager.js";
import { events } from "../../services/events.js";
import { freezeWebContents, unfreezeWebContents } from "../../utils/webContentsLifecycle.js";
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
