import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const commandServiceMock = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue([]),
  getManifest: vi.fn().mockResolvedValue(null),
  execute: vi.fn().mockResolvedValue({ success: true }),
  getBuilder: vi.fn().mockReturnValue(null),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));
vi.mock("../../../services/CommandService.js", () => ({
  commandService: commandServiceMock,
}));

import { registerCommandHandlers } from "../commands.js";
import { CHANNELS } from "../../channels.js";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): Handler {
  const fn = ipcHandlers.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  return fn as Handler;
}

function fakeEvent(): Electron.IpcMainInvokeEvent {
  return { sender: {} as Electron.WebContents } as Electron.IpcMainInvokeEvent;
}

describe("commands IPC adversarial", () => {
  let cleanup: () => void;

  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    cleanup = registerCommandHandlers();
  });

  afterEach(() => {
    cleanup();
  });

  it("commands:execute rejects null payload", async () => {
    await expect(getHandler(CHANNELS.COMMANDS_EXECUTE)(fakeEvent(), null)).rejects.toMatchObject({
      name: "AppError",
      code: "VALIDATION",
      message: expect.stringMatching(/Invalid command execution payload/),
    });
    expect(commandServiceMock.execute).not.toHaveBeenCalled();
  });

  it("commands:execute rejects payload without commandId", async () => {
    await expect(getHandler(CHANNELS.COMMANDS_EXECUTE)(fakeEvent(), {})).rejects.toMatchObject({
      name: "AppError",
      code: "VALIDATION",
    });
  });

  it("commands:execute rejects non-string commandId", async () => {
    await expect(
      getHandler(CHANNELS.COMMANDS_EXECUTE)(fakeEvent(), { commandId: 42 })
    ).rejects.toMatchObject({ name: "AppError", code: "VALIDATION" });
  });

  it("commands:execute rejects array context", async () => {
    await expect(
      getHandler(CHANNELS.COMMANDS_EXECUTE)(fakeEvent(), { commandId: "x", context: [] })
    ).rejects.toMatchObject({
      name: "AppError",
      code: "VALIDATION",
      message: expect.stringMatching(/plain object/),
    });
  });

  it("commands:execute rejects array args", async () => {
    await expect(
      getHandler(CHANNELS.COMMANDS_EXECUTE)(fakeEvent(), { commandId: "x", args: [] })
    ).rejects.toMatchObject({
      name: "AppError",
      code: "VALIDATION",
      message: expect.stringMatching(/plain object/),
    });
  });

  it("commands:execute treats absent context and args as empty plain objects", async () => {
    commandServiceMock.execute.mockResolvedValue({ success: true });

    await getHandler(CHANNELS.COMMANDS_EXECUTE)(fakeEvent(), { commandId: "x" });

    expect(commandServiceMock.execute).toHaveBeenCalledWith("x", {}, {});
  });

  it("commands:execute treats null args as empty object", async () => {
    commandServiceMock.execute.mockResolvedValue({ success: true });

    await getHandler(CHANNELS.COMMANDS_EXECUTE)(fakeEvent(), {
      commandId: "x",
      args: null,
    });

    expect(commandServiceMock.execute).toHaveBeenCalledWith("x", {}, {});
  });

  it("commands:get returns null for malformed payload without calling service", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await getHandler(CHANNELS.COMMANDS_GET)(fakeEvent(), { foo: "bar" });
    expect(result).toBeNull();
    expect(commandServiceMock.getManifest).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("commands:get returns null when payload is null", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await getHandler(CHANNELS.COMMANDS_GET)(fakeEvent(), null);
    expect(result).toBeNull();
    warn.mockRestore();
  });

  it("commands:getBuilder returns null for non-string id without calling service", async () => {
    const result = await getHandler(CHANNELS.COMMANDS_GET_BUILDER)(fakeEvent(), 42);
    expect(result).toBeNull();
    expect(commandServiceMock.getBuilder).not.toHaveBeenCalled();
  });

  it("cleanup unregisters all four command handlers", () => {
    expect(ipcHandlers.size).toBe(4);
    cleanup();
    expect(ipcHandlers.size).toBe(0);
  });

  it("commands:list forwards optional context unchanged", async () => {
    const ctx = { projectId: "p1" };
    await getHandler(CHANNELS.COMMANDS_LIST)(fakeEvent(), ctx);
    expect(commandServiceMock.list).toHaveBeenCalledWith(ctx);
  });
});
