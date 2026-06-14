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
import { TerminalRefreshTier } from "@shared/types/panel";

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

  describe("background tier gate", () => {
    it("holds bytes without writing to xterm while tier is BACKGROUND", () => {
      const writeToTerminal = vi.fn();
      const tiers = new Map<string, TerminalRefreshTier>([
        ["term-1", TerminalRefreshTier.BACKGROUND],
      ]);
      const service = new TerminalOutputIngestService(
        writeToTerminal,
        (id) => tiers.get(id) ?? TerminalRefreshTier.FOCUSED
      );

      service.bufferData("term-1", "while-backgrounded-1");
      service.bufferData("term-1", "while-backgrounded-2");

      // Nothing parsed into xterm while backgrounded.
      expect(writeToTerminal).not.toHaveBeenCalled();
    });

    it("flushes held bytes via resumeFlush after tier upgrades to active", () => {
      const writeToTerminal = vi.fn();
      const tiers = new Map<string, TerminalRefreshTier>([
        ["term-1", TerminalRefreshTier.BACKGROUND],
      ]);
      const service = new TerminalOutputIngestService(
        writeToTerminal,
        (id) => tiers.get(id) ?? TerminalRefreshTier.FOCUSED
      );

      service.bufferData("term-1", "held-a");
      service.bufferData("term-1", "held-b");
      expect(writeToTerminal).not.toHaveBeenCalled();

      // Tier upgrades back to active, then the policy triggers the flush.
      tiers.set("term-1", TerminalRefreshTier.FOCUSED);
      service.resumeFlush("term-1");

      expect(writeToTerminal).toHaveBeenCalledTimes(1);
      expect(writeToTerminal).toHaveBeenCalledWith("term-1", "held-aheld-b", 2);
    });

    it("resumeFlush respects the 256KB coalesce cap (never a single multi-MB write)", () => {
      const writeToTerminal = vi.fn();
      const tiers = new Map<string, TerminalRefreshTier>([
        ["term-1", TerminalRefreshTier.BACKGROUND],
      ]);
      const service = new TerminalOutputIngestService(
        writeToTerminal,
        (id) => tiers.get(id) ?? TerminalRefreshTier.FOCUSED
      );

      // Accumulate 3 × 150KB = 450KB while backgrounded.
      const chunk150k = "a".repeat(150_000);
      service.bufferData("term-1", chunk150k);
      service.bufferData("term-1", chunk150k);
      service.bufferData("term-1", chunk150k);
      expect(writeToTerminal).not.toHaveBeenCalled();

      tiers.set("term-1", TerminalRefreshTier.FOCUSED);
      service.resumeFlush("term-1");

      // First capped batch: do-while takes first chunk unconditionally,
      // 150k + 150k > 256KB cap, so only one chunk = 150,000 bytes.
      expect(writeToTerminal).toHaveBeenCalledTimes(1);
      const firstBatch = writeToTerminal.mock.calls[0]![1] as string;
      expect(firstBatch.length).toBe(150_000);

      // Drain remainder on acknowledgment.
      service.notifyWriteComplete("term-1", 150_000);
      expect(writeToTerminal).toHaveBeenCalledTimes(2);
      const secondBatch = writeToTerminal.mock.calls[1]![1] as string;
      expect(secondBatch.length).toBe(150_000);
    });

    it("discards background-held bytes on resetForTerminal (hibernation/destroy)", () => {
      const writeToTerminal = vi.fn();
      const tiers = new Map<string, TerminalRefreshTier>([
        ["term-1", TerminalRefreshTier.BACKGROUND],
      ]);
      const service = new TerminalOutputIngestService(
        writeToTerminal,
        (id) => tiers.get(id) ?? TerminalRefreshTier.FOCUSED
      );

      service.bufferData("term-1", "transient");
      service.resetForTerminal("term-1");

      // After reset, a tier upgrade + flush must not replay stale bytes —
      // headless serialized state is the scrollback source of truth.
      tiers.set("term-1", TerminalRefreshTier.FOCUSED);
      service.resumeFlush("term-1");
      expect(writeToTerminal).not.toHaveBeenCalled();
    });

    it("writes immediately for non-background tiers", () => {
      const writeToTerminal = vi.fn();
      const tiers = new Map<string, TerminalRefreshTier>([["term-1", TerminalRefreshTier.VISIBLE]]);
      const service = new TerminalOutputIngestService(
        writeToTerminal,
        (id) => tiers.get(id) ?? TerminalRefreshTier.FOCUSED
      );

      service.bufferData("term-1", "visible-output");
      expect(writeToTerminal).toHaveBeenCalledTimes(1);
      expect(writeToTerminal).toHaveBeenCalledWith("term-1", "visible-output", 1);
    });

    it("behaves as before when no tier provider is supplied", () => {
      const writeToTerminal = vi.fn();
      const service = new TerminalOutputIngestService(writeToTerminal);

      service.bufferData("term-1", "no-gate");
      expect(writeToTerminal).toHaveBeenCalledTimes(1);
      expect(writeToTerminal).toHaveBeenCalledWith("term-1", "no-gate", 1);
    });

    it("resumeFlush is a no-op when nothing is held", () => {
      const writeToTerminal = vi.fn();
      const service = new TerminalOutputIngestService(
        writeToTerminal,
        () => TerminalRefreshTier.FOCUSED
      );

      service.resumeFlush("unknown");
      expect(writeToTerminal).not.toHaveBeenCalled();
    });

    it("notifyWriteComplete does not drain while tier is BACKGROUND", () => {
      const writeToTerminal = vi.fn();
      const tiers = new Map<string, TerminalRefreshTier>([["term-1", TerminalRefreshTier.FOCUSED]]);
      const service = new TerminalOutputIngestService(
        writeToTerminal,
        (id) => tiers.get(id) ?? TerminalRefreshTier.FOCUSED
      );

      // Active large write pushes inFlightBytes over the high watermark.
      const largeData = "x".repeat(140_000);
      service.bufferData("term-1", largeData);
      expect(writeToTerminal).toHaveBeenCalledTimes(1);

      // Tier flips to BACKGROUND; subsequent data is held.
      tiers.set("term-1", TerminalRefreshTier.BACKGROUND);
      service.bufferData("term-1", "held-while-bg");
      expect(writeToTerminal).toHaveBeenCalledTimes(1);

      // Acknowledging the in-flight write must NOT drain the held bytes.
      service.notifyWriteComplete("term-1", 140_000);
      expect(writeToTerminal).toHaveBeenCalledTimes(1);

      // Back to active + resume → held bytes flush.
      tiers.set("term-1", TerminalRefreshTier.FOCUSED);
      service.resumeFlush("term-1");
      expect(writeToTerminal).toHaveBeenCalledTimes(2);
      expect(writeToTerminal).toHaveBeenCalledWith("term-1", "held-while-bg", 1);
    });

    it("notifyParsed does not bypass the background gate", () => {
      const writeToTerminal = vi.fn();
      const service = new TerminalOutputIngestService(
        writeToTerminal,
        () => TerminalRefreshTier.BACKGROUND
      );

      service.bufferData("term-1", "queued-bg");
      service.notifyParsed("term-1");
      expect(writeToTerminal).not.toHaveBeenCalled();
    });

    it("scheduled ink-erase drain does not fire while backgrounded", () => {
      vi.useFakeTimers();
      const writeToTerminal = vi.fn();
      const tiers = new Map<string, TerminalRefreshTier>([["term-1", TerminalRefreshTier.FOCUSED]]);
      const service = new TerminalOutputIngestService(
        writeToTerminal,
        (id) => tiers.get(id) ?? TerminalRefreshTier.FOCUSED
      );

      // Active ink-erase first half → drain scheduled via setTimeout.
      service.bufferData("term-1", "\x1b[2K");
      expect(writeToTerminal).toHaveBeenCalledTimes(1);
      service.notifyWriteComplete("term-1", 4);

      // Tier flips to BACKGROUND before the deferred drain fires.
      tiers.set("term-1", TerminalRefreshTier.BACKGROUND);
      service.bufferData("term-1", "\x1b[1Acontent");
      vi.advanceTimersByTime(0);
      expect(writeToTerminal).toHaveBeenCalledTimes(1);

      // Back to active + resume → held bytes flush.
      tiers.set("term-1", TerminalRefreshTier.FOCUSED);
      service.resumeFlush("term-1");
      expect(writeToTerminal).toHaveBeenCalledTimes(2);
      expect(writeToTerminal).toHaveBeenCalledWith("term-1", "\x1b[1Acontent", 1);

      vi.useRealTimers();
    });

    it("ink-erase drain scheduled while foreground does not fire into a terminal backgrounded before the timer (#9910)", () => {
      vi.useFakeTimers();
      const writeToTerminal = vi.fn();
      const tiers = new Map<string, TerminalRefreshTier>([["term-1", TerminalRefreshTier.FOCUSED]]);
      const service = new TerminalOutputIngestService(
        writeToTerminal,
        (id) => tiers.get(id) ?? TerminalRefreshTier.FOCUSED
      );

      // Complete ink-erase pattern in ONE foreground chunk: the chunk stays
      // queued and the deferred drain is scheduled with it still in the queue.
      service.bufferData("term-1", "\x1b[2K\x1b[1Acontent");
      expect(writeToTerminal).not.toHaveBeenCalled();

      // Tier flips to BACKGROUND between scheduling and firing — the timer
      // must not drain the held chunk into the hidden pane.
      tiers.set("term-1", TerminalRefreshTier.BACKGROUND);
      vi.advanceTimersByTime(0);
      expect(writeToTerminal).not.toHaveBeenCalled();

      // Back to active + resume → held bytes flush normally.
      tiers.set("term-1", TerminalRefreshTier.FOCUSED);
      service.resumeFlush("term-1");
      expect(writeToTerminal).toHaveBeenCalledTimes(1);
      expect(writeToTerminal).toHaveBeenCalledWith("term-1", "\x1b[2K\x1b[1Acontent", 1);

      vi.useRealTimers();
    });

    it("isolates the background gate per terminal", () => {
      const writeToTerminal = vi.fn();
      const tiers = new Map<string, TerminalRefreshTier>([
        ["bg", TerminalRefreshTier.BACKGROUND],
        ["fg", TerminalRefreshTier.FOCUSED],
      ]);
      const service = new TerminalOutputIngestService(
        writeToTerminal,
        (id) => tiers.get(id) ?? TerminalRefreshTier.FOCUSED
      );

      service.bufferData("bg", "held");
      service.bufferData("fg", "live");

      expect(writeToTerminal).toHaveBeenCalledTimes(1);
      expect(writeToTerminal).toHaveBeenCalledWith("fg", "live", 1);
    });
  });

  describe("background queue cap (#9906)", () => {
    const BACKGROUND_QUEUE_MAX_BYTES = 4 * 1024 * 1024;
    const CHUNK = "a".repeat(512 * 1024); // 512 KB

    it("bounds the held queue at 4 MB, evicting oldest chunks as new ones arrive", () => {
      const writeToTerminal = vi.fn();
      const service = new TerminalOutputIngestService(
        writeToTerminal,
        () => TerminalRefreshTier.BACKGROUND
      );

      // Stream 20 × 512 KB = 10 MB while backgrounded — far past the cap. The
      // desync this guards against keeps in-flight batches arriving uncapped;
      // queuedBytes must never exceed the ceiling.
      for (let i = 0; i < 20; i++) {
        service.bufferData("term-1", CHUNK);
        expect(service.getQueuedBytes("term-1")).toBeLessThanOrEqual(BACKGROUND_QUEUE_MAX_BYTES);
      }

      // 8 × 512 KB = exactly 4 MB is retained (the 9th onward each evict one).
      expect(service.getQueuedBytes("term-1")).toBe(BACKGROUND_QUEUE_MAX_BYTES);
      expect(writeToTerminal).not.toHaveBeenCalled();
    });

    it("drops a single chunk larger than the cap entirely", () => {
      const writeToTerminal = vi.fn();
      const service = new TerminalOutputIngestService(
        writeToTerminal,
        () => TerminalRefreshTier.BACKGROUND
      );

      const oversized = "z".repeat(5 * 1024 * 1024); // 5 MB > 4 MB cap
      service.bufferData("term-1", oversized);

      // The lone chunk exceeds the cap, so eviction empties the queue rather
      // than holding a chunk it can never get under the ceiling.
      expect(service.getQueuedBytes("term-1")).toBe(0);
    });

    it("evicts oldest-first (FIFO), preserving the most recent bytes", () => {
      const writeToTerminal = vi.fn();
      const tiers = new Map<string, TerminalRefreshTier>([
        ["term-1", TerminalRefreshTier.BACKGROUND],
      ]);
      const service = new TerminalOutputIngestService(
        writeToTerminal,
        (id) => tiers.get(id) ?? TerminalRefreshTier.FOCUSED
      );

      // Fill to exactly the cap with 8 distinguishable head chunks, then add a
      // newest marker chunk that forces eviction of the oldest.
      const oldest = "OLDEST" + "0".repeat(512 * 1024 - 6);
      service.bufferData("term-1", oldest);
      for (let i = 0; i < 7; i++) {
        service.bufferData("term-1", CHUNK);
      }
      expect(service.getQueuedBytes("term-1")).toBe(BACKGROUND_QUEUE_MAX_BYTES);

      const newest = "NEWEST";
      service.bufferData("term-1", newest);

      // The oldest 512 KB chunk was evicted; the small newest chunk survives.
      expect(service.getQueuedBytes("term-1")).toBe(
        BACKGROUND_QUEUE_MAX_BYTES - 512 * 1024 + newest.length
      );

      // Drain everything and confirm the OLDEST head bytes are gone while the
      // NEWEST tail bytes remain.
      tiers.set("term-1", TerminalRefreshTier.FOCUSED);
      service.flushForTerminal("term-1");
      const flushed = writeToTerminal.mock.calls.map((c) => c[1] as string).join("");
      expect(flushed.startsWith("OLDEST")).toBe(false);
      expect(flushed.endsWith("NEWEST")).toBe(true);
    });

    it("acks each evicted chunk so the host flow-control ledger stays balanced", () => {
      const writeToTerminal = vi.fn();
      const onEvict = vi.fn();
      const service = new TerminalOutputIngestService(
        writeToTerminal,
        () => TerminalRefreshTier.BACKGROUND,
        onEvict
      );

      // 8 × 512 KB fills exactly to the cap (no eviction yet).
      for (let i = 0; i < 8; i++) {
        service.bufferData("term-1", CHUNK);
      }
      expect(onEvict).not.toHaveBeenCalled();

      // Each subsequent chunk evicts exactly one oldest chunk → one ack.
      service.bufferData("term-1", CHUNK);
      expect(onEvict).toHaveBeenCalledTimes(1);
      expect(onEvict).toHaveBeenCalledWith("term-1");

      service.bufferData("term-1", CHUNK);
      expect(onEvict).toHaveBeenCalledTimes(2);
    });

    it("acks the dropped chunk when a single oversized chunk is evicted", () => {
      const writeToTerminal = vi.fn();
      const onEvict = vi.fn();
      const service = new TerminalOutputIngestService(
        writeToTerminal,
        () => TerminalRefreshTier.BACKGROUND,
        onEvict
      );

      service.bufferData("term-1", "z".repeat(5 * 1024 * 1024));
      expect(onEvict).toHaveBeenCalledTimes(1);
      expect(service.getQueuedBytes("term-1")).toBe(0);
    });

    it("does not cap or evict for active (non-background) terminals", () => {
      const writeToTerminal = vi.fn();
      const service = new TerminalOutputIngestService(
        writeToTerminal,
        () => TerminalRefreshTier.FOCUSED
      );

      // The background cap must not apply to active terminals. Without acks,
      // normal backpressure queues the bytes the high-watermark won't let drain
      // yet — but nothing is DROPPED. written + still-queued accounts for every
      // byte, even though the held total is well past the 4 MB background cap.
      for (let i = 0; i < 20; i++) {
        service.bufferData("term-1", CHUNK);
      }
      const totalWritten = writeToTerminal.mock.calls.reduce(
        (sum, c) => sum + (c[1] as string).length,
        0
      );
      expect(totalWritten + service.getQueuedBytes("term-1")).toBe(20 * 512 * 1024);
      // Proof the cap is background-only: the active queue blew past 4 MB.
      expect(service.getQueuedBytes("term-1")).toBeGreaterThan(BACKGROUND_QUEUE_MAX_BYTES);
    });
  });

  describe("watchdog accessors", () => {
    it("getQueuedBytes tracks held bytes and returns 0 for unknown ids", () => {
      let tier = TerminalRefreshTier.BACKGROUND;
      const writeToTerminal = vi.fn();
      const service = new TerminalOutputIngestService(writeToTerminal, () => tier);

      expect(service.getQueuedBytes("term-1")).toBe(0);

      service.bufferData("term-1", "held-bytes");
      expect(service.getQueuedBytes("term-1")).toBe(10);

      tier = TerminalRefreshTier.FOCUSED;
      service.resumeFlush("term-1");
      expect(service.getQueuedBytes("term-1")).toBe(0);
    });

    it("getStalledBytes reports a zero-in-flight hold after the tier goes active", () => {
      let tier = TerminalRefreshTier.BACKGROUND;
      const writeToTerminal = vi.fn();
      const service = new TerminalOutputIngestService(writeToTerminal, () => tier);

      service.bufferData("term-1", "held-bytes");
      // Tier flips active without a resumeFlush — the strand signature the
      // watchdog repairs (#9779-style hysteresis cancellation miss).
      tier = TerminalRefreshTier.FOCUSED;
      expect(service.getStalledBytes("term-1")).toBe(10);

      service.resumeFlush("term-1");
      expect(service.getStalledBytes("term-1")).toBe(0);
      expect(writeToTerminal).toHaveBeenCalledWith("term-1", "held-bytes", 1);
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
