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

const admissionMock = vi.hoisted(() => ({ request: vi.fn(), observe: vi.fn() }));
vi.mock("../../../services/agentLaunchAdmission.js", () => ({
  getAgentLaunchAdmission: () => admissionMock,
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

  it("asks the host's admission for one agent launch, and rejects a missing id", async () => {
    const admission = { holdReason: null, observation: { runningAgents: 1 } };
    admissionMock.request.mockResolvedValue(admission);

    registerMemoryPressureHandlers({} as never);

    await expect(getHandler("system:request-agent-launch-admission")("pane-1")).resolves.toBe(
      admission
    );
    expect(admissionMock.request).toHaveBeenCalledWith("pane-1");
    await expect(getHandler("system:request-agent-launch-admission")("")).rejects.toThrow();
  });

  it("observes the host's admission without asking for a place", async () => {
    const observation = { runningAgents: 3 };
    admissionMock.observe.mockResolvedValue(observation);

    registerMemoryPressureHandlers({} as never);

    await expect(getHandler("system:observe-agent-launch-admission")()).resolves.toBe(observation);
    expect(admissionMock.request).not.toHaveBeenCalled();
  });

  it("unregisters its channels on dispose", () => {
    const dispose = registerMemoryPressureHandlers({} as never);
    dispose();
    for (const channel of [
      "system:is-memory-pressure-critical",
      "system:request-agent-launch-admission",
      "system:observe-agent-launch-admission",
    ]) {
      expect(ipcMainMock.removeHandler).toHaveBeenCalledWith(channel);
    }
  });
});
