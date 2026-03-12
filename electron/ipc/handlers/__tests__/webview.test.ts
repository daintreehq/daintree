import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const debuggerMock = vi.hoisted(() => ({
  isAttached: vi.fn(() => false),
  attach: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendCommand: vi.fn<(...args: any[]) => Promise<any>>(() => Promise.resolve()),
  on: vi.fn(),
  off: vi.fn(),
}));

const mockWebContents = vi.hoisted(() => ({
  isDestroyed: vi.fn(() => false),
  debugger: debuggerMock,
}));

const webContentsMock = vi.hoisted(() => ({
  fromId: vi.fn(() => mockWebContents),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  webContents: webContentsMock,
}));

vi.mock("../../../services/WebviewDialogService.js", () => ({
  getWebviewDialogService: () => ({
    registerPanel: vi.fn(),
    resolveDialog: vi.fn(),
  }),
}));

const mainWindowMock = vi.hoisted(() => ({
  webContents: {
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
  },
  isDestroyed: vi.fn(() => false),
}));

vi.mock("../../utils.js", () => ({
  sendToRenderer: vi.fn(
    (mainWindow: typeof mainWindowMock, channel: string, ...args: unknown[]) => {
      mainWindow.webContents.send(channel, ...args);
    }
  ),
}));

import { registerWebviewHandlers } from "../webview.js";
import type { HandlerDependencies } from "../../types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const deps: HandlerDependencies = { mainWindow: mainWindowMock as any };

