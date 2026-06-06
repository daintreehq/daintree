import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const appAgentServiceMock = vi.hoisted(() => ({
  getConfig: vi.fn(() => ({})),
  setConfig: vi.fn(),
  hasApiKey: vi.fn(() => false),
  testApiKey: vi.fn(),
  testModel: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
}));

vi.mock("../../../services/AppAgentService.js", () => ({
  appAgentService: appAgentServiceMock,
}));

import { CHANNELS } from "../../channels.js";
import { registerAppAgentHandlers } from "../appAgent.js";

function getInvokeHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = (ipcMainMock.handle as Mock).mock.calls.find(
    ([registered]) => registered === channel
  );
  if (!call) {
    throw new Error(`No handler registered for channel: ${channel}`);
  }
  return call[1] as (...args: unknown[]) => Promise<unknown>;
}

describe("appAgent handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerAppAgentHandlers({} as never);
  });

  const mockEvent = { sender: { id: 1 } } as never;

  it("throws a sanitized ValidationError without Zod detail for invalid set-config payloads", async () => {
    const handler = getInvokeHandler(CHANNELS.APP_AGENT_SET_CONFIG);

    await expect(handler(mockEvent, { model: 123 } as never)).rejects.toThrow(
      `IPC validation failed: ${CHANNELS.APP_AGENT_SET_CONFIG}`
    );
    expect(appAgentServiceMock.setConfig).not.toHaveBeenCalled();
  });

  it("does not leak Zod schema field names or values in the thrown message", async () => {
    const handler = getInvokeHandler(CHANNELS.APP_AGENT_SET_CONFIG);

    const rejection = await handler(mockEvent, { model: 123 } as never).then(
      () => null,
      (error: unknown) => error as Error
    );

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection?.message).toBe(`IPC validation failed: ${CHANNELS.APP_AGENT_SET_CONFIG}`);
    expect(rejection?.message).not.toContain("expected");
    expect(rejection?.message).not.toContain("received");
    expect(rejection?.message).not.toContain("123");
  });
});
