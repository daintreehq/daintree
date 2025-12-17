import { SharedRingBuffer, PacketParser } from "@shared/utils/SharedRingBuffer";
import { terminalClient } from "@/clients";

const STANDARD_FLUSH_DELAY_MS = 8;
const REDRAW_FLUSH_DELAY_MS = 16;
const MAX_FLUSH_DELAY_MS = 32;
const MIN_FRAME_INTERVAL_MS = 50;
const REDRAW_LOOKBACK_CHARS = 32;
const EARLY_HOME_BYTE_WINDOW = 256;
const TUI_BURST_THRESHOLD_MS = 50;

const INTERACTIVE_FLUSH_THRESHOLD_BYTES = 2048;
const INTERACTIVE_FLUSH_DELAY_MS = 0;
const IDLE_POLL_INTERVALS = [8, 16, 33, 100] as const;
const MAX_BUFFER_BYTES = 20 * 1024;
const MAX_READS_PER_TICK = 50;
const BUSY_POLL_INTERVAL_MS = 8;
const MAX_SAB_READ_BYTES = 256 * 1024;
const MAX_SAB_BYTES_PER_TICK = 2 * 1024 * 1024;

const BYPASS_FRAME_BUFFER: boolean = false;

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

export class TerminalDataBuffer {
  private ringBuffer: SharedRingBuffer | null = null;
  private packetParser = new PacketParser();
  private pollingActive = false;
  private pollTimeoutId: number | null = null;
  private sharedBufferEnabled = false;
  private idlePollCount = 0;

  private buffers = new Map<string, BufferEntry>();
  private frameQueues = new Map<string, FrameQueue>();
  private interactiveUntil = new Map<string, number>();

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

  public boost(): void {
    this.idlePollCount = 0;

    if (!this.pollingActive || !this.ringBuffer) return;
    if (this.pollTimeoutId === null) return;

    window.clearTimeout(this.pollTimeoutId);
    this.pollTimeoutId = null;
    this.poll();
  }

  public markInteractive(id: string, ttlMs: number = 1000): void {
    this.interactiveUntil.set(id, Date.now() + ttlMs);
  }

  private startPolling(): void {
    if (this.pollingActive || !this.ringBuffer) return;
    this.pollingActive = true;
    this.idlePollCount = 0;
    this.poll();
  }

  public stopPolling(): void {
    this.pollingActive = false;
    if (this.pollTimeoutId !== null) {
      clearTimeout(this.pollTimeoutId);
      this.pollTimeoutId = null;
    }

    for (const id of [...this.buffers.keys()]) {
      this.flushBuffer(id);
    }
  }

  public bufferData(id: string, data: string | Uint8Array): void {
    if (BYPASS_FRAME_BUFFER) {
      this.writeToTerminal(id, data);
      return;
    }

    const now = Date.now();
    let entry = this.buffers.get(id);
    const dataLength = typeof data === "string" ? data.length : data.byteLength;
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

        entry.normalTimeoutId = window.setTimeout(
          () => this.flushBuffer(id),
          INTERACTIVE_FLUSH_DELAY_MS
        );
        return;
      }

