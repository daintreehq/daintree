import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const serviceMock = vi.hoisted(() => ({
  getConfig: vi.fn(() => ({ enabled: true, thresholdMinutes: 30 })),
  updateConfig: vi.fn((patch: unknown) => ({
    enabled: true,
    thresholdMinutes: 30,
    ...(patch as object),
  })),
  closeProject: vi.fn().mockResolvedValue(undefined),
  dismissProject: vi.fn(),
}));

const getServiceMock = vi.hoisted(() => vi.fn(() => serviceMock));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));
vi.mock("../../../services/IdleTerminalNotificationService.js", () => ({
  getIdleTerminalNotificationService: getServiceMock,
}));

import { registerIdleTerminalHandlers } from "../idleTerminals.js";
import { CHANNELS } from "../../channels.js";
import type { HandlerDependencies } from "../../types.js";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): Handler {
  const fn = ipcHandlers.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  return fn as Handler;
}

function fakeEvent(): Electron.IpcMainInvokeEvent {
  return { sender: {} as Electron.WebContents } as Electron.IpcMainInvokeEvent;
}

describe("idleTerminals IPC adversarial", () => {
  let cleanup: () => void;

  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    serviceMock.updateConfig.mockImplementation((patch: unknown) => ({
      enabled: true,
      thresholdMinutes: 30,
      ...(patch as object),
    }));
    cleanup = registerIdleTerminalHandlers({} as HandlerDependencies);
  });

  afterEach(() => {
    cleanup();
  });

  it("updateConfig rejects null payload", async () => {
    await expect(
      getHandler(CHANNELS.IDLE_TERMINAL_UPDATE_CONFIG)(fakeEvent(), null)
    ).rejects.toThrow(/Invalid config/);
    expect(serviceMock.updateConfig).not.toHaveBeenCalled();
  });

  it("updateConfig rejects Array payloads", async () => {
    await expect(getHandler(CHANNELS.IDLE_TERMINAL_UPDATE_CONFIG)(fakeEvent(), [])).rejects.toThrow(
      /Invalid config/
    );
    expect(serviceMock.updateConfig).not.toHaveBeenCalled();
  });

  it("updateConfig rejects non-object payloads", async () => {
    await expect(
      getHandler(CHANNELS.IDLE_TERMINAL_UPDATE_CONFIG)(fakeEvent(), "str")
    ).rejects.toThrow(/Invalid config/);
    await expect(getHandler(CHANNELS.IDLE_TERMINAL_UPDATE_CONFIG)(fakeEvent(), 42)).rejects.toThrow(
      /Invalid config/
    );
  });

  it("updateConfig rejects non-boolean enabled", async () => {
    await expect(
      getHandler(CHANNELS.IDLE_TERMINAL_UPDATE_CONFIG)(fakeEvent(), { enabled: "yes" })
    ).rejects.toThrow(/enabled/);
  });

  it("updateConfig rejects NaN/Infinity thresholdMinutes", async () => {
    await expect(
      getHandler(CHANNELS.IDLE_TERMINAL_UPDATE_CONFIG)(fakeEvent(), {
        thresholdMinutes: Number.NaN,
      })
    ).rejects.toThrow(/finite/);
    await expect(
      getHandler(CHANNELS.IDLE_TERMINAL_UPDATE_CONFIG)(fakeEvent(), {
        thresholdMinutes: Number.POSITIVE_INFINITY,
      })
    ).rejects.toThrow(/finite/);
  });

  it("updateConfig accepts boundary thresholds (15 and 1440 exactly)", async () => {
    await getHandler(CHANNELS.IDLE_TERMINAL_UPDATE_CONFIG)(fakeEvent(), {
      thresholdMinutes: 15,
    });
    await getHandler(CHANNELS.IDLE_TERMINAL_UPDATE_CONFIG)(fakeEvent(), {
      thresholdMinutes: 1440,
    });
    expect(serviceMock.updateConfig).toHaveBeenCalledTimes(2);
  });

  it("updateConfig rejects thresholds just outside the boundary (14 and 1441)", async () => {
    await expect(
      getHandler(CHANNELS.IDLE_TERMINAL_UPDATE_CONFIG)(fakeEvent(), {
        thresholdMinutes: 14,
      })
    ).rejects.toThrow(/between 15 and 1440/);
    await expect(
      getHandler(CHANNELS.IDLE_TERMINAL_UPDATE_CONFIG)(fakeEvent(), {
        thresholdMinutes: 1441,
      })
    ).rejects.toThrow(/between 15 and 1440/);
  });

  it("closeProject rejects non-string and empty projectId", async () => {
    await expect(getHandler(CHANNELS.IDLE_TERMINAL_CLOSE_PROJECT)(fakeEvent(), 42)).rejects.toThrow(
      /projectId/
    );
    await expect(getHandler(CHANNELS.IDLE_TERMINAL_CLOSE_PROJECT)(fakeEvent(), "")).rejects.toThrow(
      /projectId/
    );
    expect(serviceMock.closeProject).not.toHaveBeenCalled();
  });

  it("closeProject rejects whitespace-only projectId", async () => {
    await expect(
      getHandler(CHANNELS.IDLE_TERMINAL_CLOSE_PROJECT)(fakeEvent(), "   ")
    ).rejects.toThrow(/projectId/);
    expect(serviceMock.closeProject).not.toHaveBeenCalled();
  });

  it("dismissProject rejects empty and whitespace-only projectId", async () => {
    await expect(
      getHandler(CHANNELS.IDLE_TERMINAL_DISMISS_PROJECT)(fakeEvent(), "")
    ).rejects.toThrow(/projectId/);
    await expect(
      getHandler(CHANNELS.IDLE_TERMINAL_DISMISS_PROJECT)(fakeEvent(), "  ")
    ).rejects.toThrow(/projectId/);
    expect(serviceMock.dismissProject).not.toHaveBeenCalled();
  });

  it("service errors propagate from updateConfig", async () => {
    serviceMock.updateConfig.mockImplementationOnce(() => {
      throw new Error("service down");
    });
    await expect(
      getHandler(CHANNELS.IDLE_TERMINAL_UPDATE_CONFIG)(fakeEvent(), { enabled: true })
    ).rejects.toThrow("service down");
  });

  it("cleanup removes all four handlers", () => {
    expect(ipcHandlers.size).toBe(4);
    cleanup();
    expect(ipcHandlers.size).toBe(0);
  });
});
