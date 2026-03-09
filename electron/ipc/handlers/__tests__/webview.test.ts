import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const debuggerMock = vi.hoisted(() => ({
  isAttached: vi.fn(() => false),
  attach: vi.fn(),
  // Typed broadly so tests can override with mockImplementation using command args
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendCommand: vi.fn<(...args: any[]) => Promise<void>>(() => Promise.resolve()),
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

import { registerWebviewHandlers } from "../webview.js";

function getHandler() {
  const call = ipcMainMock.handle.mock.calls.find(([ch]) =>
    ch.includes("webview:set-lifecycle-state")
  );
  if (!call) throw new Error("Handler not registered");
  return call[1] as (event: unknown, id: unknown, frozen: unknown) => Promise<void>;
}

describe("registerWebviewHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    debuggerMock.isAttached.mockReturnValue(false);
    debuggerMock.sendCommand.mockResolvedValue(undefined);
    webContentsMock.fromId.mockReturnValue(mockWebContents);
    mockWebContents.isDestroyed.mockReturnValue(false);
  });

  it("registers and cleans up the IPC handler", () => {
    const cleanup = registerWebviewHandlers();
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "webview:set-lifecycle-state",
      expect.any(Function)
    );
    cleanup();
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("webview:set-lifecycle-state");
  });

  it("attaches debugger and sends CDP commands in correct order for freeze", async () => {
    const calls: string[] = [];
    debuggerMock.attach.mockImplementation(() => calls.push("attach"));
    debuggerMock.sendCommand.mockImplementation((cmd: string) => {
      calls.push(cmd);
      return Promise.resolve();
    });

    registerWebviewHandlers();
    const handler = getHandler();
    await handler(null, 42, true);

    expect(calls).toEqual(["attach", "Page.enable", "Page.setWebLifecycleState"]);
    expect(debuggerMock.sendCommand).toHaveBeenCalledWith("Page.setWebLifecycleState", {
      state: "frozen",
    });
  });

  it("sends active state when frozen=false", async () => {
    registerWebviewHandlers();
    const handler = getHandler();
    await handler(null, 42, false);

    expect(debuggerMock.sendCommand).toHaveBeenCalledWith("Page.setWebLifecycleState", {
      state: "active",
    });
  });

  it("skips attach if debugger already attached", async () => {
    debuggerMock.isAttached.mockReturnValue(true);
    registerWebviewHandlers();
    const handler = getHandler();
    await handler(null, 42, true);

    expect(debuggerMock.attach).not.toHaveBeenCalled();
    expect(debuggerMock.sendCommand).toHaveBeenCalledWith("Page.setWebLifecycleState", {
      state: "frozen",
    });
  });

  it("returns early if webContents not found", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    webContentsMock.fromId.mockReturnValue(null as any);
    registerWebviewHandlers();
    const handler = getHandler();
    await expect(handler(null, 99, true)).resolves.toBeUndefined();
    expect(debuggerMock.attach).not.toHaveBeenCalled();
  });

  it("returns early if webContents is destroyed", async () => {
    mockWebContents.isDestroyed.mockReturnValue(true);
    registerWebviewHandlers();
    const handler = getHandler();
    await expect(handler(null, 42, true)).resolves.toBeUndefined();
    expect(debuggerMock.attach).not.toHaveBeenCalled();
  });

  it("throws on invalid argument types", async () => {
    registerWebviewHandlers();
    const handler = getHandler();
    await expect(handler(null, "not-a-number", true)).rejects.toThrow("Invalid arguments");
    await expect(handler(null, 42, "not-a-boolean")).rejects.toThrow("Invalid arguments");
  });

  it("handles expected transient debugger errors non-fatally without logging", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    debuggerMock.sendCommand.mockRejectedValue(new Error("Target closed"));
    registerWebviewHandlers();
    const handler = getHandler();
    await expect(handler(null, 42, true)).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("logs a warning for unexpected debugger errors", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    debuggerMock.sendCommand.mockRejectedValue(new Error("Unexpected internal error"));
    registerWebviewHandlers();
    const handler = getHandler();
    await expect(handler(null, 42, true)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[webview]"),
      expect.stringContaining("Unexpected internal error")
    );
    warnSpy.mockRestore();
  });
});
