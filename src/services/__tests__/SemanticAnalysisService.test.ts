import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SemanticWorkerInboundMessage } from "@shared/types/worker-messages";
import { semanticAnalysisService } from "../SemanticAnalysisService";

const { getAnalysisBufferMock } = vi.hoisted(() => ({
  getAnalysisBufferMock: vi.fn(),
}));

class MockWorker {
  static instances: MockWorker[] = [];
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public postMessage = vi.fn<(message: SemanticWorkerInboundMessage) => void>();
  public terminate = vi.fn();

  constructor() {
    MockWorker.instances.push(this);
  }

  emitReady() {
    this.onmessage?.({ data: { type: "READY" } } as MessageEvent);
  }

  emitCrash(message: string) {
    this.onerror?.({ message } as ErrorEvent);
  }
}

/**
 * Silence and capture the console. `window.electron` here has no `logs`
 * property, so the logger's `isElectronAvailable()` is false and every call
 * falls through to its console fallback — where debug lands on `console.log`,
 * not `console.debug`.
 */
function silenceConsole() {
  return {
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

describe("SemanticAnalysisService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` leaves queued `mockResolvedValueOnce` values in place, so
    // an unconsumed buffer would leak into the next test's initialize().
    getAnalysisBufferMock.mockReset();
    MockWorker.instances = [];
    semanticAnalysisService.dispose();
    (globalThis as unknown as { Worker: typeof Worker }).Worker = MockWorker as never;
    const existingWindow =
      (globalThis as unknown as { window?: unknown }).window ?? ({} as Record<string, unknown>);
    (globalThis as unknown as { window?: unknown }).window = {
      ...(existingWindow as Record<string, unknown>),
      electron: {
        terminal: {
          getAnalysisBuffer: getAnalysisBufferMock,
        },
      },
    };
  });

  afterEach(() => {
    semanticAnalysisService.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("can retry initialize after missing analysis buffer", async () => {
    getAnalysisBufferMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(new SharedArrayBuffer(16));
    const onError = vi.fn();

    await semanticAnalysisService.initialize({ onError });
    expect(semanticAnalysisService.isReady()).toBe(false);

    await semanticAnalysisService.initialize({ onError });
    expect(getAnalysisBufferMock).toHaveBeenCalledTimes(2);
    // The first initialize bails before constructing a Worker because the
    // analysis buffer is null; only the second (buffer-present) call spawns one.
    expect(MockWorker.instances).toHaveLength(1);
  });

  it("handles restart failure after worker crash without unhandled rejection", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    getAnalysisBufferMock
      .mockResolvedValueOnce(new SharedArrayBuffer(16))
      .mockRejectedValueOnce(new Error("buffer fetch failed"));

    await semanticAnalysisService.initialize({ onError });
    const worker = MockWorker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitCrash("worker crashed");
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith("worker crashed", "worker crash");
    expect(onError).toHaveBeenCalledWith("buffer fetch failed", "initialization");
  });

  it("unregisters quietly without a worker and drops the cached registration", async () => {
    vi.useFakeTimers();
    getAnalysisBufferMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(new SharedArrayBuffer(16))
      .mockResolvedValueOnce(new SharedArrayBuffer(16));

    await semanticAnalysisService.initialize();
    expect(MockWorker.instances).toHaveLength(0);

    const console1 = silenceConsole();
    semanticAnalysisService.registerTerminal("removed");
    semanticAnalysisService.registerTerminal("kept");
    // Registering is not cleanup: a missing worker there still warns.
    expect(console1.warn).toHaveBeenCalledTimes(2);
    console1.warn.mockClear();
    console1.log.mockClear();

    semanticAnalysisService.unregisterTerminal("removed");
    semanticAnalysisService.unregisterTerminal("removed");

    expect(console1.warn).not.toHaveBeenCalled();
    expect(console1.log).toHaveBeenCalledTimes(2);
    expect(console1.log).toHaveBeenCalledWith(expect.stringContaining("Skipping worker message"), {
      type: "UNREGISTER_TERMINAL",
    });
    expect(MockWorker.instances).toHaveLength(0);

    // `registeredTerminals` is private, so the only observable proof the entry
    // was pruned is the replay a worker restart performs over the cache.
    await semanticAnalysisService.initialize();
    const first = MockWorker.instances[0];
    expect(first).toBeDefined();

    first?.emitCrash("worker crashed");
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();

    const replacement = MockWorker.instances[1];
    expect(replacement).toBeDefined();
    const replayed = (replacement?.postMessage.mock.calls ?? []).flatMap(([message]) =>
      message.type === "REGISTER_TERMINAL" ? [message.terminalId] : []
    );
    expect(replayed).toEqual(["kept"]);
  });

  it("keeps unregister quiet and safe after disposal", async () => {
    getAnalysisBufferMock.mockResolvedValueOnce(new SharedArrayBuffer(16));

    await semanticAnalysisService.initialize();
    const worker = MockWorker.instances[0];
    expect(worker).toBeDefined();
    worker?.emitReady();
    semanticAnalysisService.registerTerminal("terminal");
    worker?.postMessage.mockClear();

    const console2 = silenceConsole();
    semanticAnalysisService.dispose();
    semanticAnalysisService.dispose();
    semanticAnalysisService.unregisterTerminal("terminal");
    semanticAnalysisService.unregisterTerminal("terminal");

    expect(console2.warn).not.toHaveBeenCalled();
    expect(console2.log).toHaveBeenCalledWith(expect.stringContaining("Skipping worker message"), {
      type: "UNREGISTER_TERMINAL",
    });
    expect(worker?.terminate).toHaveBeenCalledTimes(1);
    expect(worker?.postMessage).not.toHaveBeenCalled();
    expect(semanticAnalysisService.isReady()).toBe(false);
    expect(MockWorker.instances).toHaveLength(1);
  });

  it("still posts the unregister message to a live worker", async () => {
    getAnalysisBufferMock.mockResolvedValueOnce(new SharedArrayBuffer(16));

    await semanticAnalysisService.initialize();
    const worker = MockWorker.instances[0];
    expect(worker).toBeDefined();
    worker?.emitReady();
    semanticAnalysisService.registerTerminal("terminal");
    worker?.postMessage.mockClear();

    const console3 = silenceConsole();
    semanticAnalysisService.unregisterTerminal("terminal");

    expect(worker?.postMessage).toHaveBeenCalledTimes(1);
    expect(worker?.postMessage).toHaveBeenCalledWith({
      type: "UNREGISTER_TERMINAL",
      terminalId: "terminal",
    });
    expect(console3.warn).not.toHaveBeenCalled();
    expect(console3.log).not.toHaveBeenCalled();
  });

  it("still warns when a non-cleanup message has no worker", async () => {
    getAnalysisBufferMock.mockResolvedValueOnce(null);

    await semanticAnalysisService.initialize();
    const console4 = silenceConsole();

    semanticAnalysisService.ping();
    semanticAnalysisService.reset();

    expect(console4.warn).toHaveBeenCalledTimes(2);
    expect(console4.warn).toHaveBeenCalledWith(expect.stringContaining("Cannot post message"), "");
    expect(console4.log).not.toHaveBeenCalled();
    expect(MockWorker.instances).toHaveLength(0);
  });
});
