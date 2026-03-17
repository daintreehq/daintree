import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

vi.mock("crypto", () => ({
  randomBytes: vi.fn(() => ({ toString: () => "test-request-id" })),
}));

import { registerDemoHandlers } from "../demo.js";
import type { HandlerDependencies } from "../../types.js";
import type { BrowserWindow } from "electron";

function makeDeps(isDemoMode: boolean): HandlerDependencies {
  return {
    mainWindow: {
      webContents: {
        send: vi.fn(),
        capturePage: vi.fn().mockResolvedValue({
          toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
          getSize: () => ({ width: 1920, height: 1080 }),
        }),
      },
    } as unknown as BrowserWindow,
    isDemoMode,
  };
}

describe("registerDemoHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is a no-op when isDemoMode is false", () => {
    const cleanup = registerDemoHandlers(makeDeps(false));
    expect(ipcMainMock.handle).not.toHaveBeenCalled();
    cleanup();
  });

  it("registers 9 IPC handlers when isDemoMode is true", () => {
    const cleanup = registerDemoHandlers(makeDeps(true));
    expect(ipcMainMock.handle).toHaveBeenCalledTimes(9);
    cleanup();
  });

  it("registers handlers for all demo channels", () => {
    const cleanup = registerDemoHandlers(makeDeps(true));
    const channels = ipcMainMock.handle.mock.calls.map(([ch]: unknown[]) => ch);
    expect(channels).toContain("demo:move-to");
    expect(channels).toContain("demo:click");
    expect(channels).toContain("demo:screenshot");
    expect(channels).toContain("demo:type");
    expect(channels).toContain("demo:set-zoom");
    expect(channels).toContain("demo:wait-for-selector");
    expect(channels).toContain("demo:pause");
    expect(channels).toContain("demo:resume");
    expect(channels).toContain("demo:sleep");
    cleanup();
  });

  it("cleanup removes all 9 handlers", () => {
    const cleanup = registerDemoHandlers(makeDeps(true));
    cleanup();
    expect(ipcMainMock.removeHandler).toHaveBeenCalledTimes(9);
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:move-to");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:click");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:screenshot");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:type");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:set-zoom");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:wait-for-selector");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:pause");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:resume");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:sleep");
  });

  it("screenshot handler returns Uint8Array with PNG magic bytes", async () => {
    const deps = makeDeps(true);
    registerDemoHandlers(deps);

    const [, handler] =
      ipcMainMock.handle.mock.calls.find(([ch]: unknown[]) => ch === "demo:screenshot") ?? [];
    const result = await handler();
    expect(result.data).toBeInstanceOf(Uint8Array);
    expect(result.data[0]).toBe(0x89);
    expect(result.data[1]).toBe(0x50);
    expect(result.data[2]).toBe(0x4e);
    expect(result.data[3]).toBe(0x47);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
  });

  it("moveTo handler sends exec event with requestId and awaits done", async () => {
    const deps = makeDeps(true);
    registerDemoHandlers(deps);

    const [, handler] =
      ipcMainMock.handle.mock.calls.find(([ch]: unknown[]) => ch === "demo:move-to") ?? [];

    // Simulate renderer responding to the command with matching requestId
    ipcMainMock.on.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
      if (channel === "demo:command-done") {
        setTimeout(() => {
          listener({}, { requestId: "test-request-id" });
        }, 10);
      }
    });

    const result = await handler({}, { x: 25, y: 75, durationMs: 500 });
    expect(result).toBeUndefined();
    expect(deps.mainWindow.webContents.send as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      "demo:exec-move-to",
      { x: 25, y: 75, durationMs: 500, requestId: "test-request-id" }
    );
  });

  it("sleep handler sends exec-sleep event with requestId and awaits done", async () => {
    const deps = makeDeps(true);
    registerDemoHandlers(deps);

    const [, handler] =
      ipcMainMock.handle.mock.calls.find(([ch]: unknown[]) => ch === "demo:sleep") ?? [];

    ipcMainMock.on.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
      if (channel === "demo:command-done") {
        setTimeout(() => {
          listener({}, { requestId: "test-request-id" });
        }, 10);
      }
    });

    const result = await handler({}, { durationMs: 1000 });
    expect(result).toBeUndefined();
    expect(deps.mainWindow.webContents.send as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      "demo:exec-sleep",
      { durationMs: 1000, requestId: "test-request-id" }
    );
  });
});
