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
  executeJavaScript: vi.fn().mockResolvedValue([]),
  once: vi.fn(),
  hostWebContents: null as unknown,
}));

const webContentsMock = vi.hoisted(() => ({
  fromId: vi.fn(() => mockWebContents),
}));

const browserWindowMock = vi.hoisted(() => ({
  getAllWindows: () => [mainWindowMock],
  fromWebContents: vi.fn((): unknown => null),
}));

const appMock = vi.hoisted(() => ({
  on: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  webContents: webContentsMock,
  BrowserWindow: browserWindowMock,
  app: appMock,
}));

const mockDialogService = vi.hoisted(() => ({
  registerPanel: vi.fn(),
  resolveDialog: vi.fn(),
  getPanelId: vi.fn<(id: number) => string | undefined>(() => "test-panel"),
  consumeOAuthSessionStorage: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../services/WebviewDialogService.js", () => ({
  getWebviewDialogService: () => mockDialogService,
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
  broadcastToRenderer: vi.fn((channel: string, ...args: unknown[]) => {
    mainWindowMock.webContents.send(channel, ...args);
  }),
  typedHandle: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
  typedHandleWithContext: (channel: string, handler: unknown) => {
    ipcMainMock.handle(
      channel,
      (event: { sender?: { id?: number } } | null | undefined, ...args: unknown[]) => {
        const ctx = {
          event: event as unknown,
          webContentsId: event?.sender?.id ?? 0,
          senderWindow: null,
          projectId: null,
        };
        return (handler as (...a: unknown[]) => unknown)(ctx, ...args);
      }
    );
    return () => ipcMainMock.removeHandler(channel);
  },
}));

import { registerWebviewHandlers } from "../webview.js";
import { sendToRenderer, broadcastToRenderer } from "../../utils.js";
import type { HandlerDependencies } from "../../types.js";
import { MAX_CONSOLE_ROWS } from "../../../../shared/config/devPreviewConsole.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const deps: HandlerDependencies = { mainWindow: mainWindowMock as any };

function getMessageListener() {
  const call = debuggerMock.on.mock.calls.find(([event]: string[]) => event === "message");
  if (!call) throw new Error("CDP message listener was never bound");
  return call[1] as (event: unknown, method: string, params: unknown) => void;
}

/**
 * Emit one object-bearing console row through the real capture path and return
 * the row id main assigned it — the ownership token `getConsoleProperties`
 * now requires.
 */
