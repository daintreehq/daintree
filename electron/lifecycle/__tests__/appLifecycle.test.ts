import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({
  isPackaged: false as boolean,
  on: vi.fn(),
  quit: vi.fn(),
  exit: vi.fn(),
}));

const browserWindowMock = vi.hoisted(() => ({
  getAllWindows: vi.fn(() => []),
}));

vi.mock("electron", () => ({
  app: appMock,
  BrowserWindow: browserWindowMock,
}));

vi.mock("../../services/CrashRecoveryService.js", () => ({
  getCrashRecoveryService: vi.fn(() => ({
    cleanupOnExit: vi.fn(),
  })),
}));

vi.mock("../../menu.js", () => ({
  handleDirectoryOpen: vi.fn(() => Promise.resolve()),
}));

const setSignalShutdownMock = vi.fn();
const setSafetyBeltTimerMock = vi.fn();
vi.mock("../signalShutdownState.js", () => ({
  setSignalShutdown: setSignalShutdownMock,
  setSafetyBeltTimer: setSafetyBeltTimerMock,
}));

const isWindowRecreatingMock = vi.fn(() => false);
vi.mock("../windowRecreationState.js", () => ({
  isWindowRecreating: isWindowRecreatingMock,
}));

import type { AppLifecycleOptions } from "../appLifecycle.js";
import { handleDirectoryOpen } from "../../menu.js";
import { SAFETY_BELT_TIMEOUT_MS } from "../shutdownConfig.js";

function makeOpts(overrides?: Partial<AppLifecycleOptions>): AppLifecycleOptions {
  return {
    onCreateWindow: vi.fn(),
    getMainWindow: vi.fn(() => null),
    getCliAvailabilityService: vi.fn(() => null),
    ...overrides,
  };
}

