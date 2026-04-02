import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock, BrowserWindow: { getAllWindows: () => [] } }));

vi.mock("crypto", () => ({
  randomBytes: vi.fn(() => ({ toString: () => "test-request-id" })),
}));

vi.mock("fs", () => ({
  readdirSync: vi.fn(() => ["frame-000001.png", "frame-000002.png", "frame-000003.png"]),
  mkdirSync: vi.fn(),
}));

class MockStdin extends EventEmitter {
  write = vi.fn(() => true);
  end = vi.fn();
}

let mockProc: EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: MockStdin;
  kill: ReturnType<typeof vi.fn>;
};

function createMockProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: MockStdin;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new MockStdin();
  proc.kill = vi.fn();
  return proc;
}

vi.mock("child_process", () => ({
  spawn: vi.fn(() => mockProc),
}));

import { registerDemoHandlers } from "../demo.js";
import type { HandlerDependencies } from "../../types.js";
import type { BrowserWindow } from "electron";

const FRAME_W = 1920;
const FRAME_H = 1080;
// Use a small buffer for tests — real BGRA would be FRAME_W * FRAME_H * 4 but that causes OOM in test workers
const BGRA_BUFFER = Buffer.alloc(16);

function makeMockImage() {
  const img = {
    toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    getSize: () => ({ width: FRAME_W, height: FRAME_H }),
    toBitmap: () => BGRA_BUFFER,
    resize: vi.fn().mockReturnThis(),
  };
  return img;
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

describe("registerDemoHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProc = createMockProc();
  });

  it("is a no-op when isDemoMode is false", () => {
    const cleanup = registerDemoHandlers(makeDeps(false));
    expect(ipcMainMock.handle).not.toHaveBeenCalled();
    cleanup();
  });

  it("registers 22 IPC handlers when isDemoMode is true", () => {
    const cleanup = registerDemoHandlers(makeDeps(true));
    expect(ipcMainMock.handle).toHaveBeenCalledTimes(22);
    cleanup();
  });

  it("registers handlers for all demo channels", () => {
    const cleanup = registerDemoHandlers(makeDeps(true));
    const channels = ipcMainMock.handle.mock.calls.map(([ch]: unknown[]) => ch);
    expect(channels).toContain("demo:move-to");
    expect(channels).toContain("demo:move-to-selector");
    expect(channels).toContain("demo:click");
    expect(channels).toContain("demo:screenshot");
    expect(channels).toContain("demo:type");
    expect(channels).toContain("demo:set-zoom");
    expect(channels).toContain("demo:wait-for-selector");
    expect(channels).toContain("demo:pause");
    expect(channels).toContain("demo:resume");
    expect(channels).toContain("demo:sleep");
    expect(channels).toContain("demo:start-capture");
    expect(channels).toContain("demo:stop-capture");
    expect(channels).toContain("demo:get-capture-status");
    expect(channels).toContain("demo:encode");
    expect(channels).toContain("demo:scroll");
    expect(channels).toContain("demo:drag");
    expect(channels).toContain("demo:press-key");
    expect(channels).toContain("demo:spotlight");
    expect(channels).toContain("demo:dismiss-spotlight");
    expect(channels).toContain("demo:annotate");
    expect(channels).toContain("demo:dismiss-annotation");
    expect(channels).toContain("demo:wait-for-idle");
    cleanup();
  });

  it("cleanup removes all 22 handlers", () => {
    const cleanup = registerDemoHandlers(makeDeps(true));
    cleanup();
    expect(ipcMainMock.removeHandler).toHaveBeenCalledTimes(22);
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:move-to");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:move-to-selector");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:click");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:screenshot");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:type");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:set-zoom");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:wait-for-selector");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:pause");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:resume");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:sleep");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:scroll");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:drag");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:press-key");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:spotlight");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:dismiss-spotlight");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:annotate");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:dismiss-annotation");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:wait-for-idle");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:start-capture");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:stop-capture");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:get-capture-status");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("demo:encode");
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

  describe("handleEncode", () => {
    function getEncodeHandler() {
      registerDemoHandlers(makeDeps(true));
      const [, handler] =
        ipcMainMock.handle.mock.calls.find(([ch]: unknown[]) => ch === "demo:encode") ?? [];
      return handler;
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
      const result = await promise;

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

    it("rejects old underscore-format frame names", async () => {
      const fsMod = await import("fs");
      (fsMod.readdirSync as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        "frame_0001.png",
        "frame_0002.png",
        "frame_0003.png",
      ]);

      const handler = getEncodeHandler();
      const event = makeEvent();

      await expect(
        handler(event, {
          framesDir: "/tmp/old-format",
          outputPath: "/tmp/out.mp4",
          preset: "youtube-4k",
        })
      ).rejects.toThrow("No PNG frames matching frame-NNNNNN.png found");
    });

    it("rejects on spawn error event", async () => {
      const handler = getEncodeHandler();
      const event = makeEvent();

      const promise = handler(event, {
        framesDir: "/tmp/frames",
        outputPath: "/tmp/out.mp4",
        preset: "web-webm",
      });

      mockProc.emit("error", new Error("spawn ENOENT"));
      await expect(promise).rejects.toThrow("Encode failed: spawn ENOENT");
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

    it("creates output directory before encoding", async () => {
      const fsMod = await import("fs");
      const handler = getEncodeHandler();
      const event = makeEvent();

      const promise = handler(event, {
        framesDir: "/tmp/frames",
        outputPath: "/tmp/output/video.mp4",
        preset: "youtube-1080p",
      });

      mockProc.emit("close", 0);
      await promise;

      expect(fsMod.mkdirSync).toHaveBeenCalledWith("/tmp/output", { recursive: true });
    });

    it("sends progress events via IPC", async () => {
      const handler = getEncodeHandler();
      const event = makeEvent(false);

      const promise = handler(event, {
        framesDir: "/tmp/frames",
        outputPath: "/tmp/out.mp4",
        preset: "youtube-1080p",
      });

      mockProc.stdout.emit("data", Buffer.from("frame=2\nfps=30\nprogress=continue\n"));
      mockProc.emit("close", 0);
      await promise;

      expect(event.sender.send).toHaveBeenCalledWith(
        "demo:encode:progress",
        expect.objectContaining({
          frame: 2,
          fps: 30,
          percentComplete: expect.any(Number),
          etaSeconds: expect.any(Number),
        })
      );
    });

    it("does not send progress when sender is destroyed", async () => {
      const handler = getEncodeHandler();
      const event = makeEvent(true);

      const promise = handler(event, {
        framesDir: "/tmp/frames",
        outputPath: "/tmp/out.mp4",
        preset: "youtube-1080p",
      });

      mockProc.stdout.emit("data", Buffer.from("frame=2\nfps=30\nprogress=continue\n"));
      mockProc.emit("close", 0);
      await promise;

      expect(event.sender.send).not.toHaveBeenCalled();
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

      const args = (spawnMock as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
      expect(args).toContain("yuv444p");
      expect(args).toContain("high444");
      expect(args).not.toContain("yuv420p");
    });

    it("uses yuv444p for web-webm preset with row-mt", async () => {
      const { spawn: spawnMock } = await import("child_process");
      // Need a fresh mockProc since the encode handler uses the current one
      mockProc = createMockProc();
      const handler = getEncodeHandler();
      const event = makeEvent();

      const promise = handler(event, {
        framesDir: "/tmp/frames",
        outputPath: "/tmp/out.webm",
        preset: "web-webm",
      });

      mockProc.emit("close", 0);
      await promise;

      const lastCall = (spawnMock as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      const args = lastCall[1] as string[];
      expect(args).toContain("yuv444p");
      expect(args).toContain("1");
      const rowMtIdx = args.indexOf("-row-mt");
      expect(rowMtIdx).toBeGreaterThan(-1);
    });

    it("uses frame-%06d.png input pattern matching capture output", async () => {
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
      expect(inputIdx).toBeGreaterThan(-1);
      expect(args[inputIdx + 1]).toContain("frame-%06d.png");
    });
  });

  it("moveTo handler sends exec event with requestId and awaits done", async () => {
    const deps = makeDeps(true);
    registerDemoHandlers(deps);

    const [, handler] =
      ipcMainMock.handle.mock.calls.find(([ch]: unknown[]) => ch === "demo:move-to") ?? [];

    ipcMainMock.on.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
      if (channel === "demo:command-done") {
        setTimeout(() => {
          listener({}, { requestId: "test-request-id" });
        }, 10);
      }
    });

    const result = await handler({}, { x: 25, y: 75, durationMs: 500 });
    expect(result).toBeUndefined();
    expect(deps.mainWindow!.webContents.send as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      "demo:exec-move-to",
      { x: 25, y: 75, durationMs: 500, requestId: "test-request-id" }
    );
  });

  it("moveToSelector handler sends exec event and awaits done", async () => {
    const deps = makeDeps(true);
    registerDemoHandlers(deps);

    const [, handler] =
      ipcMainMock.handle.mock.calls.find(([ch]: unknown[]) => ch === "demo:move-to-selector") ?? [];

    ipcMainMock.on.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
      if (channel === "demo:command-done") {
        setTimeout(() => {
          listener({}, { requestId: "test-request-id" });
        }, 10);
      }
    });

    const result = await handler(
      {},
      { selector: ".my-btn", durationMs: 300, offsetX: 5, offsetY: -3 }
    );
    expect(result).toBeUndefined();
    expect(deps.mainWindow!.webContents.send as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      "demo:exec-move-to-selector",
      {
        selector: ".my-btn",
        durationMs: 300,
        offsetX: 5,
        offsetY: -3,
        requestId: "test-request-id",
      }
    );
  });

  it("annotate handler returns pre-generated id", async () => {
    const deps = makeDeps(true);
    registerDemoHandlers(deps);

    const [, handler] =
      ipcMainMock.handle.mock.calls.find(([ch]: unknown[]) => ch === "demo:annotate") ?? [];

    ipcMainMock.on.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
      if (channel === "demo:command-done") {
        setTimeout(() => {
          listener({}, { requestId: "test-request-id" });
        }, 10);
      }
    });

    const result = await handler({}, { selector: ".my-el", text: "Hello", position: "top" });
    expect(result).toEqual({ id: "test-request-id" });
    expect(deps.mainWindow!.webContents.send as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      "demo:exec-annotate",
      expect.objectContaining({ selector: ".my-el", text: "Hello", id: "test-request-id" })
    );
  });

  it("annotate handler uses provided id when given", async () => {
    const deps = makeDeps(true);
    registerDemoHandlers(deps);

    const [, handler] =
      ipcMainMock.handle.mock.calls.find(([ch]: unknown[]) => ch === "demo:annotate") ?? [];

    ipcMainMock.on.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
      if (channel === "demo:command-done") {
        setTimeout(() => {
          listener({}, { requestId: "test-request-id" });
        }, 10);
      }
    });

    const result = await handler({}, { selector: ".my-el", text: "Hello", id: "custom-id" });
    expect(result).toEqual({ id: "custom-id" });
  });

  it("scroll handler sends exec-scroll event and awaits done", async () => {
    const deps = makeDeps(true);
    registerDemoHandlers(deps);

    const [, handler] =
      ipcMainMock.handle.mock.calls.find(([ch]: unknown[]) => ch === "demo:scroll") ?? [];

    ipcMainMock.on.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
      if (channel === "demo:command-done") {
        setTimeout(() => {
          listener({}, { requestId: "test-request-id" });
        }, 10);
      }
    });

    const result = await handler({}, { selector: ".content" });
    expect(result).toBeUndefined();
    expect(deps.mainWindow!.webContents.send as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      "demo:exec-scroll",
      { selector: ".content", requestId: "test-request-id" }
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
    expect(deps.mainWindow!.webContents.send as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      "demo:exec-sleep",
      { durationMs: 1000, requestId: "test-request-id" }
    );
  });
});

