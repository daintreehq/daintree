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

  it("writes text to the clipboard and returns ok", async () => {
    const handler = getHandler("clipboard:write-text");
    const result = await handler(fakeEvent, "sudo sysctl fs.inotify.max_user_watches=524288");

    expect(clipboardMock.writeText).toHaveBeenCalledWith(
      "sudo sysctl fs.inotify.max_user_watches=524288"
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects non-string input without calling clipboard", async () => {
    const handler = getHandler("clipboard:write-text");
    const result = await handler(fakeEvent, 42 as unknown as string);

    expect(clipboardMock.writeText).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: "Text must be a string" });
  });

  it("returns error when clipboard.writeText throws", async () => {
    clipboardMock.writeText.mockImplementationOnce(() => {
      throw new Error("clipboard unavailable");
    });

    const handler = getHandler("clipboard:write-text");
    const result = await handler(fakeEvent, "hello");

    expect(result).toEqual({ ok: false, error: "clipboard unavailable" });
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

  it("writes to PRIMARY selection on Linux and returns ok", async () => {
    const handler = getHandler("clipboard:write-selection");
    const result = await handler(fakeEvent, "selected text");

    expect(clipboardMock.writeText).toHaveBeenCalledWith("selected text", "selection");
    expect(result).toEqual({ ok: true });
  });

  it("rejects empty text without calling clipboard", async () => {
    const handler = getHandler("clipboard:write-selection");
    const result = await handler(fakeEvent, "");

    expect(clipboardMock.writeText).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: "Text must not be empty" });
  });

  it("rejects non-string input without calling clipboard", async () => {
    const handler = getHandler("clipboard:write-selection");
    const result = await handler(fakeEvent, 42 as unknown as string);

    expect(clipboardMock.writeText).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: "Text must be a string" });
  });

  it("short-circuits on macOS without calling clipboard", async () => {
    cleanup();
    setPlatform("darwin");
    cleanup = registerClipboardHandlers();

    const handler = getHandler("clipboard:write-selection");
    const result = await handler(fakeEvent, "hello");

    expect(clipboardMock.writeText).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      error: "PRIMARY selection is only available on Linux",
    });
  });

  it("short-circuits on Windows without calling clipboard", async () => {
    cleanup();
    setPlatform("win32");
    cleanup = registerClipboardHandlers();

    const handler = getHandler("clipboard:write-selection");
    const result = await handler(fakeEvent, "hello");

    expect(clipboardMock.writeText).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      error: "PRIMARY selection is only available on Linux",
    });
  });

  it("returns error when clipboard.writeText throws", async () => {
    clipboardMock.writeText.mockImplementationOnce(() => {
      throw new Error("wayland compositor lacks primary selection");
    });

    const handler = getHandler("clipboard:write-selection");
    const result = await handler(fakeEvent, "hello");

    expect(result).toEqual({
      ok: false,
      error: "wayland compositor lacks primary selection",
    });
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
    expect(result).toEqual({ ok: true, text: "pasted text" });
  });

  it("returns empty text when PRIMARY selection is empty", async () => {
    clipboardMock.readText.mockReturnValueOnce("");

    const handler = getHandler("clipboard:read-selection");
    const result = await handler(fakeEvent);

    expect(result).toEqual({ ok: true, text: "" });
  });

  it("short-circuits on macOS without calling clipboard", async () => {
    cleanup();
    setPlatform("darwin");
    cleanup = registerClipboardHandlers();

    const handler = getHandler("clipboard:read-selection");
    const result = await handler(fakeEvent);

    expect(clipboardMock.readText).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      error: "PRIMARY selection is only available on Linux",
    });
  });

  it("returns error when clipboard.readText throws", async () => {
    clipboardMock.readText.mockImplementationOnce(() => {
      throw new Error("focus required for primary read");
    });

    const handler = getHandler("clipboard:read-selection");
    const result = await handler(fakeEvent);

    expect(result).toEqual({
      ok: false,
      error: "focus required for primary read",
    });
  });
});
