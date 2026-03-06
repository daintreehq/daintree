import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

const telemetryServiceMock = vi.hoisted(() => ({
  isTelemetryEnabled: vi.fn(() => false),
  setTelemetryEnabled: vi.fn(),
  hasTelemetryPromptBeenShown: vi.fn(() => false),
  markTelemetryPromptShown: vi.fn(),
}));

vi.mock("../../../services/TelemetryService.js", () => telemetryServiceMock);

import { registerTelemetryHandlers } from "../telemetry.js";

describe("registerTelemetryHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers all three IPC handlers", () => {
    const cleanup = registerTelemetryHandlers();
    expect(ipcMainMock.handle).toHaveBeenCalledTimes(3);
    cleanup();
  });

  it("returns cleanup that removes all handlers", () => {
    const cleanup = registerTelemetryHandlers();
    cleanup();
    expect(ipcMainMock.removeHandler).toHaveBeenCalledTimes(3);
  });

  it("TELEMETRY_GET handler returns enabled and hasSeenPrompt", async () => {
    telemetryServiceMock.isTelemetryEnabled.mockReturnValue(true);
    telemetryServiceMock.hasTelemetryPromptBeenShown.mockReturnValue(true);

    registerTelemetryHandlers();

    const [channel, handler] =
      ipcMainMock.handle.mock.calls.find(([ch]) => ch.includes("telemetry:get")) ?? [];
    expect(channel).toBe("telemetry:get");
    const result = await handler();
    expect(result).toEqual({ enabled: true, hasSeenPrompt: true });
  });

  it("TELEMETRY_SET_ENABLED handler sets value when boolean", async () => {
    registerTelemetryHandlers();

    const [, handler] =
      ipcMainMock.handle.mock.calls.find(([ch]) => ch.includes("telemetry:set-enabled")) ?? [];

    await handler(null, true);
    expect(telemetryServiceMock.setTelemetryEnabled).toHaveBeenCalledWith(true);
  });

  it("TELEMETRY_SET_ENABLED handler ignores non-boolean values", async () => {
    registerTelemetryHandlers();

    const [, handler] =
      ipcMainMock.handle.mock.calls.find(([ch]) => ch.includes("telemetry:set-enabled")) ?? [];

    await handler(null, "yes");
    expect(telemetryServiceMock.setTelemetryEnabled).not.toHaveBeenCalled();
  });

  it("TELEMETRY_MARK_PROMPT_SHOWN handler marks prompt shown", async () => {
    registerTelemetryHandlers();

    const [, handler] =
      ipcMainMock.handle.mock.calls.find(([ch]) => ch.includes("telemetry:mark-prompt-shown")) ??
      [];

    await handler();
    expect(telemetryServiceMock.markTelemetryPromptShown).toHaveBeenCalled();
  });
});
