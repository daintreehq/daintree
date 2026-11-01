import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({
  isPackaged: false as boolean,
  isReady: vi.fn(() => true),
  whenReady: vi.fn(() => Promise.resolve()),
  on: vi.fn(),
  quit: vi.fn(),
  exit: vi.fn(),
  commandLine: { appendSwitch: vi.fn() },
}));

const browserWindowMock = vi.hoisted(() => ({
  getAllWindows: vi.fn((): unknown[] => []),
}));

interface FakeBaseWindow {
  options: unknown;
  listeners: Record<string, (...args: unknown[]) => void>;
  on: (event: string, cb: (...args: unknown[]) => void) => FakeBaseWindow;
  once: (event: string, cb: (...args: unknown[]) => void) => FakeBaseWindow;
  destroy: () => void;
  isDestroyed: () => boolean;
}

const baseWindowMock = vi.hoisted(() => {
  const instances: FakeBaseWindow[] = [];
  const order: string[] = [];
  const BaseWindow = vi.fn(function (options: unknown) {
    let destroyed = false;
    const win: FakeBaseWindow = {
      options,
      listeners: {},
      on: (event, cb) => {
        win.listeners[event] = cb;
        return win;
      },
      once: (event, cb) => {
        win.listeners[event] = cb;
        return win;
      },
      destroy: () => {
        destroyed = true;
        order.push("stand-in destroyed");
        win.listeners.closed?.();
      },
      isDestroyed: () => destroyed,
    };
    instances.push(win);
    return win;
  });
  return { BaseWindow, instances, order };
});

vi.mock("electron", () => ({
  app: appMock,
  BrowserWindow: browserWindowMock,
  BaseWindow: baseWindowMock.BaseWindow,
}));

const getActiveShutdownMock = vi.hoisted(() => vi.fn((): unknown => null));
vi.mock("../shutdownCoordinator.js", () => ({
  getActiveShutdown: getActiveShutdownMock,
}));

vi.mock("../../services/CrashRecoveryService.js", () => ({
  getCrashRecoveryService: vi.fn(() => ({
    cleanupOnExit: vi.fn(),
  })),
}));

const refreshProjectMenuStateMock = vi.hoisted(() => vi.fn());
vi.mock("../../projectMenuState.js", () => ({
  refreshProjectMenuState: refreshProjectMenuStateMock,
}));

const windowMenuStateMock = vi.hoisted(() => ({
  noteWindowClosing: vi.fn(),
  refreshOpenWindowMenu: vi.fn(),
}));
vi.mock("../../windowMenuState.js", () => windowMenuStateMock);

const onWindowTitlesChangedMock = vi.hoisted(() => vi.fn(() => () => {}));
vi.mock("../../window/windowTitle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../window/windowTitle.js")>()),
  onWindowTitlesChanged: onWindowTitlesChangedMock,
}));

const setSignalShutdownMock = vi.fn();
const setSafetyBeltTimerMock = vi.fn();
vi.mock("../signalShutdownState.js", () => ({
  setSignalShutdown: setSignalShutdownMock,
  setSafetyBeltTimer: setSafetyBeltTimerMock,
}));

const finishIfGroupStopMock = vi.hoisted(() => vi.fn(() => false));
vi.mock("../groupStop.js", () => ({
  finishIfGroupStop: finishIfGroupStopMock,
}));

const isWindowRecreatingMock = vi.fn(() => false);
vi.mock("../windowRecreationState.js", () => ({
  isWindowRecreating: isWindowRecreatingMock,
}));

// `broadcastToRenderer` pulls a heavy main-process chain (windowRef, ipcMain);
// mock it so importing appLifecycle in tests stays cheap. `archiveInstallIntent`
// is dynamically imported inside queueDntrPath.
vi.mock("../../ipc/utils.js", () => ({ broadcastToRenderer: vi.fn() }));
const enqueueArchiveInstallIntentsMock = vi.hoisted(() =>
  vi.fn<(p: readonly string[]) => Promise<void>>(async () => {})
);
vi.mock("../../setup/archiveInstallIntent.js", () => ({
  enqueueArchiveInstallIntents: enqueueArchiveInstallIntentsMock,
}));
const installPluginMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/PluginService.js", () => ({
  pluginService: { installPlugin: installPluginMock },
}));
const handleDaintreeUrlMock = vi.hoisted(() => vi.fn<(url: string) => void>());
vi.mock("../../setup/deepLinkInstall.js", () => ({
  extractDaintreeUrl: (argv: string[]) => argv.find((arg) => arg.startsWith("daintree://")) ?? null,
  handleDaintreeUrl: handleDaintreeUrlMock,
}));
// environment.ts registers real `open-file` listeners and calls enableSandbox()
// at import time; only the external folder-open dispatch is needed here.
const dispatchOpenDirPathMock = vi.hoisted(() => vi.fn<(dirPath: string) => void>());
const hasOpenDirConsumerMock = vi.hoisted(() => vi.fn<() => boolean>(() => true));
vi.mock("../../setup/environment.js", () => ({
  dispatchOpenDirPath: dispatchOpenDirPathMock,
  hasOpenDirConsumer: hasOpenDirConsumerMock,
}));

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import type { AppLifecycleOptions } from "../appLifecycle.js";
import { broadcastToRenderer } from "../../ipc/utils.js";
import { SAFETY_BELT_TIMEOUT_MS } from "../shutdownConfig.js";

function makeOpts(overrides?: Partial<AppLifecycleOptions>): AppLifecycleOptions {
  return {
    onCreateWindow: vi.fn(),
    getMainWindow: vi.fn(() => null),
    ...overrides,
  };
}

