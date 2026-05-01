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
