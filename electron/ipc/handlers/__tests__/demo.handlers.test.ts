import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

const displaySessionMock = vi.hoisted(() => ({
  setDisplayMediaRequestHandler: vi.fn(),
}));

const sessionMock = vi.hoisted(() => ({
  fromPartition: vi.fn(() => displaySessionMock),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  session: sessionMock,
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("crypto", () => ({
  randomBytes: vi.fn(() => ({ toString: () => "test-request-id" })),
}));

class MockWriteStream extends EventEmitter {
  write = vi.fn(() => true);
  end = vi.fn((cb?: () => void) => {
    if (cb) setTimeout(cb, 0);
  });
  destroy = vi.fn();
}

let mockWriteStream: MockWriteStream;

vi.mock("fs", () => ({
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(() => mockWriteStream),
}));

class MockStdin extends EventEmitter {
  write = vi.fn(() => true);
  end = vi.fn();
}

let mockProc: EventEmitter & {
  stdin: MockStdin;
  kill: ReturnType<typeof vi.fn>;
};

function createMockProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: MockStdin;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdin = new MockStdin();
  proc.kill = vi.fn();
  return proc;
}

vi.mock("child_process", () => ({
  spawn: vi.fn(() => mockProc),
}));

vi.mock("ffmpeg-static", () => ({ default: "/mock/bin/ffmpeg" }));

import { registerDemoHandlers } from "../demo.js";
import type { HandlerDependencies } from "../../types.js";
import type { BrowserWindow } from "electron";

const FRAME_W = 1920;
const FRAME_H = 1080;

function makeMockImage() {
  return {
    toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    getSize: () => ({ width: FRAME_W, height: FRAME_H }),
    toBitmap: () => Buffer.alloc(16),
    resize: vi.fn().mockReturnThis(),
  };
}

function makeDeps(isDemoMode: boolean): HandlerDependencies {
  return {
    mainWindow: {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: vi.fn(),
        capturePage: vi.fn().mockResolvedValue(makeMockImage()),
      },
    } as unknown as BrowserWindow,
    isDemoMode,
  };
}

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const call = ipcMainMock.handle.mock.calls.find(([ch]: unknown[]) => ch === channel);
  if (!call) throw new Error(`No handler registered for ${channel}`);
  return call[1] as (...args: unknown[]) => unknown;
}

function getIpcListener(channel: string): ((...args: unknown[]) => void) | undefined {
  const call = ipcMainMock.on.mock.calls.find(([ch]: unknown[]) => ch === channel);
  return call?.[1] as ((...args: unknown[]) => void) | undefined;
}

