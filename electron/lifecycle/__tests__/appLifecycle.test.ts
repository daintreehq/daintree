import { beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({
  isPackaged: false as boolean,
  on: vi.fn(),
  quit: vi.fn(),
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
  handleDirectoryOpen: vi.fn(),
}));

const setSignalShutdownMock = vi.fn();
vi.mock("../signalShutdownState.js", () => ({
  setSignalShutdown: setSignalShutdownMock,
}));

import type { AppLifecycleOptions } from "../appLifecycle.js";

function makeOpts(): AppLifecycleOptions {
  return {
    onCreateWindow: vi.fn(),
    getMainWindow: vi.fn(() => null),
    getCliAvailabilityService: vi.fn(() => null),
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

  it("registers SIGTERM and SIGINT handlers regardless of isPackaged", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");

    for (const packaged of [false, true]) {
      vi.clearAllMocks();
      appMock.isPackaged = packaged;
      registerAppLifecycleHandlers(makeOpts());

      const signalCalls = processOnSpy.mock.calls.filter(
        ([sig]: string[]) => sig === "SIGTERM" || sig === "SIGINT"
      );
      expect(signalCalls).toHaveLength(2);
      expect(signalCalls[0][0]).toBe("SIGTERM");
      expect(signalCalls[1][0]).toBe("SIGINT");
    }
  });

  it("signal handler calls setSignalShutdown, schedules timeout, and calls app.quit", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    const sigTermCall = processOnSpy.mock.calls.find(([sig]: string[]) => sig === "SIGTERM");
    const handler = sigTermCall![1] as () => void;

    handler();

    expect(setSignalShutdownMock).toHaveBeenCalledOnce();
    expect(appMock.quit).toHaveBeenCalledOnce();

    expect(processExitSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it("signal handler is idempotent — second call is a no-op", async () => {
    const { registerAppLifecycleHandlers } = await import("../appLifecycle.js");
    registerAppLifecycleHandlers(makeOpts());

    const sigTermCall = processOnSpy.mock.calls.find(([sig]: string[]) => sig === "SIGTERM");
    const handler = sigTermCall![1] as () => void;

    handler();
    handler();

    expect(setSignalShutdownMock).toHaveBeenCalledOnce();
    expect(appMock.quit).toHaveBeenCalledOnce();
  });

  it("SIGTERM then SIGINT shares the same one-shot guard", async () => {
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
  });
});
