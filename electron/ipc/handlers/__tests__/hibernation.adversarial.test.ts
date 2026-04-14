import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const getHibernationServiceMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));
vi.mock("../../../services/HibernationService.js", () => ({
  getHibernationService: getHibernationServiceMock,
}));

import { registerHibernationHandlers } from "../hibernation.js";
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

describe("hibernation IPC adversarial", () => {
  let cleanup: () => void;
  let serviceState: { enabled: boolean; inactiveThresholdHours: number };
  let updateConfigSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    serviceState = { enabled: true, inactiveThresholdHours: 24 };
    updateConfigSpy = vi.fn((patch: Partial<typeof serviceState>) => {
      Object.assign(serviceState, patch);
    });
    getHibernationServiceMock.mockReturnValue({
      getConfig: () => ({ ...serviceState }),
      updateConfig: updateConfigSpy,
    });
    cleanup = registerHibernationHandlers({} as HandlerDependencies);
  });

  afterEach(() => {
    cleanup();
  });

  it("updateConfig rejects null payload", async () => {
    await expect(getHandler(CHANNELS.HIBERNATION_UPDATE_CONFIG)(fakeEvent(), null)).rejects.toThrow(
      /Invalid config/
    );
    expect(updateConfigSpy).not.toHaveBeenCalled();
  });

  it("updateConfig rejects non-object payloads (string, number)", async () => {
    await expect(
      getHandler(CHANNELS.HIBERNATION_UPDATE_CONFIG)(fakeEvent(), "string")
    ).rejects.toThrow(/Invalid config/);
    await expect(getHandler(CHANNELS.HIBERNATION_UPDATE_CONFIG)(fakeEvent(), 42)).rejects.toThrow(
      /Invalid config/
    );
    expect(updateConfigSpy).not.toHaveBeenCalled();
  });

  it("updateConfig rejects non-boolean enabled", async () => {
    await expect(
      getHandler(CHANNELS.HIBERNATION_UPDATE_CONFIG)(fakeEvent(), { enabled: "yes" })
    ).rejects.toThrow(/enabled/);
    await expect(
      getHandler(CHANNELS.HIBERNATION_UPDATE_CONFIG)(fakeEvent(), { enabled: 1 })
    ).rejects.toThrow(/enabled/);
  });

  it("updateConfig rejects non-number inactiveThresholdHours", async () => {
    await expect(
      getHandler(CHANNELS.HIBERNATION_UPDATE_CONFIG)(fakeEvent(), {
        inactiveThresholdHours: "24",
      })
    ).rejects.toThrow(/inactiveThresholdHours/);
  });

  it("updateConfig rejects NaN/Infinity inactiveThresholdHours", async () => {
    await expect(
      getHandler(CHANNELS.HIBERNATION_UPDATE_CONFIG)(fakeEvent(), {
        inactiveThresholdHours: Number.NaN,
      })
    ).rejects.toThrow(/finite/);
    await expect(
      getHandler(CHANNELS.HIBERNATION_UPDATE_CONFIG)(fakeEvent(), {
        inactiveThresholdHours: Number.POSITIVE_INFINITY,
      })
    ).rejects.toThrow(/finite/);
  });

  it("updateConfig rejects out-of-range inactiveThresholdHours (0 and 169)", async () => {
    await expect(
      getHandler(CHANNELS.HIBERNATION_UPDATE_CONFIG)(fakeEvent(), {
        inactiveThresholdHours: 0,
      })
    ).rejects.toThrow(/between 1 and 168/);
    await expect(
      getHandler(CHANNELS.HIBERNATION_UPDATE_CONFIG)(fakeEvent(), {
        inactiveThresholdHours: 169,
      })
    ).rejects.toThrow(/between 1 and 168/);
  });

  it("updateConfig accepts boundary values 1 and 168", async () => {
    await getHandler(CHANNELS.HIBERNATION_UPDATE_CONFIG)(fakeEvent(), {
      inactiveThresholdHours: 1,
    });
    await getHandler(CHANNELS.HIBERNATION_UPDATE_CONFIG)(fakeEvent(), {
      inactiveThresholdHours: 168,
    });

    expect(updateConfigSpy).toHaveBeenCalledTimes(2);
  });

  it("updateConfig accepts a valid partial config and returns post-mutation state", async () => {
    const result = (await getHandler(CHANNELS.HIBERNATION_UPDATE_CONFIG)(fakeEvent(), {
      enabled: false,
    })) as { enabled: boolean; inactiveThresholdHours: number };

    expect(result.enabled).toBe(false);
    expect(updateConfigSpy).toHaveBeenCalledWith({ enabled: false });
  });

  it("updateConfig service throw propagates cleanly and handler remains registered", async () => {
    updateConfigSpy.mockImplementationOnce(() => {
      throw new Error("service unavailable");
    });

    await expect(
      getHandler(CHANNELS.HIBERNATION_UPDATE_CONFIG)(fakeEvent(), { enabled: true })
    ).rejects.toThrow("service unavailable");

    // Handler still works on next call
    await getHandler(CHANNELS.HIBERNATION_UPDATE_CONFIG)(fakeEvent(), { enabled: false });
    expect(updateConfigSpy).toHaveBeenCalledTimes(2);
  });

  it("getConfig returns a snapshot of the current service config", async () => {
    const result = await getHandler(CHANNELS.HIBERNATION_GET_CONFIG)(fakeEvent());
    expect(result).toEqual({ enabled: true, inactiveThresholdHours: 24 });
  });

  it("cleanup removes both handlers", () => {
    expect(ipcHandlers.size).toBe(2);
    cleanup();
    expect(ipcHandlers.size).toBe(0);
  });

  it("updateConfig rejects Array payloads", async () => {
    await expect(getHandler(CHANNELS.HIBERNATION_UPDATE_CONFIG)(fakeEvent(), [])).rejects.toThrow(
      /Invalid config/
    );
    expect(updateConfigSpy).not.toHaveBeenCalled();
  });
});
