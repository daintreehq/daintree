import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

const utilsMock = vi.hoisted(() => ({
  typedHandle: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
  typedHandleValidated: vi.fn(),
  typedHandleWithContext: vi.fn(),
  typedHandleWithContextValidated: vi.fn(),
}));

vi.mock("../../utils.js", () => utilsMock);

const checkKernelPressureCriticalMock = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
vi.mock("../../../services/SystemMemoryPressureMonitor.js", () => ({
  checkKernelPressureCritical: checkKernelPressureCriticalMock,
}));

import { registerMemoryPressureHandlers } from "../memoryPressure.js";

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const entry = ipcMainMock.handle.mock.calls.find(([ch]) => ch === channel);
  if (!entry) throw new Error(`no handler registered for ${channel}`);
  return (...args: unknown[]) => entry[1](null, ...args);
}

describe("registerMemoryPressureHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([true, false])("answers with the live kernel verdict (%s)", async (critical) => {
    checkKernelPressureCriticalMock.mockResolvedValue(critical);

    registerMemoryPressureHandlers({} as never);

    await expect(getHandler("system:is-memory-pressure-critical")()).resolves.toBe(critical);
    expect(checkKernelPressureCriticalMock).toHaveBeenCalledTimes(1);
  });

  it("unregisters its channel on dispose", () => {
    const dispose = registerMemoryPressureHandlers({} as never);
    dispose();
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("system:is-memory-pressure-critical");
  });
});
