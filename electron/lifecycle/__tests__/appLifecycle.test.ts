import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({
  isPackaged: false as boolean,
  isReady: vi.fn(() => true),
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

const refreshProjectMenuStateMock = vi.hoisted(() => vi.fn());
vi.mock("../../projectMenuState.js", () => ({
  refreshProjectMenuState: refreshProjectMenuStateMock,
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

// `broadcastToRenderer` pulls a heavy main-process chain (windowRef, ipcMain);
// mock it so importing appLifecycle in tests stays cheap and toasts are
// assertable. `archiveInstallIntent` is dynamically imported inside
// queueDntrPath.
vi.mock("../../ipc/utils.js", () => ({ broadcastToRenderer: vi.fn() }));
const enqueueArchiveInstallIntentsMock = vi.hoisted(() =>
  vi.fn<(p: readonly string[]) => Promise<void>>(async () => {})
);
vi.mock("../../setup/archiveInstallIntent.js", () => ({
  enqueueArchiveInstallIntents: enqueueArchiveInstallIntentsMock,
}));
// Tripwire: no lifecycle path may reach the installer directly any more.
const installPluginMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/PluginService.js", () => ({
  pluginService: { installPlugin: installPluginMock },
}));
// environment.ts registers real `open-file` listeners and calls enableSandbox()
// at import time; only the pre-window folder queue is needed here.
const queuePendingOpenDirPathMock = vi.hoisted(() => vi.fn<(dirPath: string) => void>());
vi.mock("../../setup/environment.js", () => ({
  queuePendingOpenDirPath: queuePendingOpenDirPathMock,
}));

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import type { AppLifecycleOptions } from "../appLifecycle.js";
import { handleDirectoryOpen } from "../../menu.js";
import { broadcastToRenderer } from "../../ipc/utils.js";
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

  // `extractCliPath` only yields paths that exist and are directories (#11410),
  // so these handler tests need a real directory rather than a fictional one.
  let cliDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "on").mockImplementation(() => process);
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    cliDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "daintree-second-instance-"));
  });

  afterEach(() => {
    fs.rmSync(cliDir, { recursive: true, force: true });
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

    handler({}, ["daintree", `--cli-path=${cliDir}`], "/");

    expect(onCreateWindowForPath).toHaveBeenCalledWith(cliDir);
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

    // Two-token form kept here on purpose: it must still work when the adjacent
    // token really is the path.
    handler({}, ["daintree", "--cli-path", cliDir], "/");

    expect(handleDirectoryOpen).toHaveBeenCalledWith(cliDir, mainWindow, undefined);
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

    handler({}, ["daintree", `--cli-path=${cliDir}`], "/");

    expect(onCreateWindowForPath).not.toHaveBeenCalled();
    expect(handleDirectoryOpen).not.toHaveBeenCalled();
    expect(getPendingCliPath()).toBe(cliDir);
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

  it("clears the File-menu project gates when the app goes windowless", async () => {
    // `browser-window-focus` never fires when focus drops to zero windows, so on
    // macOS (which survives windowless) this is the only signal that can drop the
    // gates (#11136).
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    getWindowAllClosedHandler()();

    expect(refreshProjectMenuStateMock).toHaveBeenCalled();
  });

  it("does not touch the menu gates while a window recreation is in flight", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    isWindowRecreatingMock.mockReturnValue(true);
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    getWindowAllClosedHandler()();

    // The replacement window is about to take focus and refresh them anyway.
    expect(refreshProjectMenuStateMock).not.toHaveBeenCalled();
  });

  it("refreshes the gates after a closing window's survivor is promoted", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    const createdCall = appMock.on.mock.calls.find(
      ([event]: string[]) => event === "browser-window-created"
    );
    expect(createdCall).toBeDefined();

    const winListeners: Record<string, () => void> = {};
    const fakeWin = {
      once: (event: string, cb: () => void) => {
        winListeners[event] = cb;
      },
    };
    (createdCall![1] as (event: unknown, win: unknown) => void)({}, fakeWin);

    winListeners.closed();

    // Must NOT be synchronous: WindowRegistry promotes the surviving window in
    // its own "closed" listener, registered after this one. Refreshing now would
    // still resolve against the window that is going away.
    expect(refreshProjectMenuStateMock).not.toHaveBeenCalled();

    await Promise.resolve();

    expect(refreshProjectMenuStateMock).toHaveBeenCalled();
  });

  it("refreshes the File-menu project gates whenever a window takes focus", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    const focusCall = appMock.on.mock.calls.find(
      ([event]: string[]) => event === "browser-window-focus"
    );
    expect(focusCall).toBeDefined();
    (focusCall![1] as () => void)();

    // The menu is process-global but its gates track the focused window's project.
    expect(refreshProjectMenuStateMock).toHaveBeenCalled();
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

describe("registerAppLifecycleHandlers – activate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks resets call history but not mockReturnValue overrides;
    // restore the ready-by-default baseline so per-test overrides can't leak.
    appMock.isReady.mockReturnValue(true);
    browserWindowMock.getAllWindows.mockReturnValue([]);
    vi.spyOn(process, "on").mockImplementation(() => process);
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  function getActivateHandler(): () => void {
    const call = appMock.on.mock.calls.find(([event]: string[]) => event === "activate");
    return call![1] as () => void;
  }

  function makeRegistry(size: number): AppLifecycleOptions["windowRegistry"] {
    return { size } as AppLifecycleOptions["windowRegistry"];
  }

  it("does not create a window or enumerate windows before the app is ready", async () => {
    appMock.isReady.mockReturnValue(false);
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const opts = makeOpts();
    registerAppLifecycleHandlers(opts);

    getActivateHandler()();

    expect(opts.onCreateWindow).not.toHaveBeenCalled();
    // The guard must sit before the window check — enumerating windows
    // pre-ready would also be unsafe.
    expect(browserWindowMock.getAllWindows).not.toHaveBeenCalled();
  });

  it("creates a window when ready and the registry is empty", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const opts = makeOpts({ windowRegistry: makeRegistry(0) });
    registerAppLifecycleHandlers(opts);

    getActivateHandler()();

    expect(opts.onCreateWindow).toHaveBeenCalledOnce();
  });

  it("does not create a window when ready and the registry has windows", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const opts = makeOpts({ windowRegistry: makeRegistry(1) });
    registerAppLifecycleHandlers(opts);

    getActivateHandler()();

    expect(opts.onCreateWindow).not.toHaveBeenCalled();
  });

  it("falls back to BrowserWindow.getAllWindows without a registry", async () => {
    browserWindowMock.getAllWindows.mockReturnValue([{} as never]);
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const opts = makeOpts();
    registerAppLifecycleHandlers(opts);

    getActivateHandler()();

    expect(opts.onCreateWindow).not.toHaveBeenCalled();
  });

  it("creates a window when ready with no registry and no open windows", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const opts = makeOpts();
    registerAppLifecycleHandlers(opts);

    getActivateHandler()();

    expect(opts.onCreateWindow).toHaveBeenCalledOnce();
  });

  it("does not touch the registry before the app is ready", async () => {
    appMock.isReady.mockReturnValue(false);
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const registry = {
      get size(): number {
        throw new Error("registry accessed pre-ready");
      },
    } as AppLifecycleOptions["windowRegistry"];
    const opts = makeOpts({ windowRegistry: registry });
    registerAppLifecycleHandlers(opts);

    expect(() => getActivateHandler()()).not.toThrow();
    expect(opts.onCreateWindow).not.toHaveBeenCalled();
  });

  it("re-evaluates readiness on every activation", async () => {
    appMock.isReady.mockReturnValue(false);
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const opts = makeOpts({ windowRegistry: makeRegistry(0) });
    registerAppLifecycleHandlers(opts);
    const handler = getActivateHandler();

    handler();
    expect(opts.onCreateWindow).not.toHaveBeenCalled();

    appMock.isReady.mockReturnValue(true);
    handler();
    expect(opts.onCreateWindow).toHaveBeenCalledOnce();
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

describe("extractCliPath", () => {
  // Real fixtures rather than mocked fs: choosing between candidate positionals
  // is now a filesystem-driven decision, so the behaviour under test is the
  // filesystem check itself.
  let root: string;
  let projectDir: string;
  let otherDir: string;
  let plainFile: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "daintree-cli-path-"));
    projectDir = nodePath.join(root, "project");
    otherDir = nodePath.join(root, "other");
    plainFile = nodePath.join(root, "notes.txt");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(otherDir);
    fs.writeFileSync(plainFile, "x");
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns null and stays silent when no --cli-path is present", async () => {
    const { extractCliPath } = await import("../appLifecycle.js");
    // A bare positional directory must not be treated as a project-open request.
    expect(extractCliPath(["daintree", projectDir], root)).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("accepts an existing directory in the single-token form", async () => {
    const { extractCliPath } = await import("../appLifecycle.js");
    expect(extractCliPath(["daintree", `--cli-path=${projectDir}`], root)).toBe(projectDir);
  });

  it("accepts the two-token form when the adjacent token is the real path", async () => {
    const { extractCliPath } = await import("../appLifecycle.js");
    expect(extractCliPath(["daintree", "--cli-path", projectDir], root)).toBe(projectDir);
  });

  it("ignores an injected switch and recovers the displaced path (#11410)", async () => {
    const { extractCliPath } = await import("../appLifecycle.js");
    // The exact shape reported in #11410: Chromium slots one of its own
    // switches between the flag and the folder, which lands at the end.
    expect(
      extractCliPath(["daintree", "--cli-path", "--allow-file-access-from-files", projectDir], root)
    ).toBe(projectDir);
  });

  it("never returns a switch as the path when nothing else qualifies", async () => {
    const { extractCliPath } = await import("../appLifecycle.js");
    const result = extractCliPath(
      ["daintree", "--cli-path", "--allow-file-access-from-files"],
      root
    );
    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("fails rather than substituting when the adjacent token is an explicit bad value", async () => {
    const { extractCliPath } = await import("../appLifecycle.js");
    // Nothing displaced this value — the launcher really did name a file.
    // Opening some other positional instead would be a project the user never
    // asked for.
    expect(extractCliPath(["daintree", "--cli-path", plainFile, projectDir], root)).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("does not substitute a later directory for an explicit missing path", async () => {
    const { extractCliPath } = await import("../appLifecycle.js");
    const missing = nodePath.join(root, "gone");
    expect(extractCliPath(["daintree", "--cli-path", missing, projectDir], root)).toBeNull();
  });

  it("never scans behind the flag for the displaced path", async () => {
    const { extractCliPath } = await import("../appLifecycle.js");
    // Chromium orders positionals after the switches, so a directory sitting
    // before the flag is someone else's argument — taking it would open the
    // wrong project.
    expect(
      extractCliPath(["daintree", otherDir, "--cli-path", "--injected", projectDir], root)
    ).toBe(projectDir);
  });

  it("returns null when the flag is last, even if an earlier token is a directory", async () => {
    const { extractCliPath } = await import("../appLifecycle.js");
    expect(extractCliPath(["daintree", projectDir, "--cli-path"], root)).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      "[MAIN] Failed to resolve --cli-path to an existing directory",
      expect.objectContaining({ argument: null })
    );
  });

  it("accepts a switch-like directory name in the single-token form", async () => {
    const { extractCliPath } = await import("../appLifecycle.js");
    // The `=` form is unambiguous, so the switch guard must not apply to it.
    const oddDir = nodePath.join(root, "--project");
    fs.mkdirSync(oddDir);
    expect(extractCliPath(["daintree", `--cli-path=${oddDir}`], root)).toBe(oddDir);
  });

  it("does not select a .dntr archive as the fallback directory", async () => {
    const { extractCliPath } = await import("../appLifecycle.js");
    const archive = nodePath.join(root, "plugin.dntr");
    fs.writeFileSync(archive, "x");
    expect(extractCliPath(["daintree", "--cli-path", "--injected", archive], root)).toBeNull();
  });

  it("never considers argv[0], even when it names a real directory", async () => {
    const { extractCliPath } = await import("../appLifecycle.js");
    expect(extractCliPath([projectDir, "--cli-path", "--injected"], root)).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "does not home-expand a leading ~ followed by a backslash on POSIX",
    async () => {
      const { extractCliPath } = await import("../appLifecycle.js");
      // `\` is a legal filename character here, so `~\x` is a literal name.
      const odd = nodePath.join(root, "~\\x");
      fs.mkdirSync(odd);
      expect(extractCliPath(["daintree", "--cli-path=~\\x"], root)).toBe(odd);
    }
  );

  it("takes the first qualifying directory when several positionals exist", async () => {
    const { extractCliPath } = await import("../appLifecycle.js");
    expect(
      extractCliPath(["daintree", "--cli-path", "--injected", otherDir, projectDir], root)
    ).toBe(otherDir);
  });

  it("treats the single-token form as authoritative and never falls back", async () => {
    const { extractCliPath } = await import("../appLifecycle.js");
    // An explicit value that can't be resolved must not silently open some
    // other directory the user never named.
    expect(extractCliPath(["daintree", "--cli-path=/does/not/exist", projectDir], root)).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("resolves a relative path against the launching instance's workingDirectory", async () => {
    const { extractCliPath } = await import("../appLifecycle.js");
    expect(extractCliPath(["daintree", "--cli-path=project"], root)).toBe(projectDir);
  });

  it("expands a leading ~ to the home directory", async () => {
    const { extractCliPath } = await import("../appLifecycle.js");
    // `~` alone resolves to the home directory itself, which always exists.
    expect(extractCliPath(["daintree", "--cli-path=~"], root)).toBe(os.homedir());
  });

  it("reports a failure for a path that does not exist", async () => {
    const { extractCliPath } = await import("../appLifecycle.js");
    expect(extractCliPath(["daintree", "--cli-path=/nope/nope"], root)).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      "[MAIN] Failed to resolve --cli-path to an existing directory",
      expect.objectContaining({ workingDirectory: root })
    );
  });

  it("rejects a path that exists but is not a directory", async () => {
    const { extractCliPath } = await import("../appLifecycle.js");
    expect(extractCliPath(["daintree", `--cli-path=${plainFile}`], root)).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("decodes a file:// directory URI", async () => {
    const { extractCliPath } = await import("../appLifecycle.js");
    expect(extractCliPath(["daintree", `--cli-path=file://${projectDir}`], root)).toBe(projectDir);
  });

  it.skipIf(process.platform === "win32")(
    "decodes percent-encoded characters in a file:// URI",
    async () => {
      const { extractCliPath } = await import("../appLifecycle.js");
      const spaced = nodePath.join(root, "my project");
      fs.mkdirSync(spaced);
      expect(extractCliPath(["daintree", `--cli-path=file://${root}/my%20project`], root)).toBe(
        spaced
      );
    }
  );

  it.skipIf(process.platform === "win32")("follows a symlink to a directory", async () => {
    const { extractCliPath } = await import("../appLifecycle.js");
    const link = nodePath.join(root, "link");
    fs.symlinkSync(projectDir, link);
    expect(extractCliPath(["daintree", `--cli-path=${link}`], root)).toBe(link);
  });

  it("rejects a malformed file:// URI", async () => {
    const { extractCliPath } = await import("../appLifecycle.js");
    // An encoded path separator makes fileURLToPath throw on every platform.
    expect(extractCliPath(["daintree", "--cli-path=file:///a%2Fb"], root)).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("extractDntrPaths", () => {
  it("returns absolute .dntr paths unchanged", async () => {
    const { extractDntrPaths } = await import("../appLifecycle.js");
    const abs = nodePath.resolve("/abs/Plugin.dntr");
    expect(extractDntrPaths(["daintree", abs], "/work")).toEqual([abs]);
  });

  it("resolves relative .dntr paths against the second instance's workingDirectory", async () => {
    const { extractDntrPaths } = await import("../appLifecycle.js");
    const workdir = nodePath.resolve("/work");
    expect(extractDntrPaths(["daintree", "plugin.dntr"], workdir)).toEqual([
      nodePath.join(workdir, "plugin.dntr"),
    ]);
  });

  it("matches the extension case-insensitively", async () => {
    const { extractDntrPaths } = await import("../appLifecycle.js");
    const result = extractDntrPaths(["daintree", "/a/Plugin.DNTR"], "/work");
    expect(result).toHaveLength(1);
    expect(result[0].toLowerCase().endsWith(".dntr")).toBe(true);
  });

  it("recognizes a Windows-style .dntr argument", async () => {
    const { extractDntrPaths } = await import("../appLifecycle.js");
    // Resolution differs on a POSIX test host, but the extension filter must
    // still flag the entry.
    const result = extractDntrPaths(["daintree", "C:\\Users\\a\\Plugin.DNTR"], "C:\\Users\\a");
    expect(result).toHaveLength(1);
    expect(result[0].toLowerCase().endsWith(".dntr")).toBe(true);
  });

  it("skips flag arguments and non-.dntr paths", async () => {
    const { extractDntrPaths } = await import("../appLifecycle.js");
    expect(extractDntrPaths(["daintree", "--cli-path", "/dir", "--foo=bar.dntr"], "/work")).toEqual(
      []
    );
  });

  it("returns both .dntr paths when the OS passes multiple", async () => {
    const { extractDntrPaths } = await import("../appLifecycle.js");
    const a = nodePath.resolve("/a/one.dntr");
    const b = nodePath.resolve("/b/two.dntr");
    expect(extractDntrPaths(["daintree", a, b], "/work")).toEqual([a, b]);
  });

  it("returns an empty array when no .dntr path is present", async () => {
    const { extractDntrPaths } = await import("../appLifecycle.js");
    expect(extractDntrPaths(["daintree"], "/work")).toEqual([]);
  });

  it("expands a leading ~ through the shared path normalization", async () => {
    const { extractDntrPaths } = await import("../appLifecycle.js");
    expect(extractDntrPaths(["daintree", nodePath.join("~", "plugin.dntr")], "/work")).toEqual([
      nodePath.join(os.homedir(), "plugin.dntr"),
    ]);
  });

  it("ignores tokens that only resolve onto a *.dntr directory", async () => {
    const { extractDntrPaths } = await import("../appLifecycle.js");
    // Both name a directory, not an archive. Resolving before the extension
    // check would strip the trailing separator / collapse the `..` and hand a
    // directory to the archive-install pipeline.
    expect(extractDntrPaths(["daintree", "plugin.dntr/"], "/work")).toEqual([]);
    expect(extractDntrPaths(["daintree", "plugin.dntr/child/.."], "/work")).toEqual([]);
  });
});

describe("hasCliPathFlag", () => {
  it("reports a requested path in either form, regardless of whether it resolves", async () => {
    const { hasCliPathFlag } = await import("../appLifecycle.js");
    expect(hasCliPathFlag(["daintree", "--cli-path", "/gone"])).toBe(true);
    expect(hasCliPathFlag(["daintree", "--cli-path=/gone"])).toBe(true);
    expect(hasCliPathFlag(["daintree", "--cli-path"])).toBe(true);
  });

  it("is false when no path was requested", async () => {
    const { hasCliPathFlag } = await import("../appLifecycle.js");
    expect(hasCliPathFlag(["daintree", "--other", "/some/dir"])).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "decodes file:// URIs passed by Linux file managers (electron-builder %U)",
    async () => {
      const { extractDntrPaths } = await import("../appLifecycle.js");
      expect(extractDntrPaths(["daintree", "file:///home/alice/plugin.dntr"], "/")).toEqual([
        "/home/alice/plugin.dntr",
      ]);
    }
  );

  it.skipIf(process.platform === "win32")(
    "decodes percent-encoded characters in a file:// URI",
    async () => {
      const { extractDntrPaths } = await import("../appLifecycle.js");
      expect(extractDntrPaths(["daintree", "file:///home/a%20b/my%20plugin.dntr"], "/")).toEqual([
        "/home/a b/my plugin.dntr",
      ]);
    }
  );

  it.skipIf(process.platform !== "win32")(
    "ignores Linux-style file:// URIs on Windows because they do not map to drive paths",
    async () => {
      const { extractDntrPaths } = await import("../appLifecycle.js");
      expect(extractDntrPaths(["daintree", "file:///home/alice/plugin.dntr"], "C:\\")).toEqual([]);
    }
  );
});

describe("queueDntrPaths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enqueueArchiveInstallIntentsMock.mockResolvedValue(undefined);
  });

  it("routes archives to the confirmation queue instead of installing them", async () => {
    const { queueDntrPaths } = await import("../appLifecycle.js");

    await queueDntrPaths(["/tmp/acme.dntr", "/tmp/beta.dntr"]);

    expect(enqueueArchiveInstallIntentsMock).toHaveBeenCalledExactlyOnceWith([
      "/tmp/acme.dntr",
      "/tmp/beta.dntr",
    ]);
    expect(installPluginMock).not.toHaveBeenCalled();
    // No install toast: the renderer owns the outcome once the user approves.
    expect(broadcastToRenderer).not.toHaveBeenCalled();
  });

  it("does not pre-screen the archive — the manifest preview is the gate", async () => {
    const { queueDntrPaths } = await import("../appLifecycle.js");

    await queueDntrPaths([nodePath.join(os.tmpdir(), "does-not-exist.dntr")]);

    expect(enqueueArchiveInstallIntentsMock).toHaveBeenCalledOnce();
    expect(installPluginMock).not.toHaveBeenCalled();
  });
});

describe("registerAppLifecycleHandlers – second-instance .dntr handling", () => {
  function makeBrowserWindow(overrides?: Partial<{ isMinimized: boolean; isDestroyed: boolean }>) {
    return {
      isMinimized: vi.fn(() => overrides?.isMinimized ?? false),
      isDestroyed: vi.fn(() => overrides?.isDestroyed ?? false),
      restore: vi.fn(),
      focus: vi.fn(),
    };
  }

  let dntrFile: string;
  let cliDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(process, "on").mockImplementation(() => process);
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    dntrFile = nodePath.join(os.tmpdir(), `dntr-handler-${process.pid}.dntr`);
    fs.writeFileSync(dntrFile, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    cliDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "daintree-dntr-cli-"));
    enqueueArchiveInstallIntentsMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    try {
      fs.unlinkSync(dntrFile);
    } catch {
      // already gone
    }
    fs.rmSync(cliDir, { recursive: true, force: true });
  });

  function getHandler() {
    const call = appMock.on.mock.calls.find(([event]: string[]) => event === "second-instance");
    return call![1] as (event: unknown, commandLine: string[], workingDirectory: string) => void;
  }

  it("queues a .dntr archive for confirmation and brings the window to the front", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const mainWindow = makeBrowserWindow();
    registerAppLifecycleHandlers(
      makeOpts({
        getMainWindow: vi.fn(() => mainWindow as unknown as import("electron").BrowserWindow),
      })
    );

    getHandler()({}, ["daintree", dntrFile], "/work");
    // Let the fire-and-forget queueing IIFE resolve.
    await vi.waitFor(() => expect(enqueueArchiveInstallIntentsMock).toHaveBeenCalled());

    expect(enqueueArchiveInstallIntentsMock).toHaveBeenCalledWith([dntrFile]);
    expect(mainWindow.focus).toHaveBeenCalled();
  });

  it("queues a .dntr archive even when no window exists yet", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts({ getMainWindow: vi.fn(() => null) }));

    getHandler()({}, ["daintree", dntrFile], "/work");
    // The intent queue holds the preview until a window paints, so there is no
    // separate windowless path here.
    await vi.waitFor(() =>
      expect(enqueueArchiveInstallIntentsMock).toHaveBeenCalledWith([dntrFile])
    );
  });

  it("queues several archives from one launch in argv order", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const second = nodePath.join(os.tmpdir(), `dntr-handler-2-${process.pid}.dntr`);
    fs.writeFileSync(second, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    try {
      registerAppLifecycleHandlers(makeOpts({ getMainWindow: vi.fn(() => null) }));

      getHandler()({}, ["daintree", dntrFile, second], "/work");
      await vi.waitFor(() => expect(enqueueArchiveInstallIntentsMock).toHaveBeenCalled());

      // One batch preserving argv order — never split into separate calls.
      expect(enqueueArchiveInstallIntentsMock).toHaveBeenCalledExactlyOnceWith([dntrFile, second]);
    } finally {
      fs.unlinkSync(second);
    }
  });

  it("honours a .dntr path and a CLI directory path in the same launch", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const mainWindow = makeBrowserWindow();
    const onCreateWindowForPath = vi.fn();
    registerAppLifecycleHandlers(
      makeOpts({
        getMainWindow: vi.fn(() => mainWindow as unknown as import("electron").BrowserWindow),
        onCreateWindowForPath,
      })
    );

    getHandler()({}, ["daintree", `--cli-path=${cliDir}`, dntrFile], "/work");
    await vi.waitFor(() => expect(enqueueArchiveInstallIntentsMock).toHaveBeenCalled());

    expect(onCreateWindowForPath).toHaveBeenCalledWith(cliDir);
    expect(enqueueArchiveInstallIntentsMock).toHaveBeenCalledWith([dntrFile]);
  });
});

describe("extractDirectoryPaths", () => {
  let dirPath: string;
  let filePath: string;

  beforeEach(() => {
    dirPath = fs.mkdtempSync(nodePath.join(os.tmpdir(), "dt-dir-"));
    filePath = nodePath.join(dirPath, "file.txt");
    fs.writeFileSync(filePath, "x");
  });

  afterEach(() => {
    fs.rmSync(dirPath, { recursive: true, force: true });
  });

  it("decodes a file:// URI pointing at a directory", async () => {
    const { extractDirectoryPaths } = await import("../appLifecycle.js");
    expect(extractDirectoryPaths(["daintree", pathToFileURL(dirPath).href])).toEqual([dirPath]);
  });

  it("decodes percent-encoded URIs", async () => {
    const { extractDirectoryPaths } = await import("../appLifecycle.js");
    const spaced = nodePath.join(dirPath, "my project");
    fs.mkdirSync(spaced);
    expect(extractDirectoryPaths(["daintree", pathToFileURL(spaced).href])).toEqual([spaced]);
  });

  it("ignores a file:// URI that resolves to a regular file", async () => {
    const { extractDirectoryPaths } = await import("../appLifecycle.js");
    expect(extractDirectoryPaths(["daintree", pathToFileURL(filePath).href])).toEqual([]);
  });

  it("ignores a file:// URI for a path that does not exist", async () => {
    const { extractDirectoryPaths } = await import("../appLifecycle.js");
    const missing = pathToFileURL(nodePath.join(dirPath, "gone")).href;
    expect(extractDirectoryPaths(["daintree", missing])).toEqual([]);
  });

  it("ignores bare paths so a normal launch never claims argv entries", async () => {
    const { extractDirectoryPaths } = await import("../appLifecycle.js");
    // A plain launch carries the executable path and cwd-ish arguments; only a
    // file:// URI signals an OS folder-open intent.
    expect(extractDirectoryPaths(["/usr/lib/daintree/daintree", dirPath, os.tmpdir()])).toEqual([]);
  });

  it("ignores malformed file URIs without throwing", async () => {
    const { extractDirectoryPaths } = await import("../appLifecycle.js");
    expect(extractDirectoryPaths(["daintree", "file://", "file://%%%"])).toEqual([]);
  });

  it("deduplicates repeated URIs while preserving argv order", async () => {
    const { extractDirectoryPaths } = await import("../appLifecycle.js");
    const second = nodePath.join(dirPath, "second");
    fs.mkdirSync(second);
    const result = extractDirectoryPaths([
      "daintree",
      pathToFileURL(second).href,
      pathToFileURL(dirPath).href,
      pathToFileURL(second).href,
    ]);
    expect(result).toEqual([second, dirPath]);
  });
});

describe("registerAppLifecycleHandlers – second-instance folder handling", () => {
  function makeBrowserWindow() {
    return {
      isMinimized: vi.fn(() => false),
      isDestroyed: vi.fn(() => false),
      restore: vi.fn(),
      focus: vi.fn(),
    };
  }

  let dirPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "on").mockImplementation(() => process);
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    dirPath = fs.mkdtempSync(nodePath.join(os.tmpdir(), "dt-second-"));
  });

  afterEach(() => {
    fs.rmSync(dirPath, { recursive: true, force: true });
  });

  function getHandler() {
    const call = appMock.on.mock.calls.find(([event]: string[]) => event === "second-instance");
    return call![1] as (event: unknown, commandLine: string[], workingDirectory: string) => void;
  }

  it("opens a folder URI in a new window and leaves the old window unfocused", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const mainWindow = makeBrowserWindow();
    const onCreateWindowForPath = vi.fn();
    registerAppLifecycleHandlers(
      makeOpts({
        getMainWindow: vi.fn(() => mainWindow as unknown as import("electron").BrowserWindow),
        onCreateWindowForPath,
      })
    );

    getHandler()({}, ["daintree", pathToFileURL(dirPath).href], "/work");
    await vi.waitFor(() => expect(onCreateWindowForPath).toHaveBeenCalledWith(dirPath));

    expect(mainWindow.focus).not.toHaveBeenCalled();
  });

  it("falls back to handleDirectoryOpen when onCreateWindowForPath is absent", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const mainWindow = makeBrowserWindow();
    registerAppLifecycleHandlers(
      makeOpts({
        getMainWindow: vi.fn(() => mainWindow as unknown as import("electron").BrowserWindow),
      })
    );

    getHandler()({}, ["daintree", pathToFileURL(dirPath).href], "/work");
    await vi.waitFor(() =>
      expect(handleDirectoryOpen).toHaveBeenCalledWith(dirPath, mainWindow, undefined)
    );
  });

  it("queues the folder for the pre-window drain when no window is live", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts({ onCreateWindowForPath: vi.fn() }));

    getHandler()({}, ["daintree", pathToFileURL(dirPath).href], "/work");
    await vi.waitFor(() => expect(queuePendingOpenDirPathMock).toHaveBeenCalledWith(dirPath));

    expect(handleDirectoryOpen).not.toHaveBeenCalled();
  });

  it("opens multiple folders in argv order", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const mainWindow = makeBrowserWindow();
    const onCreateWindowForPath = vi.fn();
    registerAppLifecycleHandlers(
      makeOpts({
        getMainWindow: vi.fn(() => mainWindow as unknown as import("electron").BrowserWindow),
        onCreateWindowForPath,
      })
    );

    const second = nodePath.join(dirPath, "second");
    fs.mkdirSync(second);
    getHandler()(
      {},
      ["daintree", pathToFileURL(dirPath).href, pathToFileURL(second).href],
      "/work"
    );
    await vi.waitFor(() => expect(onCreateWindowForPath).toHaveBeenCalledTimes(2));

    expect(onCreateWindowForPath.mock.calls.map(([p]) => p)).toEqual([dirPath, second]);
  });

  it("lets an explicit --cli-path win so the launch is not routed twice", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const mainWindow = makeBrowserWindow();
    const onCreateWindowForPath = vi.fn();
    registerAppLifecycleHandlers(
      makeOpts({
        getMainWindow: vi.fn(() => mainWindow as unknown as import("electron").BrowserWindow),
        onCreateWindowForPath,
      })
    );

    // A real directory: `extractCliPath` only yields paths that exist (#11410),
    // so a fictional one would fail the request rather than win it.
    const explicitDir = nodePath.join(dirPath, "explicit");
    fs.mkdirSync(explicitDir);

    getHandler()({}, ["daintree", "--cli-path", explicitDir, pathToFileURL(dirPath).href], "/work");
    await vi.waitFor(() => expect(onCreateWindowForPath).toHaveBeenCalled());

    expect(onCreateWindowForPath).toHaveBeenCalledExactlyOnceWith(explicitDir);
  });

  it("does not fall back to a folder URI when an explicit --cli-path fails to resolve", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const mainWindow = makeBrowserWindow();
    const onCreateWindowForPath = vi.fn();
    registerAppLifecycleHandlers(
      makeOpts({
        getMainWindow: vi.fn(() => mainWindow as unknown as import("electron").BrowserWindow),
        onCreateWindowForPath,
      })
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      getHandler()(
        {},
        ["daintree", "--cli-path", "/explicit/gone", pathToFileURL(dirPath).href],
        "/work"
      );
      // Microtask flush: the folder branch dispatches synchronously into a
      // promise chain, so anything it was going to call has been called by now.
      await Promise.resolve();
      await Promise.resolve();

      expect(onCreateWindowForPath).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("treats a directory named like an archive as a folder, not a .dntr install", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const mainWindow = makeBrowserWindow();
    const onCreateWindowForPath = vi.fn();
    registerAppLifecycleHandlers(
      makeOpts({
        getMainWindow: vi.fn(() => mainWindow as unknown as import("electron").BrowserWindow),
        onCreateWindowForPath,
      })
    );

    const archiveNamed = nodePath.join(dirPath, "looks-like.dntr");
    fs.mkdirSync(archiveNamed);
    getHandler()({}, ["daintree", pathToFileURL(archiveNamed).href], "/work");
    await vi.waitFor(() => expect(onCreateWindowForPath).toHaveBeenCalledWith(archiveNamed));

    expect(enqueueArchiveInstallIntentsMock).not.toHaveBeenCalled();
  });
});

