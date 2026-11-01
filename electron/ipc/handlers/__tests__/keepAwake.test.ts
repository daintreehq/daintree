import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const getPowerSaveBlockerServiceMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));
vi.mock("../../../services/PowerSaveBlockerService.js", () => ({
  getPowerSaveBlockerService: getPowerSaveBlockerServiceMock,
}));

import { registerKeepAwakeHandlers } from "../keepAwake.js";
import { CHANNELS } from "../../channels.js";
import type { HandlerDependencies } from "../../types.js";
import type { KeepAwakeConfig, KeepAwakeState } from "../../../../shared/types/ipc/keepAwake.js";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): Handler {
  const fn = ipcHandlers.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  return fn as Handler;
}

function fakeEvent(): Electron.IpcMainInvokeEvent {
  return { sender: {} as Electron.WebContents } as Electron.IpcMainInvokeEvent;
}

describe("keep-awake IPC", () => {
  let cleanup: () => void;
  let config: KeepAwakeConfig;
  let updateConfigSpy: ReturnType<typeof vi.fn>;

  const state = (): KeepAwakeState => ({
    config: { ...config },
    isBlocking: true,
    isDisplayBlocking: true,
    scheduledRunIds: ["run-1"],
    revision: 4,
  });

  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    config = { enabled: true, onBattery: false };
    updateConfigSpy = vi.fn((patch: Partial<KeepAwakeConfig>) => {
      Object.assign(config, patch);
      return state();
    });
    getPowerSaveBlockerServiceMock.mockReturnValue({
      getState: state,
      updateConfig: updateConfigSpy,
    });
    cleanup = registerKeepAwakeHandlers({} as HandlerDependencies);
  });

  afterEach(() => {
    cleanup();
  });

  it("rejects payloads that are not a plain object", async () => {
    const update = getHandler(CHANNELS.KEEP_AWAKE_UPDATE_CONFIG);
    for (const payload of [null, undefined, "on", 1, [true]]) {
      await expect(update(fakeEvent(), payload)).rejects.toThrow(/Invalid config/);
    }
    expect(updateConfigSpy).not.toHaveBeenCalled();
  });

  it("rejects values that are not booleans", async () => {
    const update = getHandler(CHANNELS.KEEP_AWAKE_UPDATE_CONFIG);
    await expect(update(fakeEvent(), { enabled: "false" })).rejects.toThrow(/enabled/);
    await expect(update(fakeEvent(), { onBattery: 1 })).rejects.toThrow(/onBattery/);
    expect(updateConfigSpy).not.toHaveBeenCalled();
  });

  it("rejects keys it does not know", async () => {
    await expect(
      getHandler(CHANNELS.KEEP_AWAKE_UPDATE_CONFIG)(fakeEvent(), { enabled: true, forever: true })
    ).rejects.toThrow(/forever/);
    expect(updateConfigSpy).not.toHaveBeenCalled();
  });

  it("passes on only the fields that were sent and returns the resulting state", async () => {
    const result = await getHandler(CHANNELS.KEEP_AWAKE_UPDATE_CONFIG)(fakeEvent(), {
      onBattery: true,
    });

    expect(updateConfigSpy).toHaveBeenCalledWith({ onBattery: true });
    expect(result).toEqual({
      config: { enabled: true, onBattery: true },
      isBlocking: true,
      isDisplayBlocking: true,
      scheduledRunIds: ["run-1"],
      revision: 4,
    });
  });

  it("resolves the service on each call rather than at registration", async () => {
    expect(getPowerSaveBlockerServiceMock).not.toHaveBeenCalled();

    await getHandler(CHANNELS.KEEP_AWAKE_GET_STATE)(fakeEvent());

    expect(getPowerSaveBlockerServiceMock).toHaveBeenCalledTimes(1);
  });
});
