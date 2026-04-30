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

const shellMock = vi.hoisted(() => ({ showItemInFolder: vi.fn() }));
const sessionMock = vi.hoisted(() => ({
  defaultSession: {
    clearCache: vi.fn(() => Promise.resolve()),
    clearCodeCaches: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  app: appMock,
  shell: shellMock,
  session: sessionMock,
}));

const storeMock = vi.hoisted(() => ({
  get: vi.fn(() => undefined),
  set: vi.fn(),
}));

vi.mock("../../../store.js", () => ({ store: storeMock }));

const telemetryServiceMock = vi.hoisted(() => ({
  closeTelemetry: vi.fn(() => Promise.resolve()),
  getTelemetryLevel: vi.fn(() => "off" as "off" | "errors" | "full"),
  setTelemetryLevel: vi.fn(() => Promise.resolve()),
  hasTelemetryPromptBeenShown: vi.fn(() => false),
}));

vi.mock("../../../services/TelemetryService.js", () => telemetryServiceMock);

const utilsMock = vi.hoisted(() => ({
  typedBroadcast: vi.fn(),
  typedHandle: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
  typedHandleWithContext: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (...args: unknown[]) => {
      const event = args[0] as { sender?: { id?: number } } | null | undefined;
      const rest = args.slice(1);
      const ctx = {
        event: event as unknown,
        webContentsId: event?.sender?.id ?? 0,
        senderWindow: null,
        projectId: null,
      };
      return (handler as (...a: unknown[]) => unknown)(ctx, ...rest);
    });
    return () => ipcMainMock.removeHandler(channel);
  },
}));

vi.mock("../../utils.js", () => utilsMock);

import { registerPrivacyHandlers } from "../privacy.js";

describe("PRIVACY_RESET_ALL_DATA handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcMainMock._handlers.clear();
  });

  it("calls relaunch then awaits closeTelemetry before exit(0)", async () => {
    let resolveClose!: () => void;
    const deferred = new Promise<void>((r) => {
      resolveClose = r;
    });
    telemetryServiceMock.closeTelemetry.mockReturnValue(deferred);

    registerPrivacyHandlers();
    const handler = ipcMainMock._handlers.get("privacy:reset-all-data")!;
    expect(handler).toBeDefined();

    const handlerPromise = handler();

    // Let synchronous prefix run (relaunch + the closeTelemetry call itself).
    await Promise.resolve();
    await Promise.resolve();
    expect(appMock.relaunch).toHaveBeenCalled();
    expect(telemetryServiceMock.closeTelemetry).toHaveBeenCalled();
    // exit MUST NOT fire before closeTelemetry resolves.
    expect(appMock.exit).not.toHaveBeenCalled();

    resolveClose();
    await handlerPromise;

    expect(appMock.exit).toHaveBeenCalledWith(0);
  });

  it("calls relaunch with --reset-data arg", async () => {
    registerPrivacyHandlers();
    const handler = ipcMainMock._handlers.get("privacy:reset-all-data")!;

    await handler();

    expect(appMock.relaunch).toHaveBeenCalledWith({
      args: expect.arrayContaining(["--reset-data"]),
    });
  });
});

describe("registerPrivacyHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcMainMock._handlers.clear();
  });

  it("PRIVACY_SET_TELEMETRY_LEVEL broadcasts consent change on valid level", async () => {
    telemetryServiceMock.hasTelemetryPromptBeenShown.mockReturnValue(true);
    registerPrivacyHandlers();

    const handler = ipcMainMock._handlers.get("privacy:set-telemetry-level");
    expect(handler).toBeDefined();

    await handler!(null, "errors");

    expect(telemetryServiceMock.setTelemetryLevel).toHaveBeenCalledWith("errors");
    expect(utilsMock.typedBroadcast).toHaveBeenCalledWith("privacy:telemetry-consent-changed", {
      level: "errors",
      hasSeenPrompt: true,
    });
  });

  it("PRIVACY_SET_TELEMETRY_LEVEL ignores invalid values and does not broadcast", async () => {
    registerPrivacyHandlers();

    const handler = ipcMainMock._handlers.get("privacy:set-telemetry-level");
    expect(handler).toBeDefined();

    await handler!(null, "nonsense");
    await handler!(null, 42);

    expect(telemetryServiceMock.setTelemetryLevel).not.toHaveBeenCalled();
    expect(utilsMock.typedBroadcast).not.toHaveBeenCalled();
  });
});