describe("registerAppLifecycleHandlers – signal handling", () => {
  let processOnSpy: ReturnType<typeof vi.spyOn>;
  let processListenersSpy: ReturnType<typeof vi.spyOn>;
  let removeAllListenersSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    processOnSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    // The runner's own signal listeners must survive the re-arm.
    processListenersSpy = vi.spyOn(process, "rawListeners").mockReturnValue([]);
    removeAllListenersSpy = vi
      .spyOn(process, "removeAllListeners")
      .mockImplementation(() => process);
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
      // SIGUSR2 is nodemon's restart signal; without this handler every dev-mode
      // rebuild exited ungracefully, never ran `markCleanExit`, and tripped the
      // CrashLoopGuard into safe mode. Keep it registered even in packaged.
      expect(signalCalls.map(([sig]: string[]) => sig)).toEqual(["SIGUSR2", "SIGTERM", "SIGINT"]);
    }
  });

  // Electron installs its own termination-signal handlers while it starts and
  // replaces the one libuv set up for an earlier listener, so the handler only
  // runs if it is registered once the app is ready.
  it("waits for ready before taking SIGTERM and SIGINT from Electron", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    let ready!: () => void;
    appMock.isReady.mockReturnValueOnce(false);
    appMock.whenReady.mockReturnValueOnce(new Promise<void>((resolve) => (ready = resolve)));
    appMock.isPackaged = true;
    registerAppLifecycleHandlers(makeOpts());

    const registered = () => processOnSpy.mock.calls.map(([sig]: string[]) => sig);
    expect(registered()).toContain("SIGUSR2");
    expect(registered()).not.toContain("SIGTERM");
    expect(registered()).not.toContain("SIGINT");

    ready();
    await Promise.resolve();
    await Promise.resolve();
    expect(registered()).toEqual(expect.arrayContaining(["SIGTERM", "SIGINT"]));
  });

  // Dependencies such as signal-exit listen from load, and libuv only installs
  // its handler when a signal goes from no listeners to one.
  it("re-arms each termination signal with its earlier listeners kept after ours", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    // rawListeners hands back a `once` listener's wrapper; re-adding that same
    // wrapper keeps it one-shot.
    const earlier = vi.fn();
    processListenersSpy.mockImplementation((sig: string) => (sig === "SIGTERM" ? [earlier] : []));
    appMock.isPackaged = true;
    registerAppLifecycleHandlers(makeOpts());

    expect(removeAllListenersSpy).toHaveBeenCalledWith("SIGTERM");
    expect(removeAllListenersSpy).toHaveBeenCalledWith("SIGINT");
    const sigterm = processOnSpy.mock.calls.filter(([sig]: string[]) => sig === "SIGTERM");
    expect(sigterm).toHaveLength(2);
    expect(sigterm[1][1]).toBe(earlier);
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

  it("checks for a group stop only once the quit has claimed the shutdown", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    const sigTermCall = processOnSpy.mock.calls.find(([sig]: string[]) => sig === "SIGTERM");
    const handler = sigTermCall![1] as () => void;

    handler();

    // The quit runs the chain's synchronous persistence; a group stop that
    // finished first would exit without it.
    expect(finishIfGroupStopMock).toHaveBeenCalledOnce();
    expect(appMock.quit.mock.invocationCallOrder[0]).toBeLessThan(
      finishIfGroupStopMock.mock.invocationCallOrder[0]
    );
  });

  it("stops Chromium's GPU fallback count before the quit starts, once", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    const sigTermCall = processOnSpy.mock.calls.find(([sig]: string[]) => sig === "SIGTERM");
    const handler = sigTermCall![1] as () => void;

    handler();
    vi.setSystemTime(Date.now() + 5_000);
    handler();

    // Relaunching a GPU process lost to the same signal must not exhaust the
    // fallback modes and abort the browser mid-quit.
    expect(appMock.commandLine.appendSwitch).toHaveBeenCalledExactlyOnceWith(
      "disable-gpu-process-crash-limit"
    );
    expect(appMock.commandLine.appendSwitch.mock.invocationCallOrder[0]).toBeLessThan(
      appMock.quit.mock.invocationCallOrder[0]
    );
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

  it("a second signal within 2s force-exits with status 1", async () => {
    vi.setSystemTime(new Date(1_000_000));
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    const sigTermCall = processOnSpy.mock.calls.find(([sig]: string[]) => sig === "SIGTERM");
    const handler = sigTermCall![1] as (signal: string) => void;

    handler("SIGTERM");
    vi.advanceTimersByTime(1); // the first dispatch has finished
    vi.setSystemTime(new Date(1_000_200));
    handler("SIGTERM");

    expect(setSignalShutdownMock).toHaveBeenCalledOnce();
    expect(appMock.quit).toHaveBeenCalledOnce();
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  // signal-exit and when-exit re-raise the signal at this process from their
  // own listeners; live, that made every SIGTERM exit with status 1.
  it("ignores the same signal echoed back, however long the quit's synchronous part took", async () => {
    vi.setSystemTime(new Date(1_000_000));
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    const sigTermCall = processOnSpy.mock.calls.find(([sig]: string[]) => sig === "SIGTERM");
    const handler = sigTermCall![1] as (signal: string) => void;

    handler("SIGTERM");
    // Still inside the first dispatch, 800 ms of synchronous persistence later.
    vi.setSystemTime(new Date(1_000_800));
    handler("SIGTERM");
    // And just after it.
    vi.advanceTimersByTime(1);
    handler("SIGTERM");

    expect(appMock.quit).toHaveBeenCalledOnce();
    expect(processExitSpy).not.toHaveBeenCalled();
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
    const termHandler = sigTermCall![1] as (signal: string) => void;
    const intHandler = sigIntCall![1] as (signal: string) => void;

    // Node passes each listener its signal; a different one is never an echo.
    termHandler("SIGTERM");
    intHandler("SIGINT");

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

  // A CLI path takes the same route as a Dock drop (#12593): `openDirHandler`
  // decides the window, so this handler neither opens nor focuses anything.
  it("routes a CLI path through the external-open dispatch without touching the old window", async () => {
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

    handler({}, ["daintree", `--cli-path=${cliDir}`], "/");

    expect(dispatchOpenDirPathMock).toHaveBeenCalledExactlyOnceWith(cliDir);
    expect(mainWindow.focus).not.toHaveBeenCalled();
  });

  it("hands a CLI path to the dispatch even with no window live", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    const secondInstanceCall = appMock.on.mock.calls.find(
      ([event]: string[]) => event === "second-instance"
    );
    const handler = secondInstanceCall![1] as (
      event: unknown,
      commandLine: string[],
      workingDirectory: string
    ) => void;

    handler({}, ["daintree", `--cli-path=${cliDir}`], "/");

    expect(dispatchOpenDirPathMock).toHaveBeenCalledExactlyOnceWith(cliDir);
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
    expect(dispatchOpenDirPathMock).not.toHaveBeenCalled();
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

describe("registerAppLifecycleHandlers – second-instance with no window", () => {
  type SecondInstanceHandler = (
    event: unknown,
    commandLine: string[],
    workingDirectory: string
  ) => void;

  let cliDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    appMock.isReady.mockReturnValue(true);
    hasOpenDirConsumerMock.mockReturnValue(true);
    vi.spyOn(process, "on").mockImplementation(() => process);
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    cliDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "daintree-second-instance-nowin-"));
  });

  afterEach(() => {
    fs.rmSync(cliDir, { recursive: true, force: true });
  });

  async function register(overrides?: Partial<AppLifecycleOptions>) {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const opts = makeOpts({ keepsRunningWithoutWindows: () => true, ...overrides });
    const handle = registerAppLifecycleHandlers(opts);
    const call = appMock.on.mock.calls.find(([event]: string[]) => event === "second-instance");
    return { opts, handle, handler: call![1] as SecondInstanceHandler };
  }

  it("keeps today's behaviour without Host mode: no window is opened", async () => {
    const { opts, handler } = await register({ keepsRunningWithoutWindows: () => false });

    handler({}, ["daintree"], "/");

    expect(opts.onCreateWindow).not.toHaveBeenCalled();
  });

  function makeWindow() {
    return {
      isMinimized: vi.fn(() => false),
      isDestroyed: vi.fn(() => false),
      restore: vi.fn(),
      focus: vi.fn(),
    };
  }

  it("hands a background --host-mode launch to this process without opening or focusing a window", async () => {
    const onHostModeRequested = vi.fn();
    const win = makeWindow();
    const { opts, handler } = await register({
      onHostModeRequested,
      getMainWindow: vi.fn(() => win as unknown as import("electron").BrowserWindow),
    });

    handler({}, ["/opt/Daintree/daintree", "--host-mode"], "/");

    expect(onHostModeRequested).toHaveBeenCalledExactlyOnceWith([
      "/opt/Daintree/daintree",
      "--host-mode",
    ]);
    expect(win.focus).not.toHaveBeenCalled();
    expect(opts.onCreateWindow).not.toHaveBeenCalled();
  });

  it("never opens a window in a Host with no display, which would crash it", async () => {
    const onHostModeRequested = vi.fn();
    const { opts, handle, handler } = await register({
      onHostModeRequested,
      canOpenWindows: () => false,
    });

    handler({}, ["/opt/Daintree/daintree"], "/home/greg");
    handler({}, ["/opt/Daintree/daintree", cliDir], "/home/greg");
    handle.onLaunchSettled();
    // A Host-mode request still reaches it.
    handler({}, ["/opt/Daintree/daintree", "--host-mode"], "/");

    expect(opts.onCreateWindow).not.toHaveBeenCalled();
    expect(onHostModeRequested).toHaveBeenCalledOnce();
  });

  it("does the same before the launch has settled, and after it settles opens nothing", async () => {
    const onHostModeRequested = vi.fn();
    const { opts, handle, handler } = await register({
      onHostModeRequested,
      isLaunchSettled: () => false,
    });

    handler({}, ["daintree", "--host-mode"], "/");
    handle.onLaunchSettled();

    expect(onHostModeRequested).toHaveBeenCalledOnce();
    expect(opts.onCreateWindow).not.toHaveBeenCalled();
  });

  it("runs due schedules for an OS job's launch without opening, focusing or routing anything", async () => {
    const onDueScheduleCheckRequested = vi.fn();
    const win = makeWindow();
    const { opts, handler } = await register({
      onDueScheduleCheckRequested,
      getMainWindow: vi.fn(() => win as unknown as import("electron").BrowserWindow),
    });

    handler(
      {},
      [
        "/opt/Daintree/daintree",
        "--run-due-schedules",
        `--cli-path=${cliDir}`,
        pathToFileURL(cliDir).href,
        nodePath.join(cliDir, "plugin.dntr"),
        "daintree://install?plugin=x",
      ],
      "/home/greg"
    );
    await Promise.resolve();

    expect(onDueScheduleCheckRequested).toHaveBeenCalledOnce();
    expect(win.focus).not.toHaveBeenCalled();
    expect(opts.onCreateWindow).not.toHaveBeenCalled();
    expect(dispatchOpenDirPathMock).not.toHaveBeenCalled();
    expect(enqueueArchiveInstallIntentsMock).not.toHaveBeenCalled();
    expect(handleDaintreeUrlMock).not.toHaveBeenCalled();
  });

  it("opens nothing for an OS job's launch with nothing to run the check", async () => {
    const { opts, handle, handler } = await register({ isLaunchSettled: () => false });

    handler({}, ["daintree", "--run-due-schedules"], "/");
    handle.onLaunchSettled();

    expect(opts.onCreateWindow).not.toHaveBeenCalled();
  });

  it("hands over Host mode asked for beside the schedule check", async () => {
    const onHostModeRequested = vi.fn();
    const onDueScheduleCheckRequested = vi.fn();
    const { opts, handler } = await register({ onHostModeRequested, onDueScheduleCheckRequested });

    handler({}, ["daintree", "--host-mode", "--run-due-schedules"], "/");

    expect(onDueScheduleCheckRequested).toHaveBeenCalledOnce();
    expect(onHostModeRequested).toHaveBeenCalledOnce();
    expect(opts.onCreateWindow).not.toHaveBeenCalled();
  });

  it("treats --host-mode as a plain relaunch where Host mode can't be handed over", async () => {
    const { opts, handler } = await register();

    handler({}, ["daintree", "--host-mode"], "/");

    expect(opts.onCreateWindow).toHaveBeenCalledOnce();
  });

  it("opens a window for a plain relaunch when none exists", async () => {
    const { opts, handler } = await register();

    handler({}, ["daintree"], "/");

    expect(opts.onCreateWindow).toHaveBeenCalledExactlyOnceWith({
      targeted: false,
      opensFolder: false,
    });
  });

  it("says a relaunch that named something to open was targeted, and which a folder", async () => {
    hasOpenDirConsumerMock.mockReturnValue(false);
    const { opts, handler } = await register();

    handler({}, ["daintree", nodePath.join(cliDir, "plugin.dntr")], "/");
    handler({}, ["daintree", "--cli-path=/nowhere/at/all"], "/");

    expect(opts.onCreateWindow).toHaveBeenNthCalledWith(1, { targeted: true, opensFolder: false });
    expect(opts.onCreateWindow).toHaveBeenNthCalledWith(2, { targeted: true, opensFolder: true });
  });

  it("treats a destroyed primary window as no window", async () => {
    const destroyed = {
      isMinimized: vi.fn(() => false),
      isDestroyed: vi.fn(() => true),
      restore: vi.fn(),
      focus: vi.fn(),
    };
    const { opts, handler } = await register({
      getMainWindow: vi.fn(() => destroyed as unknown as import("electron").BrowserWindow),
    });

    handler({}, ["daintree"], "/");

    expect(destroyed.focus).not.toHaveBeenCalled();
    expect(opts.onCreateWindow).toHaveBeenCalledOnce();
  });

  it("answers a relaunch that arrived during a windowless start once it settles", async () => {
    let settled = false;
    const { opts, handle, handler } = await register({ isLaunchSettled: () => settled });

    handler({}, ["daintree"], "/");
    handler({}, ["daintree"], "/");
    settled = true;
    handle.onLaunchSettled();
    handle.onLaunchSettled();

    expect(opts.onCreateWindow).toHaveBeenCalledOnce();
  });

  it("focuses the launch's own window instead when one came up meanwhile", async () => {
    let settled = false;
    let win: ReturnType<typeof makeWindow> | null = null;
    const { opts, handle, handler } = await register({
      isLaunchSettled: () => settled,
      getMainWindow: vi.fn(() => win as unknown as import("electron").BrowserWindow),
    });

    handler({}, ["daintree"], "/");
    win = makeWindow();
    settled = true;
    handle.onLaunchSettled();

    expect(win.focus).toHaveBeenCalledOnce();
    expect(opts.onCreateWindow).not.toHaveBeenCalled();
  });

  it("opens a window for a folder queued during a windowless start", async () => {
    let settled = false;
    hasOpenDirConsumerMock.mockReturnValue(false);
    const { opts, handle, handler } = await register({ isLaunchSettled: () => settled });

    handler({}, ["daintree", `--cli-path=${cliDir}`], "/");
    expect(dispatchOpenDirPathMock).toHaveBeenCalledExactlyOnceWith(cliDir);
    handler({}, ["daintree"], "/");
    settled = true;
    handle.onLaunchSettled();

    // Targeted, though a plain relaunch arrived after it.
    expect(opts.onCreateWindow).toHaveBeenCalledExactlyOnceWith({
      targeted: true,
      opensFolder: true,
    });
  });

  it("keeps a folder request's flags through a Dock click before the start settles", async () => {
    let settled = false;
    hasOpenDirConsumerMock.mockReturnValue(false);
    const { opts, handle, handler } = await register({ isLaunchSettled: () => settled });
    const activate = appMock.on.mock.calls.find(([event]: string[]) => event === "activate")![1];

    handler({}, ["daintree", "--cli-path=/nowhere/at/all"], "/");
    activate();
    settled = true;
    handle.onLaunchSettled();

    expect(opts.onCreateWindow).toHaveBeenCalledExactlyOnceWith({
      targeted: true,
      opensFolder: true,
    });
  });

  it("does nothing on settle when no second launch arrived", async () => {
    hasOpenDirConsumerMock.mockReturnValue(false);
    const { opts, handle } = await register();

    handle.onLaunchSettled();

    expect(opts.onCreateWindow).not.toHaveBeenCalled();
  });

  it("answers a relaunch that arrived before ready during a --host-mode start on settle", async () => {
    appMock.isReady.mockReturnValue(false);
    let settled = false;
    const { opts, handle, handler } = await register({ isLaunchSettled: () => settled });

    handler({}, ["daintree"], "/");
    appMock.isReady.mockReturnValue(true);
    settled = true;
    handle.onLaunchSettled();

    expect(opts.onCreateWindow).toHaveBeenCalledOnce();
  });

  it("brings a live window forward for a plain relaunch instead of opening another", async () => {
    const win = makeWindow();
    const { opts, handler } = await register({
      getMainWindow: vi.fn(() => win as unknown as import("electron").BrowserWindow),
    });

    handler({}, ["daintree"], "/");

    expect(win.focus).toHaveBeenCalledOnce();
    expect(opts.onCreateWindow).not.toHaveBeenCalled();
  });

  it("leaves a folder open to the routing that makes its own window", async () => {
    const { opts, handler } = await register();

    handler({}, ["daintree", `--cli-path=${cliDir}`], "/");

    expect(dispatchOpenDirPathMock).toHaveBeenCalledExactlyOnceWith(cliDir);
    expect(opts.onCreateWindow).not.toHaveBeenCalled();
  });

  it("opens a window for a folder when no window has ever installed that routing", async () => {
    hasOpenDirConsumerMock.mockReturnValue(false);
    const { opts, handler } = await register();

    handler({}, ["daintree", `--cli-path=${cliDir}`], "/");

    // Queued by the dispatch; the new window drains it.
    expect(dispatchOpenDirPathMock).toHaveBeenCalledExactlyOnceWith(cliDir);
    expect(opts.onCreateWindow).toHaveBeenCalledOnce();
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

  it("keeps running on linux while it runs without windows", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts({ keepsRunningWithoutWindows: () => true }));

    getWindowAllClosedHandler()();

    expect(appMock.quit).not.toHaveBeenCalled();
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

  /** Announce a new window to the lifecycle handlers and capture what it listens for. */
  function createWindow() {
    const createdCall = appMock.on.mock.calls.find(
      ([event]: string[]) => event === "browser-window-created"
    );
    expect(createdCall).toBeDefined();

    const winListeners: Record<string, (event?: unknown) => void> = {};
    const fakeWin = {
      once: (event: string, cb: () => void) => {
        winListeners[event] = cb;
      },
      on: (event: string, cb: (event?: unknown) => void) => {
        winListeners[event] = cb;
      },
    };
    (createdCall![1] as (event: unknown, win: unknown) => void)({}, fakeWin);
    return { fakeWin, winListeners };
  }

  it("refreshes the gates after a closing window's survivor is promoted", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    const { winListeners } = createWindow();
    winListeners.closed();

    // Must NOT be synchronous: WindowRegistry promotes the surviving window in
    // its own "closed" listener, registered after this one. Refreshing now would
    // still resolve against the window that is going away.
    expect(refreshProjectMenuStateMock).not.toHaveBeenCalled();
    expect(windowMenuStateMock.refreshOpenWindowMenu).not.toHaveBeenCalled();

    await Promise.resolve();

    expect(refreshProjectMenuStateMock).toHaveBeenCalled();
    // The survivor takes the Window menu's current-window mark.
    expect(windowMenuStateMock.refreshOpenWindowMenu).toHaveBeenCalled();
  });

  it.each(["win32", "linux"] as const)(
    "on %s takes a window off the Window menu's list as soon as it starts closing",
    async (platform) => {
      Object.defineProperty(process, "platform", { value: platform });
      const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
      registerAppLifecycleHandlers(makeOpts());

      const { fakeWin, winListeners } = createWindow();
      const closeEvent = { defaultPrevented: false };
      winListeners.close(closeEvent);

      expect(windowMenuStateMock.noteWindowClosing).toHaveBeenCalledExactlyOnceWith(
        fakeWin,
        closeEvent
      );
    }
  );

  it("on darwin leaves closing windows to AppKit's own list", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    const { winListeners } = createWindow();

    expect(winListeners.close).toBeUndefined();
  });

  it.each(["win32", "linux"] as const)(
    "on %s relabels the Window menu's list whenever window titles change",
    async (platform) => {
      Object.defineProperty(process, "platform", { value: platform });
      const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
      registerAppLifecycleHandlers(makeOpts());

      expect(onWindowTitlesChangedMock).toHaveBeenCalledExactlyOnceWith(
        windowMenuStateMock.refreshOpenWindowMenu
      );
    }
  );

  it("on darwin does not follow window titles for a list AppKit keeps", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    expect(onWindowTitlesChangedMock).not.toHaveBeenCalled();
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
    // And the Window menu marks whichever window is now focused.
    expect(windowMenuStateMock.refreshOpenWindowMenu).toHaveBeenCalled();
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

describe("registerAppLifecycleHandlers – a last window closed with scheduled runs open", () => {
  const originalPlatform = process.platform;
  type SecondInstanceHandler = (
    event: unknown,
    commandLine: string[],
    workingDirectory: string
  ) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    appMock.isReady.mockReturnValue(true);
    isWindowRecreatingMock.mockReturnValue(false);
    getActiveShutdownMock.mockReturnValue(null);
    browserWindowMock.getAllWindows.mockReturnValue([]);
    baseWindowMock.instances.length = 0;
    vi.spyOn(process, "on").mockImplementation(() => process);
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

  function handlerFor<T>(event: string): T {
    const call = appMock.on.mock.calls.find(([name]: string[]) => name === event);
    return call![1] as T;
  }

  async function register(platform: NodeJS.Platform, overrides?: Partial<AppLifecycleOptions>) {
    Object.defineProperty(process, "platform", { value: platform });
    let open = true;
    let onClosed: (() => void) | null = null;
    const stopFollowing = vi.fn();
    const scheduledRuns = {
      hasOpen: vi.fn(() => open),
      onClosed: vi.fn((listener: () => void) => {
        onClosed = listener;
        return stopFollowing;
      }),
      notified: vi.fn(() => Promise.resolve()),
    };
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const opts = makeOpts({ scheduledRuns, ...overrides });
    registerAppLifecycleHandlers(opts);
    return {
      opts,
      scheduledRuns,
      stopFollowing,
      setOpen: (value: boolean) => {
        open = value;
      },
      runClosed: () => onClosed?.(),
      closeLastWindow: () => handlerFor<() => void>("window-all-closed")(),
    };
  }

  function announceWindow() {
    const win = {
      on: vi.fn((event: string) => {
        if (event === "session-end") baseWindowMock.order.push("window hears session-end");
      }),
      once: vi.fn(),
    };
    handlerFor<(event: unknown, win: unknown) => void>("browser-window-created")({}, win);
    return win;
  }

  it.each(["win32", "linux"] as const)(
    "on %s stays up while a run is open and quits once the last one ends",
    async (platform) => {
      const { scheduledRuns, stopFollowing, setOpen, runClosed, closeLastWindow } =
        await register(platform);

      closeLastWindow();
      expect(appMock.quit).not.toHaveBeenCalled();
      expect(scheduledRuns.onClosed).toHaveBeenCalledOnce();

      // Another run is still going.
      runClosed();
      await nextTurn();
      expect(appMock.quit).not.toHaveBeenCalled();

      setOpen(false);
      runClosed();
      runClosed();
      // Heard mid-settlement: the quit waits for the rest of it.
      expect(appMock.quit).not.toHaveBeenCalled();
      await nextTurn();
      expect(appMock.quit).toHaveBeenCalledOnce();
      expect(stopFollowing).toHaveBeenCalledOnce();
    }
  );

  it("lets the last run's notification go out before it quits", async () => {
    const { scheduledRuns, setOpen, runClosed, closeLastWindow } = await register("win32");
    let sent!: () => void;
    scheduledRuns.notified.mockReturnValue(new Promise<void>((resolve) => (sent = resolve)));
    closeLastWindow();

    setOpen(false);
    runClosed();
    await nextTurn();
    expect(appMock.quit).not.toHaveBeenCalled();

    sent();
    await nextTurn();
    expect(appMock.quit).toHaveBeenCalledOnce();
  });

  it("doesn't quit after the notification if a window opened meanwhile", async () => {
    const { scheduledRuns, setOpen, runClosed, closeLastWindow } = await register("linux");
    let sent!: () => void;
    scheduledRuns.notified.mockReturnValue(new Promise<void>((resolve) => (sent = resolve)));
    closeLastWindow();
    setOpen(false);
    runClosed();
    await nextTurn();

    announceWindow();
    sent();
    await nextTurn();

    expect(appMock.quit).not.toHaveBeenCalled();
  });

  it("never lets an older notification wait quit past a later run's", async () => {
    const { scheduledRuns, setOpen, runClosed, closeLastWindow } = await register("linux");
    let firstSent!: () => void;
    let bothSent!: () => void;
    scheduledRuns.notified
      .mockReturnValueOnce(new Promise<void>((resolve) => (firstSent = resolve)))
      .mockReturnValueOnce(new Promise<void>((resolve) => (bothSent = resolve)));
    closeLastWindow();
    setOpen(false);
    runClosed();
    await nextTurn();

    // Another run started and ended while the first one's notification loaded.
    runClosed();
    await nextTurn();
    firstSent();
    await nextTurn();
    expect(appMock.quit).not.toHaveBeenCalled();

    bothSent();
    await nextTurn();
    expect(appMock.quit).toHaveBeenCalledOnce();
  });

  it("drops a notification wait from before a window reopened and closed again", async () => {
    const { scheduledRuns, setOpen, runClosed, closeLastWindow } = await register("linux");
    let firstSent!: () => void;
    scheduledRuns.notified
      .mockReturnValueOnce(new Promise<void>((resolve) => (firstSent = resolve)))
      .mockReturnValueOnce(new Promise<void>(() => {}));
    closeLastWindow();
    setOpen(false);
    runClosed();
    await nextTurn();

    announceWindow();
    setOpen(true);
    closeLastWindow();
    setOpen(false);
    runClosed();
    await nextTurn();
    firstSent();
    await nextTurn();

    expect(appMock.quit).not.toHaveBeenCalled();
  });

  it("waits ten seconds at most for a notification that never goes out", async () => {
    vi.useFakeTimers();
    try {
      const { scheduledRuns, setOpen, runClosed, closeLastWindow } = await register("linux");
      scheduledRuns.notified.mockReturnValue(new Promise<void>(() => {}));
      closeLastWindow();
      setOpen(false);
      runClosed();

      await vi.advanceTimersByTimeAsync(9_999);
      expect(appMock.quit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(appMock.quit).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("quits at once, as before, when no run is open", async () => {
    const { scheduledRuns, setOpen, closeLastWindow } = await register("linux");
    setOpen(false);

    closeLastWindow();

    expect(appMock.quit).toHaveBeenCalledOnce();
    expect(scheduledRuns.onClosed).not.toHaveBeenCalled();
  });

  it("leaves macOS's windowless lifetime alone", async () => {
    const { scheduledRuns, closeLastWindow } = await register("darwin");

    closeLastWindow();

    expect(scheduledRuns.hasOpen).not.toHaveBeenCalled();
    expect(appMock.quit).not.toHaveBeenCalled();
  });

  it("decides afresh once a window opens again", async () => {
    const { stopFollowing, setOpen, runClosed, closeLastWindow } = await register("linux");
    closeLastWindow();

    announceWindow();
    setOpen(false);
    runClosed();
    await nextTurn();

    expect(stopFollowing).toHaveBeenCalledOnce();
    expect(appMock.quit).not.toHaveBeenCalled();
  });

  it("opens a window for a relaunch while it waits", async () => {
    const { opts, closeLastWindow } = await register("win32");
    const relaunch = handlerFor<SecondInstanceHandler>("second-instance");

    relaunch({}, ["daintree"], "/");
    expect(opts.onCreateWindow).not.toHaveBeenCalled();

    closeLastWindow();
    relaunch({}, ["daintree"], "/");
    expect(opts.onCreateWindow).toHaveBeenCalledOnce();
  });

  it("stops waiting without quitting once something else keeps it running", async () => {
    let kept = false;
    const { stopFollowing, setOpen, runClosed, closeLastWindow } = await register("linux", {
      keepsRunningWithoutWindows: () => kept,
    });
    closeLastWindow();

    // A Host-mode launch handed over meanwhile.
    kept = true;
    setOpen(false);
    runClosed();
    await nextTurn();

    expect(stopFollowing).toHaveBeenCalledOnce();
    expect(appMock.quit).not.toHaveBeenCalled();
  });

  it("waits for a window recreation in flight rather than quit under it", async () => {
    const { setOpen, runClosed, closeLastWindow } = await register("linux");
    closeLastWindow();

    isWindowRecreatingMock.mockReturnValue(true);
    setOpen(false);
    runClosed();
    await nextTurn();

    expect(appMock.quit).not.toHaveBeenCalled();
  });

  it("never starts waiting once a quit has begun", async () => {
    const { scheduledRuns, closeLastWindow } = await register("linux");
    getActiveShutdownMock.mockReturnValue({ phase: "cleaning" });

    closeLastWindow();

    expect(scheduledRuns.onClosed).not.toHaveBeenCalled();
    expect(appMock.quit).toHaveBeenCalledOnce();
  });

  describe("the hidden window that hears the session end", () => {
    beforeEach(() => {
      baseWindowMock.order.length = 0;
    });

    it("on win32 stands in from a windowless start, and its session end quits as a signal", async () => {
      const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
      Object.defineProperty(process, "platform", { value: "win32" });
      const handle = registerAppLifecycleHandlers(makeOpts());

      handle.onStartedWindowless();
      handle.onStartedWindowless();

      expect(baseWindowMock.instances).toHaveLength(1);
      const [standIn] = baseWindowMock.instances;
      expect(standIn.options).toMatchObject({ show: false, skipTaskbar: true, focusable: false });

      standIn.listeners["session-end"]!();
      expect(setSignalShutdownMock).toHaveBeenCalledOnce();
      expect(appMock.quit).toHaveBeenCalledOnce();
    });

    it.each(["linux", "darwin"] as const)("on %s creates none", async (platform) => {
      const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
      Object.defineProperty(process, "platform", { value: platform });
      const handle = registerAppLifecycleHandlers(
        makeOpts({ keepsRunningWithoutWindows: () => true })
      );

      handle.onStartedWindowless();
      handlerFor<() => void>("window-all-closed")();

      expect(baseWindowMock.BaseWindow).not.toHaveBeenCalled();
    });

    it("never stands in once a quit has begun", async () => {
      const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
      Object.defineProperty(process, "platform", { value: "win32" });
      const handle = registerAppLifecycleHandlers(
        makeOpts({ keepsRunningWithoutWindows: () => true })
      );
      getActiveShutdownMock.mockReturnValue({ phase: "cleaning" });

      handle.onStartedWindowless();
      handlerFor<() => void>("window-all-closed")();

      expect(baseWindowMock.BaseWindow).not.toHaveBeenCalled();
    });

    it("never stands in beside a real window, which hears the session end itself", async () => {
      const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
      Object.defineProperty(process, "platform", { value: "win32" });
      const handle = registerAppLifecycleHandlers(makeOpts());
      browserWindowMock.getAllWindows.mockReturnValue([{}]);

      handle.onStartedWindowless();

      expect(baseWindowMock.BaseWindow).not.toHaveBeenCalled();
    });

    it("hands over to the first real window, then comes back when the last one closes", async () => {
      const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
      Object.defineProperty(process, "platform", { value: "win32" });
      const handle = registerAppLifecycleHandlers(
        makeOpts({ keepsRunningWithoutWindows: () => true })
      );
      handle.onStartedWindowless();
      const [standIn] = baseWindowMock.instances;

      announceWindow();

      // The real window listens before the stand-in goes, so no moment is unheard.
      expect(baseWindowMock.order).toEqual(["window hears session-end", "stand-in destroyed"]);
      expect(standIn.isDestroyed()).toBe(true);

      handlerFor<() => void>("window-all-closed")();
      expect(baseWindowMock.instances).toHaveLength(2);
      expect(baseWindowMock.instances[1].isDestroyed()).toBe(false);
      expect(appMock.quit).not.toHaveBeenCalled();
    });

    it("stands in while a closed last window waits on a run, and not for a plain quit", async () => {
      const { setOpen, closeLastWindow } = await register("win32");

      closeLastWindow();
      expect(baseWindowMock.instances).toHaveLength(1);

      announceWindow();
      setOpen(false);
      closeLastWindow();
      expect(baseWindowMock.instances).toHaveLength(1);
      expect(appMock.quit).toHaveBeenCalledOnce();
    });
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

  it("replays a Dock click that arrived during a windowless Host start once it settles", async () => {
    appMock.isReady.mockReturnValue(false);
    let settled = false;
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const opts = makeOpts({
      keepsRunningWithoutWindows: () => true,
      isLaunchSettled: () => settled,
    });
    const handle = registerAppLifecycleHandlers(opts);

    getActivateHandler()();
    appMock.isReady.mockReturnValue(true);
    getActivateHandler()();
    expect(opts.onCreateWindow).not.toHaveBeenCalled();

    settled = true;
    handle.onLaunchSettled();
    handle.onLaunchSettled();
    expect(opts.onCreateWindow).toHaveBeenCalledOnce();
  });

  it("still drops a pre-ready Dock click without Host mode", async () => {
    appMock.isReady.mockReturnValue(false);
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const opts = makeOpts({
      windowRegistry: makeRegistry(0),
      keepsRunningWithoutWindows: () => false,
      isLaunchSettled: () => false,
    });
    const handle = registerAppLifecycleHandlers(opts);

    getActivateHandler()();
    appMock.isReady.mockReturnValue(true);
    handle.onLaunchSettled();

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

  it.skipIf(process.platform === "win32")("decodes a file:// directory URI", async () => {
    const { extractCliPath } = await import("../appLifecycle.js");
    expect(extractCliPath(["daintree", `--cli-path=file://${projectDir}`], root)).toBe(projectDir);
  });

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
    registerAppLifecycleHandlers(
      makeOpts({
        getMainWindow: vi.fn(() => mainWindow as unknown as import("electron").BrowserWindow),
      })
    );

    getHandler()({}, ["daintree", `--cli-path=${cliDir}`, dntrFile], "/work");
    await vi.waitFor(() => expect(enqueueArchiveInstallIntentsMock).toHaveBeenCalled());

    expect(dispatchOpenDirPathMock).toHaveBeenCalledWith(cliDir);
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

  it("routes a folder URI through the external-open dispatch and leaves the old window unfocused", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const mainWindow = makeBrowserWindow();
    registerAppLifecycleHandlers(
      makeOpts({
        getMainWindow: vi.fn(() => mainWindow as unknown as import("electron").BrowserWindow),
      })
    );

    getHandler()({}, ["daintree", pathToFileURL(dirPath).href], "/work");

    expect(dispatchOpenDirPathMock).toHaveBeenCalledExactlyOnceWith(dirPath);
    expect(mainWindow.focus).not.toHaveBeenCalled();
  });

  it("hands a folder to the dispatch even with no window live", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    getHandler()({}, ["daintree", pathToFileURL(dirPath).href], "/work");

    expect(dispatchOpenDirPathMock).toHaveBeenCalledExactlyOnceWith(dirPath);
  });

  it("dispatches multiple folders in argv order", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const mainWindow = makeBrowserWindow();
    registerAppLifecycleHandlers(
      makeOpts({
        getMainWindow: vi.fn(() => mainWindow as unknown as import("electron").BrowserWindow),
      })
    );

    const second = nodePath.join(dirPath, "second");
    fs.mkdirSync(second);
    getHandler()(
      {},
      ["daintree", pathToFileURL(dirPath).href, pathToFileURL(second).href],
      "/work"
    );

    expect(dispatchOpenDirPathMock.mock.calls.map(([p]) => p)).toEqual([dirPath, second]);
  });

  it("lets an explicit --cli-path win so the launch is not routed twice", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const mainWindow = makeBrowserWindow();
    registerAppLifecycleHandlers(
      makeOpts({
        getMainWindow: vi.fn(() => mainWindow as unknown as import("electron").BrowserWindow),
      })
    );

    // A real directory: `extractCliPath` only yields paths that exist (#11410),
    // so a fictional one would fail the request rather than win it.
    const explicitDir = nodePath.join(dirPath, "explicit");
    fs.mkdirSync(explicitDir);

    getHandler()({}, ["daintree", "--cli-path", explicitDir, pathToFileURL(dirPath).href], "/work");

    expect(dispatchOpenDirPathMock).toHaveBeenCalledExactlyOnceWith(explicitDir);
  });

  it("does not fall back to a folder URI when an explicit --cli-path fails to resolve", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const mainWindow = makeBrowserWindow();
    registerAppLifecycleHandlers(
      makeOpts({
        getMainWindow: vi.fn(() => mainWindow as unknown as import("electron").BrowserWindow),
      })
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      getHandler()(
        {},
        ["daintree", "--cli-path", "/explicit/gone", pathToFileURL(dirPath).href],
        "/work"
      );

      expect(dispatchOpenDirPathMock).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("treats a directory named like an archive as a folder, not a .dntr install", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    const mainWindow = makeBrowserWindow();
    registerAppLifecycleHandlers(
      makeOpts({
        getMainWindow: vi.fn(() => mainWindow as unknown as import("electron").BrowserWindow),
      })
    );

    const archiveNamed = nodePath.join(dirPath, "looks-like.dntr");
    fs.mkdirSync(archiveNamed);
    getHandler()({}, ["daintree", pathToFileURL(archiveNamed).href], "/work");

    expect(dispatchOpenDirPathMock).toHaveBeenCalledExactlyOnceWith(archiveNamed);
    // The archive queue dynamic-imports its module first; let that settle so an
    // enqueue it was going to make has been made.
    await vi.dynamicImportSettled();
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
});
