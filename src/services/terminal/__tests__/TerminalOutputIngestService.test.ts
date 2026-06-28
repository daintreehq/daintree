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

// HIGH_WATERMARK          = 128 * 1024 = 131072 bytes
// LOW_WATERMARK           =  32 * 1024 =  32768 bytes
// COALESCE_BATCH_CAP      = 256 * 1024 = 262144 bytes
// chunkByteSize for strings = data.length

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

  it("does not enable SAB polling (intentionally disabled due to multi-view race)", async () => {
    const service = new TerminalOutputIngestService(() => {});

    await service.initialize();
    expect(service.isEnabled()).toBe(false);
    expect(service.isPolling()).toBe(false);

    await service.initialize();
    expect(service.isEnabled()).toBe(false);
    expect(service.isPolling()).toBe(false);
  });

  it("stopPolling clears buffered data without affecting reinitialization", async () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    // Buffer some data
    const largeData = "x".repeat(140_000);
    service.bufferData("term-1", largeData);
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    service.bufferData("term-1", "buffered");
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // stopPolling flushes buffered data
    service.stopPolling();
    expect(writeToTerminal).toHaveBeenCalledTimes(2);
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "buffered", 1);

    // Can reinitialize
    await service.initialize();
    expect(service.isEnabled()).toBe(false);
    expect(service.isPolling()).toBe(false);
  });

  it("writes immediately when idle and under watermark", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    service.bufferData("term-1", "hello");

    expect(writeToTerminal).toHaveBeenCalledTimes(1);
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "hello", 1);
  });

  it("buffers when inFlightBytes exceed high watermark and drains on acknowledgment", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    // 140,000 chars > 131,072 (HIGH_WATERMARK)
    const largeData = "x".repeat(140_000);
    service.bufferData("term-1", largeData);
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // Second write should be buffered (inFlightBytes = 140,000 > HIGH_WATERMARK)
    service.bufferData("term-1", "buffered");
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // Acknowledge enough bytes to drop below LOW_WATERMARK (32,768)
    service.notifyWriteComplete("term-1", 140_000);
    expect(writeToTerminal).toHaveBeenCalledTimes(2);
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "buffered", 1);
  });

  it("coalesces queued string chunks into a single write on drain", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    // Exceed watermark with first write
    const largeData = "x".repeat(140_000);
    service.bufferData("term-1", largeData);
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // Queue multiple small chunks while above watermark
    service.bufferData("term-1", "a");
    service.bufferData("term-1", "b");
    service.bufferData("term-1", "c");
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // Acknowledge to trigger drain — queued chunks should coalesce
    service.notifyWriteComplete("term-1", 140_000);
    expect(writeToTerminal).toHaveBeenCalledTimes(2);
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "abc", 3);
  });

  it("caps coalesced batch at 256 KB and drains remainder on next acknowledgment", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    // Exceed watermark to start buffering
    const largeData = "x".repeat(140_000);
    service.bufferData("term-1", largeData);
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // Queue 3 chunks of 150 KB each = 450 KB total, exceeds 256 KB cap
    const chunk150k = "a".repeat(150_000);
    service.bufferData("term-1", chunk150k);
    service.bufferData("term-1", chunk150k);
    service.bufferData("term-1", chunk150k);
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // Acknowledge first write to trigger drain
    service.notifyWriteComplete("term-1", 140_000);
    expect(writeToTerminal).toHaveBeenCalledTimes(2);

    // First capped batch should be 2 chunks (300,000 > 256 KB cap, but do-while takes first
    // chunk unconditionally, second chunk fits: 150,000 + 150,000 = 300,000 > cap, so only
    // first chunk is taken = 150,000 bytes)
    const secondCall = writeToTerminal.mock.calls[1]![1] as string;
    expect(secondCall.length).toBe(150_000);

    // Acknowledge to drain the next batch
    service.notifyWriteComplete("term-1", 150_000);
    expect(writeToTerminal).toHaveBeenCalledTimes(3);
    // Second batch: two remaining 150k chunks = 300k > cap, so takes only one
    const thirdCall = writeToTerminal.mock.calls[2]![1] as string;
    expect(thirdCall.length).toBe(150_000);

    // Acknowledge to drain the last chunk
    service.notifyWriteComplete("term-1", 150_000);
    expect(writeToTerminal).toHaveBeenCalledTimes(4);
    const fourthCall = writeToTerminal.mock.calls[3]![1] as string;
    expect(fourthCall.length).toBe(150_000);
  });

  it("passes through a single oversized chunk without stalling", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    // Exceed watermark to start buffering
    const largeData = "x".repeat(140_000);
    service.bufferData("term-1", largeData);
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // Queue a single chunk > 256 KB
    const oversized = "z".repeat(400_000);
    service.bufferData("term-1", oversized);
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // Acknowledge to drain — single chunk should pass through via the length===1 fast path
    service.notifyWriteComplete("term-1", 140_000);
    expect(writeToTerminal).toHaveBeenCalledTimes(2);
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", oversized, 1);
  });

  it("uses fast path when total queued bytes exactly equal the cap", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    // Exceed watermark to start buffering
    const largeData = "x".repeat(140_000);
    service.bufferData("term-1", largeData);
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // Queue chunks totaling exactly 262144 bytes (COALESCE_BATCH_CAP_BYTES)
    const chunkA = "a".repeat(131_072);
    const chunkB = "b".repeat(131_072);
    service.bufferData("term-1", chunkA);
    service.bufferData("term-1", chunkB);
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // Acknowledge to drain — should coalesce all into one write (fast path)
    service.notifyWriteComplete("term-1", 140_000);
    expect(writeToTerminal).toHaveBeenCalledTimes(2);
    const batch = writeToTerminal.mock.calls[1]![1] as string;
    expect(batch.length).toBe(262_144);
  });

  it("caps coalesced batch correctly with many small chunks", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    // Exceed watermark to start buffering
    const largeData = "x".repeat(140_000);
    service.bufferData("term-1", largeData);
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // Queue 500 chunks of 1024 bytes each = 512 KB total (> 256 KB cap)
    for (let i = 0; i < 500; i++) {
      service.bufferData("term-1", "a".repeat(1024));
    }
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // Acknowledge to trigger drain — first batch should be capped
    service.notifyWriteComplete("term-1", 140_000);
    expect(writeToTerminal).toHaveBeenCalledTimes(2);
    const firstBatch = writeToTerminal.mock.calls[1]![1] as string;
    // do-while takes chunks until adding next would exceed 256 KB
    // 256 chunks × 1024 = 262144 = exactly cap, so 257th would push over
    expect(firstBatch.length).toBe(256 * 1024);

    // Acknowledge to drain remainder (244 chunks × 1024 = 249856 < cap → fast path)
    service.notifyWriteComplete("term-1", firstBatch.length);
    expect(writeToTerminal).toHaveBeenCalledTimes(3);
    const secondBatch = writeToTerminal.mock.calls[2]![1] as string;
    expect(secondBatch.length).toBe(244 * 1024);
  });

  it("forceDrain bypasses the watermark but flushes in cap-bounded batches", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    // Exceed watermark to start buffering
    const largeData = "x".repeat(140_000);
    service.bufferData("term-1", largeData);
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // Queue 400 KB across multiple chunks (exceeds 256 KB cap)
    const chunk200k = "b".repeat(200_000);
    service.bufferData("term-1", chunk200k);
    service.bufferData("term-1", chunk200k);
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // forceDrain (via flushForTerminal) writes everything without waiting for
    // acknowledgments, but never as a single over-cap write (#4853).
    service.flushForTerminal("term-1");
    expect(writeToTerminal).toHaveBeenCalledTimes(3);
    const flushedBytes = writeToTerminal.mock.calls
      .slice(1)
      .reduce((sum, call) => sum + (call[1] as string).length, 0);
    expect(flushedBytes).toBe(400_000);
    for (const call of writeToTerminal.mock.calls.slice(1)) {
      expect((call[1] as string).length).toBeLessThanOrEqual(256 * 1024);
    }
  });

  it("coalesces queued Uint8Array chunks into a single write with the merged chunk count", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    // Exceed watermark to start buffering
    const largeData = "x".repeat(140_000);
    service.bufferData("term-1", largeData);
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    service.bufferData("term-1", new Uint8Array([1, 2]));
    service.bufferData("term-1", new Uint8Array([3]));
    service.bufferData("term-1", new Uint8Array([4, 5, 6]));
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    service.notifyWriteComplete("term-1", 140_000);
    expect(writeToTerminal).toHaveBeenCalledTimes(2);
    const [, merged, chunkCount] = writeToTerminal.mock.calls[1]!;
    expect(merged).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    expect(chunkCount).toBe(3);
  });

  it("caps Uint8Array coalescing at 256 KB per batch", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    const largeData = "x".repeat(140_000);
    service.bufferData("term-1", largeData);
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // 3 × 150 KB binary chunks — first batch takes one (150k + 150k > cap).
    const chunk150k = new Uint8Array(150_000).fill(65);
    service.bufferData("term-1", chunk150k);
    service.bufferData("term-1", chunk150k);
    service.bufferData("term-1", chunk150k);

    service.notifyWriteComplete("term-1", 140_000);
    expect(writeToTerminal).toHaveBeenCalledTimes(2);
    expect((writeToTerminal.mock.calls[1]![1] as Uint8Array).byteLength).toBe(150_000);
    expect(writeToTerminal.mock.calls[1]![2]).toBe(1);

    service.notifyWriteComplete("term-1", 150_000);
    expect(writeToTerminal).toHaveBeenCalledTimes(3);
    expect((writeToTerminal.mock.calls[2]![1] as Uint8Array).byteLength).toBe(150_000);
  });

  it("merges only same-type prefixes from a mixed string/binary queue, preserving order", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    const largeData = "x".repeat(140_000);
    service.bufferData("term-1", largeData);
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    service.bufferData("term-1", "a");
    service.bufferData("term-1", "b");
    service.bufferData("term-1", new Uint8Array([1]));
    service.bufferData("term-1", new Uint8Array([2]));
    service.bufferData("term-1", "c");

    service.notifyWriteComplete("term-1", 140_000);
    // Drains as: "ab" (2 chunks), [1,2] (2 chunks), "c" (1 chunk).
    expect(writeToTerminal).toHaveBeenCalledTimes(4);
    expect(writeToTerminal).toHaveBeenNthCalledWith(2, "term-1", "ab", 2);
    expect(writeToTerminal.mock.calls[2]![1]).toEqual(new Uint8Array([1, 2]));
    expect(writeToTerminal.mock.calls[2]![2]).toBe(2);
    expect(writeToTerminal).toHaveBeenNthCalledWith(4, "term-1", "c", 1);
  });

  it("defers drain via setTimeout for ink erase-line sequences", () => {
    vi.useFakeTimers();
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    service.bufferData("term-1", "\x1b[2K");
    expect(writeToTerminal).toHaveBeenCalledTimes(1);
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "\x1b[2K", 1);

    // Acknowledge previous write
    service.notifyWriteComplete("term-1", 100);

    // Second half completes the ink pattern — drain deferred via setTimeout(0)
    service.bufferData("term-1", "\x1b[1Acontent");
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(0);
    expect(writeToTerminal).toHaveBeenCalledTimes(2);
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "\x1b[1Acontent", 1);

    vi.useRealTimers();
  });

  it("notifyParsed triggers drain when buffered data exists and under high watermark", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    // Exceed watermark
    const largeData = "x".repeat(140_000);
    service.bufferData("term-1", largeData);
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // Buffer data while above watermark
    service.bufferData("term-1", "residual");
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // Partially acknowledge — drops inFlightBytes to 40,000 (above LOW but below HIGH)
    service.notifyWriteComplete("term-1", 100_000);
    // notifyWriteComplete should NOT drain because 40,000 > LOW_WATERMARK (32,768)
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // notifyParsed should drain because inFlightBytes (40,000) < HIGH_WATERMARK
    service.notifyParsed("term-1");
    expect(writeToTerminal).toHaveBeenCalledTimes(2);
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "residual", 1);
  });

  it("flushForTerminal writes pending buffer immediately regardless of watermark", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    // Exceed watermark, then buffer more
    const largeData = "x".repeat(140_000);
    service.bufferData("term-1", largeData);
    service.bufferData("term-1", "a");
    service.bufferData("term-1", "b");
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    service.flushForTerminal("term-1");
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "ab", 2);
  });

  it("resetForTerminal drops pending buffer without writing", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    const largeData = "x".repeat(140_000);
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
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", data, 1);
  });

  it("isolates queues per terminal", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    // Exceed watermark on term-1
    const largeData = "x".repeat(140_000);
    service.bufferData("term-1", largeData);
    service.bufferData("term-1", "buffered-1");

    // term-2 should still write immediately (separate queue)
    service.bufferData("term-2", "hello-2");

    expect(writeToTerminal).toHaveBeenCalledTimes(2);
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", largeData, 1);
    expect(writeToTerminal).toHaveBeenCalledWith("term-2", "hello-2", 1);
  });

  it("respects watermark bounds during rapid sequential data delivery", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    // Simulate rapid data delivery across two terminals
    const largeData = "x".repeat(140_000);
    service.bufferData("term-1", largeData);
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // Rapid data on term-1 while above watermark
    service.bufferData("term-1", "batch-1");
    service.bufferData("term-1", "batch-2");
    service.bufferData("term-1", "batch-3");
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // Rapid data on term-2 (separate queue, should write immediately)
    service.bufferData("term-2", "immediate");
    expect(writeToTerminal).toHaveBeenCalledTimes(2);
    expect(writeToTerminal).toHaveBeenCalledWith("term-2", "immediate", 1);

    // Acknowledge to drain term-1's batch
    service.notifyWriteComplete("term-1", 140_000);
    expect(writeToTerminal).toHaveBeenCalledTimes(3);
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "batch-1batch-2batch-3", 3);
  });

  it("notifyWriteComplete is a no-op for unknown terminals", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    // Should not throw
    service.notifyWriteComplete("unknown", 1000);
    expect(writeToTerminal).not.toHaveBeenCalled();
  });

  it("notifyParsed is a no-op when no buffered data exists", () => {
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    service.bufferData("term-1", "hello");
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    // No buffered data — notifyParsed should be a no-op
    service.notifyParsed("term-1");
    expect(writeToTerminal).toHaveBeenCalledTimes(1);
  });

  describe("always-live ingest (no background hold)", () => {
    // Hibernation removal: ingest no longer takes a tier provider and never
    // holds output for a "backgrounded" pane. Every chunk parses live; the only
    // reason bytes are ever queued is genuine high-watermark backpressure.
    it("writes every chunk live — there is no tier-based hold", () => {
      const writeToTerminal = vi.fn();
      const service = new TerminalOutputIngestService(writeToTerminal);

      service.bufferData("term-1", "live-1");
      service.bufferData("term-1", "live-2");

      expect(writeToTerminal).toHaveBeenCalledTimes(2);
      expect(writeToTerminal).toHaveBeenNthCalledWith(1, "term-1", "live-1", 1);
      expect(writeToTerminal).toHaveBeenNthCalledWith(2, "term-1", "live-2", 1);
      expect(service.getQueuedBytes("term-1")).toBe(0);
    });

    it("queues only under genuine backpressure, then drains on acknowledgment", () => {
      const writeToTerminal = vi.fn();
      const service = new TerminalOutputIngestService(writeToTerminal);

      // First chunk drains immediately and pushes inFlightBytes past the high
      // watermark; the second waits behind real backpressure — the only hold path
      // left now that the background gate is gone.
      service.bufferData("term-1", "x".repeat(140_000));
      service.bufferData("term-1", "tail");
      expect(writeToTerminal).toHaveBeenCalledTimes(1);
      expect(service.getQueuedBytes("term-1")).toBe(4);

      // Acking below the low watermark releases the queued tail live.
      service.notifyWriteComplete("term-1", 140_000);
      expect(writeToTerminal).toHaveBeenCalledTimes(2);
      expect(writeToTerminal).toHaveBeenLastCalledWith("term-1", "tail", 1);
      expect(service.getQueuedBytes("term-1")).toBe(0);
    });

    it("resumeFlush is a no-op when nothing is held", () => {
      const writeToTerminal = vi.fn();
      const service = new TerminalOutputIngestService(writeToTerminal);

      service.resumeFlush("term-1");
      expect(writeToTerminal).not.toHaveBeenCalled();
    });

    it("isolates queues per terminal under backpressure", () => {
      const writeToTerminal = vi.fn();
      const service = new TerminalOutputIngestService(writeToTerminal);

      // term-1 goes into backpressure; term-2 stays live and unaffected.
      service.bufferData("term-1", "x".repeat(140_000));
      service.bufferData("term-1", "held-1");
      service.bufferData("term-2", "live-2");

      expect(service.getQueuedBytes("term-1")).toBe(6);
      expect(service.getQueuedBytes("term-2")).toBe(0);
      expect(writeToTerminal).toHaveBeenCalledWith("term-2", "live-2", 1);
    });
  });

  describe("watchdog accessors", () => {
    it("getQueuedBytes tracks backpressure-held bytes and returns 0 for unknown ids", () => {
      const writeToTerminal = vi.fn();
      const service = new TerminalOutputIngestService(writeToTerminal);

      expect(service.getQueuedBytes("term-1")).toBe(0);

      // Push past the high watermark so the next chunk is held behind backpressure.
      service.bufferData("term-1", "x".repeat(140_000));
      service.bufferData("term-1", "held-bytes");
      expect(service.getQueuedBytes("term-1")).toBe(10);

      // Draining the in-flight write below the low watermark releases the hold.
      service.notifyWriteComplete("term-1", 140_000);
      expect(service.getQueuedBytes("term-1")).toBe(0);
    });

    it("getStalledBytes returns 0 under normal backpressure with writes in flight", () => {
      const writeToTerminal = vi.fn();
      const service = new TerminalOutputIngestService(writeToTerminal);

      // First chunk drains immediately and pushes inFlightBytes past the high
      // watermark; the second is queued behind legitimate backpressure.
      service.bufferData("term-1", "x".repeat(140_000));
      service.bufferData("term-1", "queued");

      expect(service.getQueuedBytes("term-1")).toBe(6);
      expect(service.getStalledBytes("term-1")).toBe(0);
    });
  });
});