function getHandler(channel: string) {
  const call = ipcMainMock.handle.mock.calls.find(([ch]: string[]) => ch.includes(channel));
  if (!call) throw new Error(`Handler not registered for ${channel}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return call[1] as (...args: any[]) => Promise<any>;
}

describe("registerWebviewHandlers", () => {
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    // Clean up previous registration to reset module-level session state
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    vi.clearAllMocks();
    debuggerMock.isAttached.mockReturnValue(false);
    debuggerMock.sendCommand.mockResolvedValue(undefined);
    webContentsMock.fromId.mockReturnValue(mockWebContents);
    mockWebContents.isDestroyed.mockReturnValue(false);
  });

  afterEach(() => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
  });

  it("registers and cleans up all IPC handlers", () => {
    cleanup = registerWebviewHandlers(deps);
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "webview:set-lifecycle-state",
      expect.any(Function)
    );
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "webview:start-console-capture",
      expect.any(Function)
    );
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "webview:get-console-properties",
      expect.any(Function)
    );
    cleanup();
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("webview:set-lifecycle-state");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("webview:start-console-capture");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("webview:stop-console-capture");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("webview:clear-console-capture");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("webview:get-console-properties");
  });

  it("attaches debugger and sends CDP commands in correct order for freeze", async () => {
    const calls: string[] = [];
    debuggerMock.attach.mockImplementation(() => calls.push("attach"));
    debuggerMock.sendCommand.mockImplementation((cmd: string) => {
      calls.push(cmd);
      return Promise.resolve();
    });

    cleanup = registerWebviewHandlers(deps);
    const handler = getHandler("webview:set-lifecycle-state");
    await handler(null, 42, true);

    expect(calls).toEqual(["attach", "Page.enable", "Page.setWebLifecycleState"]);
    expect(debuggerMock.sendCommand).toHaveBeenCalledWith("Page.setWebLifecycleState", {
      state: "frozen",
    });
  });

  it("sends active state when frozen=false", async () => {
    cleanup = registerWebviewHandlers(deps);
    const handler = getHandler("webview:set-lifecycle-state");
    await handler(null, 42, false);

    expect(debuggerMock.sendCommand).toHaveBeenCalledWith("Page.setWebLifecycleState", {
      state: "active",
    });
  });

  it("skips attach if debugger already attached", async () => {
    debuggerMock.isAttached.mockReturnValue(true);
    cleanup = registerWebviewHandlers(deps);
    const handler = getHandler("webview:set-lifecycle-state");
    await handler(null, 42, true);

    expect(debuggerMock.attach).not.toHaveBeenCalled();
    expect(debuggerMock.sendCommand).toHaveBeenCalledWith("Page.setWebLifecycleState", {
      state: "frozen",
    });
  });

  it("returns early if webContents not found", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    webContentsMock.fromId.mockReturnValue(null as any);
    cleanup = registerWebviewHandlers(deps);
    const handler = getHandler("webview:set-lifecycle-state");
    await expect(handler(null, 99, true)).resolves.toBeUndefined();
    expect(debuggerMock.attach).not.toHaveBeenCalled();
  });

  it("returns early if webContents is destroyed", async () => {
    mockWebContents.isDestroyed.mockReturnValue(true);
    cleanup = registerWebviewHandlers(deps);
    const handler = getHandler("webview:set-lifecycle-state");
    await expect(handler(null, 42, true)).resolves.toBeUndefined();
    expect(debuggerMock.attach).not.toHaveBeenCalled();
  });

  it("throws on invalid argument types", async () => {
    cleanup = registerWebviewHandlers(deps);
    const handler = getHandler("webview:set-lifecycle-state");
    await expect(handler(null, "not-a-number", true)).rejects.toThrow("Invalid arguments");
    await expect(handler(null, 42, "not-a-boolean")).rejects.toThrow("Invalid arguments");
  });

  it("handles expected transient debugger errors non-fatally without logging", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    debuggerMock.sendCommand.mockRejectedValue(new Error("Target closed"));
    cleanup = registerWebviewHandlers(deps);
    const handler = getHandler("webview:set-lifecycle-state");
    await expect(handler(null, 42, true)).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("logs a warning for unexpected debugger errors", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    debuggerMock.sendCommand.mockRejectedValue(new Error("Unexpected internal error"));
    cleanup = registerWebviewHandlers(deps);
    const handler = getHandler("webview:set-lifecycle-state");
    await expect(handler(null, 42, true)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[webview]"),
      expect.stringContaining("Unexpected internal error")
    );
    warnSpy.mockRestore();
  });

  describe("console capture", () => {
    it("attaches debugger and enables Runtime on startConsoleCapture", async () => {
      cleanup = registerWebviewHandlers(deps);
      const handler = getHandler("webview:start-console-capture");
      await handler(null, 42, "pane-1");

      expect(debuggerMock.attach).toHaveBeenCalledWith("1.3");
      expect(debuggerMock.sendCommand).toHaveBeenCalledWith("Runtime.enable");
      expect(debuggerMock.on).toHaveBeenCalledWith("message", expect.any(Function));
      expect(debuggerMock.on).toHaveBeenCalledWith("detach", expect.any(Function));
    });

    it("forwards consoleAPICalled events to renderer", async () => {
      cleanup = registerWebviewHandlers(deps);
      const handler = getHandler("webview:start-console-capture");
      await handler(null, 42, "pane-1");

      // Get the message listener that was registered
      const messageCall = debuggerMock.on.mock.calls.find(
        ([event]: string[]) => event === "message"
      );
      expect(messageCall).toBeDefined();
      const messageListener = messageCall![1];

      // Simulate a CDP consoleAPICalled event
      messageListener({}, "Runtime.consoleAPICalled", {
        type: "log",
        args: [{ type: "string", value: "hello world" }],
        timestamp: 1000,
      });

      expect(mainWindowMock.webContents.send).toHaveBeenCalledWith(
        "webview:console-message",
        expect.objectContaining({
          paneId: "pane-1",
          level: "log",
          cdpType: "log",
          summaryText: "hello world",
        })
      );
    });

    it("handles getConsoleProperties", async () => {
      debuggerMock.sendCommand.mockImplementation((cmd: string) => {
        if (cmd === "Runtime.getProperties") {
          return Promise.resolve({
            result: [
              {
                name: "key",
                value: { type: "string", value: "val" },
                configurable: true,
                enumerable: true,
              },
            ],
          });
        }
        return Promise.resolve();
      });

      cleanup = registerWebviewHandlers(deps);
      const handler = getHandler("webview:get-console-properties");
      const result = await handler(null, 42, "obj-123");

      expect(result.properties).toHaveLength(1);
      expect(result.properties[0].name).toBe("key");
      expect(result.properties[0].value).toEqual({
        type: "primitive",
        kind: "string",
        value: "val",
      });
    });

    it("returns empty properties when object not found", async () => {
      debuggerMock.sendCommand.mockImplementation((cmd: string) => {
        if (cmd === "Runtime.getProperties") {
          return Promise.reject(new Error("Could not find object with given id"));
        }
        return Promise.resolve();
      });

      cleanup = registerWebviewHandlers(deps);
      const handler = getHandler("webview:get-console-properties");
      const result = await handler(null, 42, "stale-obj");

      expect(result.properties).toEqual([]);
    });

    it("tracks group depth correctly", async () => {
      cleanup = registerWebviewHandlers(deps);
      const handler = getHandler("webview:start-console-capture");
      await handler(null, 42, "pane-1");

      const messageListener = debuggerMock.on.mock.calls.find(
        ([event]: string[]) => event === "message"
      )![1];

      // startGroup → depth 0, then children at depth 1
      messageListener({}, "Runtime.consoleAPICalled", {
        type: "startGroup",
        args: [{ type: "string", value: "group" }],
        timestamp: 1000,
      });

      messageListener({}, "Runtime.consoleAPICalled", {
        type: "log",
        args: [{ type: "string", value: "inside" }],
        timestamp: 1001,
      });

      messageListener({}, "Runtime.consoleAPICalled", {
        type: "endGroup",
        args: [],
        timestamp: 1002,
      });

      messageListener({}, "Runtime.consoleAPICalled", {
        type: "log",
        args: [{ type: "string", value: "outside" }],
        timestamp: 1003,
      });

      const calls = mainWindowMock.webContents.send.mock.calls.filter(
        ([ch]: string[]) => ch === "webview:console-message"
      );
      // endGroup doesn't produce a row, so 3 messages
      expect(calls).toHaveLength(3);
      expect(calls[0][1].groupDepth).toBe(0); // startGroup header at depth 0
      expect(calls[1][1].groupDepth).toBe(1); // child at depth 1
      expect(calls[2][1].groupDepth).toBe(0); // after endGroup, back to depth 0
    });
  });
});
