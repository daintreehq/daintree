import { SharedRingBuffer, PacketParser } from "@shared/utils/SharedRingBuffer";
import { terminalClient } from "@/clients";
import { SabFlushMode } from "./types";

const REDRAW_LOOKBACK_CHARS = 128;
const STANDARD_FLUSH_DELAY_MS = 4;
const REDRAW_FLUSH_DELAY_MS = 16;
const MAX_FLUSH_DELAY_MS = 32;
const MIN_FRAME_INTERVAL_MS = 50;
const FRAME_SETTLE_DELAY_MS = REDRAW_FLUSH_DELAY_MS;
const FRAME_DEADLINE_MS = MAX_FLUSH_DELAY_MS;
const TUI_BURST_THRESHOLD_MS = 50;
const IDLE_POLL_INTERVALS = [8, 16, 33, 100] as const;

type SabBufferEntry = {
  chunks: (string | Uint8Array)[];
  flushMode: SabFlushMode;
  normalTimeoutId: number | null;
  frameSettleTimeoutId: number | null;
  frameDeadlineTimeoutId: number | null;
  recentChars: string;
  bytesSinceStart: number;
  firstDataAt: number;
  lastDataAt: number;
  lastRedrawAt: number | null;
  flushOnRedrawOnly: boolean;
};

type FrameQueue = { frames: (string | Uint8Array)[][]; presenterTimeoutId: number | null };
type FrameStats = {
  lastFlushAt: number;
  lastIntervalMs: number | null;
  avgIntervalMs: number | null;
};

export class TerminalDataBuffer {
  private ringBuffer: SharedRingBuffer | null = null;
  private packetParser = new PacketParser();
  private pollingActive = false;
  private rafId: number | null = null;
  private pollTimeoutId: number | null = null;
  private sharedBufferEnabled = false;
  private idlePollCount = 0;

  private sabBuffers = new Map<string, SabBufferEntry>();
  private sabFrameStats = new Map<string, FrameStats>();
  private sabFrameQueues = new Map<string, FrameQueue>();

  constructor(private readonly writeToTerminal: (id: string, data: string | Uint8Array) => void) {}

  public async initialize(): Promise<void> {
    try {
      const buffer = await terminalClient.getSharedBuffer();
      if (buffer) {
        this.ringBuffer = new SharedRingBuffer(buffer);
        this.sharedBufferEnabled = true;
        this.startPolling();
        console.log("[TerminalDataBuffer] SharedArrayBuffer polling enabled");
      } else {
        console.log("[TerminalDataBuffer] SharedArrayBuffer unavailable, using IPC");
      }
    } catch (error) {
      console.warn("[TerminalDataBuffer] Failed to initialize SharedArrayBuffer:", error);
    }
  }

  public isEnabled(): boolean {
    return this.sharedBufferEnabled;
  }

  public isPolling(): boolean {
    return this.pollingActive;
  }

  private startPolling(): void {
    if (this.pollingActive || !this.ringBuffer) return;
    this.pollingActive = true;
    this.idlePollCount = 0;
    this.poll();
  }

