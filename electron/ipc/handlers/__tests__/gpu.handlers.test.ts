import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
    _handlers: handlers,
  };
});

const appMock = vi.hoisted(() => ({
  getPath: vi.fn(() => "/tmp/user-data"),
  relaunch: vi.fn(),
  exit: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  app: appMock,
}));

const storeMock = vi.hoisted(() => ({
  get: vi.fn(() => undefined),
  set: vi.fn(),
}));

vi.mock("../../../store.js", () => ({ store: storeMock }));

const gpuMonitorMock = vi.hoisted(() => ({
  isGpuDisabledByFlag: vi.fn(() => false),
  isGpuAngleFallbackByFlag: vi.fn(() => false),
  isGpuAngleFallbackApplied: vi.fn(() => false),
  writeGpuDisabledFlag: vi.fn(),
  clearGpuDisabledFlag: vi.fn(),
  clearGpuAngleFallbackFlag: vi.fn(),
}));

vi.mock("../../../services/GpuCrashMonitorService.js", () => gpuMonitorMock);

const telemetryServiceMock = vi.hoisted(() => ({
  closeTelemetry: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../services/TelemetryService.js", () => telemetryServiceMock);

const shutdownMock = vi.hoisted(() => ({
  result: "started" as "started" | "already-shutting-down" | "unavailable",
  onSettled: null as null | ((outcome: "clean" | "dirty") => void),
  startShutdown: vi.fn(),
}));
shutdownMock.startShutdown.mockImplementation(
  (_initiator: string, onSettled: (outcome: "clean" | "dirty") => void) => {
    shutdownMock.onSettled = onSettled;
    return shutdownMock.result;
  }
);

// The relaunch now runs through the shutdown coordinator rather than exiting
// inline, so the chain that captures every agent's session id gets to run
// first (#12320). Mocked here so the test can drive its settle point.
vi.mock("../../../lifecycle/shutdownCoordinator.js", () => ({
  startShutdown: (initiator: string, onSettled: (outcome: "clean" | "dirty") => void) =>
    shutdownMock.startShutdown(initiator, onSettled),
}));

vi.mock("../../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { registerGpuHandlers } from "../app/gpu.js";

describe("GPU_SET_HARDWARE_ACCELERATION handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcMainMock._handlers.clear();
    shutdownMock.result = "started";
    shutdownMock.onSettled = null;
    shutdownMock.startShutdown.mockImplementation(
      (_initiator: string, onSettled: (outcome: "clean" | "dirty") => void) => {
        shutdownMock.onSettled = onSettled;
        return shutdownMock.result;
      }
    );
    telemetryServiceMock.closeTelemetry.mockReturnValue(Promise.resolve());
  });

  /** Persist state, hand the exit to the shutdown coordinator, settle, exit. */
  async function invokeToggle(enabled: boolean) {
    registerGpuHandlers();
    const handler = ipcMainMock._handlers.get("gpu:set-hardware-acceleration")!;
    expect(handler).toBeDefined();
    const handlerPromise = handler({} as Electron.IpcMainInvokeEvent, enabled);
    await handlerPromise;
    return handlerPromise;
  }

  it("persists the GPU decision before asking to restart", async () => {
    // Ordering is load-bearing: a relaunch that beats the write comes back to
    // the state the user just changed away from.
    await invokeToggle(false);

    expect(gpuMonitorMock.writeGpuDisabledFlag).toHaveBeenCalled();
    expect(storeMock.set).toHaveBeenCalledWith("gpu", { hardwareAccelerationDisabled: true });
    const writeOrder = gpuMonitorMock.writeGpuDisabledFlag.mock.invocationCallOrder[0];
    const relaunchOrder = appMock.relaunch.mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(relaunchOrder);
  });

  it("clears the disabled and ANGLE flags when re-enabling", async () => {
    await invokeToggle(true);

    expect(gpuMonitorMock.clearGpuDisabledFlag).toHaveBeenCalled();
    expect(gpuMonitorMock.clearGpuAngleFallbackFlag).toHaveBeenCalled();
    expect(storeMock.set).toHaveBeenCalledWith("gpu", { hardwareAccelerationDisabled: false });
    expect(appMock.relaunch).toHaveBeenCalled();
  });

  it("claims the shutdown so agent sessions are captured, and exits only once it settles", async () => {
    // The old shape called app.exit(0) directly, which skips before-quit and
    // therefore the entire capture chain — so an app-initiated restart was the
    // one restart that lost every agent's --resume session (#12320).
    let resolveClose!: () => void;
    telemetryServiceMock.closeTelemetry.mockReturnValue(
      new Promise<void>((r) => {
        resolveClose = r;
      })
    );

    await invokeToggle(false);

    expect(shutdownMock.startShutdown).toHaveBeenCalledWith(
      "app-relaunch",
      expect.any(Function) as unknown as () => void
    );
    expect(appMock.relaunch).toHaveBeenCalled();
    expect(appMock.exit).not.toHaveBeenCalled();

    shutdownMock.onSettled?.("clean");
    expect(telemetryServiceMock.closeTelemetry).toHaveBeenCalled();
    expect(appMock.exit).not.toHaveBeenCalled();

    resolveClose();
    await Promise.resolve();
    await Promise.resolve();
    expect(appMock.exit).toHaveBeenCalledWith(0);
  });

  it("still exits when telemetry close rejects", async () => {
    telemetryServiceMock.closeTelemetry.mockReturnValue(Promise.reject(new Error("no sink")));

    await invokeToggle(false);
    shutdownMock.onSettled?.("dirty");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(appMock.exit).toHaveBeenCalledWith(0);
  });

  it("arms no relaunch when something else already owns the shutdown", async () => {
    // Electron cannot cancel an armed relaunch, so arming one against a user's
    // deliberate Quit would bring the app back up after they closed it.
    shutdownMock.result = "already-shutting-down";

    await invokeToggle(false);

    expect(appMock.relaunch).not.toHaveBeenCalled();
    expect(appMock.exit).not.toHaveBeenCalled();
  });
});

describe("GPU_GET_STATUS handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcMainMock._handlers.clear();
  });

  it("returns both flag states as false by default", async () => {
    gpuMonitorMock.isGpuDisabledByFlag.mockReturnValue(false);
    gpuMonitorMock.isGpuAngleFallbackApplied.mockReturnValue(false);

    registerGpuHandlers();
    const handler = ipcMainMock._handlers.get("gpu:get-status")!;

    const result = await handler({} as Electron.IpcMainInvokeEvent);

    expect(result).toEqual({
      hardwareAccelerationDisabled: false,
      angleFallbackActive: false,
    });
  });

  it("reports angleFallbackActive=true when ANGLE is actually applied", async () => {
    gpuMonitorMock.isGpuDisabledByFlag.mockReturnValue(false);
    gpuMonitorMock.isGpuAngleFallbackApplied.mockReturnValue(true);

    registerGpuHandlers();
    const handler = ipcMainMock._handlers.get("gpu:get-status")!;

    const result = (await handler({} as Electron.IpcMainInvokeEvent)) as {
      hardwareAccelerationDisabled: boolean;
      angleFallbackActive: boolean;
    };

    expect(result.angleFallbackActive).toBe(true);
    expect(result.hardwareAccelerationDisabled).toBe(false);
    expect(gpuMonitorMock.isGpuAngleFallbackApplied).toHaveBeenCalledWith("/tmp/user-data");
  });

  it("reports angleFallbackActive=false when the flag exists but ANGLE is not applied", async () => {
    // Mirrors the macOS / Linux X11 / Windows case: GpuCrashMonitorService
    // writes the flag on any platform after the first GPU crash, but
    // environment.ts only appends the ANGLE switches on Linux Wayland.
    // isGpuAngleFallbackApplied gates on platform so non-Wayland users
    // don't see a misleading "running in ANGLE mode" warning.
    gpuMonitorMock.isGpuDisabledByFlag.mockReturnValue(false);
    gpuMonitorMock.isGpuAngleFallbackByFlag.mockReturnValue(true);
    gpuMonitorMock.isGpuAngleFallbackApplied.mockReturnValue(false);

    registerGpuHandlers();
    const handler = ipcMainMock._handlers.get("gpu:get-status")!;

    const result = (await handler({} as Electron.IpcMainInvokeEvent)) as {
      hardwareAccelerationDisabled: boolean;
      angleFallbackActive: boolean;
    };

    expect(result.angleFallbackActive).toBe(false);
  });

  it("reports hardwareAccelerationDisabled=true when the disable flag exists", async () => {
    gpuMonitorMock.isGpuDisabledByFlag.mockReturnValue(true);
    gpuMonitorMock.isGpuAngleFallbackApplied.mockReturnValue(false);

    registerGpuHandlers();
    const handler = ipcMainMock._handlers.get("gpu:get-status")!;

    const result = (await handler({} as Electron.IpcMainInvokeEvent)) as {
      hardwareAccelerationDisabled: boolean;
      angleFallbackActive: boolean;
    };

    expect(result.hardwareAccelerationDisabled).toBe(true);
    expect(result.angleFallbackActive).toBe(false);
  });
});
