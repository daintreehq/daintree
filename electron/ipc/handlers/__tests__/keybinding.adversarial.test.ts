import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => ({
  get: vi.fn<(key: string) => unknown>(),
  set: vi.fn<(key: string, value: unknown) => void>(),
}));

const dialogMock = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
  showOpenDialog: vi.fn(),
}));

const fsMock = vi.hoisted(() => ({
  readFile: vi.fn<(p: string, enc: string) => Promise<string>>(),
  writeFile: vi.fn<(p: string, data: string, enc: string) => Promise<void>>(),
}));

const profileIoMock = vi.hoisted(() => ({
  exportProfile: vi.fn<(overrides: Record<string, string[]>) => string>(),
  importProfile: vi.fn<(json: string) => unknown>(),
}));

const windowRegistryMock = vi.hoisted(() => ({
  getWindowForWebContents: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  dialog: dialogMock,
}));

vi.mock("node:fs", () => ({
  promises: fsMock,
}));

vi.mock("../../../store.js", () => ({ store: storeMock }));
vi.mock("../../../utils/keybindingProfileIO.js", () => profileIoMock);
vi.mock("../../../window/webContentsRegistry.js", () => windowRegistryMock);

import { ipcMain } from "electron";
import { registerKeybindingHandlers } from "../keybinding.js";
import { CHANNELS } from "../../channels.js";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): Handler {
  const calls = vi.mocked(ipcMain.handle).mock.calls;
  const match = calls.find(([ch]) => ch === channel);
  if (!match) throw new Error(`handler not registered: ${channel}`);
  return match[1] as Handler;
}

function fakeEvent(): Electron.IpcMainInvokeEvent {
  return {
    sender: {} as Electron.WebContents,
  } as Electron.IpcMainInvokeEvent;
}

