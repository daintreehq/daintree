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
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "buffered");

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
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "hello");
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
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "buffered");
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
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "abc");
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
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", oversized);
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

  it("forceDrain bypasses cap and writes all buffered data", () => {
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

    // forceDrain (via flushForTerminal) should write ALL data in one call
    service.flushForTerminal("term-1");
    expect(writeToTerminal).toHaveBeenCalledTimes(2);
    const flushed = writeToTerminal.mock.calls[1]![1] as string;
    expect(flushed.length).toBe(400_000);
  });

  it("defers drain via setTimeout for ink erase-line sequences", () => {
    vi.useFakeTimers();
    const writeToTerminal = vi.fn();
    const service = new TerminalOutputIngestService(writeToTerminal);

    service.bufferData("term-1", "\x1b[2K");
    expect(writeToTerminal).toHaveBeenCalledTimes(1);
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "\x1b[2K");

    // Acknowledge previous write
    service.notifyWriteComplete("term-1", 100);

    // Second half completes the ink pattern — drain deferred via setTimeout(0)
    service.bufferData("term-1", "\x1b[1Acontent");
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(0);
    expect(writeToTerminal).toHaveBeenCalledTimes(2);
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "\x1b[1Acontent");

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
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "residual");
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
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "ab");
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
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", data);
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
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", largeData);
    expect(writeToTerminal).toHaveBeenCalledWith("term-2", "hello-2");
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
    expect(writeToTerminal).toHaveBeenCalledWith("term-2", "immediate");

    // Acknowledge to drain term-1's batch
    service.notifyWriteComplete("term-1", 140_000);
    expect(writeToTerminal).toHaveBeenCalledTimes(3);
    expect(writeToTerminal).toHaveBeenCalledWith("term-1", "batch-1batch-2batch-3");
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
      expect(writeToTerminal).toHaveBeenCalledWith("term-1", "held-aheld-b");
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
      expect(writeToTerminal).toHaveBeenCalledWith("term-1", "visible-output");
    });

    it("behaves as before when no tier provider is supplied", () => {
      const writeToTerminal = vi.fn();
      const service = new TerminalOutputIngestService(writeToTerminal);

      service.bufferData("term-1", "no-gate");
      expect(writeToTerminal).toHaveBeenCalledTimes(1);
      expect(writeToTerminal).toHaveBeenCalledWith("term-1", "no-gate");
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
      expect(writeToTerminal).toHaveBeenCalledWith("term-1", "held-while-bg");
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
      expect(writeToTerminal).toHaveBeenCalledWith("term-1", "\x1b[1Acontent");

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
      expect(writeToTerminal).toHaveBeenCalledWith("fg", "live");
    });
  });
});