      if (entry.flushMode === "normal") {
        entry.normalTimeoutId = window.setTimeout(
          () => this.flushBuffer(id),
          STANDARD_FLUSH_DELAY_MS
        );
      } else {
        entry.frameSettleTimeoutId = window.setTimeout(
          () => this.onFrameSettle(id),
          REDRAW_FLUSH_DELAY_MS
        );
        entry.frameDeadlineTimeoutId = window.setTimeout(
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
        entry.frameSettleTimeoutId = window.setTimeout(() => this.onFrameSettle(id), settleDelay);
        entry.frameDeadlineTimeoutId = window.setTimeout(
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

    // Typing fast-lane: flush aggressively right after user input.
    const until = this.interactiveUntil.get(id);
    if (until !== undefined && Date.now() <= until) {
      if (entry.flushMode === "frame") {
        this.rescheduleFrameTimers(id, entry);
        return;
      }
      if (entry.bytes <= INTERACTIVE_FLUSH_THRESHOLD_BYTES) {
        this.flushBuffer(id);
        return;
      }

      if (entry.normalTimeoutId !== null) {
        window.clearTimeout(entry.normalTimeoutId);
      }

      entry.normalTimeoutId = window.setTimeout(
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
        entry.normalTimeoutId = window.setTimeout(
          () => this.flushBuffer(id),
          STANDARD_FLUSH_DELAY_MS
        );
      }
      return;
    }

    this.rescheduleFrameTimers(id, entry);
  }

  private rescheduleFrameTimers(id: string, entry: BufferEntry): void {
    if (entry.frameSettleTimeoutId !== null) {
      window.clearTimeout(entry.frameSettleTimeoutId);
    }

    entry.frameSettleTimeoutId = window.setTimeout(
      () => this.onFrameSettle(id),
      REDRAW_FLUSH_DELAY_MS
    );

    if (entry.frameDeadlineTimeoutId === null) {
      entry.frameDeadlineTimeoutId = window.setTimeout(
        () => this.flushBuffer(id),
        MAX_FLUSH_DELAY_MS
      );
    }
  }

  public resetForTerminal(id: string): void {
    const entry = this.buffers.get(id);
    if (!entry) return;
    this.clearEntryTimers(entry);
    this.buffers.delete(id);
    this.interactiveUntil.delete(id);

    const queue = this.frameQueues.get(id);
    if (queue) {
      if (queue.presenterTimeoutId !== null) {
        window.clearTimeout(queue.presenterTimeoutId);
      }
      this.frameQueues.delete(id);
    }
  }

  public flushForTerminal(id: string): void {
    this.flushBuffer(id);
  }

  private poll = (): void => {
    if (!this.pollingActive || !this.ringBuffer) return;
    this.pollTimeoutId = null;

    let hasData = false;
    let reads = 0;
    let bytesReadThisTick = 0;

    while (reads < MAX_READS_PER_TICK && bytesReadThisTick < MAX_SAB_BYTES_PER_TICK) {
      const remainingBudget = MAX_SAB_BYTES_PER_TICK - bytesReadThisTick;
      if (remainingBudget <= 0) {
        break;
      }
      const perReadBudget = Math.min(MAX_SAB_READ_BYTES, remainingBudget);
      const data = this.ringBuffer.readUpTo(perReadBudget);
      if (!data) {
        break;
      }

      hasData = true;
      reads += 1;
      bytesReadThisTick += data.byteLength;
      const packets = this.packetParser.parse(data);

      for (const packet of packets) {
        this.bufferData(packet.id, packet.data);
      }
    }

    if (hasData) {
      this.idlePollCount = 0;
      this.pollTimeoutId = window.setTimeout(this.poll, BUSY_POLL_INTERVAL_MS);
    } else {
      const intervalIndex = Math.min(this.idlePollCount, IDLE_POLL_INTERVALS.length - 1);
      const interval = IDLE_POLL_INTERVALS[intervalIndex];
      this.idlePollCount = Math.min(this.idlePollCount + 1, IDLE_POLL_INTERVALS.length - 1);
      this.pollTimeoutId = window.setTimeout(this.poll, interval);
    }
  };

  private detectRedrawPatternInStream(
    prevRecent: string,
    nextChunk: string,
    bytesSinceStart: number
  ): boolean {
    const combined = prevRecent + nextChunk;
    if (!combined) return false;

    // Clear screen (CSI 2 J) - most common TUI redraw
    const hasNewClear = this.hasNewAnsiSequence(prevRecent, nextChunk, "\x1b[2J");
    if (hasNewClear) return true;

    // Cursor home at start of output - often indicates TUI redraw
    const hasNewHome = this.hasNewAnsiSequence(prevRecent, nextChunk, "\x1b[H");
    if (hasNewHome && bytesSinceStart <= EARLY_HOME_BYTE_WINDOW) return true;

    // Clear scrollback (CSI 3 J) - clears the entire buffer
    const hasNewClearScrollback = this.hasNewAnsiSequence(prevRecent, nextChunk, "\x1b[3J");
    if (hasNewClearScrollback) return true;

    // Alt buffer enter (CSI ? 1049 h) - used by TUIs like vim, htop, etc.
    const hasAltEnter = this.hasNewAnsiSequence(prevRecent, nextChunk, "\x1b[?1049h");
    if (hasAltEnter) return true;

    // Alt buffer exit (CSI ? 1049 l) - returning from alt buffer
    const hasAltExit = this.hasNewAnsiSequence(prevRecent, nextChunk, "\x1b[?1049l");
    if (hasAltExit) return true;

    // Alternate buffer variants (CSI ? 47 h/l and CSI ? 1047 h/l)
    const hasAlt47h = this.hasNewAnsiSequence(prevRecent, nextChunk, "\x1b[?47h");
    if (hasAlt47h) return true;

    const hasAlt47l = this.hasNewAnsiSequence(prevRecent, nextChunk, "\x1b[?47l");
    if (hasAlt47l) return true;

    const hasAlt1047h = this.hasNewAnsiSequence(prevRecent, nextChunk, "\x1b[?1047h");
    if (hasAlt1047h) return true;

    const hasAlt1047l = this.hasNewAnsiSequence(prevRecent, nextChunk, "\x1b[?1047l");
    if (hasAlt1047l) return true;

    // RIS - full terminal reset
    const hasRis = this.hasNewAnsiSequence(prevRecent, nextChunk, "\x1bc");
    if (hasRis) return true;

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

    const now = Date.now();
    if (now - entry.lastDataAt >= REDRAW_FLUSH_DELAY_MS - 1) {
      if (entry.flushMode === "frame" && entry.flushOnRedrawOnly) {
        return;
      }
      this.flushBuffer(id);
    }
  }

  private clearEntryTimers(entry: BufferEntry): void {
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

  private writeFrameChunks(id: string, chunks: (string | Uint8Array)[]): void {
    if (chunks.length === 0) return;
    if (chunks.length === 1) {
      this.writeToTerminal(id, chunks[0]);
      return;
    }

    const allStrings = chunks.every((chunk) => typeof chunk === "string");
    if (allStrings) {
      this.writeToTerminal(id, (chunks as string[]).join(""));
      return;
    }

    for (const chunk of chunks) {
      this.writeToTerminal(id, chunk);
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
      queue.frames.splice(0, queue.frames.length - MAX_FRAMES);
    }

    if (queue.presenterTimeoutId === null) {
      this.scheduleFramePresenter(id, queue);
    }
  }

  private scheduleFramePresenter(id: string, queue: FrameQueue): void {
    const now = Date.now();
    const delta = queue.lastPresentedAt ? now - queue.lastPresentedAt : Number.POSITIVE_INFINITY;
    const delay = delta < MIN_FRAME_INTERVAL_MS ? MIN_FRAME_INTERVAL_MS - delta : 0;
    queue.presenterTimeoutId = window.setTimeout(() => this.presentNextFrame(id), delay);
  }

  private presentNextFrame(id: string): void {
    const queue = this.frameQueues.get(id);
    if (!queue) return;

    queue.presenterTimeoutId = null;
    const frame = queue.frames.shift();
    if (!frame) return;

    this.writeFrameChunks(id, frame);
    queue.lastPresentedAt = Date.now();

    if (queue.frames.length > 0) {
      this.scheduleFramePresenter(id, queue);
    }
  }

  private flushBuffer(id: string): void {
    const entry = this.buffers.get(id);
    if (!entry) return;

    this.clearEntryTimers(entry);
    this.buffers.delete(id);
    if (entry.chunks.length === 0) return;

    if (entry.flushMode === "frame") {
      this.enqueueFrame(id, entry.chunks);
      return;
    }

    this.writeFrameChunks(id, entry.chunks);
  }
}
