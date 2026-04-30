import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

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

import { defineIpcNamespace, op, opValidated, ValidationError } from "../define.js";

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
          filePath: "/tmp/x.png",
          thumbnailDataUrl: "data:image/png;base64,AA",
        })),
        writeText: op(CH.writeText, async (_text: string) => undefined),
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
          filePath: "/tmp/x.png",
          thumbnailDataUrl: "data:image/png;base64,AA",
        })),
        writeText: op(CH.writeText, async (_text: string) => undefined),
        readSelection: op(CH.readSelection, async () => ({ text: "" })),
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
          filePath: "/tmp/x.png",
          thumbnailDataUrl: "data:image/png;base64,AA",
        })),
        writeText: op(CH.writeText, async (_text: string) => undefined),
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
          filePath: "/tmp/x.png",
          thumbnailDataUrl: "data:image/png;base64,AA",
        })),
        writeText: op(CH.writeText, async (_text: string) => undefined),
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
          filePath: "/tmp/x.png",
          thumbnailDataUrl: "data:image/png;base64,AA",
        })),
        writeText: op(CH.writeText, async (_text: string) => undefined),
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
          filePath: "/tmp/x.png",
          thumbnailDataUrl: "data:image/png;base64,AA",
        })),
        writeText: op(CH.writeText, async (_text: string) => undefined),
      },
    });

    expect(ns.channels().sort()).toEqual(["clipboard:save-image", "clipboard:write-text"]);
  });
});