describe("frame capture pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProc = createMockProc();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const defaultPayload = {
    fps: 30,
    outputPath: "/tmp/capture/out.mp4",
    preset: "youtube-1080p" as const,
  };

  it("startCapture spawns ffmpeg with rawvideo stdin args and returns outputPath", async () => {
    const { spawn: spawnMock } = await import("child_process");
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const handler = getHandler("demo:start-capture");
    const result = (await handler({}, defaultPayload)) as { outputPath: string };

    expect(result.outputPath).toBe("/tmp/capture/out.mp4");

    const args = (spawnMock as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain("-f");
    expect(args).toContain("rawvideo");
    expect(args).toContain("-pix_fmt");
    expect(args[args.indexOf("-pix_fmt") + 1]).toBe("bgra");
    expect(args).toContain("-video_size");
    expect(args[args.indexOf("-video_size") + 1]).toBe("1920x1080");
    expect(args).toContain("-framerate");
    expect(args[args.indexOf("-framerate") + 1]).toBe("30");
    expect(args).toContain("-i");
    expect(args[args.indexOf("-i") + 1]).toBe("pipe:0");
    expect(args).toContain("-fps_mode");
    expect(args).toContain("cfr");

    cleanup();
  });

  it("creates output directory before spawning ffmpeg", async () => {
    const fsMod = await import("fs");
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const handler = getHandler("demo:start-capture");
    await handler({}, defaultPayload);

    expect(fsMod.mkdirSync).toHaveBeenCalledWith("/tmp/capture", { recursive: true });

    cleanup();
  });

  it("captures first frame and calls resize for HiDPI normalization", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const handler = getHandler("demo:start-capture");
    await handler({}, defaultPayload);

    const capturePage = deps.mainWindow!.webContents.capturePage as ReturnType<typeof vi.fn>;
    expect(capturePage).toHaveBeenCalled();

    // The mock image's resize should have been called with logical dims
    const mockImage = await capturePage.mock.results[0].value;
    expect(mockImage.resize).toHaveBeenCalledWith({
      width: 1920,
      height: 1080,
      quality: "best",
    });

    cleanup();
  });

  it("ticker writes BGRA buffer to ffmpeg stdin", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const handler = getHandler("demo:start-capture");
    await handler({}, defaultPayload);

    // Advance timer to trigger the ticker
    await vi.advanceTimersByTimeAsync(34);

    expect(mockProc.stdin.write).toHaveBeenCalledWith(BGRA_BUFFER);

    cleanup();
  });

  it("getCaptureStatus returns inactive before start", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const handler = getHandler("demo:get-capture-status");
    const status = (await handler({})) as {
      active: boolean;
      frameCount: number;
      outputPath: string | null;
    };

    expect(status.active).toBe(false);
    expect(status.frameCount).toBe(0);
    expect(status.outputPath).toBeNull();

    cleanup();
  });

  it("getCaptureStatus reports active while capturing", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const startHandler = getHandler("demo:start-capture");
    await startHandler({}, defaultPayload);

    // Write one frame via ticker
    await vi.advanceTimersByTimeAsync(34);

    const statusHandler = getHandler("demo:get-capture-status");
    const status = (await statusHandler({})) as {
      active: boolean;
      frameCount: number;
      outputPath: string | null;
    };

    expect(status.active).toBe(true);
    expect(status.frameCount).toBe(1);
    expect(status.outputPath).toBe("/tmp/capture/out.mp4");

    cleanup();
  });

  it("stopCapture calls stdin.end and resolves with outputPath and frameCount", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const startHandler = getHandler("demo:start-capture");
    await startHandler({}, defaultPayload);

    // Write one frame
    await vi.advanceTimersByTimeAsync(34);

    const stopHandler = getHandler("demo:stop-capture");
    const stopPromise = stopHandler({}) as Promise<{ outputPath: string; frameCount: number }>;

    expect(mockProc.stdin.end).toHaveBeenCalled();

    // Simulate ffmpeg closing successfully
    mockProc.emit("close", 0);

    const result = await stopPromise;
    expect(result.outputPath).toBe("/tmp/capture/out.mp4");
    expect(result.frameCount).toBe(1);

    cleanup();
  });

  it("stopCapture rejects when no capture in progress", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const stopHandler = getHandler("demo:stop-capture");
    await expect(stopHandler({})).rejects.toThrow("No capture in progress");

    cleanup();
  });

  it("rejects startCapture when already active", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const handler = getHandler("demo:start-capture");
    await handler({}, defaultPayload);

    await expect(handler({}, defaultPayload)).rejects.toThrow("Capture already in progress");

    cleanup();
  });

  it("auto-stops when maxFrames is reached", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const startHandler = getHandler("demo:start-capture");
    await startHandler({}, { ...defaultPayload, maxFrames: 2 });

    // Write first frame
    await vi.advanceTimersByTimeAsync(34);
    expect(mockProc.stdin.write).toHaveBeenCalledTimes(1);

    // Write second frame — should trigger auto-stop
    await vi.advanceTimersByTimeAsync(34);
    expect(mockProc.stdin.write).toHaveBeenCalledTimes(2);
    expect(mockProc.stdin.end).toHaveBeenCalled();

    cleanup();
  });

  it("handles backpressure by pausing ticker and resuming on drain", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    // First write returns false (backpressure)
    mockProc.stdin.write.mockReturnValueOnce(false);

    const startHandler = getHandler("demo:start-capture");
    await startHandler({}, defaultPayload);

    // First tick — write returns false
    await vi.advanceTimersByTimeAsync(34);
    expect(mockProc.stdin.write).toHaveBeenCalledTimes(1);

    // More ticks should NOT produce writes (ticker paused)
    await vi.advanceTimersByTimeAsync(34);
    expect(mockProc.stdin.write).toHaveBeenCalledTimes(1);

    // Emit drain — should resume ticker
    mockProc.stdin.emit("drain");

    // Next tick after drain should write again
    await vi.advanceTimersByTimeAsync(34);
    expect(mockProc.stdin.write).toHaveBeenCalledTimes(2);

    cleanup();
  });

  it("cleanup stops capture and kills ffmpeg process", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const startHandler = getHandler("demo:start-capture");
    await startHandler({}, defaultPayload);

    cleanup();

    expect(mockProc.stdin.end).toHaveBeenCalled();
    expect(mockProc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("rejects finalize promise when ffmpeg exits with non-zero code", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const startHandler = getHandler("demo:start-capture");
    await startHandler({}, defaultPayload);

    const stopHandler = getHandler("demo:stop-capture");
    const stopPromise = stopHandler({}) as Promise<unknown>;

    mockProc.emit("close", 1);

    await expect(stopPromise).rejects.toThrow("ffmpeg exited with code 1");

    cleanup();
  });

  it("rejects finalize promise on ffmpeg spawn error", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const startHandler = getHandler("demo:start-capture");
    await startHandler({}, defaultPayload);

    // Stop first to get the finalize promise, then emit error
    const stopHandler = getHandler("demo:stop-capture");
    const stopPromise = stopHandler({}) as Promise<unknown>;

    mockProc.emit("error", new Error("spawn ENOENT"));

    await expect(stopPromise).rejects.toThrow("Capture encode failed: spawn ENOENT");

    cleanup();
  });

  it("uses capture preset options including yuv444p for youtube-1080p", async () => {
    const { spawn: spawnMock } = await import("child_process");
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const handler = getHandler("demo:start-capture");
    await handler({}, defaultPayload);

    const args = (spawnMock as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain("yuv444p");
    expect(args).toContain("high444");
    expect(args).toContain("libx264");
    expect(args).not.toContain("yuv420p");

    cleanup();
  });

  it("uses web-webm capture preset with VP9 and yuv444p", async () => {
    const { spawn: spawnMock } = await import("child_process");
    mockProc = createMockProc();
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const handler = getHandler("demo:start-capture");
    await handler({}, { ...defaultPayload, preset: "web-webm", outputPath: "/tmp/out.webm" });

    const args = (spawnMock as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain("libvpx-vp9");
    expect(args).toContain("yuv444p");
    expect(args).toContain("-row-mt");

    cleanup();
  });

  it("supports start/stop/restart cycle with fresh state", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const startHandler = getHandler("demo:start-capture");
    const stopHandler = getHandler("demo:stop-capture");

    // First session
    await startHandler({}, defaultPayload);
    await vi.advanceTimersByTimeAsync(34);
    const stopPromise1 = stopHandler({}) as Promise<{ outputPath: string; frameCount: number }>;
    mockProc.emit("close", 0);
    const result1 = await stopPromise1;
    expect(result1.outputPath).toBe("/tmp/capture/out.mp4");
    expect(result1.frameCount).toBe(1);

    // Second session — need fresh mockProc
    mockProc = createMockProc();
    const { spawn: spawnMock } = await import("child_process");
    (spawnMock as ReturnType<typeof vi.fn>).mockReturnValue(mockProc);

    await startHandler({}, { ...defaultPayload, outputPath: "/tmp/capture/out2.mp4" });
    await vi.advanceTimersByTimeAsync(34);
    await vi.advanceTimersByTimeAsync(34);
    const stopPromise2 = stopHandler({}) as Promise<{ outputPath: string; frameCount: number }>;
    mockProc.emit("close", 0);
    const result2 = await stopPromise2;
    expect(result2.outputPath).toBe("/tmp/capture/out2.mp4");
    expect(result2.frameCount).toBe(2);

    cleanup();
  });

  it("rejects startCapture when first capturePage fails", async () => {
    const deps = makeDeps(true);
    const capturePage = deps.mainWindow!.webContents.capturePage as ReturnType<typeof vi.fn>;
    capturePage.mockRejectedValueOnce(new Error("GPU context lost"));

    const cleanup = registerDemoHandlers(deps);

    const { spawn: spawnMock } = await import("child_process");
    const spawnCallsBefore = (spawnMock as ReturnType<typeof vi.fn>).mock.calls.length;

    const handler = getHandler("demo:start-capture");
    await expect(handler({}, defaultPayload)).rejects.toThrow("GPU context lost");

    // ffmpeg should not have been spawned
    expect((spawnMock as ReturnType<typeof vi.fn>).mock.calls.length).toBe(spawnCallsBefore);

    cleanup();
  });
});
