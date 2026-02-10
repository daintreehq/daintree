import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const shellMock = vi.hoisted(() => ({
  openPath: vi.fn(),
}));

const loggerMock = vi.hoisted(() => ({
  getLogFilePath: vi.fn(() => "/tmp/canopy.log"),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  shell: shellMock,
  BrowserWindow: class {},
}));

vi.mock("../../utils/logger.js", () => loggerMock);

import { CHANNELS } from "../channels.js";
import { registerErrorHandlers } from "../errorHandlers.js";

describe("errorHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shellMock.openPath.mockResolvedValue("");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function getInvokeHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
    const call = (ipcMainMock.handle as Mock).mock.calls.find(
      ([registered]) => registered === channel
    );
    if (!call) {
      throw new Error(`No handler registered for channel: ${channel}`);
    }
    return call[1] as (...args: unknown[]) => Promise<unknown>;
  }

  it("registers retry/open-log handlers and removes them on cleanup", () => {
    const cleanup = registerErrorHandlers({} as never, null, null);

    expect(ipcMainMock.handle).toHaveBeenCalledWith(CHANNELS.ERROR_RETRY, expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith(CHANNELS.ERROR_OPEN_LOGS, expect.any(Function));

    cleanup();

    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith(CHANNELS.ERROR_RETRY);
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith(CHANNELS.ERROR_OPEN_LOGS);
  });

  it("retries terminal spawn with default cols/rows", async () => {
    const spawn = vi.fn();
    registerErrorHandlers(
      {
        isDestroyed: () => false,
        webContents: { send: vi.fn() },
      } as never,
      null,
      { spawn } as never
    );

    const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
    await retryHandler(
      {} as never,
      { errorId: "error-1", action: "terminal", args: { id: "term-1", cwd: "/tmp" } } as never
    );

    expect(spawn).toHaveBeenCalledWith("term-1", { cwd: "/tmp", cols: 80, rows: 30 });
  });

  it("sanitizes invalid terminal dimensions in retry args", async () => {
    const spawn = vi.fn();
    registerErrorHandlers(
      {
        isDestroyed: () => false,
        webContents: { send: vi.fn() },
      } as never,
      null,
      { spawn } as never
    );

    const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
    await retryHandler(
      {} as never,
      {
        errorId: "error-1b",
        action: "terminal",
        args: { id: "term-1b", cwd: "/tmp", cols: -25, rows: Number.NaN },
      } as never
    );

    expect(spawn).toHaveBeenCalledWith("term-1b", { cwd: "/tmp", cols: 80, rows: 30 });
  });

  it("rethrows original retry failure even when renderer webContents is unavailable", async () => {
    const expectedError = new Error("spawn failed");
    const spawn = vi.fn(() => {
      throw expectedError;
    });

    registerErrorHandlers(
      {
        isDestroyed: () => false,
        // no webContents on purpose: should not mask retry error
      } as never,
      null,
      { spawn } as never
    );

    const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
    await expect(
      retryHandler(
        {} as never,
        { errorId: "error-2", action: "terminal", args: { id: "term-2", cwd: "/tmp" } } as never
      )
    ).rejects.toThrow("spawn failed");
  });

  it("rejects malformed retry payload and reports it safely", async () => {
    const send = vi.fn();
    registerErrorHandlers(
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send,
        },
      } as never,
      null,
      { spawn: vi.fn() } as never
    );

    const retryHandler = getInvokeHandler(CHANNELS.ERROR_RETRY);
    await expect(retryHandler({} as never, undefined as never)).rejects.toThrow(
      "Invalid retry payload"
    );

    expect(send).toHaveBeenCalledWith(
      CHANNELS.ERROR_NOTIFY,
      expect.objectContaining({
        source: "retry-unknown",
      })
    );
  });
});
