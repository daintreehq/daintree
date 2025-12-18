/**
 * TerminalOutputCoalescer - FRONTEND OUTPUT OPTIMIZATION
 *
 * PROTECTED INFRASTRUCTURE:
 * This component coalesces high-frequency output chunks into larger frames
 * to prevent xterm.js layout thrashing. It also handles frame dropping
 * when the UI is overwhelmed (backpressure).
 *
 * Do not remove the frame queue, settlement timers, or flush logic.
 */

const STANDARD_FLUSH_DELAY_MS = 8;
const REDRAW_FLUSH_DELAY_MS = 16;
const MAX_FLUSH_DELAY_MS = 32;
const MIN_FRAME_INTERVAL_MS = 50;
const REDRAW_LOOKBACK_CHARS = 32;
const EARLY_HOME_BYTE_WINDOW = 256;
const TUI_BURST_THRESHOLD_MS = 50;

const INTERACTIVE_FLUSH_THRESHOLD_BYTES = 2048;
const INTERACTIVE_FLUSH_DELAY_MS = 0;
const MAX_BUFFER_BYTES = 20 * 1024;

type FlushMode = "normal" | "frame";

type BufferEntry = {
  chunks: (string | Uint8Array)[];
  bytes: number;
  flushMode: FlushMode;
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

type FrameQueue = {
  frames: (string | Uint8Array)[][];
  presenterTimeoutId: number | null;
  lastPresentedAt: number;
};

export type CoalescerOutput = {
  id: string;
  data: string | Uint8Array;
};

export class TerminalOutputCoalescer {
  private buffers = new Map<string, BufferEntry>();
  private frameQueues = new Map<string, FrameQueue>();
  private interactiveUntil = new Map<string, number>();

  // Debug stats
  private stats = {
    framesCoalesced: 0,
    framesDropped: 0,
  };

  constructor(
    private readonly scheduleTimeout: (callback: () => void, delayMs: number) => number,
    private readonly clearScheduledTimeout: (timeoutId: number) => void,
    private readonly getNow: () => number,
    private readonly onOutput: (output: CoalescerOutput) => void
  ) {}

  public bufferData(id: string, data: string | Uint8Array): void {
    const now = this.getNow();
    let entry = this.buffers.get(id);
    const dataLength = typeof data === "string" ? data.length : data.byteLength;
    console.log(`[TERM_FLOW] Coalescer.bufferData(${id}): ${dataLength}b, existingEntry=${!!entry}`);
    const stringData = typeof data === "string" ? data : "";
    const prevRecent = entry ? entry.recentChars : "";
    const prevBytes = entry ? entry.bytesSinceStart : 0;
    const combinedRecent = (prevRecent + stringData).slice(-REDRAW_LOOKBACK_CHARS);
    const bytesSinceStart = prevBytes + dataLength;
    const isRedraw = this.detectRedrawPatternInStream(prevRecent, stringData, bytesSinceStart);

    if (!entry) {
      entry = {
        chunks: [],
        bytes: 0,
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
      this.buffers.set(id, entry);

      entry.chunks.push(data);
      entry.bytes += dataLength;

      if (entry.bytes >= MAX_BUFFER_BYTES) {
        this.flushBuffer(id);
        return;
      }

      const until = this.interactiveUntil.get(id);
      if (until !== undefined && now <= until && entry.flushMode === "normal") {
        if (entry.bytes <= INTERACTIVE_FLUSH_THRESHOLD_BYTES) {
          this.flushBuffer(id);
          return;
        }

        entry.normalTimeoutId = this.scheduleTimeout(
          () => this.flushBuffer(id),
          INTERACTIVE_FLUSH_DELAY_MS
        );
        return;
      }

      if (entry.flushMode === "normal") {
        entry.normalTimeoutId = this.scheduleTimeout(
          () => this.flushBuffer(id),
          STANDARD_FLUSH_DELAY_MS
        );
      } else {
        entry.frameSettleTimeoutId = this.scheduleTimeout(
          () => this.onFrameSettle(id),
          REDRAW_FLUSH_DELAY_MS
        );
        entry.frameDeadlineTimeoutId = this.scheduleTimeout(
          () => this.flushBuffer(id),
          MAX_FLUSH_DELAY_MS
        );
      }
      return;
    }

    if (isRedraw) {
      if (entry.lastRedrawAt !== null) {
        const clearDelta = now - entry.lastRedrawAt;
        if (clearDelta <= TUI_BURST_THRESHOLD_MS) {
          entry.flushOnRedrawOnly = true;
        }
      }
      entry.lastRedrawAt = now;
    }

    entry.recentChars = combinedRecent;
    entry.bytesSinceStart = bytesSinceStart;
    entry.lastDataAt = now;

    if (isRedraw && entry.chunks.length > 0) {
      const queue = this.frameQueues.get(id);
      const delta = queue ? now - queue.lastPresentedAt : Number.POSITIVE_INFINITY;

      if (delta < MIN_FRAME_INTERVAL_MS) {
        this.clearEntryTimers(entry);
        entry.chunks = [data];
        entry.bytes = dataLength;
        entry.flushMode = "frame";
        entry.bytesSinceStart = dataLength;
        entry.recentChars = combinedRecent;
        entry.firstDataAt = now;
        entry.lastDataAt = now;
        entry.lastRedrawAt = now;

        const settleDelay = Math.max(REDRAW_FLUSH_DELAY_MS, MIN_FRAME_INTERVAL_MS - delta);
        entry.frameSettleTimeoutId = this.scheduleTimeout(
          () => this.onFrameSettle(id),
          settleDelay
        );
        entry.frameDeadlineTimeoutId = this.scheduleTimeout(
          () => this.flushBuffer(id),
          Math.max(MAX_FLUSH_DELAY_MS, settleDelay)
        );
        return;
      }

      this.flushBuffer(id);
      this.bufferData(id, data);
      return;
    }

    entry.chunks.push(data);
    entry.bytes += dataLength;

    const until = this.interactiveUntil.get(id);
    if (until !== undefined && this.getNow() <= until) {
      if (entry.flushMode === "frame") {
        this.rescheduleFrameTimers(id, entry);
        return;
      }
      if (entry.bytes <= INTERACTIVE_FLUSH_THRESHOLD_BYTES) {
        this.flushBuffer(id);
        return;
      }

      if (entry.normalTimeoutId !== null) {
        this.clearScheduledTimeout(entry.normalTimeoutId);
      }

      entry.normalTimeoutId = this.scheduleTimeout(
        () => this.flushBuffer(id),
        INTERACTIVE_FLUSH_DELAY_MS
      );
      return;
    }

    if (entry.bytes >= MAX_BUFFER_BYTES) {
      this.flushBuffer(id);
      return;
    }

    if (entry.flushMode === "normal") {
      if (entry.normalTimeoutId === null) {
        entry.normalTimeoutId = this.scheduleTimeout(
          () => this.flushBuffer(id),
          STANDARD_FLUSH_DELAY_MS
        );
      }
      return;
    }

    this.rescheduleFrameTimers(id, entry);
  }

  public markInteractive(id: string, ttlMs: number = 1000): void {
    this.interactiveUntil.set(id, this.getNow() + ttlMs);
  }

  public resetForTerminal(id: string): void {
    const entry = this.buffers.get(id);
    if (entry) {
      this.clearEntryTimers(entry);
      this.buffers.delete(id);
    }
    this.interactiveUntil.delete(id);

    const queue = this.frameQueues.get(id);
    if (queue) {
      if (queue.presenterTimeoutId !== null) {
        this.clearScheduledTimeout(queue.presenterTimeoutId);
      }
      this.frameQueues.delete(id);
    }
  }

  public flushForTerminal(id: string): void {
    this.flushBuffer(id);
  }

  public flushAll(): void {
    for (const id of [...this.buffers.keys()]) {
      this.flushBuffer(id);
    }
  }

  public dispose(): void {
    for (const entry of this.buffers.values()) {
      this.clearEntryTimers(entry);
    }
    for (const queue of this.frameQueues.values()) {
      if (queue.presenterTimeoutId !== null) {
        this.clearScheduledTimeout(queue.presenterTimeoutId);
      }
    }
    this.buffers.clear();
    this.frameQueues.clear();
    this.interactiveUntil.clear();
  }

  private rescheduleFrameTimers(id: string, entry: BufferEntry): void {
    if (entry.frameSettleTimeoutId !== null) {
      this.clearScheduledTimeout(entry.frameSettleTimeoutId);
    }

    entry.frameSettleTimeoutId = this.scheduleTimeout(
      () => this.onFrameSettle(id),
      REDRAW_FLUSH_DELAY_MS
    );

    if (entry.frameDeadlineTimeoutId === null) {
      entry.frameDeadlineTimeoutId = this.scheduleTimeout(
        () => this.flushBuffer(id),
        MAX_FLUSH_DELAY_MS
      );
    }
  }

  private detectRedrawPatternInStream(
    prevRecent: string,
    nextChunk: string,
    bytesSinceStart: number
  ): boolean {
    const combined = prevRecent + nextChunk;
    if (!combined) return false;

    const hasNewClear = this.hasNewAnsiSequence(prevRecent, nextChunk, "\x1b[2J");
    if (hasNewClear) return true;

    const hasNewHome = this.hasNewAnsiSequence(prevRecent, nextChunk, "\x1b[H");
    if (hasNewHome && bytesSinceStart <= EARLY_HOME_BYTE_WINDOW) return true;

    return false;
  }

  private hasNewAnsiSequence(prevRecent: string, nextChunk: string, needle: string): boolean {
    if (!needle) return false;
    const combined = prevRecent + nextChunk;
    const idx = combined.lastIndexOf(needle);
    if (idx === -1) return false;

    const boundary = prevRecent.length;
    if (idx >= boundary) return true;
    return idx + needle.length > boundary;
  }

  private onFrameSettle(id: string): void {
    const entry = this.buffers.get(id);
    if (!entry) return;

    entry.frameSettleTimeoutId = null;

    const now = this.getNow();
    if (now - entry.lastDataAt >= REDRAW_FLUSH_DELAY_MS - 1) {
      if (entry.flushMode === "frame" && entry.flushOnRedrawOnly) {
        console.log(`[TERM_FLOW] Coalescer.onFrameSettle(${id}): SKIPPED flushOnRedrawOnly=true`);
        return;
      }
      this.flushBuffer(id);
    }
  }

  private clearEntryTimers(entry: BufferEntry): void {
    if (entry.normalTimeoutId !== null) {
      this.clearScheduledTimeout(entry.normalTimeoutId);
      entry.normalTimeoutId = null;
    }

    if (entry.frameSettleTimeoutId !== null) {
      this.clearScheduledTimeout(entry.frameSettleTimeoutId);
      entry.frameSettleTimeoutId = null;
    }

    if (entry.frameDeadlineTimeoutId !== null) {
      this.clearScheduledTimeout(entry.frameDeadlineTimeoutId);
      entry.frameDeadlineTimeoutId = null;
    }
  }

  private writeFrameChunks(id: string, chunks: (string | Uint8Array)[]): void {
    if (chunks.length === 0) return;
    const totalBytes = chunks.reduce((sum, c) => sum + (typeof c === "string" ? c.length : c.byteLength), 0);
    console.log(`[TERM_FLOW] Coalescer.writeFrameChunks(${id}): ${chunks.length} chunks, ${totalBytes}b -> onOutput`);
    if (chunks.length === 1) {
      this.onOutput({ id, data: chunks[0] });
      return;
    }

    const allStrings = chunks.every((chunk) => typeof chunk === "string");
    if (allStrings) {
      this.onOutput({ id, data: (chunks as string[]).join("") });
      return;
    }

    for (const chunk of chunks) {
      this.onOutput({ id, data: chunk });
    }
  }

  private enqueueFrame(id: string, chunks: (string | Uint8Array)[]): void {
    let queue = this.frameQueues.get(id);
    if (!queue) {
      queue = { frames: [], presenterTimeoutId: null, lastPresentedAt: 0 };
      this.frameQueues.set(id, queue);
    }

    queue.frames.push(chunks);

    const MAX_FRAMES = 3;
    if (queue.frames.length > MAX_FRAMES) {
      this.stats.framesDropped += queue.frames.length - MAX_FRAMES;
      queue.frames.splice(0, queue.frames.length - MAX_FRAMES);
    }

    if (queue.presenterTimeoutId === null) {
      this.scheduleFramePresenter(id, queue);
    }
  }

  private scheduleFramePresenter(id: string, queue: FrameQueue): void {
    const now = this.getNow();
    const delta = queue.lastPresentedAt ? now - queue.lastPresentedAt : Number.POSITIVE_INFINITY;
    const delay = delta < MIN_FRAME_INTERVAL_MS ? MIN_FRAME_INTERVAL_MS - delta : 0;
    queue.presenterTimeoutId = this.scheduleTimeout(() => this.presentNextFrame(id), delay);
  }

  private presentNextFrame(id: string): void {
    const queue = this.frameQueues.get(id);
    if (!queue) return;

    queue.presenterTimeoutId = null;
    const frame = queue.frames.shift();
    if (!frame) return;

    this.writeFrameChunks(id, frame);
    queue.lastPresentedAt = this.getNow();

    if (queue.frames.length > 0) {
      this.scheduleFramePresenter(id, queue);
    }
  }

  private flushBuffer(id: string): void {
    const entry = this.buffers.get(id);
    if (!entry) return;

    this.clearEntryTimers(entry);
    this.buffers.delete(id);
    if (entry.chunks.length === 0) {
      console.log(`[TERM_FLOW] Coalescer.flushBuffer(${id}): empty, no-op`);
      return;
    }
    console.log(`[TERM_FLOW] Coalescer.flushBuffer(${id}): ${entry.chunks.length} chunks, ${entry.bytes}b, mode=${entry.flushMode}`);

    if (entry.flushMode === "frame") {
      this.enqueueFrame(id, entry.chunks);
      return;
    }

    this.writeFrameChunks(id, entry.chunks);
  }
}