describe("opValidated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Use the slash-commands:list channel — it has a single object payload
  // typed against IpcInvokeMap, so we don't need to widen the namespace
  // type to validate the test path.
  const SLASH_LIST = "slash-commands:list" as const;
  const SlashListSchema = z.object({
    agentId: z.literal("claude-code"),
    projectPath: z.string().optional(),
  });

  const REPLAY_HISTORY = "terminal:replay-history" as const;
  const ReplayHistorySchema = z.object({
    terminalId: z.string().min(1),
    maxLines: z
      .number()
      .int()
      .transform((val) => Math.max(1, Math.min(val, 100_000)))
      .optional()
      .default(100),
  });

  it("passes parsed payload to handler when validation succeeds", async () => {
    const handler = vi.fn().mockResolvedValue([]);
    const ns = defineIpcNamespace({
      name: "slashCommands",
      ops: {
        list: opValidated(SLASH_LIST, SlashListSchema, handler),
      },
    });

    ns.register();

    const ipcHandler = ipcMainMock.handle.mock.calls.find(
      (call) => call[0] === SLASH_LIST
    )?.[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>;
    expect(ipcHandler).toBeDefined();

    const result = await ipcHandler({} as unknown, {
      agentId: "claude-code",
      projectPath: "/tmp/project",
    });

    expect(handler).toHaveBeenCalledWith({
      agentId: "claude-code",
      projectPath: "/tmp/project",
    });
    expect(result).toEqual([]);
  });

  it("throws ValidationError before invoking handler when payload is invalid", async () => {
    const handler = vi.fn();
    const ns = defineIpcNamespace({
      name: "slashCommands",
      ops: {
        list: opValidated(SLASH_LIST, SlashListSchema, handler),
      },
    });

    ns.register();

    const ipcHandler = ipcMainMock.handle.mock.calls.find(
      (call) => call[0] === SLASH_LIST
    )?.[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>;

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      ipcHandler({} as unknown, { agentId: "wrong-id", projectPath: "/tmp" })
    ).rejects.toBeInstanceOf(ValidationError);

    expect(handler).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("does not include field paths or user values in the thrown message", async () => {
    const handler = vi.fn();
    const ns = defineIpcNamespace({
      name: "slashCommands",
      ops: {
        list: opValidated(SLASH_LIST, SlashListSchema, handler),
      },
    });
    ns.register();

    const ipcHandler = ipcMainMock.handle.mock.calls.find(
      (call) => call[0] === SLASH_LIST
    )?.[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>;

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let caught: unknown;
    try {
      await ipcHandler({} as unknown, {
        agentId: "wrong-id",
        projectPath: "/sensitive/user/path",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    const message = (caught as Error).message;
    // Sanitized: only mentions the channel name, never field names, paths,
    // or the offending user value.
    expect(message).toBe(`IPC validation failed: ${SLASH_LIST}`);
    expect(message).not.toContain("agentId");
    expect(message).not.toContain("projectPath");
    expect(message).not.toContain("/sensitive/user/path");
    expect(message).not.toContain("wrong-id");
    consoleSpy.mockRestore();
  });

  it("logs Zod issues locally on validation failure", async () => {
    const handler = vi.fn();
    const ns = defineIpcNamespace({
      name: "slashCommands",
      ops: {
        list: opValidated(SLASH_LIST, SlashListSchema, handler),
      },
    });
    ns.register();

    const ipcHandler = ipcMainMock.handle.mock.calls.find(
      (call) => call[0] === SLASH_LIST
    )?.[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>;

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(ipcHandler({} as unknown, { agentId: "wrong-id" })).rejects.toBeInstanceOf(
      ValidationError
    );

    expect(consoleSpy).toHaveBeenCalledOnce();
    const logCall = consoleSpy.mock.calls[0];
    expect(logCall[0]).toContain(SLASH_LIST);
    consoleSpy.mockRestore();
  });

  it("passes z.output<S> (post-transform) to handler so transforms apply", async () => {
    const handler = vi.fn().mockResolvedValue({ replayed: 0 });
    const ns = defineIpcNamespace({
      name: "terminal",
      ops: {
        replay: opValidated(REPLAY_HISTORY, ReplayHistorySchema, handler),
      },
    });
    ns.register();

    const ipcHandler = ipcMainMock.handle.mock.calls.find(
      (call) => call[0] === REPLAY_HISTORY
    )?.[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>;

    // Out-of-range maxLines should be clamped to the schema's max.
    await ipcHandler({} as unknown, { terminalId: "abc", maxLines: 999_999 });
    expect(handler).toHaveBeenCalledWith({
      terminalId: "abc",
      maxLines: 100_000,
    });

    // Default applies when maxLines is omitted.
    handler.mockClear();
    await ipcHandler({} as unknown, { terminalId: "abc" });
    expect(handler).toHaveBeenCalledWith({
      terminalId: "abc",
      maxLines: 100,
    });
  });

  it("withContext: true passes ctx + parsed payload, and rejects on parse failure", async () => {
    const handler = vi.fn().mockResolvedValue([]);
    const ns = defineIpcNamespace({
      name: "slashCommands",
      ops: {
        list: opValidated(SLASH_LIST, SlashListSchema, handler, { withContext: true }),
      },
    });
    ns.register();

    const ipcHandler = ipcMainMock.handle.mock.calls.find(
      (call) => call[0] === SLASH_LIST
    )?.[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>;
    expect(ipcHandler).toBeDefined();

    // Valid payload: handler receives `ctx` first, parsed payload second.
    await ipcHandler({ sender: { id: 42 } } as unknown, {
      agentId: "claude-code",
      projectPath: "/tmp/project",
    });
    expect(handler).toHaveBeenCalledOnce();
    const [ctx, payload] = handler.mock.calls[0];
    expect(ctx).toMatchObject({ webContentsId: 42 });
    expect(payload).toEqual({ agentId: "claude-code", projectPath: "/tmp/project" });

    // Invalid payload: rejects before handler runs.
    handler.mockClear();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      ipcHandler({ sender: { id: 42 } } as unknown, { agentId: "wrong-id" })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(handler).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("non-validated and validated ops can coexist in the same namespace", () => {
    const ns = defineIpcNamespace({
      name: "mixed",
      ops: {
        plain: op(CH.writeText, async (_text: string) => undefined),
        validated: opValidated(SLASH_LIST, SlashListSchema, async () => []),
      },
    });

    ns.register();

    const channels = ipcMainMock.handle.mock.calls.map((call) => call[0]);
    expect(channels).toContain("clipboard:write-text");
    expect(channels).toContain(SLASH_LIST);
  });
});
