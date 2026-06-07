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
    mockWriteStream = new MockWriteStream();
  });

  it("is a no-op when isDemoMode is false", () => {
    const cleanup = registerDemoHandlers(makeDeps(false));
    expect(ipcMainMock.handle).not.toHaveBeenCalled();
    expect(displaySessionMock.setDisplayMediaRequestHandler).not.toHaveBeenCalled();
    cleanup();
  });

  it("registers 22 IPC handlers when isDemoMode is true", () => {
    const cleanup = registerDemoHandlers(makeDeps(true));
    expect(ipcMainMock.handle).toHaveBeenCalledTimes(22);
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
    const result = (await handler({})) as {
      data: Uint8Array;
      width: number;
      height: number;
    };
    expect(result.data).toBeInstanceOf(Uint8Array);
    expect(result.data[0]).toBe(0x89);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
  });

  describe("MediaRecorder capture pipeline", () => {
    const defaultPayload = {
      fps: 30,
      outputPath: "/tmp/capture/out.webm",
    };

    function autoResolveCommandDone() {
      ipcMainMock.on.mockImplementation(
        (channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === "demo:command-done") {
            setTimeout(() => listener({}, { requestId: "test-request-id" }), 5);
          }
        }
      );
    }

    it("startCapture creates write stream, sends exec start, returns outputPath", async () => {
      const fsMod = await import("fs");
      autoResolveCommandDone();
      const deps = makeDeps(true);
      const cleanup = registerDemoHandlers(deps);
      const handler = getHandler("demo:start-capture");

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
      autoResolveCommandDone();
      const cleanup = registerDemoHandlers(makeDeps(true));
      const handler = getHandler("demo:start-capture");
      await handler({}, defaultPayload);
      await expect(handler({}, defaultPayload)).rejects.toThrow("Capture already in progress");
      cleanup();
    });

    it("capture chunk handler writes buffer to stream for matching captureId", async () => {
      autoResolveCommandDone();
      const deps = makeDeps(true);
      const cleanup = registerDemoHandlers(deps);
      const startHandler = getHandler("demo:start-capture");
      await startHandler({}, defaultPayload);

      const chunkListener = getIpcListener("demo:capture-chunk");
      expect(chunkListener).toBeDefined();
      chunkListener!({}, { captureId: "test-request-id", data: new Uint8Array([1, 2, 3, 4]) });
      expect(mockWriteStream.write).toHaveBeenCalledTimes(1);
      cleanup();
    });

    it("getCaptureStatus reports live chunkCount as chunks arrive during capture", async () => {
      autoResolveCommandDone();
      const deps = makeDeps(true);
      const cleanup = registerDemoHandlers(deps);
      await (getHandler("demo:start-capture") as (...a: unknown[]) => Promise<unknown>)(
        {},
        defaultPayload
      );

      const statusHandler = getHandler("demo:get-capture-status") as (
        ev: unknown
      ) => Promise<{ active: boolean; chunkCount: number; outputPath: string | null }>;
      const chunkListener = getIpcListener("demo:capture-chunk");

      expect((await statusHandler({})).chunkCount).toBe(0);

      chunkListener!({}, { captureId: "test-request-id", data: new Uint8Array([1]) });
      chunkListener!({}, { captureId: "test-request-id", data: new Uint8Array([2]) });
      let status = await statusHandler({});
      expect(status.active).toBe(true);
      expect(status.chunkCount).toBe(2);

      // Stale-captureId chunks must not advance the live counter.
      chunkListener!({}, { captureId: "bogus", data: new Uint8Array([3]) });
      status = await statusHandler({});
      expect(status.chunkCount).toBe(2);
      cleanup();
    });

    it("stale captureId chunks are ignored", async () => {
      autoResolveCommandDone();
      const cleanup = registerDemoHandlers(makeDeps(true));
      const handler = getHandler("demo:start-capture");
      await handler({}, defaultPayload);
      const chunkListener = getIpcListener("demo:capture-chunk");
      chunkListener!({}, { captureId: "bogus", data: new Uint8Array([9]) });
      expect(mockWriteStream.write).not.toHaveBeenCalled();
      cleanup();
    });

    it("stop flow: exec-stop sent then capture-stop finalizes writeStream and resolves", async () => {
      autoResolveCommandDone();
      const deps = makeDeps(true);
      const cleanup = registerDemoHandlers(deps);

      await (getHandler("demo:start-capture") as (...a: unknown[]) => Promise<unknown>)(
        {},
        defaultPayload
      );
      const stopPromise = (
        getHandler("demo:stop-capture") as (...a: unknown[]) => Promise<{
          outputPath: string;
          chunkCount: number;
        }>
      )({});

      setTimeout(() => {
        const stopListener = getIpcListener("demo:capture-stop");
        stopListener!({}, { captureId: "test-request-id", chunkCount: 7 });
      }, 10);

      const result = await stopPromise;
      expect(mockWriteStream.end).toHaveBeenCalled();
      expect(result.outputPath).toBe("/tmp/capture/out.webm");
      expect(result.chunkCount).toBe(7);
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
        getHandler("demo:get-capture-status") as (ev: unknown) => Promise<unknown>
      )({})) as {
        active: boolean;
        chunkCount: number;
        outputPath: string | null;
      };
      expect(status.active).toBe(false);
      expect(status.outputPath).toBeNull();
      cleanup();
    });

    it("getCaptureStatus reports active after start", async () => {
      autoResolveCommandDone();
      const cleanup = registerDemoHandlers(makeDeps(true));
      await (getHandler("demo:start-capture") as (...a: unknown[]) => Promise<unknown>)(
        {},
        defaultPayload
      );
      const status = (await (
        getHandler("demo:get-capture-status") as (ev: unknown) => Promise<unknown>
      )({})) as {
        active: boolean;
        outputPath: string | null;
      };
      expect(status.active).toBe(true);
      expect(status.outputPath).toBe("/tmp/capture/out.webm");
      cleanup();
    });

    it("error from renderer on capture-stop rejects finalize promise", async () => {
      autoResolveCommandDone();
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
        stopListener!({}, { captureId: "test-request-id", chunkCount: 0, error: "boom" });
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

  describe("command watchdog timeout (#10142)", () => {
    // Auto-acks every command after a short real delay so handlers resolve without
    // wall-clock waits, while the setTimeout spy records the watchdog delay arg.
    function autoAck() {
      ipcMainMock.on.mockImplementation(
        (channel: string, listener: (...args: unknown[]) => void) => {
          if (channel === "demo:command-done") {
            setTimeout(() => listener({}, { requestId: "test-request-id" }), 5);
          }
        }
      );
    }

    // The watchdog setTimeout is the only one armed with a delay other than the
    // 5ms auto-ack scheduler; return that delay so tests assert the derived budget.
    function watchdogDelay(spy: ReturnType<typeof vi.spyOn>): number | undefined {
      const call = spy.mock.calls.find(([, delay]) => delay !== 5);
      return call?.[1] as number | undefined;
    }

    async function runAndCaptureDelay(
      channel: string,
      payload?: unknown
    ): Promise<number | undefined> {
      const spy = vi.spyOn(global, "setTimeout");
      autoAck();
      const cleanup = registerDemoHandlers(makeDeps(true));
      try {
        await getHandler(channel)({}, payload);
        return watchdogDelay(spy);
      } finally {
        cleanup();
        spy.mockRestore();
      }
    }

    it("sleep derives the watchdog from durationMs (above the old 30s cap)", async () => {
      // 45000 * 1.2 + 5000 = 59000 — would have been capped at 30000 before the fix.
      expect(await runAndCaptureDelay("demo:sleep", { durationMs: 45_000 })).toBe(59_000);
    });

    it("waitForSelector derives the watchdog from the supplied timeoutMs", async () => {
      // 40000 * 1.2 + 5000 = 53000
      expect(
        await runAndCaptureDelay("demo:wait-for-selector", { selector: ".x", timeoutMs: 40_000 })
      ).toBe(53_000);
    });

    it("waitForSelector falls back to the 10s default when timeoutMs is omitted", async () => {
      // 10000 * 1.2 + 5000 = 17000
      expect(await runAndCaptureDelay("demo:wait-for-selector", { selector: ".x" })).toBe(17_000);
    });

    it("waitForIdle derives the watchdog from timeoutMs, ignoring settleMs", async () => {
      // 60000 * 1.2 + 5000 = 77000 — settleMs is a polling cadence, not additive.
      expect(
        await runAndCaptureDelay("demo:wait-for-idle", { timeoutMs: 60_000, settleMs: 800 })
      ).toBe(77_000);
    });

    it("type scales the watchdog with text length and can exceed 30s", async () => {
      // 100 chars at 12 cps: ceil(100/12*1000*8 + 5000) = 71667
      const text = "a".repeat(100);
      expect(await runAndCaptureDelay("demo:type", { selector: ".x", text })).toBe(71_667);
    });

    it("type honors a slower cps, lengthening the watchdog", async () => {
      // 20 chars at 5 cps: ceil(20/5*1000*8 + 5000) = 37000
      const text = "a".repeat(20);
      expect(await runAndCaptureDelay("demo:type", { selector: ".x", text, cps: 5 })).toBe(37_000);
    });

    it("typeInTerminal uses the same text-derived watchdog", async () => {
      const text = "a".repeat(100);
      expect(await runAndCaptureDelay("demo:type-in-terminal", { selector: ".x", text })).toBe(
        71_667
      );
    });

    it("drag derives the watchdog from durationMs", async () => {
      // 8000 * 1.2 + 5000 = 14600
      expect(
        await runAndCaptureDelay("demo:drag", {
          fromSelector: ".a",
          toSelector: ".b",
          durationMs: 8_000,
        })
      ).toBe(14_600);
    });

    it("type falls back to the 20ms keystroke floor at very high cps", async () => {
      // 1000 chars at 1000 cps: nominal = 1000/1000*1000*8 = 8000, but the renderer
      // floors each keystroke at 20ms => 1000*20 = 20000 wins; +5000 = 25000.
      const text = "a".repeat(1000);
      expect(await runAndCaptureDelay("demo:type", { selector: ".x", text, cps: 1000 })).toBe(
        25_000
      );
    });

    it("moveTo falls back to the 3s default when durationMs is omitted", async () => {
      // 3000 * 1.2 + 5000 = 8600
      expect(await runAndCaptureDelay("demo:move-to", { x: 1, y: 2 })).toBe(8_600);
    });

    it("moveToSelector falls back to the 3s default when durationMs is omitted", async () => {
      expect(await runAndCaptureDelay("demo:move-to-selector", { selector: ".x" })).toBe(8_600);
    });

    it("drag falls back to the 3s default when durationMs is omitted", async () => {
      expect(await runAndCaptureDelay("demo:drag", { fromSelector: ".a", toSelector: ".b" })).toBe(
        8_600
      );
    });

    it("unbounded commands keep the 30s default watchdog", async () => {
      // click carries no duration/timeout payload, so the watchdog is unchanged.
      expect(await runAndCaptureDelay("demo:click")).toBe(30_000);
    });
  });
});
