import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clipboardMock = vi.hoisted(() => ({
  writeImage: vi.fn(),
  readImage: vi.fn(),
}));

const nativeImageMock = vi.hoisted(() => ({
  createFromBuffer: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  clipboard: clipboardMock,
  nativeImage: nativeImageMock,
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(() => Promise.resolve()),
  readdir: vi.fn(() => Promise.resolve([])),
  stat: vi.fn(),
  unlink: vi.fn(),
  writeFile: vi.fn(() => Promise.resolve()),
}));

vi.mock("node:crypto", () => ({
  randomBytes: vi.fn(() => ({ toString: () => "abc123" })),
}));

import { ipcMain } from "electron";
import { registerClipboardHandlers } from "../clipboard.js";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): Handler {
  const calls = vi.mocked(ipcMain.handle).mock.calls;
  const match = calls.find(([ch]) => ch === channel);
  if (!match) throw new Error(`No handler registered for ${channel}`);
  return match[1] as Handler;
}

const fakeEvent = {} as Electron.IpcMainInvokeEvent;

describe("clipboard:write-image handler", () => {
  let cleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup = registerClipboardHandlers();
  });

  afterEach(() => {
    cleanup();
  });

  it("registers the clipboard:write-image handler", () => {
    const channels = vi.mocked(ipcMain.handle).mock.calls.map(([ch]) => ch);
    expect(channels).toContain("clipboard:write-image");
  });

  it("writes valid PNG data to clipboard and returns ok", async () => {
    const fakeImage = { isEmpty: () => false };
    nativeImageMock.createFromBuffer.mockReturnValue(fakeImage);

    const pngData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const handler = getHandler("clipboard:write-image");
    const result = await handler(fakeEvent, pngData);

    expect(nativeImageMock.createFromBuffer).toHaveBeenCalledTimes(1);
    const bufferArg = nativeImageMock.createFromBuffer.mock.calls[0][0];
    expect(Buffer.isBuffer(bufferArg)).toBe(true);
    expect([...bufferArg]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    expect(clipboardMock.writeImage).toHaveBeenCalledWith(fakeImage);
    expect(result).toEqual({ ok: true });
  });

  it("handles Uint8Array subarray with non-zero byteOffset correctly", async () => {
    const fakeImage = { isEmpty: () => false };
    nativeImageMock.createFromBuffer.mockReturnValue(fakeImage);

    const fullBuffer = new Uint8Array([0x00, 0x00, 0x89, 0x50, 0x4e, 0x47]);
    const subarray = fullBuffer.subarray(2);

    const handler = getHandler("clipboard:write-image");
    await handler(fakeEvent, subarray);

    const bufferArg = nativeImageMock.createFromBuffer.mock.calls[0][0];
    expect([...bufferArg]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("returns error for empty/invalid image data", async () => {
    const fakeImage = { isEmpty: () => true };
    nativeImageMock.createFromBuffer.mockReturnValue(fakeImage);

    const handler = getHandler("clipboard:write-image");
    const result = await handler(fakeEvent, new Uint8Array([]));

    expect(clipboardMock.writeImage).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: "Invalid image data" });
  });

  it("returns error when nativeImage.createFromBuffer throws", async () => {
    nativeImageMock.createFromBuffer.mockImplementation(() => {
      throw new Error("Corrupt buffer");
    });

    const handler = getHandler("clipboard:write-image");
    const result = await handler(fakeEvent, new Uint8Array([0xff]));

    expect(result).toEqual({ ok: false, error: "Corrupt buffer" });
  });

  it("cleanup removes the handler", () => {
    cleanup();
    const removedChannels = vi.mocked(ipcMain.removeHandler).mock.calls.map(([ch]) => ch);
    expect(removedChannels).toContain("clipboard:write-image");
  });
});