describe("registerAppLifecycleHandlers – signal handling", () => {
  let processOnSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    processOnSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  it("registers SIGTERM, SIGINT, and SIGUSR2 handlers regardless of isPackaged", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");

    for (const packaged of [false, true]) {
      vi.clearAllMocks();
      appMock.isPackaged = packaged;
      registerAppLifecycleHandlers(makeOpts());

      const signalCalls = processOnSpy.mock.calls.filter(([sig]: string[]) =>
        ["SIGTERM", "SIGINT", "SIGUSR2"].includes(sig)
      );
      expect(signalCalls).toHaveLength(3);
      expect(signalCalls[0][0]).toBe("SIGTERM");
      expect(signalCalls[1][0]).toBe("SIGINT");
      // SIGUSR2 is nodemon's restart signal; without this handler every dev-mode
      // rebuild exited ungracefully, never ran `markCleanExit`, and tripped the
      // CrashLoopGuard into safe mode. Keep it registered even in packaged.
      expect(signalCalls[2][0]).toBe("SIGUSR2");
    }
  });

  it("registers SIGHUP only when !isPackaged", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");

    appMock.isPackaged = false;
    registerAppLifecycleHandlers(makeOpts());
    expect(processOnSpy.mock.calls.some(([sig]: string[]) => sig === "SIGHUP")).toBe(true);

    vi.clearAllMocks();
    appMock.isPackaged = true;
    registerAppLifecycleHandlers(makeOpts());
    expect(processOnSpy.mock.calls.some(([sig]: string[]) => sig === "SIGHUP")).toBe(false);
  });

  it("signal handler calls setSignalShutdown, schedules safety-belt timer, and calls app.quit", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    const sigTermCall = processOnSpy.mock.calls.find(([sig]: string[]) => sig === "SIGTERM");
    const handler = sigTermCall![1] as () => void;

    handler();

    expect(setSignalShutdownMock).toHaveBeenCalledOnce();
    expect(appMock.quit).toHaveBeenCalledOnce();
    // Belt handle must be stored so shutdown.ts can cancel it on clean exit.
    // Without this, a slow closeTelemetry() could let the belt fire after
    // app.exit(0) and clobber the exit code with a wrong-direction exit(1).
    expect(setSafetyBeltTimerMock).toHaveBeenCalledWith(expect.anything());

    // Belt must outlast the full cleanup chain: CLEANUP_TIMEOUT_MS + 3000ms
    // buffer + 2500ms closeTelemetry budget. Advancing to (SAFETY_BELT_TIMEOUT_MS - 1)
    // confirms the belt hasn't fired prematurely.
    vi.advanceTimersByTime(SAFETY_BELT_TIMEOUT_MS - 1);
    expect(appMock.exit).not.toHaveBeenCalled();
    expect(processExitSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    // Belt fires app.exit(1) — dirty exit signals supervisors correctly and
    // runs Electron's native teardown. Never process.exit(0).
    expect(appMock.exit).toHaveBeenCalledWith(1);
    expect(processExitSpy).not.toHaveBeenCalledWith(0);
  });

  it("safety-belt nulls the stored handle when it fires", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    const sigTermCall = processOnSpy.mock.calls.find(([sig]: string[]) => sig === "SIGTERM");
    const handler = sigTermCall![1] as () => void;

    handler();
    setSafetyBeltTimerMock.mockClear();

    vi.advanceTimersByTime(SAFETY_BELT_TIMEOUT_MS);

    // Belt fired → handle cleared so a late clearSafetyBeltTimer() from
    // shutdown.ts is a no-op rather than canceling an already-fired timer.
    expect(setSafetyBeltTimerMock).toHaveBeenCalledWith(null);
  });

  it("rapid second signal within 2s force-exits with status 1", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    const sigTermCall = processOnSpy.mock.calls.find(([sig]: string[]) => sig === "SIGTERM");
    const handler = sigTermCall![1] as () => void;

    handler();
    // Same tick — Date.now() delta is ~0ms, well within the 2000ms force-exit window.
    handler();

    expect(setSignalShutdownMock).toHaveBeenCalledOnce();
    expect(appMock.quit).toHaveBeenCalledOnce();
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("second signal at 1999ms force-exits (boundary inside window)", async () => {
    vi.setSystemTime(new Date(1_000_000));
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    const sigTermCall = processOnSpy.mock.calls.find(([sig]: string[]) => sig === "SIGTERM");
    const handler = sigTermCall![1] as () => void;

    handler();
    // 1ms inside the 2000ms exclusive boundary — must force-exit. Pins the
    // `<` boundary so an accidental change to `<=` would surface here.
    vi.setSystemTime(new Date(1_001_999));
    handler();

    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("second signal after 2s force-exit window is ignored", async () => {
    vi.setSystemTime(new Date(1_000_000));
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    const sigTermCall = processOnSpy.mock.calls.find(([sig]: string[]) => sig === "SIGTERM");
    const handler = sigTermCall![1] as () => void;

    handler();
    // Boundary is exclusive — exactly 2000ms later is outside the window.
    vi.setSystemTime(new Date(1_002_000));
    handler();

    expect(setSignalShutdownMock).toHaveBeenCalledOnce();
    expect(appMock.quit).toHaveBeenCalledOnce();
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it("SIGTERM then SIGINT within window force-exits", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    const sigTermCall = processOnSpy.mock.calls.find(([sig]: string[]) => sig === "SIGTERM");
    const sigIntCall = processOnSpy.mock.calls.find(([sig]: string[]) => sig === "SIGINT");
    const termHandler = sigTermCall![1] as () => void;
    const intHandler = sigIntCall![1] as () => void;

    termHandler();
    intHandler();

    expect(setSignalShutdownMock).toHaveBeenCalledOnce();
    expect(appMock.quit).toHaveBeenCalledOnce();
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});

describe("registerAppLifecycleHandlers – second-instance", () => {
  function makeBrowserWindow(overrides?: Partial<{ isMinimized: boolean; isDestroyed: boolean }>) {
    return {
      isMinimized: vi.fn(() => overrides?.isMinimized ?? false),
      isDestroyed: vi.fn(() => overrides?.isDestroyed ?? false),
      restore: vi.fn(),
      focus: vi.fn(),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "on").mockImplementation(() => process);
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  it("creates a new window via onCreateWindowForPath when CLI path and existing window", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const mainWindow = makeBrowserWindow();
    const onCreateWindowForPath = vi.fn();
    registerAppLifecycleHandlers(
      makeOpts({
        getMainWindow: vi.fn(() => mainWindow as unknown as import("electron").BrowserWindow),
        onCreateWindowForPath,
      })
    );

    const secondInstanceCall = appMock.on.mock.calls.find(
      ([event]: string[]) => event === "second-instance"
    );
    const handler = secondInstanceCall![1] as (
      event: unknown,
      commandLine: string[],
      workingDirectory: string
    ) => void;

    handler({}, ["daintree", "--cli-path", "/path/to/repo"], "/");

    expect(onCreateWindowForPath).toHaveBeenCalledWith("/path/to/repo");
    expect(handleDirectoryOpen).not.toHaveBeenCalled();
    expect(mainWindow.focus).not.toHaveBeenCalled();
  });

  it("falls back to handleDirectoryOpen when onCreateWindowForPath is not provided", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const mainWindow = makeBrowserWindow();
    registerAppLifecycleHandlers(
      makeOpts({
        getMainWindow: vi.fn(() => mainWindow as unknown as import("electron").BrowserWindow),
      })
    );

    const secondInstanceCall = appMock.on.mock.calls.find(
      ([event]: string[]) => event === "second-instance"
    );
    const handler = secondInstanceCall![1] as (
      event: unknown,
      commandLine: string[],
      workingDirectory: string
    ) => void;

    handler({}, ["daintree", "--cli-path", "/path/to/repo"], "/");

    expect(handleDirectoryOpen).toHaveBeenCalledWith("/path/to/repo", mainWindow, undefined);
  });

  it("queues CLI path as pending when no window exists", async () => {
    const { registerAppLifecycleHandlers, getPendingCliPath } = await import("../appLifecycle.js");
    const onCreateWindowForPath = vi.fn();
    registerAppLifecycleHandlers(makeOpts({ onCreateWindowForPath }));

    const secondInstanceCall = appMock.on.mock.calls.find(
      ([event]: string[]) => event === "second-instance"
    );
    const handler = secondInstanceCall![1] as (
      event: unknown,
      commandLine: string[],
      workingDirectory: string
    ) => void;

    handler({}, ["daintree", "--cli-path", "/pending/path"], "/");

    expect(onCreateWindowForPath).not.toHaveBeenCalled();
    expect(handleDirectoryOpen).not.toHaveBeenCalled();
    expect(getPendingCliPath()).toBe("/pending/path");
  });

  it("focuses primary window when no CLI path is provided", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const mainWindow = makeBrowserWindow();
    registerAppLifecycleHandlers(
      makeOpts({
        getMainWindow: vi.fn(() => mainWindow as unknown as import("electron").BrowserWindow),
      })
    );

    const secondInstanceCall = appMock.on.mock.calls.find(
      ([event]: string[]) => event === "second-instance"
    );
    const handler = secondInstanceCall![1] as (
      event: unknown,
      commandLine: string[],
      workingDirectory: string
    ) => void;

    handler({}, ["daintree"], "/");

    expect(mainWindow.focus).toHaveBeenCalled();
    expect(handleDirectoryOpen).not.toHaveBeenCalled();
  });

  it("restores minimized window before focusing when no CLI path", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const mainWindow = makeBrowserWindow({ isMinimized: true });
    registerAppLifecycleHandlers(
      makeOpts({
        getMainWindow: vi.fn(() => mainWindow as unknown as import("electron").BrowserWindow),
      })
    );

    const secondInstanceCall = appMock.on.mock.calls.find(
      ([event]: string[]) => event === "second-instance"
    );
    const handler = secondInstanceCall![1] as (
      event: unknown,
      commandLine: string[],
      workingDirectory: string
    ) => void;

    handler({}, ["daintree"], "/");

    expect(mainWindow.restore).toHaveBeenCalled();
    expect(mainWindow.focus).toHaveBeenCalled();
  });
});

describe("registerAppLifecycleHandlers – window-all-closed", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    isWindowRecreatingMock.mockReturnValue(false);
    vi.spyOn(process, "on").mockImplementation(() => process);
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  function getWindowAllClosedHandler(): () => void {
    const call = appMock.on.mock.calls.find(([event]: string[]) => event === "window-all-closed");
    return call![1] as () => void;
  }

  it("calls app.quit on linux when no recreation is in flight", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    getWindowAllClosedHandler()();

    expect(appMock.quit).toHaveBeenCalledOnce();
  });

  it("skips app.quit on linux while a window recreation is in flight", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    isWindowRecreatingMock.mockReturnValue(true);
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    getWindowAllClosedHandler()();

    // Suppressing the quit during OOM recreate is the whole point of #5724.
    expect(appMock.quit).not.toHaveBeenCalled();
  });

  it("does not call app.quit on darwin even when no recreation is in flight", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    getWindowAllClosedHandler()();

    expect(appMock.quit).not.toHaveBeenCalled();
  });

  it("calls app.quit on win32 when no recreation is in flight", async () => {
    // Pin the `!== "darwin"` branch for Windows — if a future refactor
    // narrowed the check (e.g. to `=== "linux"`), this test would catch it.
    Object.defineProperty(process, "platform", { value: "win32" });
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    getWindowAllClosedHandler()();

    expect(appMock.quit).toHaveBeenCalledOnce();
  });

  it("resumes calling app.quit after the recreation flag returns to false", async () => {
    // Round-trip: a suppressed event during recreation must not leave the
    // quit path permanently disabled once the recreation settles.
    Object.defineProperty(process, "platform", { value: "linux" });
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());
    const handler = getWindowAllClosedHandler();

    isWindowRecreatingMock.mockReturnValue(true);
    handler();
    expect(appMock.quit).not.toHaveBeenCalled();

    isWindowRecreatingMock.mockReturnValue(false);
    handler();
    expect(appMock.quit).toHaveBeenCalledOnce();
  });
});

