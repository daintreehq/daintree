import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const debuggerMock = vi.hoisted(() => ({
  isAttached: vi.fn(() => false),
  attach: vi.fn(),
  sendCommand: vi.fn(() => Promise.resolve()),
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

  it("attaches debugger if not already attached and sends frozen state", async () => {
    registerWebviewHandlers();
    const handler = getHandler();
    await handler(null, 42, true);

    expect(debuggerMock.attach).toHaveBeenCalledWith("1.3");
    expect(debuggerMock.sendCommand).toHaveBeenCalledWith("Page.enable");
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
    webContentsMock.fromId.mockReturnValue(null);
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

  it("swallows debugger errors silently", async () => {
    debuggerMock.sendCommand.mockRejectedValue(new Error("debugger detached"));
    registerWebviewHandlers();
    const handler = getHandler();
    await expect(handler(null, 42, true)).resolves.toBeUndefined();
  });
});