describe("keybinding handlers adversarial", () => {
  let cleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    profileIoMock.exportProfile.mockImplementation((o) => JSON.stringify(o));
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.readFile.mockResolvedValue("{}");
    windowRegistryMock.getWindowForWebContents.mockReturnValue(null);
    cleanup = registerKeybindingHandlers({} as never);
  });

  afterEach(() => {
    cleanup();
  });

  it("getOverrides filters out corrupt values from a polluted store", async () => {
    storeMock.get.mockReturnValue({
      "action.a": ["Cmd+A"],
      "action.b": [],
      "action.c": ["", "Cmd+C"],
      "action.d": "not-an-array",
      "action.e": [42, "Cmd+E"],
      "action.f": [{ nested: true }],
    });

    const handler = getHandler(CHANNELS.KEYBINDING_GET_OVERRIDES);
    const result = await handler(fakeEvent());

    expect(result).toEqual({ "action.a": ["Cmd+A"], "action.b": [] });
  });

  it("getOverrides returns {} for non-object or array store values", async () => {
    const handler = getHandler(CHANNELS.KEYBINDING_GET_OVERRIDES);

    storeMock.get.mockReturnValue(null);
    expect(await handler(fakeEvent())).toEqual({});

    storeMock.get.mockReturnValue(["not", "an", "object"]);
    expect(await handler(fakeEvent())).toEqual({});

    storeMock.get.mockReturnValue("string");
    expect(await handler(fakeEvent())).toEqual({});
  });

  it("setOverride persists sanitized existing entries plus the new override, dropping invalid keys", async () => {
    storeMock.get.mockReturnValue({
      "valid.existing": ["Cmd+V"],
      "invalid.existing": ["", "   "],
      "bad.type": "oops",
    });

    const handler = getHandler(CHANNELS.KEYBINDING_SET_OVERRIDE);
    await handler(fakeEvent(), { actionId: "new.action", combo: ["Cmd+N"] });

    expect(storeMock.set).toHaveBeenCalledWith("keybindingOverrides.overrides", {
      "valid.existing": ["Cmd+V"],
      "new.action": ["Cmd+N"],
    });
  });

  it("setOverride rejects non-object payloads", async () => {
    const handler = getHandler(CHANNELS.KEYBINDING_SET_OVERRIDE);

    await expect(handler(fakeEvent(), null)).rejects.toThrow(/Invalid keybinding override/);
    await expect(handler(fakeEvent(), "string")).rejects.toThrow(/Invalid keybinding override/);
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("setOverride rejects combos containing empty strings or non-strings", async () => {
    storeMock.get.mockReturnValue({});
    const handler = getHandler(CHANNELS.KEYBINDING_SET_OVERRIDE);

    await expect(
      handler(fakeEvent(), { actionId: "a", combo: ["Cmd+A", "", "Cmd+B"] })
    ).rejects.toThrow(/empty values/);
    await expect(
      handler(fakeEvent(), { actionId: "a", combo: [42 as unknown as string] })
    ).rejects.toThrow(/non-string/);
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("setOverride accepts an empty combo array (treated as deliberate unbind)", async () => {
    storeMock.get.mockReturnValue({});
    const handler = getHandler(CHANNELS.KEYBINDING_SET_OVERRIDE);

    await handler(fakeEvent(), { actionId: "a", combo: [] });

    expect(storeMock.set).toHaveBeenCalledWith("keybindingOverrides.overrides", { a: [] });
  });

  it("removeOverride drops the key and re-sanitizes siblings", async () => {
    storeMock.get.mockReturnValue({
      keep: ["Cmd+K"],
      drop: ["Cmd+D"],
      broken: ["", ""],
    });
    const handler = getHandler(CHANNELS.KEYBINDING_REMOVE_OVERRIDE);

    await handler(fakeEvent(), "drop");

    expect(storeMock.set).toHaveBeenCalledWith("keybindingOverrides.overrides", {
      keep: ["Cmd+K"],
    });
  });

  it("export cancelled dialog returns false without writing to disk", async () => {
    dialogMock.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });
    storeMock.get.mockReturnValue({});
    const handler = getHandler(CHANNELS.KEYBINDING_EXPORT_PROFILE);

    const result = await handler(fakeEvent());

    expect(result).toBe(false);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("export uses parent window when available for the save dialog", async () => {
    const window = {} as Electron.BrowserWindow;
    windowRegistryMock.getWindowForWebContents.mockReturnValue(window);
    dialogMock.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: "/tmp/profile.json",
    });
    storeMock.get.mockReturnValue({ a: ["Cmd+A"] });
    const handler = getHandler(CHANNELS.KEYBINDING_EXPORT_PROFILE);

    await handler(fakeEvent());

    expect(dialogMock.showSaveDialog).toHaveBeenCalledWith(window, expect.any(Object));
    expect(fsMock.writeFile).toHaveBeenCalledWith("/tmp/profile.json", expect.any(String), "utf-8");
  });

  it("import cancelled is side-effect free", async () => {
    dialogMock.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const handler = getHandler(CHANNELS.KEYBINDING_IMPORT_PROFILE);

    const result = await handler(fakeEvent());

    expect(result).toMatchObject({ ok: false, errors: ["Cancelled"] });
    expect(fsMock.readFile).not.toHaveBeenCalled();
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("import readFile error rejects and does not mutate store", async () => {
    dialogMock.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["/tmp/x.json"],
    });
    fsMock.readFile.mockRejectedValue(new Error("EACCES"));
    const handler = getHandler(CHANNELS.KEYBINDING_IMPORT_PROFILE);

    await expect(handler(fakeEvent())).rejects.toThrow("EACCES");
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("import success merges with sanitized existing overrides only", async () => {
    dialogMock.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["/tmp/x.json"],
    });
    fsMock.readFile.mockResolvedValue('{"action.imported":["Cmd+I"]}');
    profileIoMock.importProfile.mockReturnValue({
      ok: true,
      overrides: { "action.imported": ["Cmd+I"] },
      applied: 1,
      skipped: 0,
      errors: [],
    });
    storeMock.get.mockReturnValue({
      "action.existing.valid": ["Cmd+E"],
      "action.existing.bad": ["", ""],
    });
    const handler = getHandler(CHANNELS.KEYBINDING_IMPORT_PROFILE);

    await handler(fakeEvent());

    expect(storeMock.set).toHaveBeenCalledWith("keybindingOverrides.overrides", {
      "action.existing.valid": ["Cmd+E"],
      "action.imported": ["Cmd+I"],
    });
  });

  it("import failure does not mutate the store even when dialog and readFile succeed", async () => {
    dialogMock.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["/tmp/x.json"],
    });
    fsMock.readFile.mockResolvedValue("{}");
    profileIoMock.importProfile.mockReturnValue({
      ok: false,
      overrides: {},
      applied: 0,
      skipped: 0,
      errors: ["schema invalid"],
    });
    storeMock.get.mockReturnValue({});
    const handler = getHandler(CHANNELS.KEYBINDING_IMPORT_PROFILE);

    const result = await handler(fakeEvent());

    expect(storeMock.set).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, errors: ["schema invalid"] });
  });
});
