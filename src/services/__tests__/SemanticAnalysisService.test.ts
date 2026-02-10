import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { semanticAnalysisService } from "../SemanticAnalysisService";

const { getAnalysisBufferMock } = vi.hoisted(() => ({
  getAnalysisBufferMock: vi.fn(),
}));

class MockWorker {
  static instances: MockWorker[] = [];
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public postMessage = vi.fn();
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

describe("SemanticAnalysisService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(MockWorker.instances).toHaveLength(2);
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
    vi.useRealTimers();
  });
});
