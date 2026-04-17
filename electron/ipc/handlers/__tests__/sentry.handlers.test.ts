import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

const telemetryServiceMock = vi.hoisted(() => ({
  getTelemetryLevel: vi.fn(() => "off" as "off" | "errors" | "full"),
  hasTelemetryPromptBeenShown: vi.fn(() => false),
}));

vi.mock("../../../services/TelemetryService.js", () => telemetryServiceMock);

import { registerSentryHandlers } from "../sentry.js";

describe("registerSentryHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the consent-state handler", () => {
    const cleanup = registerSentryHandlers();
    expect(ipcMainMock.handle).toHaveBeenCalledTimes(1);
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "sentry:get-consent-state",
      expect.any(Function)
    );
    cleanup();
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("sentry:get-consent-state");
  });

  it("returns { level, hasSeenPrompt } from TelemetryService", async () => {
    telemetryServiceMock.getTelemetryLevel.mockReturnValue("errors");
    telemetryServiceMock.hasTelemetryPromptBeenShown.mockReturnValue(true);

    registerSentryHandlers();
    const [, handler] = ipcMainMock.handle.mock.calls[0];
    const result = await handler();

    expect(result).toEqual({ level: "errors", hasSeenPrompt: true });
  });

  it("reflects off/not-prompted defaults", async () => {
    telemetryServiceMock.getTelemetryLevel.mockReturnValue("off");
    telemetryServiceMock.hasTelemetryPromptBeenShown.mockReturnValue(false);

    registerSentryHandlers();
    const [, handler] = ipcMainMock.handle.mock.calls[0];
    const result = await handler();

    expect(result).toEqual({ level: "off", hasSeenPrompt: false });
  });
});
