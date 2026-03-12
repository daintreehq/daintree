import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

const telemetryServiceMock = vi.hoisted(() => ({
  isTelemetryEnabled: vi.fn(() => false),
  setTelemetryEnabled: vi.fn(() => Promise.resolve()),
  hasTelemetryPromptBeenShown: vi.fn(() => false),
  markTelemetryPromptShown: vi.fn(),
  trackEvent: vi.fn(),
}));

vi.mock("../../../services/TelemetryService.js", () => telemetryServiceMock);

import { registerTelemetryHandlers } from "../telemetry.js";

describe("registerTelemetryHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers all four IPC handlers", () => {
    const cleanup = registerTelemetryHandlers();
    expect(ipcMainMock.handle).toHaveBeenCalledTimes(4);
    cleanup();
  });

  it("returns cleanup that removes all handlers by channel name", () => {
    const cleanup = registerTelemetryHandlers();
    cleanup();
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("telemetry:get");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("telemetry:set-enabled");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("telemetry:mark-prompt-shown");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("telemetry:track");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledTimes(4);
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

  it("TELEMETRY_GET handler returns default false/false state", async () => {
    telemetryServiceMock.isTelemetryEnabled.mockReturnValue(false);
    telemetryServiceMock.hasTelemetryPromptBeenShown.mockReturnValue(false);

    registerTelemetryHandlers();

    const [, handler] =
      ipcMainMock.handle.mock.calls.find(([ch]) => ch.includes("telemetry:get")) ?? [];
    const result = await handler();
    expect(result).toEqual({ enabled: false, hasSeenPrompt: false });
  });

  it("TELEMETRY_GET handler returns mixed state (enabled=false, hasSeenPrompt=true)", async () => {
    telemetryServiceMock.isTelemetryEnabled.mockReturnValue(false);
    telemetryServiceMock.hasTelemetryPromptBeenShown.mockReturnValue(true);

    registerTelemetryHandlers();

    const [, handler] =
      ipcMainMock.handle.mock.calls.find(([ch]) => ch.includes("telemetry:get")) ?? [];
    const result = await handler();
    expect(result).toEqual({ enabled: false, hasSeenPrompt: true });
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

  it("TELEMETRY_TRACK handler dispatches valid event to service", async () => {
    registerTelemetryHandlers();

    const [, handler] =
      ipcMainMock.handle.mock.calls.find(([ch]) => ch.includes("telemetry:track")) ?? [];

    await handler(null, "onboarding_step_viewed", { step: "telemetry" });
    expect(telemetryServiceMock.trackEvent).toHaveBeenCalledWith("onboarding_step_viewed", {
      step: "telemetry",
    });
  });

  it("TELEMETRY_TRACK handler rejects unknown event names", async () => {
    registerTelemetryHandlers();

    const [, handler] =
      ipcMainMock.handle.mock.calls.find(([ch]) => ch.includes("telemetry:track")) ?? [];

    await handler(null, "malicious_event", { data: "bad" });
    expect(telemetryServiceMock.trackEvent).not.toHaveBeenCalled();
  });

  it("TELEMETRY_TRACK handler rejects non-object properties", async () => {
    registerTelemetryHandlers();

    const [, handler] =
      ipcMainMock.handle.mock.calls.find(([ch]) => ch.includes("telemetry:track")) ?? [];

    await handler(null, "onboarding_step_viewed", "not-an-object");
    expect(telemetryServiceMock.trackEvent).not.toHaveBeenCalled();
  });

  it("TELEMETRY_TRACK handler rejects array properties", async () => {
    registerTelemetryHandlers();

    const [, handler] =
      ipcMainMock.handle.mock.calls.find(([ch]) => ch.includes("telemetry:track")) ?? [];

    await handler(null, "onboarding_step_viewed", [1, 2, 3]);
    expect(telemetryServiceMock.trackEvent).not.toHaveBeenCalled();
  });
});