describe("extractDntrPaths – interaction with folder opens", () => {
  it("does not claim the --cli-path operand as an archive", async () => {
    const { extractDntrPaths } = await import("../appLifecycle.js");
    // A Windows folder verb passes `--cli-path "C:\work\foo.dntr"`. Treating the
    // operand as an archive would open the folder AND queue a plugin install.
    expect(extractDntrPaths(["daintree", "--cli-path", "/work/foo.dntr"], "/")).toEqual([]);
  });

  it("still claims a bare archive path alongside a --cli-path operand", async () => {
    const { extractDntrPaths } = await import("../appLifecycle.js");
    expect(
      extractDntrPaths(["daintree", "--cli-path", "/work/proj.dntr", "/other/real.dntr"], "/")
    ).toEqual([nodePath.resolve("/", "/other/real.dntr")]);
  });

  it("normalizes decoded URIs so the folder filter can match them", async () => {
    const { extractDirectoryPaths } = await import("../appLifecycle.js");
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "dt-norm-"));
    try {
      // A doubled separator survives fileURLToPath but not path.resolve; if the
      // two extractors disagree the .dntr de-duplication silently fails.
      const doubled = `file://${pathToFileURL(dir).pathname}//`;
      expect(extractDirectoryPaths(["daintree", doubled])).toEqual([dir]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
