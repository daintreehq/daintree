import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: Object.assign(class {}, {
    fromWebContents: vi.fn(),
    getAllWindows: vi.fn(() => [] as unknown[]),
  }),
  webContents: {
    fromId: vi.fn(() => null),
  },
}));

vi.mock("../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(() => null),
  getAppWebContents: vi.fn(() => ({ send: undefined, isDestroyed: () => true })),
  getAllAppWebContents: vi.fn(() => []),
}));

vi.mock("../../window/windowRef.js", () => ({
  getProjectViewManager: vi.fn(() => null),
}));

import { defineIpcNamespace, op } from "../define.js";

// Use real clipboard channels so `op()` generics narrow against `IpcInvokeMap`
// without needing casts. These match the runtime channel strings.
const CH = {
  saveImage: "clipboard:save-image",
  writeText: "clipboard:write-text",
  readSelection: "clipboard:read-selection",
} as const;

describe("defineIpcNamespace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preloadBindings routes each method to the correct channel and forwards args", async () => {
    const ns = defineIpcNamespace({
      name: "clipboard",
      ops: {
        saveImage: op(CH.saveImage, async () => ({
          ok: true as const,
          filePath: "/tmp/x.png",
          thumbnailDataUrl: "data:image/png;base64,AA",
        })),
        writeText: op(CH.writeText, async (_text: string) => ({ ok: true as const })),
      },
    });

    const invoke = vi.fn().mockResolvedValue({ ok: true });
    const bindings = ns.preloadBindings(invoke);

    await bindings.saveImage();
    expect(invoke).toHaveBeenNthCalledWith(1, "clipboard:save-image");

    await bindings.writeText("hello");
    expect(invoke).toHaveBeenNthCalledWith(2, "clipboard:write-text", "hello");
  });

  it("register installs an ipcMain handler for every op", () => {
    const ns = defineIpcNamespace({
      name: "clipboard",
      ops: {
        saveImage: op(CH.saveImage, async () => ({
          ok: true as const,
          filePath: "/tmp/x.png",
          thumbnailDataUrl: "data:image/png;base64,AA",
        })),
        writeText: op(CH.writeText, async (_text: string) => ({ ok: true as const })),
        readSelection: op(CH.readSelection, async () => ({ ok: true as const, text: "" })),
      },
    });

    ns.register();

    const channels = ipcMainMock.handle.mock.calls.map((call) => call[0]);
    expect(channels).toEqual([
      "clipboard:save-image",
      "clipboard:write-text",
      "clipboard:read-selection",
    ]);
  });

  it("returned cleanup removes every handler it installed", () => {
    const ns = defineIpcNamespace({
      name: "clipboard",
      ops: {
        saveImage: op(CH.saveImage, async () => ({
          ok: true as const,
          filePath: "/tmp/x.png",
          thumbnailDataUrl: "data:image/png;base64,AA",
        })),
        writeText: op(CH.writeText, async (_text: string) => ({ ok: true as const })),
      },
    });

    const cleanup = ns.register();
    cleanup();

    const removed = ipcMainMock.removeHandler.mock.calls.map((call) => call[0]).sort();
    expect(removed).toEqual(["clipboard:save-image", "clipboard:write-text"]);
  });

  it("cleanup swallows individual removeHandler errors so later cleanups still run", () => {
    const ns = defineIpcNamespace({
      name: "clipboard",
      ops: {
        saveImage: op(CH.saveImage, async () => ({
          ok: true as const,
          filePath: "/tmp/x.png",
          thumbnailDataUrl: "data:image/png;base64,AA",
        })),
        writeText: op(CH.writeText, async (_text: string) => ({ ok: true as const })),
      },
    });

    const cleanup = ns.register();

    ipcMainMock.removeHandler.mockImplementationOnce(() => {
      throw new Error("boom");
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => cleanup()).not.toThrow();
    // Cleanups run in reverse; the first call is for `writeText` (which throws),
    // followed by `saveImage`.
    const removed = ipcMainMock.removeHandler.mock.calls.map((call) => call[0]);
    expect(removed).toContain("clipboard:save-image");
    expect(removed).toContain("clipboard:write-text");
    consoleSpy.mockRestore();
  });

  it("register unwinds already-installed handlers if a later registration throws", () => {
    const ns = defineIpcNamespace({
      name: "clipboard",
      ops: {
        saveImage: op(CH.saveImage, async () => ({
          ok: true as const,
          filePath: "/tmp/x.png",
          thumbnailDataUrl: "data:image/png;base64,AA",
        })),
        writeText: op(CH.writeText, async (_text: string) => ({ ok: true as const })),
      },
    });

    // First ipcMain.handle succeeds, second throws — simulating a duplicate
    // channel conflict halfway through registration.
    ipcMainMock.handle.mockImplementationOnce(() => undefined);
    ipcMainMock.handle.mockImplementationOnce(() => {
      throw new Error("duplicate channel");
    });

    expect(() => ns.register()).toThrow("duplicate channel");

    // The already-installed handler must be torn down so it doesn't leak onto
    // ipcMain with no cleanup reference.
    const removed = ipcMainMock.removeHandler.mock.calls.map((call) => call[0]);
    expect(removed).toEqual(["clipboard:save-image"]);
  });

  it("channels() returns every channel string the namespace owns", () => {
    const ns = defineIpcNamespace({
      name: "clipboard",
      ops: {
        saveImage: op(CH.saveImage, async () => ({
          ok: true as const,
          filePath: "/tmp/x.png",
          thumbnailDataUrl: "data:image/png;base64,AA",
        })),
        writeText: op(CH.writeText, async (_text: string) => ({ ok: true as const })),
      },
    });

    expect(ns.channels().sort()).toEqual(["clipboard:save-image", "clipboard:write-text"]);
  });
});
