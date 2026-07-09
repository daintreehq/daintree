import type { TerminalOutputWorkerInboundMessage } from "@shared/types/terminal-output-worker-messages";
import { PERF_MARKS } from "@shared/perf/marks";
import { markRendererPerformance } from "@/utils/performance";
import { logDebug } from "@/utils/logger";
import { yieldToScheduler } from "@/lib/schedulerYield";

// Renderer-side backpressure layer that throttles xterm consumption. The
// IPC-layer counterparts (the burst absorber between PTY host and renderer) live
// in electron/services/pty/types.ts: IPC_MAX_QUEUE_BYTES (3MB ceiling),
// IPC_HIGH_WATERMARK_PERCENT (67, pause PTY), IPC_LOW_WATERMARK_PERCENT (33,
// resume PTY). These two layers are independent: the IPC queue absorbs PTY
// bursts, these watermarks pace how fast xterm drains them.
const RENDERER_HIGH_WATERMARK_BYTES = 128 * 1024;
const RENDERER_LOW_WATERMARK_BYTES = 32 * 1024;
const COALESCE_BATCH_CAP_BYTES = 256 * 1024;
// Background (non-focused) terminals get a much smaller in-flight window and
// batch size: bytes already handed to xterm.write() are un-holdable parse
// backlog (xterm chews them in ~12ms main-thread slices), so a flood pane
// fed 128KB+256KB keeps blocking the thread long after a focused-echo hold
// engages (#10948-class feel regressions). A 32KB window keeps the per-pane
// un-holdable backlog to roughly one parse slice while costing throughput
// only one extra drain wakeup per 32KB — background floods are parse-bound,
// not scheduling-bound.
const BACKGROUND_HIGH_WATERMARK_BYTES = 32 * 1024;
const BACKGROUND_LOW_WATERMARK_BYTES = 16 * 1024;
const BACKGROUND_COALESCE_CAP_BYTES = 32 * 1024;
const IPC_LOOKBACK_CHARS = 32;
const INK_ERASE_LINE_PATTERN = "\x1b[2K\x1b[1A";

// Default-on, opt-out build-time flag (mirrors DAINTREE_DISABLE_WEBGL in
// TerminalWebGLManager). When enabled, a background (non-focused) terminal's
// drain yields to the scheduler so a queued wheel/scroll/keystroke event on the
// focused terminal dispatches first, instead of running every terminal's write
// batch back-to-back in one task (#10881). Set DAINTREE_DISABLE_FOCUSED_DRAIN_PRIORITY=1
// to fall back to the legacy fully-synchronous drain.
const FOCUSED_DRAIN_PRIORITY_ENABLED =
  import.meta.env.DAINTREE_DISABLE_FOCUSED_DRAIN_PRIORITY !== "1";

// While the user is actively wheel-scrolling a terminal, background terminals'
// drains are HELD (re-checked on a timer) instead of merely yielded once, so
// their xterm write-buffer parse slices don't stack up on the main thread
// mid-gesture. Bounded fairness, not starvation: each queue drains a batch at
// least every HOLD_MAX_MS even during a continuous scroll, and the hold decays
// with the wheel burst itself (~1s after the last wheel event).
const BACKGROUND_HOLD_RECHECK_MS = 24;
const BACKGROUND_HOLD_MAX_MS = 250;

type TerminalIngestQueue = {
  chunks: Array<string | Uint8Array>;
  queuedBytes: number;
  inFlightBytes: number;
  recentChars: string;
  drainScheduled: boolean;
  holdStartedAt: number | undefined;
  // True while the pending drainScheduled continuation is a wheel-burst HOLD
  // recheck (as opposed to an ink-erase or yield continuation). Lets
  // enqueueChunk drain inline for a terminal that stopped being deferrable
  // mid-hold (e.g. focus moved to it) instead of waiting out the recheck.
  holdScheduled: boolean;
};

