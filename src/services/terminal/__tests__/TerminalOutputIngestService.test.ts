import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  // #10881: a background (non-focused) terminal's drain must yield to the
  // scheduler so a queued wheel/scroll/keystroke event on the focused terminal
  // dispatches first, while the focused terminal keeps draining synchronously.
  // yieldToScheduler falls back to setTimeout(0) when no native `scheduler`
  // exists, so these tests stub it away and drive fake timers to observe the
  // deferral deterministically (mirrors schedulerYield.test.ts).
  describe("focused-drain priority (#10881)", () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it("drains the focused terminal synchronously (echo latency unchanged)", () => {
      const writeToTerminal = vi.fn();
      const service = new TerminalOutputIngestService(writeToTerminal, () => "term-focused");

      service.bufferData("term-focused", "hello");

      // No timer advance — the focused pane's write lands inline, in the same
      // task the keystroke echo arrived in.
      expect(writeToTerminal).toHaveBeenCalledTimes(1);
      expect(writeToTerminal).toHaveBeenCalledWith("term-focused", "hello", 1);
    });

    it("drains synchronously when focus is unknown (null must not defer everyone)", () => {
      const writeToTerminal = vi.fn();
      const service = new TerminalOutputIngestService(writeToTerminal, () => null);

      service.bufferData("term-bg", "data");

      expect(writeToTerminal).toHaveBeenCalledTimes(1);
      expect(writeToTerminal).toHaveBeenCalledWith("term-bg", "data", 1);
    });

    it("defers a background terminal's drain until a scheduler tick", async () => {
      vi.stubGlobal("scheduler", undefined);
      vi.useFakeTimers();
      const writeToTerminal = vi.fn();
      const service = new TerminalOutputIngestService(writeToTerminal, () => "term-focused");

      service.bufferData("term-bg", "background");

      // Held, not written — the focused pane's input gets the current task.
      expect(writeToTerminal).not.toHaveBeenCalled();
      expect(service.getQueuedBytes("term-bg")).toBe(10);

      await vi.advanceTimersByTimeAsync(0);

      expect(writeToTerminal).toHaveBeenCalledTimes(1);
      expect(writeToTerminal).toHaveBeenCalledWith("term-bg", "background", 1);
    });

    it("coalesces background chunks arriving before the deferred drain fires", async () => {
      vi.stubGlobal("scheduler", undefined);
      vi.useFakeTimers();
      const writeToTerminal = vi.fn();
      const service = new TerminalOutputIngestService(writeToTerminal, () => "term-focused");

      service.bufferData("term-bg", "a");
      service.bufferData("term-bg", "b");
      service.bufferData("term-bg", "c");

      // One scheduled continuation, not one per chunk (#8150).
      expect(writeToTerminal).not.toHaveBeenCalled();
      expect(service.getQueuedBytes("term-bg")).toBe(3);

      await vi.advanceTimersByTimeAsync(0);

      // The deferred drain still routes through the capped coalescer (#4853),
      // so three chunks land as one write carrying chunkCount 3.
      expect(writeToTerminal).toHaveBeenCalledTimes(1);
      expect(writeToTerminal).toHaveBeenCalledWith("term-bg", "abc", 3);
    });

    it("gates the notifyWriteComplete resume path, not just chunk arrival (#8371)", async () => {
      vi.stubGlobal("scheduler", undefined);
      vi.useFakeTimers();
      const writeToTerminal = vi.fn();
      const service = new TerminalOutputIngestService(writeToTerminal, () => "term-focused");

      // Background terminal pushed past the high watermark: the first chunk
      // drains (deferred), the next is held behind backpressure.
      service.bufferData("term-bg", "x".repeat(140_000));
      await vi.advanceTimersByTimeAsync(0);
      expect(writeToTerminal).toHaveBeenCalledTimes(1);

      service.bufferData("term-bg", "held");
      await vi.advanceTimersByTimeAsync(0);
      expect(writeToTerminal).toHaveBeenCalledTimes(1); // still over watermark, nothing drains

      // Acknowledging the in-flight write drops below the low watermark and
      // releases the hold — this resume must defer for a background terminal,
      // not write inline (regression: gating only enqueueChunk would leak here).
      service.notifyWriteComplete("term-bg", 140_000);
      expect(writeToTerminal).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(0);
      expect(writeToTerminal).toHaveBeenCalledTimes(2);
      expect(writeToTerminal).toHaveBeenLastCalledWith("term-bg", "held", 1);
    });

    it("flushForTerminal drains a pending deferred background drain synchronously, once", async () => {
      vi.stubGlobal("scheduler", undefined);
      vi.useFakeTimers();
      const writeToTerminal = vi.fn();
      const service = new TerminalOutputIngestService(writeToTerminal, () => "term-focused");

      service.bufferData("term-bg", "pending");
      expect(writeToTerminal).not.toHaveBeenCalled(); // deferred behind the yield

      // A teardown/resize flush is a forceDrain path — it must not wait on the
      // scheduler; it drains the held bytes now and deletes the queue.
      service.flushForTerminal("term-bg");
      expect(writeToTerminal).toHaveBeenCalledTimes(1);
      expect(writeToTerminal).toHaveBeenCalledWith("term-bg", "pending", 1);

      // The already-scheduled continuation must be a no-op: its stale-queue
      // identity guard bails because the queue was deleted — no double write.
      await vi.advanceTimersByTimeAsync(0);
      expect(writeToTerminal).toHaveBeenCalledTimes(1);
    });
  });

  // During an active wheel gesture, background terminals' drains are HELD on a
  // bounded recheck timer (not just yielded once) so their parse slices stay
  // off the main thread mid-scroll. BACKGROUND_HOLD_RECHECK_MS=24,
  // BACKGROUND_HOLD_MAX_MS=250.
  describe("wheel-burst background hold", () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    function makeService(
      writeToTerminal: (id: string, data: string | Uint8Array, chunkCount: number) => void,
      focusedId: string | null,
      getWheelId: () => string | null
    ) {
      return new TerminalOutputIngestService(
        writeToTerminal,
        () => focusedId,
        () => getWheelId() !== null,
        (id) => getWheelId() === id
      );
    }

    it("holds a background queue while a wheel burst is active elsewhere", async () => {
      vi.stubGlobal("scheduler", undefined);
      vi.useFakeTimers();
      const writeToTerminal = vi.fn();
      const service = makeService(writeToTerminal, "term-focused", () => "term-wheel");

      service.bufferData("term-bg", "held");

      // A plain yield tick is NOT enough — the queue is held, not yielded.
      await vi.advanceTimersByTimeAsync(0);
      expect(writeToTerminal).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(24);
      expect(writeToTerminal).not.toHaveBeenCalled();
      expect(service.getQueuedBytes("term-bg")).toBe(4);
    });

    it("releases the hold when the wheel burst ends", async () => {
      vi.stubGlobal("scheduler", undefined);
      vi.useFakeTimers();
      const writeToTerminal = vi.fn();
      let wheelId: string | null = "term-wheel";
      const service = makeService(writeToTerminal, "term-focused", () => wheelId);

      service.bufferData("term-bg", "held");
      await vi.advanceTimersByTimeAsync(24);
      expect(writeToTerminal).not.toHaveBeenCalled();

      wheelId = null;
      // Next recheck falls through to the normal single-yield defer, then drains.
      await vi.advanceTimersByTimeAsync(25);
      expect(writeToTerminal).toHaveBeenCalledTimes(1);
      expect(writeToTerminal).toHaveBeenCalledWith("term-bg", "held", 1);
    });

    it("drains anyway once the hold cap elapses during a continuous burst", async () => {
      vi.stubGlobal("scheduler", undefined);
      vi.useFakeTimers();
      const writeToTerminal = vi.fn();
      const service = makeService(writeToTerminal, "term-focused", () => "term-wheel");

      service.bufferData("term-bg", "capped");

      // Burst never ends; the bounded-fairness cap must force a drain.
      await vi.advanceTimersByTimeAsync(300);
      expect(writeToTerminal).toHaveBeenCalledTimes(1);
      expect(writeToTerminal).toHaveBeenCalledWith("term-bg", "capped", 1);
    });

    it("drains the wheeled terminal inline (unfocused TUI scroll round-trip)", () => {
      const writeToTerminal = vi.fn();
      const service = makeService(writeToTerminal, "term-focused", () => "term-wheel");

      // The wheeled terminal is background (not focused) but a participant in
      // the gesture — its redraw frames ARE the scroll, so it drains inline
      // like the focused pane, not after a scheduler yield.
      service.bufferData("term-wheel", "frames");
      expect(writeToTerminal).toHaveBeenCalledTimes(1);
      expect(writeToTerminal).toHaveBeenCalledWith("term-wheel", "frames", 1);
    });

    it("never lets concurrently wheeled terminals hold each other", async () => {
      vi.stubGlobal("scheduler", undefined);
      vi.useFakeTimers();
      const writeToTerminal = vi.fn();
      const wheeled = new Set(["term-wheel-a", "term-wheel-b"]);
      const service = new TerminalOutputIngestService(
        writeToTerminal,
        () => "term-focused",
        () => wheeled.size > 0,
        (id) => wheeled.has(id)
      );

      // Both actively-scrolled TUIs drain inline; a third terminal is held.
      service.bufferData("term-wheel-a", "frames-a");
      service.bufferData("term-wheel-b", "frames-b");
      expect(writeToTerminal).toHaveBeenCalledTimes(2);
      expect(writeToTerminal).toHaveBeenCalledWith("term-wheel-a", "frames-a", 1);
      expect(writeToTerminal).toHaveBeenCalledWith("term-wheel-b", "frames-b", 1);

      service.bufferData("term-bg", "held");
      await vi.advanceTimersByTimeAsync(24);
      expect(writeToTerminal).toHaveBeenCalledTimes(2);
      expect(service.getQueuedBytes("term-bg")).toBe(4);
    });

    it("never holds the focused terminal", async () => {
      vi.stubGlobal("scheduler", undefined);
      vi.useFakeTimers();
      const writeToTerminal = vi.fn();
      const service = makeService(writeToTerminal, "term-focused", () => "term-wheel");

      service.bufferData("term-focused", "echo");
      // Inline, same task — no timers needed.
      expect(writeToTerminal).toHaveBeenCalledTimes(1);
    });

    it("drains inline when focus moves to a held terminal mid-burst", async () => {
      vi.stubGlobal("scheduler", undefined);
      vi.useFakeTimers();
      const writeToTerminal = vi.fn();
      let focusedId = "term-focused";
      const service = new TerminalOutputIngestService(
        writeToTerminal,
        () => focusedId,
        () => true,
        (id) => id === "term-wheel"
      );

      service.bufferData("term-bg", "a");
      expect(writeToTerminal).not.toHaveBeenCalled();

      // Focus lands on the held terminal while its hold recheck is pending.
      // The next chunk must not wait out the recheck — echo drains inline.
      focusedId = "term-bg";
      service.bufferData("term-bg", "b");
      expect(writeToTerminal).toHaveBeenCalledTimes(1);
      expect(writeToTerminal).toHaveBeenCalledWith("term-bg", "ab", 2);

      // The stale recheck continuation is a no-op on the drained queue.
      await vi.advanceTimersByTimeAsync(30);
      expect(writeToTerminal).toHaveBeenCalledTimes(1);
    });
  });
});
