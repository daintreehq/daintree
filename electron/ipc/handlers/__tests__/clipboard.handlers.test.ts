import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clipboardMock = vi.hoisted(() => ({
  writeImage: vi.fn(),
  readImage: vi.fn(),
  writeText: vi.fn(),
  readText: vi.fn(),
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

  it("writes valid PNG data to clipboard and returns void", async () => {
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
    expect(result).toBeUndefined();
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

  it("throws CLIPBOARD_INVALID for empty/invalid image data", async () => {
    const fakeImage = { isEmpty: () => true };
    nativeImageMock.createFromBuffer.mockReturnValue(fakeImage);

    const handler = getHandler("clipboard:write-image");
    await expect(handler(fakeEvent, new Uint8Array([]))).rejects.toMatchObject({
      name: "AppError",
      code: "CLIPBOARD_INVALID",
      message: "Invalid image data",
    });

    expect(clipboardMock.writeImage).not.toHaveBeenCalled();
  });

  it("propagates raw errors when nativeImage.createFromBuffer throws", async () => {
    nativeImageMock.createFromBuffer.mockImplementation(() => {
      throw new Error("Corrupt buffer");
    });

    const handler = getHandler("clipboard:write-image");
    await expect(handler(fakeEvent, new Uint8Array([0xff]))).rejects.toThrow("Corrupt buffer");
  });

  it("cleanup removes the handler", () => {
    cleanup();
    const removedChannels = vi.mocked(ipcMain.removeHandler).mock.calls.map(([ch]) => ch);
    expect(removedChannels).toContain("clipboard:write-image");
  });
});

describe("clipboard:write-text handler", () => {
  let cleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup = registerClipboardHandlers();
  });

  afterEach(() => {
    cleanup();
  });

  it("registers the clipboard:write-text handler", () => {
    const channels = vi.mocked(ipcMain.handle).mock.calls.map(([ch]) => ch);
    expect(channels).toContain("clipboard:write-text");
  });

  it("writes text to the clipboard and returns void", async () => {
    const handler = getHandler("clipboard:write-text");
    const result = await handler(fakeEvent, "sudo sysctl fs.inotify.max_user_watches=524288");

    expect(clipboardMock.writeText).toHaveBeenCalledWith(
      "sudo sysctl fs.inotify.max_user_watches=524288"
    );
    expect(result).toBeUndefined();
  });

  it("rejects non-string input with VALIDATION error", async () => {
    const handler = getHandler("clipboard:write-text");
    await expect(handler(fakeEvent, 42 as unknown as string)).rejects.toMatchObject({
      name: "AppError",
      code: "VALIDATION",
      message: "Text must be a string",
    });

    expect(clipboardMock.writeText).not.toHaveBeenCalled();
  });

  it("propagates raw errors when clipboard.writeText throws", async () => {
    clipboardMock.writeText.mockImplementationOnce(() => {
      throw new Error("clipboard unavailable");
    });

    const handler = getHandler("clipboard:write-text");
    await expect(handler(fakeEvent, "hello")).rejects.toThrow("clipboard unavailable");
  });

  it("cleanup removes the clipboard:write-text handler", () => {
    cleanup();
    const removedChannels = vi.mocked(ipcMain.removeHandler).mock.calls.map(([ch]) => ch);
    expect(removedChannels).toContain("clipboard:write-text");
  });
});

describe("clipboard:write-selection handler", () => {
  const originalPlatform = process.platform;
  let cleanup: () => void;

  const setPlatform = (value: NodeJS.Platform) => {
    Object.defineProperty(process, "platform", { value, configurable: true });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform("linux");
    cleanup = registerClipboardHandlers();
  });

  afterEach(() => {
    cleanup();
    setPlatform(originalPlatform);
  });

  it("registers the clipboard:write-selection handler", () => {
    const channels = vi.mocked(ipcMain.handle).mock.calls.map(([ch]) => ch);
    expect(channels).toContain("clipboard:write-selection");
  });

  it("writes to PRIMARY selection on Linux and returns void", async () => {
    const handler = getHandler("clipboard:write-selection");
    const result = await handler(fakeEvent, "selected text");

    expect(clipboardMock.writeText).toHaveBeenCalledWith("selected text", "selection");
    expect(result).toBeUndefined();
  });

  it("rejects empty text with VALIDATION error", async () => {
    const handler = getHandler("clipboard:write-selection");
    await expect(handler(fakeEvent, "")).rejects.toMatchObject({
      name: "AppError",
      code: "VALIDATION",
      message: "Text must not be empty",
    });

    expect(clipboardMock.writeText).not.toHaveBeenCalled();
  });

  it("rejects non-string input with VALIDATION error", async () => {
    const handler = getHandler("clipboard:write-selection");
    await expect(handler(fakeEvent, 42 as unknown as string)).rejects.toMatchObject({
      name: "AppError",
      code: "VALIDATION",
      message: "Text must be a string",
    });

    expect(clipboardMock.writeText).not.toHaveBeenCalled();
  });

  it("throws UNSUPPORTED on macOS without calling clipboard", async () => {
    cleanup();
    setPlatform("darwin");
    cleanup = registerClipboardHandlers();

    const handler = getHandler("clipboard:write-selection");
    await expect(handler(fakeEvent, "hello")).rejects.toMatchObject({
      name: "AppError",
      code: "UNSUPPORTED",
      message: "PRIMARY selection is only available on Linux",
    });

    expect(clipboardMock.writeText).not.toHaveBeenCalled();
  });

  it("throws UNSUPPORTED on Windows without calling clipboard", async () => {
    cleanup();
    setPlatform("win32");
    cleanup = registerClipboardHandlers();

    const handler = getHandler("clipboard:write-selection");
    await expect(handler(fakeEvent, "hello")).rejects.toMatchObject({
      name: "AppError",
      code: "UNSUPPORTED",
    });

    expect(clipboardMock.writeText).not.toHaveBeenCalled();
  });

  it("propagates raw errors when clipboard.writeText throws", async () => {
    clipboardMock.writeText.mockImplementationOnce(() => {
      throw new Error("wayland compositor lacks primary selection");
    });

    const handler = getHandler("clipboard:write-selection");
    await expect(handler(fakeEvent, "hello")).rejects.toThrow(
      "wayland compositor lacks primary selection"
    );
  });
});

