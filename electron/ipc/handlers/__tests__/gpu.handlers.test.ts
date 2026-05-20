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

import { registerGpuHandlers } from "../app/gpu.js";

describe("GPU_SET_HARDWARE_ACCELERATION handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcMainMock._handlers.clear();
  });

  it("disables GPU then awaits closeTelemetry before exit(0)", async () => {
    let resolveClose!: () => void;
    const deferred = new Promise<void>((r) => {
      resolveClose = r;
    });
    telemetryServiceMock.closeTelemetry.mockReturnValue(deferred);

    registerGpuHandlers();
    const handler = ipcMainMock._handlers.get("gpu:set-hardware-acceleration")!;
    expect(handler).toBeDefined();

    const handlerPromise = handler({} as Electron.IpcMainInvokeEvent, false);

    await Promise.resolve();
    await Promise.resolve();
    expect(gpuMonitorMock.writeGpuDisabledFlag).toHaveBeenCalled();
    expect(storeMock.set).toHaveBeenCalledWith("gpu", { hardwareAccelerationDisabled: true });
    expect(appMock.relaunch).toHaveBeenCalled();
    expect(telemetryServiceMock.closeTelemetry).toHaveBeenCalled();
    expect(appMock.exit).not.toHaveBeenCalled();

    resolveClose();
    await handlerPromise;

    expect(appMock.exit).toHaveBeenCalledWith(0);
  });

  it("enables GPU then awaits closeTelemetry before exit(0)", async () => {
    let resolveClose!: () => void;
    const deferred = new Promise<void>((r) => {
      resolveClose = r;
    });
    telemetryServiceMock.closeTelemetry.mockReturnValue(deferred);

    registerGpuHandlers();
    const handler = ipcMainMock._handlers.get("gpu:set-hardware-acceleration")!;

    const handlerPromise = handler({} as Electron.IpcMainInvokeEvent, true);

    await Promise.resolve();
    await Promise.resolve();
    expect(gpuMonitorMock.clearGpuDisabledFlag).toHaveBeenCalled();
    expect(gpuMonitorMock.clearGpuAngleFallbackFlag).toHaveBeenCalled();
    expect(storeMock.set).toHaveBeenCalledWith("gpu", { hardwareAccelerationDisabled: false });
    expect(appMock.relaunch).toHaveBeenCalled();
    expect(telemetryServiceMock.closeTelemetry).toHaveBeenCalled();
    expect(appMock.exit).not.toHaveBeenCalled();

    resolveClose();
    await handlerPromise;

    expect(appMock.exit).toHaveBeenCalledWith(0);
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