// A drained batch plus how many raw queue chunks it merged. The count must
// travel with the write: port-delivered chunks map 1:1 to host port-ack FIFO
// entries, so a write that coalesced N chunks must settle N entries on
// completion (acknowledgePortData's chunkCount) or the host ledger drifts
// toward permanent backpressure.
type CoalescedBatch = {
  data: string | Uint8Array;
  chunkCount: number;
};

export class TerminalOutputIngestService {
  private worker: Worker | null = null;
  private sabAvailable = false;
  private pollingActive = false;
  private initializePromise: Promise<void> | null = null;
  private perfSampleCounter = 0;
  private queues = new Map<string, TerminalIngestQueue>();

  constructor(
    private readonly writeToTerminal: (
      id: string,
      data: string | Uint8Array,
      chunkCount: number
    ) => void,
    // Which terminal is currently focused, or null when focus is unknown.
    // Defaults to () => null so a bare `new TerminalOutputIngestService(write)`
    // keeps the legacy fully-synchronous drain — null focus means "drain
    // synchronously for everyone", never "defer everyone".
    private readonly getFocusedId: () => string | null = () => null,
    // Whether a sustained interaction (a live wheel gesture on any terminal,
    // or a keystroke echo in flight) is in effect. While true, non-participant
    // background drains are held on a recheck timer instead of draining after
    // one yield.
    private readonly hasInteractionHold: () => boolean = () => false,
    // Whether this terminal is a participant in the live interaction (it is
    // being wheel-scrolled, or its keystroke echo is in flight). Participants
    // drain inline like the focused pane: scrolling an unfocused full-screen
    // TUI is a PTY round-trip per redraw, and deferring — let alone holding —
    // its own output stalls the very gesture the hold regime protects.
    private readonly isInteractionParticipant: (id: string) => boolean = () => false
  ) {}