describe("registerWindowSessionEndHandler – Windows planned-shutdown wiring", () => {
  const originalPlatform = process.platform;

  function makeWin() {
    return { on: vi.fn() } as unknown as import("electron").BrowserWindow & {
      on: ReturnType<typeof vi.fn>;
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("registers a session-end listener on win32 and nothing else", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { registerWindowSessionEndHandler } = await import("../appLifecycle.js");
    const win = makeWin();

    registerWindowSessionEndHandler(win);

    const winOn = win.on as unknown as ReturnType<typeof vi.fn>;
    const sessionEndCalls = winOn.mock.calls.filter(([event]) => event === "session-end");
    expect(sessionEndCalls).toHaveLength(1);
    // Locks in the documented "no veto" decision — wiring query-session-end
    // with event.preventDefault() would block the user's planned shutdown.
    const queryEndCalls = winOn.mock.calls.filter(([event]) => event === "query-session-end");
    expect(queryEndCalls).toHaveLength(0);
  });

  it("invoking the session-end listener calls setSignalShutdown then app.quit", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { registerWindowSessionEndHandler } = await import("../appLifecycle.js");
    const win = makeWin();
    registerWindowSessionEndHandler(win);

    const winOn = win.on as unknown as ReturnType<typeof vi.fn>;
    const sessionEndCall = winOn.mock.calls.find(([event]) => event === "session-end");
    const handler = sessionEndCall![1] as () => void;

    handler();

    // setSignalShutdown must run before app.quit so the before-quit handler in
    // shutdown.ts skips the agent-count dialog (isSignalShutdown gate).
    expect(setSignalShutdownMock).toHaveBeenCalledOnce();
    expect(appMock.quit).toHaveBeenCalledOnce();
    expect(setSignalShutdownMock.mock.invocationCallOrder[0]).toBeLessThan(
      appMock.quit.mock.invocationCallOrder[0]
    );
  });

  it("registers nothing on darwin", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { registerWindowSessionEndHandler } = await import("../appLifecycle.js");
    const win = makeWin();

    registerWindowSessionEndHandler(win);

    const winOn = win.on as unknown as ReturnType<typeof vi.fn>;
    expect(winOn).not.toHaveBeenCalled();
  });

  it("registers nothing on linux", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { registerWindowSessionEndHandler } = await import("../appLifecycle.js");
    const win = makeWin();

    registerWindowSessionEndHandler(win);

    const winOn = win.on as unknown as ReturnType<typeof vi.fn>;
    expect(winOn).not.toHaveBeenCalled();
  });
});