async function emitObjectRow(paneId: string, objectId: string, timestamp = 1000) {
  const start = getHandler("webview:start-console-capture");
  await start(null, 42, paneId);
  getMessageListener()({}, "Runtime.consoleAPICalled", {
    type: "log",
    args: [{ type: "object", objectId, className: "Object" }],
    timestamp,
  });
  const sent = mainWindowMock.webContents.send.mock.calls.filter(
    ([channel]: string[]) => channel === "webview:console-message"
  );
  return (sent[sent.length - 1][1] as { id: number }).id;
}

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
    // clearAllMocks resets calls but not implementations, so a suite that
    // stubs an unregistered guest would otherwise leak that into every test
    // declared after it.
    mockDialogService.getPanelId.mockReturnValue("test-panel");
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
      expect.stringContaining("[webContentsLifecycle]"),
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
      const rowId = await emitObjectRow("pane-1", "obj-123");
      const handler = getHandler("webview:get-console-properties");
      const result = await handler(null, 42, "pane-1", rowId, "obj-123");

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
      const rowId = await emitObjectRow("pane-1", "stale-obj");
      const handler = getHandler("webview:get-console-properties");
      const result = await handler(null, 42, "pane-1", rowId, "stale-obj");

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

    it("sends console messages to owner window when hostWebContents resolves", async () => {
      const ownerWindowMock = {
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
        isDestroyed: vi.fn(() => false),
      };
      mockWebContents.hostWebContents = { id: 99 };
      browserWindowMock.fromWebContents.mockReturnValue(ownerWindowMock);

      cleanup = registerWebviewHandlers(deps);
      const handler = getHandler("webview:start-console-capture");
      await handler(null, 42, "pane-1");

      const messageListener = debuggerMock.on.mock.calls.find(
        ([event]: string[]) => event === "message"
      )![1];

      vi.mocked(sendToRenderer).mockClear();
      vi.mocked(broadcastToRenderer).mockClear();

      messageListener({}, "Runtime.consoleAPICalled", {
        type: "log",
        args: [{ type: "string", value: "targeted" }],
        timestamp: 2000,
      });

      expect(sendToRenderer).toHaveBeenCalledWith(
        ownerWindowMock,
        "webview:console-message",
        expect.objectContaining({ paneId: "pane-1", summaryText: "targeted" })
      );
      expect(broadcastToRenderer).not.toHaveBeenCalled();

      // Reset for other tests
      mockWebContents.hostWebContents = null;
      browserWindowMock.fromWebContents.mockReturnValue(null);
    });

    it("falls back to broadcast when hostWebContents is null", async () => {
      mockWebContents.hostWebContents = null;
      browserWindowMock.fromWebContents.mockReturnValue(null);

      cleanup = registerWebviewHandlers(deps);
      const handler = getHandler("webview:start-console-capture");
      await handler(null, 42, "pane-1");

      const messageListener = debuggerMock.on.mock.calls.find(
        ([event]: string[]) => event === "message"
      )![1];

      vi.mocked(sendToRenderer).mockClear();
      vi.mocked(broadcastToRenderer).mockClear();

      messageListener({}, "Runtime.consoleAPICalled", {
        type: "log",
        args: [{ type: "string", value: "fallback" }],
        timestamp: 3000,
      });

      expect(broadcastToRenderer).toHaveBeenCalledWith(
        "webview:console-message",
        expect.objectContaining({ paneId: "pane-1", summaryText: "fallback" })
      );
      expect(sendToRenderer).not.toHaveBeenCalled();
    });

    it("enables Log domain on startConsoleCapture", async () => {
      cleanup = registerWebviewHandlers(deps);
      const handler = getHandler("webview:start-console-capture");
      await handler(null, 42, "pane-1");

      expect(debuggerMock.sendCommand).toHaveBeenCalledWith("Log.enable");
    });

    it("enables Runtime and Log only once across multiple panes", async () => {
      cleanup = registerWebviewHandlers(deps);
      const handler = getHandler("webview:start-console-capture");
      await handler(null, 42, "pane-1");
      await handler(null, 42, "pane-2");

      const runtimeEnableCalls = debuggerMock.sendCommand.mock.calls.filter(
        ([cmd]: string[]) => cmd === "Runtime.enable"
      );
      const logEnableCalls = debuggerMock.sendCommand.mock.calls.filter(
        ([cmd]: string[]) => cmd === "Log.enable"
      );
      expect(runtimeEnableCalls).toHaveLength(1);
      expect(logEnableCalls).toHaveLength(1);
    });

    it("disables Log domain when the last pane stops", async () => {
      cleanup = registerWebviewHandlers(deps);
      const startHandler = getHandler("webview:start-console-capture");
      const stopHandler = getHandler("webview:stop-console-capture");
      await startHandler(null, 42, "pane-1");
      await startHandler(null, 42, "pane-2");

      await stopHandler(null, 42, "pane-1");
      expect(debuggerMock.sendCommand).not.toHaveBeenCalledWith("Log.disable");

      await stopHandler(null, 42, "pane-2");
      expect(debuggerMock.sendCommand).toHaveBeenCalledWith("Log.disable");
      expect(debuggerMock.sendCommand).toHaveBeenCalledWith("Runtime.disable");
    });

    it("forwards Runtime.exceptionThrown as an error row", async () => {
      cleanup = registerWebviewHandlers(deps);
      const handler = getHandler("webview:start-console-capture");
      await handler(null, 42, "pane-1");

      const messageListener = debuggerMock.on.mock.calls.find(
        ([event]: string[]) => event === "message"
      )![1];

      messageListener({}, "Runtime.exceptionThrown", {
        timestamp: 5000,
        exceptionDetails: {
          text: "Uncaught",
          exception: { type: "object", description: "TypeError: boom\n  at foo (a.js:1:1)" },
          stackTrace: {
            callFrames: [{ functionName: "foo", url: "a.js", lineNumber: 0, columnNumber: 0 }],
          },
        },
      });

      expect(mainWindowMock.webContents.send).toHaveBeenCalledWith(
        "webview:console-message",
        expect.objectContaining({
          paneId: "pane-1",
          level: "error",
          cdpType: "error",
          summaryText: "TypeError: boom\n  at foo (a.js:1:1)",
          stackTrace: { callFrames: [expect.objectContaining({ functionName: "foo" })] },
        })
      );
    });

    it("falls back to exceptionDetails.text when description is absent", async () => {
      cleanup = registerWebviewHandlers(deps);
      const handler = getHandler("webview:start-console-capture");
      await handler(null, 42, "pane-1");

      const messageListener = debuggerMock.on.mock.calls.find(
        ([event]: string[]) => event === "message"
      )![1];

      messageListener({}, "Runtime.exceptionThrown", {
        timestamp: 5000,
        exceptionDetails: { text: "Uncaught (in promise) plain string" },
      });

      expect(mainWindowMock.webContents.send).toHaveBeenCalledWith(
        "webview:console-message",
        expect.objectContaining({
          level: "error",
          cdpType: "error",
          summaryText: "Uncaught (in promise) plain string",
        })
      );
    });

    it("maps Log.entryAdded level and source onto the row", async () => {
      cleanup = registerWebviewHandlers(deps);
      const handler = getHandler("webview:start-console-capture");
      await handler(null, 42, "pane-1");

      const messageListener = debuggerMock.on.mock.calls.find(
        ([event]: string[]) => event === "message"
      )![1];

      messageListener({}, "Log.entryAdded", {
        entry: {
          source: "security",
          level: "error",
          text: "Refused to load script (CSP)",
          timestamp: 6000,
          url: "https://example.com",
          lineNumber: 12,
        },
      });

      expect(mainWindowMock.webContents.send).toHaveBeenCalledWith(
        "webview:console-message",
        expect.objectContaining({
          paneId: "pane-1",
          level: "error",
          cdpType: "log-entry",
          category: "security",
          summaryText: "Refused to load script (CSP)",
        })
      );
    });

    it("maps verbose Log.entryAdded level to log and unknown source to other", async () => {
      cleanup = registerWebviewHandlers(deps);
      const handler = getHandler("webview:start-console-capture");
      await handler(null, 42, "pane-1");

      const messageListener = debuggerMock.on.mock.calls.find(
        ([event]: string[]) => event === "message"
      )![1];

      messageListener({}, "Log.entryAdded", {
        entry: { source: "appcache", level: "verbose", text: "v", timestamp: 1 },
      });

      expect(mainWindowMock.webContents.send).toHaveBeenCalledWith(
        "webview:console-message",
        expect.objectContaining({ level: "log", cdpType: "log-entry", category: "other" })
      );
    });

    it("rate-limits identical Log.entryAdded events to 5 per window", async () => {
      cleanup = registerWebviewHandlers(deps);
      const handler = getHandler("webview:start-console-capture");
      await handler(null, 42, "pane-1");

      const messageListener = debuggerMock.on.mock.calls.find(
        ([event]: string[]) => event === "message"
      )![1];

      const evt = {
        entry: {
          source: "network",
          level: "warning",
          text: "Slow request",
          timestamp: 1,
          url: "https://x.test/a",
          lineNumber: 3,
        },
      };
      for (let i = 0; i < 7; i++) messageListener({}, "Log.entryAdded", evt);

      const logRows = mainWindowMock.webContents.send.mock.calls.filter(
        (call): call is [string, { cdpType?: string }] =>
          call[0] === "webview:console-message" && (call[1] as any).cdpType === "log-entry"
      );
      expect(logRows).toHaveLength(5);
    });

    it("still captures Runtime.consoleAPICalled when Log.enable fails", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      debuggerMock.sendCommand.mockImplementation((cmd: string) => {
        if (cmd === "Log.enable") return Promise.reject(new Error("Log domain unsupported"));
        return Promise.resolve();
      });

      cleanup = registerWebviewHandlers(deps);
      const handler = getHandler("webview:start-console-capture");
      await handler(null, 42, "pane-1");

      const messageCall = debuggerMock.on.mock.calls.find(
        ([event]: string[]) => event === "message"
      );
      expect(messageCall).toBeDefined();
      messageCall![1]({}, "Runtime.consoleAPICalled", {
        type: "log",
        args: [{ type: "string", value: "still works" }],
        timestamp: 1000,
      });

      expect(mainWindowMock.webContents.send).toHaveBeenCalledWith(
        "webview:console-message",
        expect.objectContaining({ paneId: "pane-1", summaryText: "still works" })
      );
      warnSpy.mockRestore();
    });

    it("fans exceptionThrown and Log.entryAdded out to every pane", async () => {
      cleanup = registerWebviewHandlers(deps);
      const handler = getHandler("webview:start-console-capture");
      await handler(null, 42, "pane-1");
      await handler(null, 42, "pane-2");

      const messageListener = debuggerMock.on.mock.calls.find(
        ([event]: string[]) => event === "message"
      )![1];

      messageListener({}, "Runtime.exceptionThrown", {
        timestamp: 1,
        exceptionDetails: { text: "Uncaught Error: x" },
      });
      messageListener({}, "Log.entryAdded", {
        entry: { source: "network", level: "error", text: "failed", timestamp: 2 },
      });

      const rows = mainWindowMock.webContents.send.mock.calls
        .filter((call): call is [string, any] => call[0] === "webview:console-message")
        .map((call) => call[1] as { paneId: string; cdpType: string });
      const exceptionPanes = rows.filter((r) => r.cdpType === "error").map((r) => r.paneId);
      const logPanes = rows.filter((r) => r.cdpType === "log-entry").map((r) => r.paneId);
      expect(exceptionPanes.sort()).toEqual(["pane-1", "pane-2"]);
      expect(logPanes.sort()).toEqual(["pane-1", "pane-2"]);
    });

    it("resets the Log.entryAdded rate-limit window after it elapses", async () => {
      vi.useFakeTimers();
      try {
        cleanup = registerWebviewHandlers(deps);
        const handler = getHandler("webview:start-console-capture");
        await handler(null, 42, "pane-1");

        const messageListener = debuggerMock.on.mock.calls.find(
          ([event]: string[]) => event === "message"
        )![1];

        const evt = {
          entry: {
            source: "network",
            level: "warning",
            text: "slow",
            timestamp: 1,
            url: "https://x.test/a",
            lineNumber: 3,
          },
        };
        for (let i = 0; i < 6; i++) messageListener({}, "Log.entryAdded", evt);
        const countAfterFlood = mainWindowMock.webContents.send.mock.calls.filter(
          (call): call is [string, { cdpType?: string }] =>
            call[0] === "webview:console-message" && (call[1] as any).cdpType === "log-entry"
        ).length;
        expect(countAfterFlood).toBe(5);

        vi.advanceTimersByTime(5_001);
        messageListener({}, "Log.entryAdded", evt);

        const totalAfterReset = mainWindowMock.webContents.send.mock.calls.filter(
          (call): call is [string, { cdpType?: string }] =>
            call[0] === "webview:console-message" && (call[1] as any).cdpType === "log-entry"
        ).length;
        expect(totalAfterReset).toBe(6);
      } finally {
        vi.useRealTimers();
      }
    });

    it("uses the fallback summary for malformed Runtime.exceptionThrown payloads", async () => {
      cleanup = registerWebviewHandlers(deps);
      const handler = getHandler("webview:start-console-capture");
      await handler(null, 42, "pane-1");

      const messageListener = debuggerMock.on.mock.calls.find(
        ([event]: string[]) => event === "message"
      )![1];

      expect(() => messageListener({}, "Runtime.exceptionThrown", null)).not.toThrow();
      messageListener({}, "Runtime.exceptionThrown", {
        timestamp: 1,
        exceptionDetails: { exception: { type: "object" } },
      });

      expect(mainWindowMock.webContents.send).toHaveBeenCalledWith(
        "webview:console-message",
        expect.objectContaining({
          level: "error",
          cdpType: "error",
          summaryText: "Uncaught (unknown exception)",
          args: [],
        })
      );
    });
  });

  describe("ownership validation", () => {
    it("handleSetLifecycleState returns early for unregistered webContentsId", async () => {
      mockDialogService.getPanelId.mockReturnValue(undefined);
      cleanup = registerWebviewHandlers(deps);
      const handler = getHandler("webview:set-lifecycle-state");
      await expect(handler(null, 42, true)).resolves.toBeUndefined();
      expect(debuggerMock.attach).not.toHaveBeenCalled();
      expect(debuggerMock.sendCommand).not.toHaveBeenCalled();
    });

    it("handleStartConsoleCapture returns early for unregistered webContentsId", async () => {
      mockDialogService.getPanelId.mockReturnValue(undefined);
      cleanup = registerWebviewHandlers(deps);
      const handler = getHandler("webview:start-console-capture");
      await expect(handler(null, 42, "pane-1")).resolves.toBeUndefined();
      expect(webContentsMock.fromId).not.toHaveBeenCalled();
      expect(debuggerMock.attach).not.toHaveBeenCalled();
      expect(debuggerMock.sendCommand).not.toHaveBeenCalled();
    });

    it("handleStopConsoleCapture returns early for unregistered webContentsId", async () => {
      mockDialogService.getPanelId.mockReturnValue(undefined);
      cleanup = registerWebviewHandlers(deps);
      const handler = getHandler("webview:stop-console-capture");
      await expect(handler(null, 42, "pane-1")).resolves.toBeUndefined();
      expect(webContentsMock.fromId).not.toHaveBeenCalled();
    });

    it("handleClearConsoleCapture returns early for unregistered webContentsId", async () => {
      mockDialogService.getPanelId.mockReturnValue(undefined);
      cleanup = registerWebviewHandlers(deps);
      const handler = getHandler("webview:clear-console-capture");
      await expect(handler(null, 42, "pane-1")).resolves.toBeUndefined();
      expect(webContentsMock.fromId).not.toHaveBeenCalled();
    });

    it("handleGetConsoleProperties returns empty for unregistered webContentsId", async () => {
      mockDialogService.getPanelId.mockReturnValue(undefined);
      cleanup = registerWebviewHandlers(deps);
      const handler = getHandler("webview:get-console-properties");
      const result = await handler(null, 42, "pane-1", 0, "obj-123");
      expect(result).toEqual({ properties: [] });
      expect(debuggerMock.sendCommand).not.toHaveBeenCalled();
    });
  });

  describe("console capture ordering and replay (#12298)", () => {
    /**
     * Chrome replays the guest's buffered console messages as a side effect of
     * `Runtime.enable`, before the command resolves. Modelling that here is the
     * whole point: with the old enable-then-bind ordering the replayed row has
     * nobody listening and is lost.
     */
    function replayOnRuntimeEnable(rows: Array<Record<string, unknown>>) {
      debuggerMock.sendCommand.mockImplementation((cmd: string) => {
        if (cmd === "Runtime.enable") {
          const call = debuggerMock.on.mock.calls.find(([event]: string[]) => event === "message");
          const listener = call?.[1] as
            ((event: unknown, method: string, params: unknown) => void) | undefined;
          for (const row of rows) listener?.({}, "Runtime.consoleAPICalled", row);
        }
        return Promise.resolve();
      });
    }

    function consoleRows() {
      return mainWindowMock.webContents.send.mock.calls
        .filter(([channel]: string[]) => channel === "webview:console-message")
        .map((call) => call[1] as { summaryText: string });
    }

    it("binds the CDP message listener before enabling the Runtime domain", async () => {
      const order: string[] = [];
      debuggerMock.on.mockImplementation((event: string) => {
        order.push(`on:${event}`);
      });
      debuggerMock.sendCommand.mockImplementation((cmd: string) => {
        order.push(`send:${cmd}`);
        return Promise.resolve();
      });

      cleanup = registerWebviewHandlers(deps);
      await getHandler("webview:start-console-capture")(null, 42, "pane-1");

      expect(order.indexOf("on:message")).toBeLessThan(order.indexOf("send:Runtime.enable"));
      debuggerMock.on.mockReset();
    });

    it("captures console messages replayed during Runtime.enable", async () => {
      replayOnRuntimeEnable([
        { type: "log", args: [{ type: "string", value: "AUDIT_BEFORE_ENABLE" }], timestamp: 1000 },
      ]);

      cleanup = registerWebviewHandlers(deps);
      await getHandler("webview:start-console-capture")(null, 42, "pane-1");

      expect(consoleRows().map((row) => row.summaryText)).toEqual(["AUDIT_BEFORE_ENABLE"]);
    });

    it("does not re-deliver replayed messages after a stop/start cycle", async () => {
      const buffered = {
        type: "log",
        args: [{ type: "string", value: "STARTUP" }],
        timestamp: 1000,
      };
      replayOnRuntimeEnable([buffered]);

      cleanup = registerWebviewHandlers(deps);
      await getHandler("webview:start-console-capture")(null, 42, "pane-1");
      await getHandler("webview:stop-console-capture")(null, 42, "pane-1");

      // The guest logged again while capture was off; the next enable replays
      // both, and only the newer one is still news to the renderer.
      replayOnRuntimeEnable([
        buffered,
        { type: "log", args: [{ type: "string", value: "WHILE_STOPPED" }], timestamp: 2000 },
      ]);
      await getHandler("webview:start-console-capture")(null, 42, "pane-1");

      expect(consoleRows().map((row) => row.summaryText)).toEqual(["STARTUP", "WHILE_STOPPED"]);
    });

    it("does not rebind listeners across a stop/start cycle", async () => {
      cleanup = registerWebviewHandlers(deps);
      await getHandler("webview:start-console-capture")(null, 42, "pane-1");
      await getHandler("webview:stop-console-capture")(null, 42, "pane-1");
      await getHandler("webview:start-console-capture")(null, 42, "pane-1");

      const messageBinds = debuggerMock.on.mock.calls.filter(
        ([event]: string[]) => event === "message"
      );
      expect(messageBinds).toHaveLength(1);
    });

    it("unbinds listeners when Runtime.enable fails for the only pane", async () => {
      debuggerMock.sendCommand.mockImplementation((cmd: string) =>
        cmd === "Runtime.enable" ? Promise.reject(new Error("Target closed")) : Promise.resolve()
      );

      cleanup = registerWebviewHandlers(deps);
      await getHandler("webview:start-console-capture")(null, 42, "pane-1");

      expect(debuggerMock.off).toHaveBeenCalledWith("message", expect.any(Function));
      expect(debuggerMock.off).toHaveBeenCalledWith("detach", expect.any(Function));
    });
  });

  describe("console object ownership (#12298)", () => {
    function releasedIds() {
      return debuggerMock.sendCommand.mock.calls
        .filter(([cmd]: string[]) => cmd === "Runtime.releaseObject")
        .map((call) => (call[1] as { objectId: string }).objectId);
    }

    it("releases handles for rows evicted past the renderer's row cap", async () => {
      cleanup = registerWebviewHandlers(deps);
      await getHandler("webview:start-console-capture")(null, 42, "pane-1");
      const listener = getMessageListener();

      for (let i = 0; i < MAX_CONSOLE_ROWS + 2; i++) {
        listener({}, "Runtime.consoleAPICalled", {
          type: "log",
          args: [{ type: "object", objectId: `obj-${i}`, className: "Object" }],
          timestamp: 1000 + i,
        });
      }

      // The two oldest rows fell off the cap; everything still on screen keeps
      // its handle.
      expect(releasedIds()).toEqual(["obj-0", "obj-1"]);
    });

    it("attributes nested handles from an expansion to the row that owns them", async () => {
      cleanup = registerWebviewHandlers(deps);
      const rowId = await emitObjectRow("pane-1", "root-obj");

      debuggerMock.sendCommand.mockImplementation((cmd: string) => {
        if (cmd === "Runtime.getProperties") {
          return Promise.resolve({
            result: [
              {
                name: "nested",
                value: { type: "object", objectId: "nested-obj", className: "Object" },
                enumerable: true,
              },
            ],
          });
        }
        return Promise.resolve();
      });
      await getHandler("webview:get-console-properties")(null, 42, "pane-1", rowId, "root-obj");

      await getHandler("webview:clear-console-capture")(null, 42, "pane-1");

      expect(releasedIds()).toContain("root-obj");
      expect(releasedIds()).toContain("nested-obj");
    });

    it("releases nested handles whose owning row was cleared mid-request", async () => {
      cleanup = registerWebviewHandlers(deps);
      const rowId = await emitObjectRow("pane-1", "root-obj");

      let resolveProperties: (value: unknown) => void = () => {};
      debuggerMock.sendCommand.mockImplementation((cmd: string) => {
        if (cmd === "Runtime.getProperties") {
          return new Promise((resolve) => {
            resolveProperties = resolve;
          });
        }
        return Promise.resolve();
      });

      const pending = getHandler("webview:get-console-properties")(
        null,
        42,
        "pane-1",
        rowId,
        "root-obj"
      );
      await getHandler("webview:clear-console-capture")(null, 42, "pane-1");
      resolveProperties({
        result: [
          {
            name: "nested",
            value: { type: "object", objectId: "late-nested", className: "Object" },
            enumerable: true,
          },
        ],
      });
      await pending;

      // The row lost ownership while the request was in flight, so the late
      // descendant must be released rather than resurrect the released row.
      expect(releasedIds()).toContain("late-nested");
    });

    it("refuses to expand a row that no longer owns its handles", async () => {
      cleanup = registerWebviewHandlers(deps);
      const rowId = await emitObjectRow("pane-1", "root-obj");
      await getHandler("webview:clear-console-capture")(null, 42, "pane-1");

      debuggerMock.sendCommand.mockClear();
      const result = await getHandler("webview:get-console-properties")(
        null,
        42,
        "pane-1",
        rowId,
        "root-obj"
      );

      expect(result).toEqual({ properties: [] });
      expect(debuggerMock.sendCommand).not.toHaveBeenCalledWith(
        "Runtime.getProperties",
        expect.anything()
      );
    });
  });

  describe("scroll position sentinel (#12298)", () => {
    it("returns a genuine zero when the page is at the top", async () => {
      debuggerMock.sendCommand.mockImplementation((cmd: string) =>
        cmd === "Page.getLayoutMetrics"
          ? Promise.resolve({ cssLayoutViewport: { pageY: 0 } })
          : Promise.resolve()
      );

      cleanup = registerWebviewHandlers(deps);
      await expect(getHandler("webview:get-scroll-position")(null, 42)).resolves.toBe(0);
    });

    it("returns null when the CDP read fails", async () => {
      debuggerMock.sendCommand.mockImplementation((cmd: string) =>
        cmd === "Page.getLayoutMetrics"
          ? Promise.reject(new Error("Target closed"))
          : Promise.resolve()
      );

      cleanup = registerWebviewHandlers(deps);
      await expect(getHandler("webview:get-scroll-position")(null, 42)).resolves.toBeNull();
    });

    it("returns null when the layout metrics are missing", async () => {
      debuggerMock.sendCommand.mockImplementation((cmd: string) =>
        cmd === "Page.getLayoutMetrics" ? Promise.resolve({}) : Promise.resolve()
      );

      cleanup = registerWebviewHandlers(deps);
      await expect(getHandler("webview:get-scroll-position")(null, 42)).resolves.toBeNull();
    });

    it("returns null for an unregistered webContentsId", async () => {
      mockDialogService.getPanelId.mockReturnValue(undefined);
      cleanup = registerWebviewHandlers(deps);
      await expect(getHandler("webview:get-scroll-position")(null, 42)).resolves.toBeNull();
    });
  });

  describe("stack frame coordinates (#12298)", () => {
    it("converts zero-based CDP line/column to one-based file locations", async () => {
      cleanup = registerWebviewHandlers(deps);
      await getHandler("webview:start-console-capture")(null, 42, "pane-1");

      getMessageListener()({}, "Runtime.consoleAPICalled", {
        type: "error",
        args: [{ type: "string", value: "boom" }],
        timestamp: 1000,
        stackTrace: {
          callFrames: [
            {
              functionName: "boot",
              url: "http://localhost:5173/main.ts",
              lineNumber: 0,
              columnNumber: 0,
            },
            {
              functionName: "run",
              url: "http://localhost:5173/main.ts",
              lineNumber: 41,
              columnNumber: 7,
            },
          ],
        },
      });

      expect(mainWindowMock.webContents.send).toHaveBeenCalledWith(
        "webview:console-message",
        expect.objectContaining({
          stackTrace: {
            callFrames: [
              expect.objectContaining({ lineNumber: 1, columnNumber: 1 }),
              expect.objectContaining({ lineNumber: 42, columnNumber: 8 }),
            ],
          },
        })
      );
    });
  });
});
