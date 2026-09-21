import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PtyClient } from "../../services/PtyClient.js";
import type { WorkspaceClient } from "../../services/WorkspaceClient.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PowerHandler = (...args: any[]) => void;

// Every watch is recorded separately: the mocked factory is cached across the
// `vi.resetModules()` each test opens with, so a shared spy would carry its call
// history between tests and make order decide whether an assertion holds.
const linuxSource = vi.hoisted(() => ({
  watches: [] as Array<{
    onChange: (onBattery: boolean) => void;
    refresh: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("../../services/linuxPowerSource.js", () => ({
  watchLinuxPowerSource: vi.fn((onChange: (onBattery: boolean) => void) => {
    const watch = { onChange, refresh: vi.fn(async () => {}), dispose: vi.fn() };
    linuxSource.watches.push(watch);
    return watch;
  }),
}));

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

const powerHandlers = new Map<string, PowerHandler>();
let mockGetAllWindows: ReturnType<typeof vi.fn>;
let mockGetFocusedWindow: ReturnType<typeof vi.fn>;
let mockGetAppWebContents: ReturnType<typeof vi.fn>;
let mockIsOnBatteryPower: ReturnType<typeof vi.fn>;

function createMockWindow(options: { destroyed?: boolean } = {}) {
  const wc = {
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
  };
  return {
    wc,
    win: {
      isDestroyed: vi.fn(() => options.destroyed ?? false),
      webContents: wc,
    },
  };
}

function createMockPtyClient(): PtyClient {
  return {
    pauseHealthCheck: vi.fn(),
    pauseAll: vi.fn(),
    resumeHealthCheck: vi.fn(),
    resumeAll: vi.fn(),
  } as unknown as PtyClient;
}

function createMockWorkspaceClient(overrides: Partial<WorkspaceClient> = {}): WorkspaceClient {
  return {
    pauseHealthCheck: vi.fn(),
    resumeHealthCheck: vi.fn(),
    setWorkspacePowerPolicy: vi.fn(),
    updateMonitorConfig: vi.fn(),
    waitForReady: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    refreshOnWake: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as WorkspaceClient;
}

let setupPowerMonitor: typeof import("../powerMonitor.js").setupPowerMonitor;
let clearResumeTimeout: typeof import("../powerMonitor.js").clearResumeTimeout;
let events: typeof import("../../services/events.js").events;

describe("setupPowerMonitor", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    // Linux takes the sysfs branch and CI runs on Linux, so each test names the
    // platform it means rather than inheriting the runner's.
    setPlatform("darwin");
    mockIsOnBatteryPower = vi.fn(() => false);
    linuxSource.watches.length = 0;
    powerHandlers.clear();
    vi.resetModules();

    mockGetAllWindows = vi.fn(() => []);
    // Default to a focused window so existing resume tests still see
    // the workspace policy push — the blur-during-resume guard is exercised
    // in dedicated tests below.
    mockGetFocusedWindow = vi.fn(() => ({}));

    vi.doMock("electron", () => ({
      app: { on: vi.fn() },
      BrowserWindow: {
        getFocusedWindow: mockGetFocusedWindow,
        getAllWindows: mockGetAllWindows,
      },
      powerMonitor: {
        isOnBatteryPower: mockIsOnBatteryPower,
        on: vi.fn((event: string, handler: PowerHandler) => {
          powerHandlers.set(event, handler);
        }),
      },
    }));

    vi.doMock("../../ipc/channels.js", () => ({
      CHANNELS: { EVENTS_PUSH: "events:push" },
    }));

    mockGetAppWebContents = vi.fn((win: { webContents: unknown }) => win.webContents);
    vi.doMock("../webContentsRegistry.js", () => ({
      getAppWebContents: mockGetAppWebContents,
    }));

    const mod = await import("../powerMonitor.js");
    setupPowerMonitor = mod.setupPowerMonitor;
    clearResumeTimeout = mod.clearResumeTimeout;
    // Resume re-reads window state before re-enabling workspace polling, so the
    // app needs one visible registered window; focus comes from the mock above.
    mod.registerWindowForFocusThrottle({
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      on: vi.fn(),
    } as unknown as Electron.BrowserWindow);
    // Imported after `resetModules` + the powerMonitor import so this is the
    // same bus instance powerMonitor closed over; the top-level singleton from
    // a previous registry would silently never receive the emit.
    events = (await import("../../services/events.js")).events;
  });

  afterEach(() => {
    // First, and guarded: a beforeEach that threw before the dynamic imports
    // landed would otherwise strand the faked platform on the next test.
    Object.defineProperty(process, "platform", realPlatform);
    clearResumeTimeout?.();
    events?.removeAllListeners();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("pauses pty and workspace services on suspend", () => {
    const ptyClient = createMockPtyClient();
    const workspaceClient = createMockWorkspaceClient();

    setupPowerMonitor({
      getPtyClient: () => ptyClient,
      getWorkspaceClient: () => workspaceClient,
    });

    const suspendHandler = powerHandlers.get("suspend")!;
    expect(suspendHandler).toBeDefined();
    suspendHandler();

    expect(ptyClient.pauseHealthCheck).toHaveBeenCalledTimes(1);
    expect(ptyClient.pauseAll).toHaveBeenCalledTimes(1);
    expect(workspaceClient.pauseHealthCheck).toHaveBeenCalledTimes(1);
    expect(workspaceClient.setWorkspacePowerPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ statusAllowed: false })
    );
  });

  it("does not trigger refresh before the 2s resume debounce elapses", async () => {
    const workspaceClient = createMockWorkspaceClient();
    setupPowerMonitor({
      getPtyClient: () => createMockPtyClient(),
      getWorkspaceClient: () => workspaceClient,
    });

    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(1999);

    expect(workspaceClient.waitForReady).not.toHaveBeenCalled();
    expect(workspaceClient.setWorkspacePowerPolicy).not.toHaveBeenCalled();
    expect(workspaceClient.refreshOnWake).not.toHaveBeenCalled();
  });

  it("runs the full refresh sequence after the 2s debounce and broadcasts SYSTEM_WAKE", async () => {
    const ptyClient = createMockPtyClient();
    const callLog: string[] = [];
    const workspaceClient = createMockWorkspaceClient({
      waitForReady: vi.fn(() => {
        callLog.push("waitForReady");
        return Promise.resolve();
      }),
      setWorkspacePowerPolicy: vi.fn((policy: { statusAllowed: boolean }) => {
        callLog.push(`setWorkspacePowerPolicy(status=${policy.statusAllowed})`);
      }),
      resumeHealthCheck: vi.fn(() => {
        callLog.push("resumeHealthCheck");
      }),
      refreshOnWake: vi.fn(() => {
        callLog.push("refreshOnWake");
        return Promise.resolve();
      }),
    } as unknown as Partial<WorkspaceClient>);

    const { win, wc } = createMockWindow();
    mockGetAllWindows.mockReturnValue([win]);

    setupPowerMonitor({
      getPtyClient: () => ptyClient,
      getWorkspaceClient: () => workspaceClient,
    });

    // Simulate a sleep/wake cycle to exercise the sleepDuration branch
    powerHandlers.get("suspend")!();
    // Reset the call log so we only capture the resume-side sequence below.
    callLog.length = 0;
    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(2000);

    expect(callLog).toEqual([
      "waitForReady",
      "setWorkspacePowerPolicy(status=true)",
      "resumeHealthCheck",
      "refreshOnWake",
    ]);
    expect(ptyClient.resumeAll).toHaveBeenCalledTimes(1);
    expect(ptyClient.resumeHealthCheck).toHaveBeenCalledTimes(1);
    expect(wc.send).toHaveBeenCalledWith(
      "events:push",
      expect.objectContaining({
        name: "system:wake",
        payload: expect.objectContaining({
          sleepDuration: expect.any(Number),
          timestamp: expect.any(Number),
        }),
      })
    );
  });

  it("coalesces multiple rapid resume events into a single refresh", async () => {
    const workspaceClient = createMockWorkspaceClient();
    setupPowerMonitor({
      getPtyClient: () => createMockPtyClient(),
      getWorkspaceClient: () => workspaceClient,
    });

    const resume = powerHandlers.get("resume")!;
    resume();
    await vi.advanceTimersByTimeAsync(500);
    resume();
    await vi.advanceTimersByTimeAsync(500);
    resume();
    await vi.advanceTimersByTimeAsync(2000);

    expect(workspaceClient.refreshOnWake).toHaveBeenCalledTimes(1);
    expect(workspaceClient.setWorkspacePowerPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ statusAllowed: true })
    );
  });

  it("cancels a pending resume refresh when a suspend arrives before the debounce fires", async () => {
    const workspaceClient = createMockWorkspaceClient();
    setupPowerMonitor({
      getPtyClient: () => createMockPtyClient(),
      getWorkspaceClient: () => workspaceClient,
    });

    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(1000);
    powerHandlers.get("suspend")!();
    await vi.advanceTimersByTimeAsync(3000);

    expect(workspaceClient.refreshOnWake).not.toHaveBeenCalled();
    expect(workspaceClient.setWorkspacePowerPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ statusAllowed: false })
    );
    expect(workspaceClient.setWorkspacePowerPolicy).not.toHaveBeenCalledWith(
      expect.objectContaining({ statusAllowed: true })
    );
  });

  it("still resumes pty and broadcasts SYSTEM_WAKE when workspaceClient is null", async () => {
    const ptyClient = createMockPtyClient();
    const { win, wc } = createMockWindow();
    mockGetAllWindows.mockReturnValue([win]);

    setupPowerMonitor({
      getPtyClient: () => ptyClient,
      getWorkspaceClient: () => null,
    });

    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(2000);

    expect(ptyClient.resumeAll).toHaveBeenCalledTimes(1);
    expect(ptyClient.resumeHealthCheck).toHaveBeenCalledTimes(1);
    expect(wc.send).toHaveBeenCalledWith(
      "events:push",
      expect.objectContaining({ name: "system:wake", payload: expect.any(Object) })
    );
  });

  it("catches and logs errors from workspaceClient.refreshOnWake", async () => {
    const refreshError = new Error("refresh failed");
    const workspaceClient = createMockWorkspaceClient({
      refreshOnWake: vi.fn().mockRejectedValue(refreshError),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    setupPowerMonitor({
      getPtyClient: () => createMockPtyClient(),
      getWorkspaceClient: () => workspaceClient,
    });

    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(2000);

    expect(consoleError).toHaveBeenCalledWith("[MAIN] Error during resume:", refreshError);
  });

  it("skips destroyed windows when broadcasting SYSTEM_WAKE", async () => {
    const workspaceClient = createMockWorkspaceClient();
    const live = createMockWindow();
    const dead = createMockWindow({ destroyed: true });
    mockGetAllWindows.mockReturnValue([live.win, dead.win]);

    setupPowerMonitor({
      getPtyClient: () => createMockPtyClient(),
      getWorkspaceClient: () => workspaceClient,
    });

    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(2000);

    expect(live.wc.send).toHaveBeenCalledWith(
      "events:push",
      expect.objectContaining({ name: "system:wake", payload: expect.any(Object) })
    );
    expect(dead.wc.send).not.toHaveBeenCalled();
  });

  it("blocks refresh and broadcast until waitForReady resolves", async () => {
    let resolveReady: (() => void) | null = null;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const workspaceClient = createMockWorkspaceClient({
      waitForReady: vi.fn(() => readyPromise),
    });
    const { win, wc } = createMockWindow();
    mockGetAllWindows.mockReturnValue([win]);

    setupPowerMonitor({
      getPtyClient: () => createMockPtyClient(),
      getWorkspaceClient: () => workspaceClient,
    });

    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(2000);

    expect(workspaceClient.waitForReady).toHaveBeenCalledTimes(1);
    expect(workspaceClient.setWorkspacePowerPolicy).not.toHaveBeenCalled();
    expect(workspaceClient.resumeHealthCheck).not.toHaveBeenCalled();
    expect(workspaceClient.refreshOnWake).not.toHaveBeenCalled();
    expect(wc.send).not.toHaveBeenCalled();

    resolveReady!();
    await vi.advanceTimersByTimeAsync(0);

    expect(workspaceClient.setWorkspacePowerPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ statusAllowed: true })
    );
    expect(workspaceClient.resumeHealthCheck).toHaveBeenCalledTimes(1);
    expect(workspaceClient.refreshOnWake).toHaveBeenCalledTimes(1);
    expect(wc.send).toHaveBeenCalledWith(
      "events:push",
      expect.objectContaining({ name: "system:wake", payload: expect.any(Object) })
    );
  });

  it("uses refreshOnWake (not refresh) on resume so adaptive polling state is reset", async () => {
    const workspaceClient = createMockWorkspaceClient();
    setupPowerMonitor({
      getPtyClient: () => createMockPtyClient(),
      getWorkspaceClient: () => workspaceClient,
    });

    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(2000);

    expect(workspaceClient.refreshOnWake).toHaveBeenCalledTimes(1);
    expect(workspaceClient.refresh).not.toHaveBeenCalled();
  });

  it("restores status polling on resume when a window is still visible but blurred", async () => {
    // A machine that sleeps and wakes with Daintree visible on a second screen
    // reports IDENTICAL observations before and after: still visible, still
    // blurred. Nothing fires, so recovery has to reconcile the policy itself
    // rather than wait for a change that never comes — otherwise suspend's
    // withdrawal is permanent and the sidebar never ticks again.
    mockGetFocusedWindow.mockReturnValue(null);
    const workspaceClient = createMockWorkspaceClient();
    setupPowerMonitor({
      getPtyClient: () => createMockPtyClient(),
      getWorkspaceClient: () => workspaceClient,
    });

    powerHandlers.get("suspend")!();
    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(2000);

    expect(workspaceClient.waitForReady).toHaveBeenCalledTimes(1);
    expect(workspaceClient.setWorkspacePowerPolicy).toHaveBeenLastCalledWith({
      statusAllowed: true,
      backgroundWorkAllowed: false,
      attenuated: true,
    });
    expect(workspaceClient.resumeHealthCheck).toHaveBeenCalledTimes(1);
    // The network refresh is a different question: nobody is waiting on it, so
    // it stays owed to whoever comes back.
    expect(workspaceClient.refreshOnWake).not.toHaveBeenCalled();
  });

  it("does not re-enable polling on resume while the screen is still locked", async () => {
    // A laptop usually wakes to the lock screen, with Daintree still the
    // focused app. Nobody can see it yet, so polling stays paused until unlock.
    const workspaceClient = createMockWorkspaceClient();
    setupPowerMonitor({
      getPtyClient: () => createMockPtyClient(),
      getWorkspaceClient: () => workspaceClient,
    });

    powerHandlers.get("lock-screen")!();
    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(2000);

    expect(workspaceClient.setWorkspacePowerPolicy).not.toHaveBeenCalledWith(
      expect.objectContaining({ statusAllowed: true })
    );
    expect(workspaceClient.refreshOnWake).not.toHaveBeenCalled();
  });

  it("records battery, AC, lock and unlock as power observations", async () => {
    const { getPowerPolicy } = await import("../powerPolicy.js");
    setupPowerMonitor({
      getPtyClient: () => null,
      getWorkspaceClient: () => null,
    });

    powerHandlers.get("on-battery")!();
    expect(getPowerPolicy()).toMatchObject({ onBattery: true, level: "saving" });

    powerHandlers.get("lock-screen")!();
    expect(getPowerPolicy()).toMatchObject({ screenLocked: true, level: "deep" });

    powerHandlers.get("unlock-screen")!();
    powerHandlers.get("on-ac")!();
    expect(getPowerPolicy()).toMatchObject({
      onBattery: false,
      screenLocked: false,
      level: "active",
    });
  });

  it("skips SYSTEM_WAKE for a window whose webContents is destroyed", async () => {
    const workspaceClient = createMockWorkspaceClient();
    const { win, wc } = createMockWindow();
    wc.isDestroyed.mockReturnValue(true);
    mockGetAllWindows.mockReturnValue([win]);

    setupPowerMonitor({
      getPtyClient: () => createMockPtyClient(),
      getWorkspaceClient: () => workspaceClient,
    });

    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(2000);

    expect(wc.send).not.toHaveBeenCalled();
  });

  it("emits sys:wake on the internal bus with the same values as the renderer push (#12175)", async () => {
    const workspaceClient = createMockWorkspaceClient();
    const { win, wc } = createMockWindow();
    mockGetAllWindows.mockReturnValue([win]);
    const onWake = vi.fn();
    events.on("sys:wake", onWake);

    setupPowerMonitor({
      getPtyClient: () => createMockPtyClient(),
      getWorkspaceClient: () => workspaceClient,
    });

    powerHandlers.get("suspend")!();
    await vi.advanceTimersByTimeAsync(5_000);
    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(2000);

    expect(onWake).toHaveBeenCalledTimes(1);
    const busPayload = onWake.mock.calls[0]?.[0];
    // One wake, one set of numbers: a plugin reacting to the bus and a renderer
    // reacting to the push must not disagree about when it happened or how long
    // the machine slept.
    const pushPayload = wc.send.mock.calls[0]?.[1]?.payload;
    expect(busPayload).toEqual(pushPayload);
    // Exactly the 5s sleep plus the 2s settle debounce: pins the documented
    // "includes the settle delay" claim, which a `>=` assertion would not.
    expect(busPayload.sleepDuration).toBe(7_000);
  });

  it("emits sys:wake even with no window to broadcast to", async () => {
    const workspaceClient = createMockWorkspaceClient();
    mockGetAllWindows.mockReturnValue([]);
    mockGetFocusedWindow.mockReturnValue(null);
    const onWake = vi.fn();
    events.on("sys:wake", onWake);

    setupPowerMonitor({
      getPtyClient: () => createMockPtyClient(),
      getWorkspaceClient: () => workspaceClient,
    });

    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(2000);

    // The blurred, windowless wake is precisely the case the renderer push
    // cannot serve — a plugin must still hear it.
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("does not emit sys:wake when the resume is cancelled by a re-suspend", async () => {
    const workspaceClient = createMockWorkspaceClient();
    const onWake = vi.fn();
    events.on("sys:wake", onWake);

    setupPowerMonitor({
      getPtyClient: () => createMockPtyClient(),
      getWorkspaceClient: () => workspaceClient,
    });

    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(1000);
    powerHandlers.get("suspend")!();
    await vi.advanceTimersByTimeAsync(5000);

    expect(onWake).not.toHaveBeenCalled();
  });

  it("still broadcasts to windows when a sys:wake subscriber throws", async () => {
    const workspaceClient = createMockWorkspaceClient();
    const { win, wc } = createMockWindow();
    mockGetAllWindows.mockReturnValue([win]);
    const thrower = vi.fn(() => {
      throw new Error("listener boom");
    });
    events.on("sys:wake", thrower);
    vi.spyOn(console, "error").mockImplementation(() => {});

    setupPowerMonitor({
      getPtyClient: () => createMockPtyClient(),
      getWorkspaceClient: () => workspaceClient,
    });

    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(2000);

    // Assert the thrower actually ran — otherwise deleting the emit entirely
    // would leave the renderer assertions below green.
    expect(thrower).toHaveBeenCalledTimes(1);
    expect(wc.send).toHaveBeenCalledTimes(1);
    expect(workspaceClient.refreshOnWake).toHaveBeenCalledTimes(1);
  });

  it("still announces the wake when post-wake recovery fails", async () => {
    const workspaceClient = createMockWorkspaceClient({
      refreshOnWake: vi.fn().mockRejectedValue(new Error("refresh failed")),
    });
    const { win, wc } = createMockWindow();
    mockGetAllWindows.mockReturnValue([win]);
    const onWake = vi.fn();
    events.on("sys:wake", onWake);
    vi.spyOn(console, "error").mockImplementation(() => {});

    setupPowerMonitor({
      getPtyClient: () => createMockPtyClient(),
      getWorkspaceClient: () => workspaceClient,
    });

    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(2000);

    // A half-recovered host is precisely when a listener needs to revalidate;
    // swallowing the wake there would strand everyone on suspend-era state.
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(wc.send).toHaveBeenCalledTimes(1);
  });

  it("announces the next wake after one was cancelled by a re-suspend", async () => {
    const workspaceClient = createMockWorkspaceClient();
    const onWake = vi.fn();
    events.on("sys:wake", onWake);

    setupPowerMonitor({
      getPtyClient: () => createMockPtyClient(),
      getWorkspaceClient: () => workspaceClient,
    });

    // Cancelled cycle: resume, then re-suspend before the debounce fires.
    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(1000);
    powerHandlers.get("suspend")!();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onWake).not.toHaveBeenCalled();

    // The real wake that follows must still land, timed from the newer suspend.
    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(2000);

    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onWake.mock.calls[0]?.[0].sleepDuration).toBe(5_000);
  });

  describe("battery observation", () => {
    it("seeds from Electron and follows its events off Linux", async () => {
      const { getPowerPolicy } = await import("../powerPolicy.js");
      mockIsOnBatteryPower.mockReturnValue(true);

      setupPowerMonitor({ getPtyClient: () => null, getWorkspaceClient: () => null });
      expect(getPowerPolicy()).toMatchObject({ onBattery: true, level: "saving" });

      powerHandlers.get("on-ac")!();
      expect(getPowerPolicy()).toMatchObject({ onBattery: false, level: "active" });
      expect(linuxSource.watches).toHaveLength(0);
    });

    it("takes the reading from sysfs on Linux, where Electron reports AC regardless", async () => {
      setPlatform("linux");
      const { getPowerPolicy } = await import("../powerPolicy.js");

      setupPowerMonitor({ getPtyClient: () => null, getWorkspaceClient: () => null });
      const watch = linuxSource.watches[0]!;
      expect(watch).toBeDefined();
      expect(getPowerPolicy()).toMatchObject({ onBattery: false, level: "active" });

      watch.onChange(true);
      expect(getPowerPolicy()).toMatchObject({ onBattery: true, level: "saving" });

      watch.onChange(false);
      expect(getPowerPolicy()).toMatchObject({ onBattery: false, level: "active" });
    });

    it("leaves the Electron battery events unregistered on Linux, so nothing can latch a stale answer", () => {
      setPlatform("linux");

      setupPowerMonitor({ getPtyClient: () => null, getWorkspaceClient: () => null });

      // The sysfs watch reports against its own last answer, so a second writer
      // would strand the policy until the hardware genuinely changed.
      expect(powerHandlers.has("on-battery")).toBe(false);
      expect(powerHandlers.has("on-ac")).toBe(false);
      expect(mockIsOnBatteryPower).not.toHaveBeenCalled();
    });

    it("re-reads sysfs on resume rather than waiting out the poll interval", () => {
      setPlatform("linux");
      setupPowerMonitor({ getPtyClient: () => null, getWorkspaceClient: () => null });
      const watch = linuxSource.watches[0]!;
      // Counted from here, so a refresh moved into setup would not pass for it.
      watch.refresh.mockClear();

      powerHandlers.get("resume")!();

      expect(watch.refresh).toHaveBeenCalledTimes(1);
    });

    it("keeps a battery reading that lands on resume through the wake recovery", async () => {
      setPlatform("linux");
      const { getPowerPolicy } = await import("../powerPolicy.js");
      const workspaceClient = createMockWorkspaceClient();
      setupPowerMonitor({ getPtyClient: () => null, getWorkspaceClient: () => workspaceClient });
      const watch = linuxSource.watches[0]!;
      watch.refresh.mockImplementation(async () => {
        watch.onChange(true);
      });

      powerHandlers.get("suspend")!();
      powerHandlers.get("resume")!();
      await vi.advanceTimersByTimeAsync(2000);

      // Recovery re-reads the windows; it must not re-read the power source and
      // overwrite what sysfs reported on the way in.
      expect(getPowerPolicy()).toMatchObject({ onBattery: true, level: "saving" });
      expect(mockIsOnBatteryPower).not.toHaveBeenCalled();
    });

    it("does not read sysfs on resume off Linux", () => {
      setupPowerMonitor({ getPtyClient: () => null, getWorkspaceClient: () => null });

      powerHandlers.get("resume")!();

      expect(linuxSource.watches).toHaveLength(0);
    });

    it("disposes the previous sysfs watch when set up again and keeps the new one", () => {
      setPlatform("linux");
      setupPowerMonitor({ getPtyClient: () => null, getWorkspaceClient: () => null });
      setupPowerMonitor({ getPtyClient: () => null, getWorkspaceClient: () => null });

      expect(linuxSource.watches).toHaveLength(2);
      const [first, second] = linuxSource.watches as [
        (typeof linuxSource.watches)[number],
        (typeof linuxSource.watches)[number],
      ];
      expect(first.dispose).toHaveBeenCalledTimes(1);
      expect(second.dispose).not.toHaveBeenCalled();

      // The surviving watch is the new one, not the disposed one.
      powerHandlers.get("resume")!();
      expect(second.refresh).toHaveBeenCalledTimes(1);
      expect(first.refresh).not.toHaveBeenCalled();
    });
  });
});