describe("registerDemoHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProc = createMockProc();
    mockWriteStream = new MockWriteStream();
  });

  it("is a no-op when isDemoMode is false", () => {
    const cleanup = registerDemoHandlers(makeDeps(false));
    expect(ipcMainMock.handle).not.toHaveBeenCalled();
    expect(displaySessionMock.setDisplayMediaRequestHandler).not.toHaveBeenCalled();
    cleanup();
  });

  it("registers 20 IPC handlers when isDemoMode is true", () => {
    const cleanup = registerDemoHandlers(makeDeps(true));
    expect(ipcMainMock.handle).toHaveBeenCalledTimes(20);
    cleanup();
  });

  it("registers setDisplayMediaRequestHandler on persist:daintree session", () => {
    const cleanup = registerDemoHandlers(makeDeps(true));
    expect(sessionMock.fromPartition).toHaveBeenCalledWith("persist:daintree");
    expect(displaySessionMock.setDisplayMediaRequestHandler).toHaveBeenCalledTimes(1);
    const args = displaySessionMock.setDisplayMediaRequestHandler.mock.calls[0]!;
    expect(typeof args[0]).toBe("function");
    expect(args[1]).toEqual({ useSystemPicker: false });
    cleanup();
  });

  it("display handler invokes callback with request frame", () => {
    const cleanup = registerDemoHandlers(makeDeps(true));
    const [handlerFn] = displaySessionMock.setDisplayMediaRequestHandler.mock.calls[0]!;
    const callback = vi.fn();
    const frame = { id: "frame1" };
    (handlerFn as (req: unknown, cb: (r: unknown) => void) => void)(
      { frame, videoRequested: true },
      callback
    );
    expect(callback).toHaveBeenCalledWith({ video: frame });
    cleanup();
  });

  it("cleanup removes the display media handler", () => {
    const cleanup = registerDemoHandlers(makeDeps(true));
    cleanup();
    expect(displaySessionMock.setDisplayMediaRequestHandler).toHaveBeenLastCalledWith(null);
  });

  it("registers handlers for all demo channels", () => {
    const cleanup = registerDemoHandlers(makeDeps(true));
    const channels = ipcMainMock.handle.mock.calls.map(([ch]: unknown[]) => ch);
    expect(channels).toContain("demo:move-to");
    expect(channels).toContain("demo:click");
    expect(channels).toContain("demo:screenshot");
    expect(channels).toContain("demo:start-capture");
    expect(channels).toContain("demo:stop-capture");
    expect(channels).toContain("demo:get-capture-status");
    expect(channels).toContain("demo:encode");
    cleanup();
  });

  it("registers chunk and stop listeners on ipcMain", () => {
    const cleanup = registerDemoHandlers(makeDeps(true));
    const onChannels = ipcMainMock.on.mock.calls.map(([ch]: unknown[]) => ch);
    expect(onChannels).toContain("demo:capture-chunk");
    expect(onChannels).toContain("demo:capture-stop");
    cleanup();
  });

  it("cleanup removes all 22 handlers", () => {
    const cleanup = registerDemoHandlers(makeDeps(true));
    cleanup();
    expect(ipcMainMock.removeHandler).toHaveBeenCalledTimes(22);
  });

  it("cleanup removes chunk and stop listeners", () => {
    const cleanup = registerDemoHandlers(makeDeps(true));
    cleanup();
    const removed = ipcMainMock.removeListener.mock.calls.map(([ch]: unknown[]) => ch);
    expect(removed).toContain("demo:capture-chunk");
    expect(removed).toContain("demo:capture-stop");
  });

  it("screenshot handler returns Uint8Array with PNG magic bytes", async () => {
    const deps = makeDeps(true);
    registerDemoHandlers(deps);
    const handler = getHandler("demo:screenshot");
    const result = (await handler()) as {
      data: Uint8Array;
      width: number;
      height: number;
    };
    expect(result.data).toBeInstanceOf(Uint8Array);
    expect(result.data[0]).toBe(0x89);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
  });

  describe("handleEncode", () => {
    function getEncodeHandler() {
      registerDemoHandlers(makeDeps(true));
      return getHandler("demo:encode");
    }

    function makeEvent(isDestroyed = false) {
      return {
        sender: {
          send: vi.fn(),
          isDestroyed: vi.fn(() => isDestroyed),
        },
      };
    }

    it("resolves with outputPath and durationMs on success", async () => {
      const handler = getEncodeHandler();
      const event = makeEvent();
      const promise = handler(event, {
        framesDir: "/tmp/frames",
        outputPath: "/tmp/out.mp4",
        preset: "youtube-1080p",
      });
      mockProc.emit("close", 0);
      const result = (await promise) as { outputPath: string; durationMs: number };
      expect(result.outputPath).toBe("/tmp/out.mp4");
      expect(typeof result.durationMs).toBe("number");
    });

    it("rejects when no PNG frames found", async () => {
      const fsMod = await import("fs");
      (fsMod.readdirSync as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      const handler = getEncodeHandler();
      const event = makeEvent();
      await expect(
        handler(event, {
          framesDir: "/tmp/empty",
          outputPath: "/tmp/out.mp4",
          preset: "youtube-4k",
        })
      ).rejects.toThrow("No PNG frames matching frame-NNNNNN.png found");
    });

    it("rejects on non-zero exit code with stderr", async () => {
      const handler = getEncodeHandler();
      const event = makeEvent();
      const promise = handler(event, {
        framesDir: "/tmp/frames",
        outputPath: "/tmp/out.mp4",
        preset: "web-webm",
      });
      mockProc.stderr.emit("data", Buffer.from("Unknown encoder libx264"));
      mockProc.emit("close", 1);
      await expect(promise).rejects.toThrow("ffmpeg exited with code 1");
    });

    it("uses yuv444p and high444 profile for youtube presets", async () => {
      const { spawn: spawnMock } = await import("child_process");
      const handler = getEncodeHandler();
      const event = makeEvent();
      const promise = handler(event, {
        framesDir: "/tmp/frames",
        outputPath: "/tmp/out.mp4",
        preset: "youtube-1080p",
      });
      mockProc.emit("close", 0);
      await promise;
      const args = (spawnMock as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string[];
      expect(args).toContain("yuv444p");
      expect(args).toContain("high444");
    });

    it("uses frame-%06d.png input pattern", async () => {
      const { spawn: spawnMock } = await import("child_process");
      const handler = getEncodeHandler();
      const event = makeEvent();
      const promise = handler(event, {
        framesDir: "/tmp/frames",
        outputPath: "/tmp/out.mp4",
        preset: "youtube-1080p",
      });
      mockProc.emit("close", 0);
      await promise;
      const args = (spawnMock as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string[];
      const inputIdx = args.indexOf("-i");
      expect(args[inputIdx + 1]).toContain("frame-%06d.png");
    });
  });

  describe("MediaRecorder capture pipeline", () => {
    const defaultPayload = {
      fps: 30,
      outputPath: "/tmp/capture/out.webm",
    };

    it("startCapture creates write stream, sends exec start, returns outputPath", async () => {
      const fsMod = await import("fs");
      const deps = makeDeps(true);
      const cleanup = registerDemoHandlers(deps);
      const handler = getHandler("demo:start-capture");

      ipcMainMock.on.mockImplementation(
        (channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === "demo:command-done") {
            setTimeout(() => listener({}, { requestId: "test-request-id" }), 5);
          }
        }
      );

      const result = (await handler({}, defaultPayload)) as { outputPath: string };
      expect(result.outputPath).toBe("/tmp/capture/out.webm");
      expect(fsMod.mkdirSync).toHaveBeenCalledWith("/tmp/capture", { recursive: true });
      expect(fsMod.createWriteStream).toHaveBeenCalledWith("/tmp/capture/out.webm");

      const send = deps.mainWindow!.webContents.send as ReturnType<typeof vi.fn>;
      const startSend = send.mock.calls.find((c) => c[0] === "demo:exec-start-capture");
      expect(startSend).toBeDefined();
      expect(startSend![1]).toMatchObject({
        fps: 30,
        mimeType: "video/webm;codecs=vp9",
      });
      cleanup();
    });

    it("rejects startCapture when already active", async () => {
      ipcMainMock.on.mockImplementation(
        (channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === "demo:command-done") {
            setTimeout(() => listener({}, { requestId: "test-request-id" }), 5);
          }
        }
      );
      const cleanup = registerDemoHandlers(makeDeps(true));
      const handler = getHandler("demo:start-capture");
      await handler({}, defaultPayload);
      await expect(handler({}, defaultPayload)).rejects.toThrow("Capture already in progress");
      cleanup();
    });

    it("capture chunk handler writes buffer to stream for matching captureId", async () => {
      // Build a real registration (not mocked) so we can capture the listener
      const deps = makeDeps(true);
      const cleanup = registerDemoHandlers(deps);
      const startHandler = getHandler("demo:start-capture");

      // Arrange: resolve exec-start-capture
      let doneListener: ((...args: unknown[]) => void) | undefined;
      ipcMainMock.on.mock.calls.forEach((c: unknown[]) => {
        if (c[0] === "demo:command-done") {
          doneListener = c[1] as (...args: unknown[]) => void;
        }
      });
      const startPromise = startHandler({}, defaultPayload);
      // find the latest demo:command-done listener added by sendCommandAndAwait
      setTimeout(() => {
        const latest = ipcMainMock.on.mock.calls
          .filter((c: unknown[]) => c[0] === "demo:command-done")
          .at(-1);
        (latest?.[1] as (...args: unknown[]) => void)?.({}, { requestId: "test-request-id" });
      }, 0);
      await startPromise;

      const chunkListener = getIpcListener("demo:capture-chunk");
      expect(chunkListener).toBeDefined();
      const data = new Uint8Array([1, 2, 3, 4]);
      chunkListener!({}, { captureId: "test-request-id", data });
      expect(mockWriteStream.write).toHaveBeenCalledTimes(1);
      cleanup();
      // doneListener is captured but unused; simulateCommandDone retained for other tests
      void doneListener;
    });

    it("stale captureId chunks are ignored", async () => {
      ipcMainMock.on.mockImplementation(
        (channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === "demo:command-done") {
            setTimeout(() => listener({}, { requestId: "test-request-id" }), 5);
          }
        }
      );
      const cleanup = registerDemoHandlers(makeDeps(true));
      const handler = getHandler("demo:start-capture");
      await handler({}, defaultPayload);
      const chunkListener = getIpcListener("demo:capture-chunk");
      chunkListener!({}, { captureId: "bogus", data: new Uint8Array([9]) });
      expect(mockWriteStream.write).not.toHaveBeenCalled();
      cleanup();
    });

    it("stop flow: exec-stop sent then capture-stop finalizes writeStream and resolves", async () => {
      ipcMainMock.on.mockImplementation(
        (channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === "demo:command-done") {
            setTimeout(() => listener({}, { requestId: "test-request-id" }), 5);
          }
        }
      );
      const deps = makeDeps(true);
      const cleanup = registerDemoHandlers(deps);

      await (getHandler("demo:start-capture") as (...a: unknown[]) => Promise<unknown>)(
        {},
        defaultPayload
      );
      const stopPromise = (
        getHandler("demo:stop-capture") as (...a: unknown[]) => Promise<{
          outputPath: string;
          frameCount: number;
        }>
      )({});

      // Simulate renderer posting the final DEMO_CAPTURE_STOP
      setTimeout(() => {
        const stopListener = getIpcListener("demo:capture-stop");
        stopListener!({}, { captureId: "test-request-id", frameCount: 7 });
      }, 10);

      const result = await stopPromise;
      expect(mockWriteStream.end).toHaveBeenCalled();
      expect(result.outputPath).toBe("/tmp/capture/out.webm");
      expect(result.frameCount).toBe(7);
      cleanup();
    });

    it("stopCapture rejects when no capture in progress", async () => {
      const cleanup = registerDemoHandlers(makeDeps(true));
      const handler = getHandler("demo:stop-capture");
      await expect(handler({})).rejects.toThrow("No capture in progress");
      cleanup();
    });

    it("getCaptureStatus returns inactive before start", async () => {
      const cleanup = registerDemoHandlers(makeDeps(true));
      const status = (await (
        getHandler("demo:get-capture-status") as () => Promise<unknown>
      )()) as {
        active: boolean;
        frameCount: number;
        outputPath: string | null;
      };
      expect(status.active).toBe(false);
      expect(status.outputPath).toBeNull();
      cleanup();
    });

    it("getCaptureStatus reports active after start", async () => {
      ipcMainMock.on.mockImplementation(
        (channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === "demo:command-done") {
            setTimeout(() => listener({}, { requestId: "test-request-id" }), 5);
          }
        }
      );
      const cleanup = registerDemoHandlers(makeDeps(true));
      await (getHandler("demo:start-capture") as (...a: unknown[]) => Promise<unknown>)(
        {},
        defaultPayload
      );
      const status = (await (
        getHandler("demo:get-capture-status") as () => Promise<unknown>
      )()) as {
        active: boolean;
        outputPath: string | null;
      };
      expect(status.active).toBe(true);
      expect(status.outputPath).toBe("/tmp/capture/out.webm");
      cleanup();
    });

    it("error from renderer on capture-stop rejects finalize promise", async () => {
      ipcMainMock.on.mockImplementation(
        (channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === "demo:command-done") {
            setTimeout(() => listener({}, { requestId: "test-request-id" }), 5);
          }
        }
      );
      const cleanup = registerDemoHandlers(makeDeps(true));
      await (getHandler("demo:start-capture") as (...a: unknown[]) => Promise<unknown>)(
        {},
        defaultPayload
      );
      const stopPromise = (
        getHandler("demo:stop-capture") as (...a: unknown[]) => Promise<unknown>
      )({});
      setTimeout(() => {
        const stopListener = getIpcListener("demo:capture-stop");
        stopListener!({}, { captureId: "test-request-id", frameCount: 0, error: "boom" });
      }, 10);
      await expect(stopPromise).rejects.toThrow("Capture failed: boom");
      cleanup();
    });
  });

  it("moveTo handler sends exec event with requestId and awaits done", async () => {
    ipcMainMock.on.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
      if (channel === "demo:command-done") {
        setTimeout(() => listener({}, { requestId: "test-request-id" }), 10);
      }
    });
    const deps = makeDeps(true);
    registerDemoHandlers(deps);
    const handler = getHandler("demo:move-to");
    const result = await handler({}, { x: 25, y: 75, durationMs: 500 });
    expect(result).toBeUndefined();
    expect(deps.mainWindow!.webContents.send as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      "demo:exec-move-to",
      { x: 25, y: 75, durationMs: 500, requestId: "test-request-id" }
    );
  });

  it("annotate handler returns pre-generated id", async () => {
    ipcMainMock.on.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
      if (channel === "demo:command-done") {
        setTimeout(() => listener({}, { requestId: "test-request-id" }), 10);
      }
    });
    const deps = makeDeps(true);
    registerDemoHandlers(deps);
    const handler = getHandler("demo:annotate");
    const result = await handler({}, { selector: ".my-el", text: "Hello", position: "top" });
    expect(result).toEqual({ id: "test-request-id" });
  });
});
