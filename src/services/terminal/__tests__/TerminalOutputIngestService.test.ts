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
});