describe("clipboard:read-selection handler", () => {
  const originalPlatform = process.platform;
  let cleanup: () => void;

  const setPlatform = (value: NodeJS.Platform) => {
    Object.defineProperty(process, "platform", { value, configurable: true });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform("linux");
    cleanup = registerClipboardHandlers();
  });

  afterEach(() => {
    cleanup();
    setPlatform(originalPlatform);
  });

  it("registers the clipboard:read-selection handler", () => {
    const channels = vi.mocked(ipcMain.handle).mock.calls.map(([ch]) => ch);
    expect(channels).toContain("clipboard:read-selection");
  });

  it("reads PRIMARY selection on Linux and returns text", async () => {
    clipboardMock.readText.mockReturnValueOnce("pasted text");

    const handler = getHandler("clipboard:read-selection");
    const result = await handler(fakeEvent);

    expect(clipboardMock.readText).toHaveBeenCalledWith("selection");
    expect(result).toEqual({ text: "pasted text" });
  });

  it("returns empty text when PRIMARY selection is empty", async () => {
    clipboardMock.readText.mockReturnValueOnce("");

    const handler = getHandler("clipboard:read-selection");
    const result = await handler(fakeEvent);

    expect(result).toEqual({ text: "" });
  });

  it("throws UNSUPPORTED on macOS without calling clipboard", async () => {
    cleanup();
    setPlatform("darwin");
    cleanup = registerClipboardHandlers();

    const handler = getHandler("clipboard:read-selection");
    await expect(handler(fakeEvent)).rejects.toMatchObject({
      name: "AppError",
      code: "UNSUPPORTED",
      message: "PRIMARY selection is only available on Linux",
    });

    expect(clipboardMock.readText).not.toHaveBeenCalled();
  });

  it("propagates raw errors when clipboard.readText throws", async () => {
    clipboardMock.readText.mockImplementationOnce(() => {
      throw new Error("focus required for primary read");
    });

    const handler = getHandler("clipboard:read-selection");
    await expect(handler(fakeEvent)).rejects.toThrow("focus required for primary read");
  });
});
