import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PtyClient } from "../../services/PtyClient.js";
import type { WorkspaceClient } from "../../services/WorkspaceClient.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PowerHandler = (...args: any[]) => void;

const powerHandlers = new Map<string, PowerHandler>();
let mockGetAllWindows: ReturnType<typeof vi.fn>;
let mockGetFocusedWindow: ReturnType<typeof vi.fn>;
let mockGetAppWebContents: ReturnType<typeof vi.fn>;

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
    setPollingEnabled: vi.fn(),
    waitForReady: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    refreshOnWake: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as WorkspaceClient;
}

let setupPowerMonitor: typeof import("../powerMonitor.js").setupPowerMonitor;
let clearResumeTimeout: typeof import("../powerMonitor.js").clearResumeTimeout;

describe("setupPowerMonitor", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    powerHandlers.clear();
    vi.resetModules();

    mockGetAllWindows = vi.fn(() => []);
    // Default to a focused window so existing resume tests still see
    // setPollingEnabled(true) — the blur-during-resume guard is exercised
    // in dedicated tests below.
    mockGetFocusedWindow = vi.fn(() => ({}));

    vi.doMock("electron", () => ({
      app: { on: vi.fn() },
      BrowserWindow: {
        getFocusedWindow: mockGetFocusedWindow,
        getAllWindows: mockGetAllWindows,
      },
      powerMonitor: {
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
  });

  afterEach(() => {
    clearResumeTimeout();
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
    expect(workspaceClient.setPollingEnabled).toHaveBeenCalledWith(false);
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
    expect(workspaceClient.setPollingEnabled).not.toHaveBeenCalled();
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
      setPollingEnabled: vi.fn((enabled: boolean) => {
        callLog.push(`setPollingEnabled(${enabled})`);
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
      "setPollingEnabled(true)",
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
    expect(workspaceClient.setPollingEnabled).toHaveBeenCalledWith(true);
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
    expect(workspaceClient.setPollingEnabled).toHaveBeenCalledWith(false);
    expect(workspaceClient.setPollingEnabled).not.toHaveBeenCalledWith(true);
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
    expect(workspaceClient.setPollingEnabled).not.toHaveBeenCalled();
    expect(workspaceClient.resumeHealthCheck).not.toHaveBeenCalled();
    expect(workspaceClient.refreshOnWake).not.toHaveBeenCalled();
    expect(wc.send).not.toHaveBeenCalled();

    resolveReady!();
    await vi.advanceTimersByTimeAsync(0);

    expect(workspaceClient.setPollingEnabled).toHaveBeenCalledWith(true);
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

  it("does not re-enable polling on resume if the app is still fully blurred", async () => {
    // Scenario: user blurs app → blur-throttle pauses polling → machine
    // suspends → wakes while no window is focused. Resume must NOT
    // re-enable polling, otherwise the blur pause is silently undone.
    // removeThrottle() will re-enable polling on the next focus event.
    mockGetFocusedWindow.mockReturnValue(null);
    const workspaceClient = createMockWorkspaceClient();
    setupPowerMonitor({
      getPtyClient: () => createMockPtyClient(),
      getWorkspaceClient: () => workspaceClient,
    });

    powerHandlers.get("resume")!();
    await vi.advanceTimersByTimeAsync(2000);

    expect(workspaceClient.waitForReady).toHaveBeenCalledTimes(1);
    expect(workspaceClient.setPollingEnabled).not.toHaveBeenCalledWith(true);
    // The rest of the resume sequence still runs.
    expect(workspaceClient.resumeHealthCheck).toHaveBeenCalledTimes(1);
    expect(workspaceClient.refreshOnWake).toHaveBeenCalledTimes(1);
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
});
