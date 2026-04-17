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

const fsMocks = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require("events") as typeof import("events");
  class MockWriteStream extends EE {
    write = vi.fn(() => true);
    end = vi.fn(() => {
      queueMicrotask(() => this.emit("finish"));
    });
    destroy = vi.fn();
    destroyed = false;
  }
  const state: { last: MockWriteStream | null } = { last: null };
  return {
    MockWriteStream,
    state,
    readdirSync: vi.fn(() => ["frame-000001.png", "frame-000002.png", "frame-000003.png"]),
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn(() => {
      state.last = new MockWriteStream();
      return state.last;
    }),
  };
});

vi.mock("fs", () => ({
  readdirSync: fsMocks.readdirSync,
  mkdirSync: fsMocks.mkdirSync,
  createWriteStream: fsMocks.createWriteStream,
}));

let mockProc: EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
};

function createMockProc() {
  const stdin = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  stdin.write = vi.fn(() => true);
  stdin.end = vi.fn();
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: typeof stdin;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = stdin;
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

function makeMockImage() {
  const img = {
    toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    getSize: () => ({ width: FRAME_W, height: FRAME_H }),
    toBitmap: () => Buffer.alloc(16),
    resize: vi.fn().mockReturnThis(),
  };
  return img;
}

function makeDeps(
  isDemoMode: boolean,
  setDisplayMediaRequestHandler: ReturnType<typeof vi.fn> = vi.fn()
): HandlerDependencies {
  return {
    mainWindow: {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: vi.fn(),
        capturePage: vi.fn().mockResolvedValue(makeMockImage()),
        session: { setDisplayMediaRequestHandler },
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

describe("frame capture pipeline (MediaRecorder)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.state.last = null;
    mockProc = createMockProc();
  });

  const defaultPayload = {
    fps: 30,
    outputPath: "/tmp/capture/out.webm",
  };

  function getIpcListener(channel: string): ((...args: unknown[]) => void) | null {
    const calls = ipcMainMock.on.mock.calls as Array<[string, (...args: unknown[]) => void]>;
    // Find the most recent registration for this channel.
    for (let i = calls.length - 1; i >= 0; i--) {
      if (calls[i]![0] === channel) return calls[i]![1];
    }
    return null;
  }

  it("startCapture creates output dir, opens write stream, and signals renderer", async () => {
    const fsMod = await import("fs");
    const setDisplayHandler = vi.fn();
    const deps = makeDeps(true, setDisplayHandler);
    const cleanup = registerDemoHandlers(deps);

    const handler = getHandler("demo:start-capture");
    const result = (await handler({}, defaultPayload)) as { outputPath: string };

    expect(result.outputPath).toBe("/tmp/capture/out.webm");
    expect(fsMod.mkdirSync).toHaveBeenCalledWith("/tmp/capture", { recursive: true });
    expect(fsMod.createWriteStream).toHaveBeenCalledWith("/tmp/capture/out.webm");
    expect(setDisplayHandler).toHaveBeenCalledTimes(1);
    expect(setDisplayHandler.mock.calls[0]![1]).toEqual({ useSystemPicker: false });

    const send = deps.mainWindow!.webContents.send as ReturnType<typeof vi.fn>;
    const startCall = send.mock.calls.find(([ch]) => ch === "demo:capture-start");
    expect(startCall).toBeDefined();
    expect(startCall![1]).toMatchObject({ captureId: expect.any(String), fps: 30 });

    cleanup();
  });

  it("display media handler auto-approves by passing request.frame", async () => {
    const setDisplayHandler = vi.fn();
    const deps = makeDeps(true, setDisplayHandler);
    const cleanup = registerDemoHandlers(deps);

    const handler = getHandler("demo:start-capture");
    await handler({}, defaultPayload);

    const handlerFn = setDisplayHandler.mock.calls[0]![0] as (
      request: { frame: unknown },
      callback: (response: { video?: unknown }) => void
    ) => void;

    const callback = vi.fn();
    const fakeFrame = { url: "app://test" };
    handlerFn({ frame: fakeFrame }, callback);
    expect(callback).toHaveBeenCalledWith({ video: fakeFrame });

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

  it("chunk listener writes transferred ArrayBuffer to file stream", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const handler = getHandler("demo:start-capture");
    await handler({}, defaultPayload);

    const send = deps.mainWindow!.webContents.send as ReturnType<typeof vi.fn>;
    const startCall = send.mock.calls.find(([ch]) => ch === "demo:capture-start")!;
    const { captureId } = startCall[1] as { captureId: string };

    const chunkListener = getIpcListener("demo:capture-chunk")!;
    const data = new Uint8Array([1, 2, 3, 4]).buffer;
    chunkListener({}, { captureId }, data);

    expect(fsMocks.state.last!.write).toHaveBeenCalledTimes(1);
    const written = fsMocks.state.last!.write.mock.calls[0]![0] as Buffer;
    expect(Buffer.isBuffer(written)).toBe(true);
    expect(written.length).toBe(4);
    expect(written[0]).toBe(1);
    expect(written[3]).toBe(4);

    cleanup();
  });

  it("chunk listener ignores stale captureId", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const handler = getHandler("demo:start-capture");
    await handler({}, defaultPayload);

    const chunkListener = getIpcListener("demo:capture-chunk")!;
    chunkListener({}, { captureId: "not-matching" }, new Uint8Array([9]).buffer);

    expect(fsMocks.state.last!.write).not.toHaveBeenCalled();

    cleanup();
  });

  it("chunk listener ignores empty or missing buffer", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const handler = getHandler("demo:start-capture");
    await handler({}, defaultPayload);

    const send = deps.mainWindow!.webContents.send as ReturnType<typeof vi.fn>;
    const startCall = send.mock.calls.find(([ch]) => ch === "demo:capture-start")!;
    const { captureId } = startCall[1] as { captureId: string };

    const chunkListener = getIpcListener("demo:capture-chunk")!;
    chunkListener({}, { captureId });
    chunkListener({}, { captureId }, new ArrayBuffer(0));

    expect(fsMocks.state.last!.write).not.toHaveBeenCalled();

    cleanup();
  });

  it("stopCapture sends stop signal but does NOT resolve until renderer finalizes", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const startHandler = getHandler("demo:start-capture");
    await startHandler({}, defaultPayload);

    const send = deps.mainWindow!.webContents.send as ReturnType<typeof vi.fn>;
    const startCall = send.mock.calls.find(([ch]) => ch === "demo:capture-start")!;
    const { captureId } = startCall[1] as { captureId: string };

    const stopHandler = getHandler("demo:stop-capture");
    const stopPromise = stopHandler({}) as Promise<{
      outputPath: string;
      frameCount: number;
    }>;

    // Stop signal should have been sent to the renderer.
    const stopCall = send.mock.calls.find(([ch]) => ch === "demo:capture-stop");
    expect(stopCall).toBeDefined();
    expect(stopCall![1]).toEqual({ captureId });

    // Verify promise is still pending — critical W3C ordering invariant.
    let resolved = false;
    void stopPromise.then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);

    // Simulate the renderer's onstop handler sending DEMO_CAPTURE_FINISHED.
    const finishListener = getIpcListener("demo:capture-finished")!;
    finishListener({}, { captureId });

    // Now the write stream's .end() was called; its 'finish' microtask resolves the promise.
    expect(fsMocks.state.last!.end).toHaveBeenCalled();

    const result = await stopPromise;
    expect(result.outputPath).toBe("/tmp/capture/out.webm");
    expect(result.frameCount).toBe(0);

    cleanup();
  });

  it("finish listener ignores stale captureId", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const startHandler = getHandler("demo:start-capture");
    await startHandler({}, defaultPayload);

    const finishListener = getIpcListener("demo:capture-finished")!;
    finishListener({}, { captureId: "wrong" });

    expect(fsMocks.state.last!.end).not.toHaveBeenCalled();

    cleanup();
  });

  it("stopCapture rejects when no capture in progress", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const stopHandler = getHandler("demo:stop-capture");
    await expect(stopHandler({})).rejects.toThrow("No capture in progress");

    cleanup();
  });

  it("getCaptureStatus reflects active state with frameCount=0", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const statusHandler = getHandler("demo:get-capture-status");

    const before = (await statusHandler({})) as {
      active: boolean;
      frameCount: number;
      outputPath: string | null;
    };
    expect(before).toEqual({ active: false, frameCount: 0, outputPath: null });

    const startHandler = getHandler("demo:start-capture");
    await startHandler({}, defaultPayload);

    const during = (await statusHandler({})) as {
      active: boolean;
      frameCount: number;
      outputPath: string | null;
    };
    expect(during.active).toBe(true);
    expect(during.frameCount).toBe(0);
    expect(during.outputPath).toBe("/tmp/capture/out.webm");

    cleanup();
  });

  it("cleanup destroys file stream and removes capture listeners", async () => {
    const setDisplayHandler = vi.fn();
    const deps = makeDeps(true, setDisplayHandler);
    const cleanup = registerDemoHandlers(deps);

    const startHandler = getHandler("demo:start-capture");
    await startHandler({}, defaultPayload);

    cleanup();

    expect(fsMocks.state.last!.destroy).toHaveBeenCalled();
    // Display media handler should be cleared on cleanup.
    expect(setDisplayHandler).toHaveBeenCalledWith(null);
  });

  it("safety timeout force-stops capture after max duration", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps(true);
      const cleanup = registerDemoHandlers(deps);

      const startHandler = getHandler("demo:start-capture");
      await startHandler({}, defaultPayload);

      const send = deps.mainWindow!.webContents.send as ReturnType<typeof vi.fn>;
      const stopCallsBefore = send.mock.calls.filter(([ch]) => ch === "demo:capture-stop").length;

      // Fast-forward past the 10-minute max.
      vi.advanceTimersByTime(10 * 60 * 1000 + 10);

      const stopCallsAfter = send.mock.calls.filter(([ch]) => ch === "demo:capture-stop").length;
      expect(stopCallsAfter).toBe(stopCallsBefore + 1);

      cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("finalize timeout rejects the stop promise if renderer never finalizes", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps(true);
      const cleanup = registerDemoHandlers(deps);

      const startHandler = getHandler("demo:start-capture");
      await startHandler({}, defaultPayload);

      const stopHandler = getHandler("demo:stop-capture");
      const stopPromise = stopHandler({}) as Promise<unknown>;

      // Renderer never sends DEMO_CAPTURE_FINISHED.
      vi.advanceTimersByTime(30 * 1000 + 10);

      await expect(stopPromise).rejects.toThrow("Capture finalize timed out");

      cleanup();
    } finally {
      vi.useRealTimers();
    }
  });
});
