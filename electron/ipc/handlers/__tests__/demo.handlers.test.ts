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

const fsMock = vi.hoisted(() => ({
  mkdtemp: vi.fn().mockResolvedValue("/tmp/canopy-capture-abc123"),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("fs/promises", () => fsMock);

vi.mock("fs", () => ({
  readdirSync: vi.fn(() => ["frame-000001.png", "frame-000002.png", "frame-000003.png"]),
  mkdirSync: vi.fn(),
}));

let mockProc: EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function createMockProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

vi.mock("child_process", () => ({
  spawn: vi.fn(() => mockProc),
}));

import { registerDemoHandlers } from "../demo.js";
import type { HandlerDependencies } from "../../types.js";
import type { BrowserWindow } from "electron";

function makeDeps(isDemoMode: boolean): HandlerDependencies {
  return {
    mainWindow: {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
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

  it("registers 14 IPC handlers when isDemoMode is true", () => {
    const cleanup = registerDemoHandlers(makeDeps(true));
    expect(ipcMainMock.handle).toHaveBeenCalledTimes(14);
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
    cleanup();
  });

  it("cleanup removes all 14 handlers", () => {
    const cleanup = registerDemoHandlers(makeDeps(true));
    cleanup();
    expect(ipcMainMock.removeHandler).toHaveBeenCalledTimes(14);
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

    it("spawns ffmpeg with the resolved binary path", async () => {
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

      expect(spawnMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(["-i", "/tmp/frames/frame-%06d.png", "-c:v", "libx264"]),
        expect.any(Object)
      );
    });
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

  it("startCapture creates a temp directory and returns outputDir", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const handler = getHandler("demo:start-capture");
    const result = (await handler({}, { fps: 30 })) as { outputDir: string };

    expect(fsMock.mkdtemp).toHaveBeenCalledWith(expect.stringContaining("canopy-capture-"));
    expect(result.outputDir).toBe("/tmp/canopy-capture-abc123");

    cleanup();
  });

  it("startCapture uses explicit outputDir when provided", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const handler = getHandler("demo:start-capture");
    const result = (await handler({}, { fps: 30, outputDir: "/custom/dir" })) as {
      outputDir: string;
    };

    expect(fsMock.mkdtemp).not.toHaveBeenCalled();
    expect(result.outputDir).toBe("/custom/dir");

    cleanup();
  });

  it("getCaptureStatus returns inactive before start", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const handler = getHandler("demo:get-capture-status");
    const status = (await handler({})) as {
      active: boolean;
      frameCount: number;
      outputDir: string | null;
    };

    expect(status.active).toBe(false);
    expect(status.frameCount).toBe(0);
    expect(status.outputDir).toBeNull();

    cleanup();
  });

  it("captures a frame with zero-padded filename", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const startHandler = getHandler("demo:start-capture");
    await startHandler({}, { fps: 30 });

    // Advance timer to trigger the first capture
    await vi.advanceTimersByTimeAsync(34);

    expect(fsMock.writeFile).toHaveBeenCalledWith(
      "/tmp/canopy-capture-abc123/frame-000001.png",
      expect.any(Buffer)
    );

    cleanup();
  });

  it("stopCapture returns outputDir and frameCount", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const startHandler = getHandler("demo:start-capture");
    await startHandler({}, { fps: 30 });

    // Capture one frame
    await vi.advanceTimersByTimeAsync(34);

    const stopHandler = getHandler("demo:stop-capture");
    const result = (await stopHandler({})) as { outputDir: string; frameCount: number };

    expect(result.outputDir).toBe("/tmp/canopy-capture-abc123");
    expect(result.frameCount).toBe(1);

    cleanup();
  });

  it("rejects startCapture when already active", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const handler = getHandler("demo:start-capture");
    await handler({}, { fps: 30 });

    await expect(handler({}, { fps: 30 })).rejects.toThrow("Capture already in progress");

    cleanup();
  });

  it("auto-stops when maxFrames is reached", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const startHandler = getHandler("demo:start-capture");
    await startHandler({}, { fps: 30, maxFrames: 2 });

    // Capture first frame
    await vi.advanceTimersByTimeAsync(34);
    // Capture second frame (should auto-stop)
    await vi.advanceTimersByTimeAsync(34);

    const statusHandler = getHandler("demo:get-capture-status");
    const status = (await statusHandler({})) as { active: boolean; frameCount: number };

    expect(status.active).toBe(false);
    expect(status.frameCount).toBe(2);

    cleanup();
  });

  it("cleanup stops an active capture", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const startHandler = getHandler("demo:start-capture");
    await startHandler({}, { fps: 30 });

    cleanup();

    // After cleanup, no more frames should be written
    fsMock.writeFile.mockClear();
    await vi.advanceTimersByTimeAsync(100);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("getCaptureStatus reports active while capturing", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    const startHandler = getHandler("demo:start-capture");
    await startHandler({}, { fps: 30 });

    await vi.advanceTimersByTimeAsync(34);

    const statusHandler = getHandler("demo:get-capture-status");
    const status = (await statusHandler({})) as {
      active: boolean;
      frameCount: number;
      outputDir: string | null;
    };

    expect(status.active).toBe(true);
    expect(status.frameCount).toBe(1);
    expect(status.outputDir).toBe("/tmp/canopy-capture-abc123");

    cleanup();
  });

  it("continues capturing after capturePage error", async () => {
    const deps = makeDeps(true);
    const capturePage = deps.mainWindow!.webContents.capturePage as ReturnType<typeof vi.fn>;
    capturePage.mockRejectedValueOnce(new Error("GPU error")).mockResolvedValue({
      toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      getSize: () => ({ width: 1920, height: 1080 }),
    });

    const cleanup = registerDemoHandlers(deps);

    const startHandler = getHandler("demo:start-capture");
    await startHandler({}, { fps: 30 });

    // First tick — capturePage throws
    await vi.advanceTimersByTimeAsync(34);
    expect(fsMock.writeFile).not.toHaveBeenCalled();

    // Second tick — should recover and write a frame
    await vi.advanceTimersByTimeAsync(34);
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);

    const statusHandler = getHandler("demo:get-capture-status");
    const status = (await statusHandler({})) as { active: boolean; frameCount: number };
    expect(status.active).toBe(true);
    expect(status.frameCount).toBe(1);

    cleanup();
  });

  it("supports start/stop/restart cycle with fresh state", async () => {
    const deps = makeDeps(true);
    const cleanup = registerDemoHandlers(deps);

    fsMock.mkdtemp
      .mockResolvedValueOnce("/tmp/canopy-capture-session1")
      .mockResolvedValueOnce("/tmp/canopy-capture-session2");

    const startHandler = getHandler("demo:start-capture");
    const stopHandler = getHandler("demo:stop-capture");

    // First session
    await startHandler({}, { fps: 30 });
    await vi.advanceTimersByTimeAsync(34);
    const result1 = (await stopHandler({})) as { outputDir: string; frameCount: number };
    expect(result1.outputDir).toBe("/tmp/canopy-capture-session1");
    expect(result1.frameCount).toBe(1);

    // Second session — should have fresh frame count
    await startHandler({}, { fps: 30 });
    await vi.advanceTimersByTimeAsync(34);
    await vi.advanceTimersByTimeAsync(34);
    const result2 = (await stopHandler({})) as { outputDir: string; frameCount: number };
    expect(result2.outputDir).toBe("/tmp/canopy-capture-session2");
    expect(result2.frameCount).toBe(2);

    // Filenames should restart from 000001 in second session
    expect(fsMock.writeFile).toHaveBeenCalledWith(
      "/tmp/canopy-capture-session2/frame-000001.png",
      expect.any(Buffer)
    );

    cleanup();
  });
});
