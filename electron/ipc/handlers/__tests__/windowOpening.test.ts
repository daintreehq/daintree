import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const storeData = vi.hoisted(() => new Map<string, unknown>());
const storeMock = vi.hoisted(() => ({
  get: vi.fn((key: string) => storeData.get(key)),
  set: vi.fn((key: string, value: unknown) => {
    storeData.set(key, value);
  }),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));
vi.mock("../../../store.js", () => ({ store: storeMock }));

import { registerWindowOpeningHandlers } from "../windowOpening.js";
import {
  buildWindowOpeningPreloadBindings,
  WINDOW_OPENING_METHOD_CHANNELS,
} from "../windowOpening.preload.js";
import { readWindowOpeningConfig } from "../../../window/windowOpeningConfig.js";
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

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return getHandler(channel)(fakeEvent(), ...args);
}

describe("readWindowOpeningConfig", () => {
  beforeEach(() => {
    storeData.clear();
    vi.clearAllMocks();
  });

  it.each(["default", "on", "off"] as const)("returns a stored %s as-is", (mode) => {
    storeData.set("windowOpening", { openFoldersInNewWindow: mode });
    expect(readWindowOpeningConfig()).toEqual({ openFoldersInNewWindow: mode });
  });

  it.each([
    ["an absent slice", undefined],
    ["a null slice", null],
    ["a non-object slice", "on"],
    ["an unknown mode", { openFoldersInNewWindow: "sometimes" }],
    ["a wrongly typed mode", { openFoldersInNewWindow: true }],
    ["a missing mode", {}],
  ])("reads %s as the default", (_label, stored) => {
    storeData.set("windowOpening", stored);
    expect(readWindowOpeningConfig()).toEqual({ openFoldersInNewWindow: "default" });
  });

  it("never writes while reading", () => {
    storeData.set("windowOpening", { openFoldersInNewWindow: "sometimes" });
    readWindowOpeningConfig();
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("sees a change made after an earlier read", () => {
    storeData.set("windowOpening", { openFoldersInNewWindow: "on" });
    expect(readWindowOpeningConfig().openFoldersInNewWindow).toBe("on");
    storeData.set("windowOpening", { openFoldersInNewWindow: "off" });
    expect(readWindowOpeningConfig().openFoldersInNewWindow).toBe("off");
  });
});

describe("windowOpening IPC", () => {
  let cleanup: () => void;

  beforeEach(() => {
    ipcHandlers.clear();
    storeData.clear();
    vi.clearAllMocks();
    cleanup = registerWindowOpeningHandlers({} as HandlerDependencies);
  });

  afterEach(() => {
    cleanup();
  });

  it("declares its channels in CHANNELS", () => {
    expect(WINDOW_OPENING_METHOD_CHANNELS.getConfig).toBe(CHANNELS.WINDOW_OPENING_GET_CONFIG);
    expect(WINDOW_OPENING_METHOD_CHANNELS.updateConfig).toBe(CHANNELS.WINDOW_OPENING_UPDATE_CONFIG);
  });

  it("removes its handlers on cleanup", () => {
    cleanup();
    expect(ipcHandlers.has(CHANNELS.WINDOW_OPENING_GET_CONFIG)).toBe(false);
    expect(ipcHandlers.has(CHANNELS.WINDOW_OPENING_UPDATE_CONFIG)).toBe(false);
    cleanup = registerWindowOpeningHandlers({} as HandlerDependencies);
  });

  it("getConfig reads the default from a store that predates the key", async () => {
    await expect(invoke(CHANNELS.WINDOW_OPENING_GET_CONFIG)).resolves.toEqual({
      openFoldersInNewWindow: "default",
    });
  });

  it.each(["default", "on", "off"] as const)("updateConfig persists %s", async (mode) => {
    await expect(
      invoke(CHANNELS.WINDOW_OPENING_UPDATE_CONFIG, { openFoldersInNewWindow: mode })
    ).resolves.toEqual({ openFoldersInNewWindow: mode });
    expect(storeMock.set).toHaveBeenCalledWith("windowOpening", { openFoldersInNewWindow: mode });
    await expect(invoke(CHANNELS.WINDOW_OPENING_GET_CONFIG)).resolves.toEqual({
      openFoldersInNewWindow: mode,
    });
  });

  it.each([
    ["an empty patch", {}],
    ["an explicitly undefined mode", { openFoldersInNewWindow: undefined }],
  ])("updateConfig treats %s as a no-op", async (_label, patch) => {
    storeData.set("windowOpening", { openFoldersInNewWindow: "off" });
    await expect(invoke(CHANNELS.WINDOW_OPENING_UPDATE_CONFIG, patch)).resolves.toEqual({
      openFoldersInNewWindow: "off",
    });
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "on"],
  ])("updateConfig rejects %s without writing", async (_label, payload) => {
    await expect(invoke(CHANNELS.WINDOW_OPENING_UPDATE_CONFIG, payload)).rejects.toThrow(
      /Invalid config object/
    );
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown mode", "sometimes"],
    ["a boolean", true],
    ["a differently cased mode", "On"],
  ])("updateConfig rejects %s without writing", async (_label, mode) => {
    await expect(
      invoke(CHANNELS.WINDOW_OPENING_UPDATE_CONFIG, { openFoldersInNewWindow: mode })
    ).rejects.toThrow(/openFoldersInNewWindow must be one of: default, on, off/);
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("updateConfig rejects keys it does not know, so a misspelt field isn't a silent no-op", async () => {
    await expect(
      invoke(CHANNELS.WINDOW_OPENING_UPDATE_CONFIG, { openFolderInNewWindow: "on" })
    ).rejects.toThrow(/Unknown window opening setting: openFolderInNewWindow/);
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("updateConfig repairs a hand-edited slice rather than carrying it forward", async () => {
    storeData.set("windowOpening", "garbage");
    await expect(
      invoke(CHANNELS.WINDOW_OPENING_UPDATE_CONFIG, { openFoldersInNewWindow: "off" })
    ).resolves.toEqual({ openFoldersInNewWindow: "off" });
    expect(storeData.get("windowOpening")).toEqual({ openFoldersInNewWindow: "off" });
  });

  it("updateConfig surfaces a store write failure", async () => {
    storeMock.set.mockImplementationOnce(() => {
      throw new Error("EACCES: permission denied");
    });
    await expect(
      invoke(CHANNELS.WINDOW_OPENING_UPDATE_CONFIG, { openFoldersInNewWindow: "on" })
    ).rejects.toThrow(/EACCES/);
  });

  it("preload bindings forward each method to its channel", async () => {
    const invokeMock = vi.fn(() => Promise.resolve({ openFoldersInNewWindow: "on" }));
    const bindings = buildWindowOpeningPreloadBindings(invokeMock);
    await bindings.getConfig();
    await bindings.updateConfig({ openFoldersInNewWindow: "on" });
    expect(invokeMock).toHaveBeenNthCalledWith(1, CHANNELS.WINDOW_OPENING_GET_CONFIG);
    expect(invokeMock).toHaveBeenNthCalledWith(2, CHANNELS.WINDOW_OPENING_UPDATE_CONFIG, {
      openFoldersInNewWindow: "on",
    });
  });
});