  public async initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.initializeImpl();
    return this.initializePromise;
  }

  private async initializeImpl(): Promise<void> {
    // SAB worker is intentionally disabled. SharedArrayBuffer ring buffers use a single shared
    // read pointer (single-consumer design), but per-project WebContentsViews each create their
    // own worker polling the same buffers. This causes a race where one view's worker consumes
    // data meant for another view, silently dropping terminal output.
    //
    // MessagePort is now the primary data path (like VS Code). It routes data per-window with
    // project filtering, ensuring each view receives only its own terminals' output.
    // Data flows: pty-host → MessagePort → terminalClient.onData → bufferData → writeToTerminal.
    logDebug("[TerminalOutputIngestService] Using MessagePort data path (SAB worker disabled)");
    this.sabAvailable = false;
    this.pollingActive = false;
    this.worker = null;
  }

  public isEnabled(): boolean {
    return this.sabAvailable;
  }

  public isPolling(): boolean {
    return this.pollingActive;
  }

  public bufferData(id: string, data: string | Uint8Array): void {
    if (this.pollingActive) return;
    this.markTerminalDataReceived(id, data);
    this.enqueueChunk(id, data);
  }

  public notifyWriteComplete(id: string, bytes: number): void {
    const queue = this.queues.get(id);
    if (!queue) return;
    queue.inFlightBytes = Math.max(0, queue.inFlightBytes - bytes);
    const lowWatermark = this.shouldDeferDrain(id)
      ? BACKGROUND_LOW_WATERMARK_BYTES
      : RENDERER_LOW_WATERMARK_BYTES;
    if (queue.inFlightBytes <= lowWatermark && queue.chunks.length > 0) {
      this.scheduleOrDrain(id, queue);
    }
  }

  public notifyParsed(id: string): void {
    const queue = this.queues.get(id);
    if (!queue || queue.chunks.length === 0 || queue.drainScheduled) return;
    this.scheduleOrDrain(id, queue);
  }

  /**
   * Drain any held bytes through tryDrain (not forceDrain) so the 256KB
   * COALESCE_BATCH_CAP_BYTES cap is respected — a backlog must not become a
   * single multi-MB xterm.write() that blocks the main thread (#4853).
   */
  public resumeFlush(id: string): void {
    const queue = this.queues.get(id);
    if (!queue || queue.chunks.length === 0) return;
    this.scheduleOrDrain(id, queue);
  }

  /** Held ingest bytes for a terminal — diagnostic accessor for the watchdog. */
  public getQueuedBytes(id: string): number {
    return this.queues.get(id)?.queuedBytes ?? 0;
  }

  /**
   * Bytes stranded in the queue with nothing left to rescue them: chunks are
   * held, no drain is scheduled, and no write is in flight (so no
   * notifyWriteComplete will ever fire). Normal backpressure keeps
   * inFlightBytes non-zero while chunks wait; a zero-in-flight hold is the
   * background-gate / hysteresis-strand signature the watchdog repairs.
   */
  public getStalledBytes(id: string): number {
    const queue = this.queues.get(id);
    if (!queue || queue.chunks.length === 0) return 0;
    if (queue.drainScheduled) return 0;
    if (queue.inFlightBytes > 0) return 0;
    return queue.queuedBytes;
  }

  public resetForTerminal(id: string): void {
    this.clearQueue(id);
    if (!this.pollingActive || !this.worker) return;
    const message: TerminalOutputWorkerInboundMessage = {
      type: "RESET_TERMINAL",
      id,
    };
    this.worker.postMessage(message);
  }

  public flushForTerminal(id: string): void {
    this.forceDrain(id);
    if (!this.pollingActive || !this.worker) return;
    const message: TerminalOutputWorkerInboundMessage = {
      type: "FLUSH_TERMINAL",
      id,
    };
    this.worker.postMessage(message);
  }

  public stopPolling(): void {
    for (const id of this.queues.keys()) {
      this.forceDrain(id);
    }
    this.pollingActive = false;
    this.sabAvailable = false;
    if (!this.worker) return;
    const message: TerminalOutputWorkerInboundMessage = {
      type: "STOP",
    };
    this.worker.postMessage(message);
    setTimeout(() => {
      this.worker?.terminate();
      this.worker = null;
      this.initializePromise = null;
    }, 50);
  }

  private markTerminalDataReceived(id: string, data: string | Uint8Array): void {
    this.perfSampleCounter += 1;
    if (this.perfSampleCounter % 64 !== 0) return;

    markRendererPerformance(PERF_MARKS.TERMINAL_DATA_RECEIVED, {
      terminalId: id,
      bytes: typeof data === "string" ? data.length : data.byteLength,
    });
  }

  private getOrCreateQueue(id: string): TerminalIngestQueue {
    let queue = this.queues.get(id);
    if (!queue) {
      queue = {
        chunks: [],
        queuedBytes: 0,
        inFlightBytes: 0,
        recentChars: "",
        drainScheduled: false,
        holdStartedAt: undefined,
        holdScheduled: false,
      };
      this.queues.set(id, queue);
    }
    return queue;
  }

  private chunkByteSize(data: string | Uint8Array): number {
    return typeof data === "string" ? data.length : data.byteLength;
  }

  private enqueueChunk(id: string, data: string | Uint8Array): void {
    const queue = this.getOrCreateQueue(id);
    const bytes = this.chunkByteSize(data);
    queue.chunks.push(data);
    queue.queuedBytes += bytes;

    const stringData = typeof data === "string" ? data : "";
    if (stringData) {
      // Scan the chunk and the boundary window separately — concatenating
      // recentChars with the full chunk would flatten a copy of the entire
      // chunk just to find an 8-char pattern. A straddling occurrence uses at
      // most the first pattern-length-minus-one chars of the new chunk.
      const boundary = queue.recentChars + stringData.slice(0, INK_ERASE_LINE_PATTERN.length - 1);
      const containsInkErase =
        stringData.includes(INK_ERASE_LINE_PATTERN) || boundary.includes(INK_ERASE_LINE_PATTERN);
      queue.recentChars =
        stringData.length >= IPC_LOOKBACK_CHARS
          ? stringData.slice(-IPC_LOOKBACK_CHARS)
          : (queue.recentChars + stringData).slice(-IPC_LOOKBACK_CHARS);

      if (containsInkErase && !queue.drainScheduled) {
        queue.drainScheduled = true;
        globalThis.setTimeout(() => {
          if (this.queues.get(id) !== queue) return;
          queue.drainScheduled = false;
          this.scheduleOrDrain(id, queue);
        }, 0);
        return;
      }
    }

    if (!queue.drainScheduled) {
      this.scheduleOrDrain(id, queue);
    } else if (queue.holdScheduled && !this.shouldDeferDrain(id)) {
      // A wheel-burst hold recheck is pending, but this terminal is no longer
      // deferrable (focus moved to it mid-gesture). Drain inline now — echo
      // latency must not wait out the hold. The pending recheck no-ops on an
      // empty queue. Scoped to holdScheduled: an ink-erase continuation must
      // keep its coalescing window.
      this.tryDrain(id, queue);
    }
  }

  /**
   * Drain the queue, but let a background (non-focused) terminal yield to the
   * scheduler first so a queued wheel/scroll/keystroke event on the focused
   * terminal dispatches ahead of this write batch (#10881). The focused
   * terminal (and the unknown-focus / flag-disabled cases) drains inline, so
   * keystroke-echo latency on the pane the user is watching is unchanged.
   *
   * A single yield is enough: it hands one task back to input dispatch, then we
   * drain. We deliberately do NOT re-defer while still background — that would
   * starve steady background output. Repeat triggers coalesce via
   * queue.drainScheduled into one pending continuation (no per-chunk timer
   * churn, #8150); the deferred drain still routes through tryDrain, so the
   * COALESCE_BATCH_CAP_BYTES cap is respected (#4853).
   *
   * Exception: during an ACTIVE wheel gesture (getActiveWheelId non-null),
   * background queues are additionally held on a bounded recheck timer — see
   * BACKGROUND_HOLD_MAX_MS — because a scroll is a sustained interaction where
   * even yielded-once batches stack enough parse slices to jank the gesture.
   */
  private scheduleOrDrain(id: string, queue: TerminalIngestQueue): void {
    if (!this.shouldDeferDrain(id)) {
      queue.holdStartedAt = undefined;
      this.tryDrain(id, queue);
      return;
    }
    if (queue.drainScheduled) return;

    // Active wheel gesture elsewhere: hold this background queue on a recheck
    // timer (bounded by BACKGROUND_HOLD_MAX_MS) so its parse work stays off
    // the thread while the user is scrolling. Not a starvation risk: the hold
    // cap forces a drain, the wheel burst decays ~1s after the last event,
    // and getStalledBytes treats drainScheduled=true as healthy so the
    // watchdog never sees a held queue as stranded.
    if (this.shouldHoldDrain(id)) {
      const now = Date.now();
      queue.holdStartedAt ??= now;
      if (now - queue.holdStartedAt < BACKGROUND_HOLD_MAX_MS) {
        queue.drainScheduled = true;
        queue.holdScheduled = true;
        globalThis.setTimeout(() => {
          if (this.queues.get(id) !== queue) return;
          queue.drainScheduled = false;
          queue.holdScheduled = false;
          if (queue.chunks.length === 0) {
            queue.holdStartedAt = undefined;
            return;
          }
          this.scheduleOrDrain(id, queue);
        }, BACKGROUND_HOLD_RECHECK_MS);
        return;
      }
    }
    queue.holdStartedAt = undefined;

    queue.drainScheduled = true;
    void yieldToScheduler().then(() => {
      // The queue may have been cleared/replaced (resetForTerminal,
      // forceDrain) while we were yielding — bail on a stale identity.
      if (this.queues.get(id) !== queue) return;
      queue.drainScheduled = false;
      if (queue.chunks.length === 0) return;
      this.tryDrain(id, queue);
    });
  }

  private shouldDeferDrain(id: string): boolean {
    if (!FOCUSED_DRAIN_PRIORITY_ENABLED) return false;
    const focusedId = this.getFocusedId();
    if (focusedId === null || focusedId === id) return false;
    return !this.isInteractionParticipant(id);
  }

  private shouldHoldDrain(id: string): boolean {
    return this.hasInteractionHold() && !this.isInteractionParticipant(id);
  }

  private tryDrain(id: string, queue: TerminalIngestQueue): void {
    const deferred = this.shouldDeferDrain(id);
    const highWatermark = deferred
      ? BACKGROUND_HIGH_WATERMARK_BYTES
      : RENDERER_HIGH_WATERMARK_BYTES;
    const batchCap = deferred ? BACKGROUND_COALESCE_CAP_BYTES : COALESCE_BATCH_CAP_BYTES;
    while (queue.chunks.length > 0 && queue.inFlightBytes < highWatermark) {
      const batch = this.coalesceBatch(queue, batchCap);
      const batchBytes = this.chunkByteSize(batch.data);
      queue.inFlightBytes += batchBytes;
      this.writeToTerminal(id, batch.data, batch.chunkCount);
    }
  }

  // Merge the longest same-type chunk prefix into one write, capped at
  // `batchCap` (#4853 — xterm yields between write-buffer entries, not within
  // one chunk, so an unbounded merge would block the main thread). The first
  // chunk is always taken even when it alone exceeds the cap. Uint8Array
  // prefixes merge into one freshly-allocated array — the MessagePort path
  // delivers binary chunks, so without this branch a backpressure/wake backlog
  // drains as hundreds of per-chunk writes.
  private coalesceBatch(
    queue: TerminalIngestQueue,
    batchCap: number = COALESCE_BATCH_CAP_BYTES
  ): CoalescedBatch {
    if (queue.chunks.length === 1) {
      const chunk = queue.chunks[0]!;
      queue.chunks.length = 0;
      queue.queuedBytes = 0;
      return { data: chunk, chunkCount: 1 };
    }

    const first = queue.chunks[0]!;
    const firstIsString = typeof first === "string";
    let taken = this.chunkByteSize(first);
    let count = 1;
    while (count < queue.chunks.length) {
      const next = queue.chunks[count]!;
      if ((typeof next === "string") !== firstIsString) break;
      const size = this.chunkByteSize(next);
      if (taken + size > batchCap) break;
      taken += size;
      count++;
    }

    if (count === 1) {
      queue.chunks.shift();
      queue.queuedBytes -= taken;
      return { data: first, chunkCount: 1 };
    }

    const merged = queue.chunks.splice(0, count);
    queue.queuedBytes -= taken;
    if (queue.chunks.length === 0) {
      queue.queuedBytes = 0;
    }
    if (firstIsString) {
      return { data: (merged as string[]).join(""), chunkCount: count };
    }
    const out = new Uint8Array(taken);
    let offset = 0;
    for (const chunk of merged as Uint8Array[]) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { data: out, chunkCount: count };
  }

  private clearQueue(id: string): void {
    this.queues.delete(id);
  }

  // Flush everything held for a terminal, bypassing the in-flight watermark
  // but still emitting cap-bounded batches — a resize/teardown flush of a
  // multi-MB hold must not become one synchronous xterm.write (#4853).
  private forceDrain(id: string): void {
    const queue = this.queues.get(id);
    if (!queue || queue.chunks.length === 0) return;

    while (queue.chunks.length > 0) {
      const batch = this.coalesceBatch(queue);
      this.writeToTerminal(id, batch.data, batch.chunkCount);
    }

    this.queues.delete(id);
  }
}
