import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

const telemetryServiceMock = vi.hoisted(() => ({
  isTelemetryEnabled: vi.fn(() => false),
  setTelemetryEnabled: vi.fn(() => Promise.resolve()),
  hasTelemetryPromptBeenShown: vi.fn(() => false),
  markTelemetryPromptShown: vi.fn(),
  getTelemetryLevel: vi.fn(() => "off" as "off" | "errors" | "full"),
  trackEvent: vi.fn(),
}));

vi.mock("../../../services/TelemetryService.js", () => telemetryServiceMock);

const broadcasterMock = vi.hoisted(() => {
  // Mirror real module behavior: the active flag is module-level, so
  // setTelemetryPreviewActive must be observable via isTelemetryPreviewActive
  // for the toggle handler's broadcast-state-changed path to assert correctly.
  const state = { active: false };
  return {
    _state: state,
    isTelemetryPreviewActive: vi.fn(() => state.active),
    setTelemetryPreviewActive: vi.fn((next: boolean) => {
      state.active = next;
    }),
    setTelemetryPreviewEnqueue: vi.fn(),
  };
});

vi.mock("../../../services/TelemetryPreviewBroadcaster.js", () => broadcasterMock);

const utilsMock = vi.hoisted(() => ({
  typedBroadcast: vi.fn(),
  typedHandle: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
  typedHandleWithContext: (channel: string, handler: unknown) => {
    ipcMainMock.handle(
      channel,
      (event: { sender?: { id?: number } } | null | undefined, ...args: unknown[]) => {
        const ctx = {
          event: event as unknown,
          webContentsId: event?.sender?.id ?? 0,
          senderWindow: null,
          projectId: null,
        };
        return (handler as (...a: unknown[]) => unknown)(ctx, ...args);
      }
    );
    return () => ipcMainMock.removeHandler(channel);
  },
}));

vi.mock("../../utils.js", () => utilsMock);

import { registerTelemetryHandlers } from "../telemetry.js";

describe("registerTelemetryHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    broadcasterMock._state.active = false;
  });

  it("registers all invoke + subscribe IPC handlers", () => {
    const cleanup = registerTelemetryHandlers();
    // 4 pre-existing handlers + 2 new preview invoke handlers (get-state, toggle)
    expect(ipcMainMock.handle).toHaveBeenCalledTimes(6);
    // 2 new preview subscribe/unsubscribe listeners via ipcMain.on
    expect(ipcMainMock.on).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("returns cleanup that removes all handlers by channel name", () => {
    const cleanup = registerTelemetryHandlers();
    cleanup();
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("telemetry:get");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("telemetry:set-enabled");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("telemetry:mark-prompt-shown");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("telemetry:track");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("telemetry:preview-get-state");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("telemetry:preview-toggle");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledTimes(6);
    expect(ipcMainMock.removeListener).toHaveBeenCalledWith(
      "telemetry:preview-subscribe",
      expect.any(Function)
    );
    expect(ipcMainMock.removeListener).toHaveBeenCalledWith(
      "telemetry:preview-unsubscribe",
      expect.any(Function)
    );
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

  it("TELEMETRY_SET_ENABLED handler broadcasts consent change on valid boolean", async () => {
    telemetryServiceMock.getTelemetryLevel.mockReturnValue("errors");
    telemetryServiceMock.hasTelemetryPromptBeenShown.mockReturnValue(true);
    registerTelemetryHandlers();

    const [, handler] =
      ipcMainMock.handle.mock.calls.find(([ch]) => ch.includes("telemetry:set-enabled")) ?? [];

    await handler(null, true);
    expect(utilsMock.typedBroadcast).toHaveBeenCalledWith("privacy:telemetry-consent-changed", {
      level: "errors",
      hasSeenPrompt: true,
    });
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

  it("TELEMETRY_MARK_PROMPT_SHOWN broadcasts the updated consent", async () => {
    telemetryServiceMock.getTelemetryLevel.mockReturnValue("errors");
    registerTelemetryHandlers();

    const [, handler] =
      ipcMainMock.handle.mock.calls.find(([ch]) => ch.includes("telemetry:mark-prompt-shown")) ??
      [];

    await handler();
    expect(utilsMock.typedBroadcast).toHaveBeenCalledWith("privacy:telemetry-consent-changed", {
      level: "errors",
      hasSeenPrompt: true,
    });
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

  it("TELEMETRY_PREVIEW_GET_STATE returns the current active flag", async () => {
    broadcasterMock._state.active = true;
    registerTelemetryHandlers();

    const [, handler] =
      ipcMainMock.handle.mock.calls.find(([ch]) => ch === "telemetry:preview-get-state") ?? [];

    const result = await handler();
    expect(result).toEqual({ active: true });
  });

  it("TELEMETRY_PREVIEW_TOGGLE flips state and broadcasts the change on boolean input", async () => {
    broadcasterMock._state.active = false;
    registerTelemetryHandlers();

    const [, handler] =
      ipcMainMock.handle.mock.calls.find(([ch]) => ch === "telemetry:preview-toggle") ?? [];

    const result = await handler(null, true);
    expect(broadcasterMock.setTelemetryPreviewActive).toHaveBeenCalledWith(true);
    expect(result).toEqual({ active: true });
    expect(utilsMock.typedBroadcast).toHaveBeenCalledWith("telemetry:preview-state-changed", {
      active: true,
    });
  });

  it("TELEMETRY_PREVIEW_TOGGLE ignores non-boolean values and does not broadcast", async () => {
    broadcasterMock._state.active = false;
    registerTelemetryHandlers();

    const [, handler] =
      ipcMainMock.handle.mock.calls.find(([ch]) => ch === "telemetry:preview-toggle") ?? [];

    const result = await handler(null, "true");
    expect(broadcasterMock.setTelemetryPreviewActive).not.toHaveBeenCalled();
    expect(result).toEqual({ active: false });
    expect(utilsMock.typedBroadcast).not.toHaveBeenCalled();
  });
});
