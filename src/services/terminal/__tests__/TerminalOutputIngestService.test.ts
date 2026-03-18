import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSharedBuffersMock } = vi.hoisted(() => ({
  getSharedBuffersMock: vi.fn(),
}));

vi.mock("@/clients", () => ({
  terminalClient: {
    getSharedBuffers: getSharedBuffersMock,
  },
}));

import { TerminalOutputIngestService } from "../TerminalOutputIngestService";

type WorkerMessage = { type: string };

class MockWorker {
  static instances: MockWorker[] = [];

  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public postMessage = vi.fn((_message: WorkerMessage) => {});
  public terminate = vi.fn(() => {});

  constructor() {
    MockWorker.instances.push(this);
  }
}

describe("TerminalOutputIngestService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockWorker.instances = [];
    (globalThis as unknown as { Worker: typeof Worker }).Worker = MockWorker as never;
    (globalThis as unknown as { window: Window & typeof globalThis }).window = {
      ...(globalThis as unknown as { window?: Window & typeof globalThis }).window,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    } as Window & typeof globalThis;
  });

  it("retries initialization after shared-buffer bootstrap failure", async () => {
    const buffer = new SharedArrayBuffer(8);
    const signalBuffer = new SharedArrayBuffer(4);
    getSharedBuffersMock.mockRejectedValueOnce(new Error("sab unavailable")).mockResolvedValueOnce({
      visualBuffers: [buffer],
      signalBuffer,
    });

    const service = new TerminalOutputIngestService(() => {});

    await service.initialize();
    expect(service.isEnabled()).toBe(false);
    expect(service.isPolling()).toBe(false);

    await service.initialize();
    expect(getSharedBuffersMock).toHaveBeenCalledTimes(2);
    expect(service.isEnabled()).toBe(true);
    expect(service.isPolling()).toBe(true);
    expect(MockWorker.instances).toHaveLength(1);
  });

  it("can initialize again after stopPolling tears down worker", async () => {
    vi.useFakeTimers();
    const buffer = new SharedArrayBuffer(8);
    const signalBuffer = new SharedArrayBuffer(4);
    getSharedBuffersMock.mockResolvedValue({
      visualBuffers: [buffer],
      signalBuffer,
    });

    const service = new TerminalOutputIngestService(() => {});

    await service.initialize();
    expect(service.isEnabled()).toBe(true);
    expect(service.isPolling()).toBe(true);
    expect(MockWorker.instances).toHaveLength(1);

    service.stopPolling();
    vi.advanceTimersByTime(60);
    expect(MockWorker.instances[0]?.terminate).toHaveBeenCalled();

    await service.initialize();
    expect(getSharedBuffersMock).toHaveBeenCalledTimes(2);
    expect(MockWorker.instances).toHaveLength(2);
    expect(service.isEnabled()).toBe(true);
    expect(service.isPolling()).toBe(true);

    vi.useRealTimers();
  });

  it("writes immediately when idle and under watermark", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    service.bufferData("term-1", "hello");

    expect(writeToTerminal).toHaveBeenCalledTimes(1);
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "hello");
  });

  it("coalesces multiple string chunks into a single write", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    service.bufferData("term-1", "a");
    service.bufferData("term-1", "b");
    service.bufferData("term-1", "c");

    // First write goes immediately, then subsequent data arrives before acknowledgment
    // so they coalesce on the next drain
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "a");
  });

  it("buffers when inFlightBytes exceed high watermark", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    // Write a large chunk that exceeds the high watermark (128KB)
    const largeData = "x".repeat(50_000);
    service.bufferData("term-1", largeData);
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // Write more data — still under watermark (50k * 3 = 150KB > 128KB for strings)
    // so subsequent writes should be buffered
    service.bufferData("term-1", "buffered");
    expect(writeToTerminal).toHaveBeenCalledTimes(1);
  });

  it("drains buffered data when notifyWriteComplete reduces inFlightBytes below low watermark", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    // Write a large chunk that exceeds high watermark after byte estimation
    const largeData = "x".repeat(50_000);
    service.bufferData("term-1", largeData);
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // Buffer more data while above watermark
    service.bufferData("term-1", "queued");
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // Acknowledge enough bytes to drop below low watermark
    service.notifyWriteComplete("term-1", 200_000);

    expect(writeToTerminal).toHaveBeenCalledTimes(2);
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "queued");
  });

  it("defers drain via setTimeout for ink erase-line sequences", () => {
    vi.useFakeTimers();
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    service.bufferData("term-1", "\x1b[2K");
    expect(writeToTerminal).toHaveBeenCalledTimes(1);
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "\x1b[2K");

    // Acknowledge previous write so we're back under watermark
    service.notifyWriteComplete("term-1", 100);

    // Now send the second half that completes the ink pattern
    service.bufferData("term-1", "\x1b[1Acontent");
    // Ink pattern detected — drain deferred via setTimeout(0)
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(0);
    expect(writeToTerminal).toHaveBeenCalledTimes(2);
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "\x1b[1Acontent");

    vi.useRealTimers();
  });

  it("notifyParsed triggers drain of residual buffered data", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    // Write a large chunk to exceed watermark
    const largeData = "x".repeat(50_000);
    service.bufferData("term-1", largeData);
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // Buffer data while above watermark
    service.bufferData("term-1", "residual");
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // Partially acknowledge — not enough to drop below low watermark
    service.notifyWriteComplete("term-1", 50_000);

    // notifyParsed should attempt drain since there's buffered data
    // and inFlightBytes may now be below high watermark
    service.notifyParsed("term-1");
    expect(writeToTerminal).toHaveBeenCalledTimes(2);
  });

  it("flushForTerminal writes pending buffer immediately regardless of watermark", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    // Write a large chunk to exceed watermark
    const largeData = "x".repeat(50_000);
    service.bufferData("term-1", largeData);
    service.bufferData("term-1", "a");
    service.bufferData("term-1", "b");

    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    service.flushForTerminal("term-1");

    // Force drain should write all buffered data
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "ab");
  });

  it("resetForTerminal drops pending buffer without writing", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    // Write a large chunk and buffer more data
    const largeData = "x".repeat(50_000);
    service.bufferData("term-1", largeData);
    service.bufferData("term-1", "pending");
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    service.resetForTerminal("term-1");

    // Acknowledge won't cause drain since queue was cleared
    service.notifyWriteComplete("term-1", 200_000);
    expect(writeToTerminal).toHaveBeenCalledTimes(1);
  });

  it("handles Uint8Array data correctly", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    const data = new Uint8Array([72, 101, 108, 108, 111]);
    service.bufferData("term-1", data);

    expect(writeToTerminal).toHaveBeenCalledTimes(1);
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", data);
  });

  it("routes worker SAB batches through watermark logic", async () => {
    const buffer = new SharedArrayBuffer(8);
    const signalBuffer = new SharedArrayBuffer(4);
    getSharedBuffersMock.mockResolvedValueOnce({
      visualBuffers: [buffer],
      signalBuffer,
    });

    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    await service.initialize();
    expect(service.isPolling()).toBe(true);

    const worker = MockWorker.instances[0]!;
    worker.onmessage!({
      data: {
        type: "OUTPUT_BATCH",
        batches: [{ id: "term-1", data: "worker-data" }],
      },
    } as MessageEvent);

    expect(writeToTerminal).toHaveBeenCalledTimes(1);
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "worker-data");
  });
});