  public stopPolling(): void {
    this.pollingActive = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.pollTimeoutId !== null) {
      clearTimeout(this.pollTimeoutId);
      this.pollTimeoutId = null;
    }
  }

  public bufferData(id: string, data: string | Uint8Array): void {
    const now = Date.now();
    let entry = this.sabBuffers.get(id);

    const stringData = typeof data === "string" ? data : "";
    const dataLength = typeof data === "string" ? data.length : data.byteLength;
    const prevRecent = entry ? entry.recentChars : "";
    const prevBytes = entry ? entry.bytesSinceStart : 0;
    const combinedRecent = (prevRecent + stringData).slice(-REDRAW_LOOKBACK_CHARS);
    const bytesSinceStart = prevBytes + dataLength;

    const isRedraw = this.detectRedrawPatternInStream(combinedRecent);

    if (!entry) {
      entry = {
        chunks: [],
        flushMode: isRedraw ? "frame" : "normal",
        normalTimeoutId: null,
        frameSettleTimeoutId: null,
        frameDeadlineTimeoutId: null,
        recentChars: combinedRecent,
        bytesSinceStart,
        firstDataAt: now,
        lastDataAt: now,
        lastRedrawAt: isRedraw ? now : null,
        flushOnRedrawOnly: false,
      };
      this.sabBuffers.set(id, entry);
      entry.chunks.push(data);

      if (entry.flushMode === "normal") {
        entry.normalTimeoutId = window.setTimeout(
          () => this.flushBuffer(id),
          STANDARD_FLUSH_DELAY_MS
        );
      } else {
        entry.frameSettleTimeoutId = window.setTimeout(
          () => this.onFrameSettle(id),
          FRAME_SETTLE_DELAY_MS
        );
        entry.frameDeadlineTimeoutId = window.setTimeout(
          () => this.flushBuffer(id),
          FRAME_DEADLINE_MS
        );
      }
      return;
    }

    // Existing entry: update TUI burst detection state.
    if (isRedraw) {
      if (entry.lastRedrawAt !== null) {
        const clearDelta = now - entry.lastRedrawAt;
        if (clearDelta <= TUI_BURST_THRESHOLD_MS) {
          entry.flushOnRedrawOnly = true;
        }
      }
      entry.lastRedrawAt = now;
    }

    if (isRedraw && entry.chunks.length > 0) {
      const stats = this.sabFrameStats.get(id);
      if (stats) {
        const delta = now - stats.lastFlushAt;
        if (delta < MIN_FRAME_INTERVAL_MS) {
          this.cancelBufferTimers(entry);

          entry.chunks = [data];
          entry.flushMode = "frame";
          entry.bytesSinceStart = dataLength;
          entry.recentChars = combinedRecent;
          entry.firstDataAt = now;
          entry.lastDataAt = now;

          const remaining = MIN_FRAME_INTERVAL_MS - delta;
          const settleDelay = Math.max(FRAME_SETTLE_DELAY_MS, remaining);

          entry.frameSettleTimeoutId = window.setTimeout(() => this.onFrameSettle(id), settleDelay);
          entry.frameDeadlineTimeoutId = window.setTimeout(
            () => this.flushBuffer(id),
            Math.max(FRAME_DEADLINE_MS, settleDelay)
          );

          return;
        }
      }

      this.flushBuffer(id);
      this.bufferData(id, data);
      return;
    }

    entry.chunks.push(data);
    entry.lastDataAt = now;
    entry.bytesSinceStart = bytesSinceStart;
    entry.recentChars = combinedRecent;

    if (entry.flushMode === "normal") {
      if (entry.normalTimeoutId === null) {
        entry.normalTimeoutId = window.setTimeout(
          () => this.flushBuffer(id),
          STANDARD_FLUSH_DELAY_MS
        );
      }
      return;
    }

    if (entry.frameSettleTimeoutId !== null) {
      window.clearTimeout(entry.frameSettleTimeoutId);
    }
    entry.frameSettleTimeoutId = window.setTimeout(
      () => this.onFrameSettle(id),
      FRAME_SETTLE_DELAY_MS
    );

    if (entry.frameDeadlineTimeoutId === null) {
      entry.frameDeadlineTimeoutId = window.setTimeout(
        () => this.flushBuffer(id),
        FRAME_DEADLINE_MS
      );
    }
  }

  public resetForTerminal(id: string): void {
    const entry = this.sabBuffers.get(id);
    if (entry) {
      this.cancelBufferTimers(entry);
      this.sabBuffers.delete(id);
    }

    const queue = this.sabFrameQueues.get(id);
    if (queue) {
      if (queue.presenterTimeoutId !== null) {
        window.clearTimeout(queue.presenterTimeoutId);
      }
      this.sabFrameQueues.delete(id);
    }

    this.sabFrameStats.delete(id);
  }

  private poll = (): void => {
    if (!this.pollingActive || !this.ringBuffer) return;
    this.pollTimeoutId = null;

    let hasData = false;

    while (true) {
      const data = this.ringBuffer.read();
      if (!data) {
        break;
      }

      hasData = true;
      const packets = this.packetParser.parse(data);

      for (const packet of packets) {
        this.bufferData(packet.id, packet.data);
      }
    }

    if (hasData) {
      this.idlePollCount = 0;
      this.rafId = window.requestAnimationFrame(() => {
        this.rafId = null;
        this.poll();
      });
    } else {
      const intervalIndex = Math.min(this.idlePollCount, IDLE_POLL_INTERVALS.length - 1);
      const interval = IDLE_POLL_INTERVALS[intervalIndex];
      this.idlePollCount = Math.min(this.idlePollCount + 1, IDLE_POLL_INTERVALS.length - 1);
      this.pollTimeoutId = window.setTimeout(this.poll, interval);
    }
  };

  private cancelBufferTimers(entry: SabBufferEntry): void {
    if (entry.normalTimeoutId !== null) {
      window.clearTimeout(entry.normalTimeoutId);
      entry.normalTimeoutId = null;
    }
    if (entry.frameSettleTimeoutId !== null) {
      window.clearTimeout(entry.frameSettleTimeoutId);
      entry.frameSettleTimeoutId = null;
    }
    if (entry.frameDeadlineTimeoutId !== null) {
      window.clearTimeout(entry.frameDeadlineTimeoutId);
      entry.frameDeadlineTimeoutId = null;
    }
  }

  private onFrameSettle(id: string): void {
    const entry = this.sabBuffers.get(id);
    if (!entry) return;

    entry.frameSettleTimeoutId = null;

    const now = Date.now();
    if (now - entry.lastDataAt >= FRAME_SETTLE_DELAY_MS - 1) {
      if (entry.flushMode === "frame" && entry.flushOnRedrawOnly) {
        return;
      }
      this.flushBuffer(id);
    }
  }

  private flushBuffer(id: string): void {
    const entry = this.sabBuffers.get(id);

    if (!entry || entry.chunks.length === 0) {
      if (entry) {
        this.cancelBufferTimers(entry);
        this.sabBuffers.delete(id);
      }
      return;
    }

    this.cancelBufferTimers(entry);
    this.sabBuffers.delete(id);

    const { chunks } = entry;

    if (entry.flushMode === "normal") {
      this.writeFrameChunks(id, chunks);
      this.recordFrameFlush(id);
      return;
    }

    this.enqueueFrame(id, chunks);
  }

  private detectRedrawPatternInStream(recent: string): boolean {
    if (!recent) return false;
    if (recent.includes("\x1b[2J")) return true;
    if (recent.includes("\x1b[H")) return true;
    return false;
  }

  private writeFrameChunks(id: string, chunks: (string | Uint8Array)[]): void {
    if (chunks.length === 0) return;
    if (chunks.length === 1) {
      this.writeToTerminal(id, chunks[0]);
      return;
    }
    const allStrings = chunks.every((c) => typeof c === "string");
    if (allStrings) {
      this.writeToTerminal(id, (chunks as string[]).join(""));
      return;
    }
    for (const chunk of chunks) {
      this.writeToTerminal(id, chunk);
    }
  }

  private recordFrameFlush(id: string): void {
    const now = Date.now();
    const existing = this.sabFrameStats.get(id);
    const lastIntervalMs = existing ? now - existing.lastFlushAt : null;

    let avgIntervalMs: number | null = lastIntervalMs;
    if (existing && existing.avgIntervalMs != null && lastIntervalMs != null) {
      const alpha = 0.2;
      avgIntervalMs = existing.avgIntervalMs * (1 - alpha) + lastIntervalMs * alpha;
    }

    this.sabFrameStats.set(id, {
      lastFlushAt: now,
      lastIntervalMs,
      avgIntervalMs,
    });
  }

  private enqueueFrame(id: string, chunks: (string | Uint8Array)[]): void {
    let queue = this.sabFrameQueues.get(id);
    if (!queue) {
      queue = { frames: [], presenterTimeoutId: null };
      this.sabFrameQueues.set(id, queue);
    }
    queue.frames.push(chunks);

    const MAX_FRAMES = 3;
    if (queue.frames.length > MAX_FRAMES) {
      queue.frames.splice(0, queue.frames.length - MAX_FRAMES);
    }

    if (queue.presenterTimeoutId === null) {
      this.scheduleFramePresenter(id, queue);
    }
  }

  private scheduleFramePresenter(id: string, queue: FrameQueue): void {
    const stats = this.sabFrameStats.get(id);
    const now = Date.now();
    let delay = 0;
    if (stats && stats.lastFlushAt) {
      const delta = now - stats.lastFlushAt;
      if (delta < MIN_FRAME_INTERVAL_MS) {
        delay = MIN_FRAME_INTERVAL_MS - delta;
      }
    }
    queue.presenterTimeoutId = window.setTimeout(() => this.presentNextFrame(id), delay);
  }

  private presentNextFrame(id: string): void {
    const queue = this.sabFrameQueues.get(id);
    if (!queue) return;

    queue.presenterTimeoutId = null;
    const frame = queue.frames.shift();
    if (!frame) {
      return;
    }

    this.writeFrameChunks(id, frame);
    this.recordFrameFlush(id);

    if (queue.frames.length > 0) {
      this.scheduleFramePresenter(id, queue);
    }
  }
}
