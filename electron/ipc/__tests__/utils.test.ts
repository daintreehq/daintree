import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: class {},
}));

import { sendToRenderer, typedHandle, typedSend } from "../utils.js";

describe("ipc utils", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sendToRenderer sends when window and webContents are alive", () => {
    const send = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send,
      },
    } as unknown;

    sendToRenderer(win as never, "channel:test", { ok: true });
    expect(send).toHaveBeenCalledWith("channel:test", { ok: true });
  });

  it("sendToRenderer tolerates missing webContents without throwing", () => {
    const win = {
      isDestroyed: () => false,
    } as unknown;

    expect(() => sendToRenderer(win as never, "channel:test", { ok: true })).not.toThrow();
  });

  it("sendToRenderer tolerates webContents without isDestroyed function", () => {
    const send = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: {
        send,
      },
    } as unknown;

    expect(() => sendToRenderer(win as never, "channel:test", { ok: true })).not.toThrow();
    expect(send).toHaveBeenCalledWith("channel:test", { ok: true });
  });

  it("typedSend sends payload when window is alive", () => {
    const send = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send,
      },
    } as unknown;

    typedSend(win as never, "app:error" as never, { error: "x" } as never);
    expect(send).toHaveBeenCalledWith("app:error", { error: "x" });
  });

  it("typedSend tolerates missing webContents without throwing", () => {
    const win = {
      isDestroyed: () => false,
    } as unknown;

    expect(() =>
      typedSend(win as never, "app:error" as never, { error: "x" } as never)
    ).not.toThrow();
  });

  it("typedSend tolerates webContents without isDestroyed function", () => {
    const send = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: {
        send,
      },
    } as unknown;

    expect(() =>
      typedSend(win as never, "app:error" as never, { error: "x" } as never)
    ).not.toThrow();
    expect(send).toHaveBeenCalledWith("app:error", { error: "x" });
  });

  it("typedHandle registers handler and cleanup removes it", async () => {
    const handler = vi.fn(async (input: string) => ({ ok: input === "value" }));
    const cleanup = typedHandle("project:get:all" as never, handler as never);

    const [[channel, registered]] = ipcMainMock.handle.mock.calls as [
      [string, (...args: unknown[]) => Promise<unknown>],
    ];
    expect(channel).toBe("project:get:all");

    const result = await registered({} as unknown, "value");
    expect(result).toEqual({ ok: true });

    cleanup();
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("project:get:all");
  });
});
