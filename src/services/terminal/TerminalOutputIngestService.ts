import type { TerminalOutputWorkerInboundMessage } from "@shared/types/terminal-output-worker-messages";
import { PERF_MARKS } from "@shared/perf/marks";
import { markRendererPerformance } from "@/utils/performance";
import { logDebug } from "@/utils/logger";

// Renderer-side backpressure layer that throttles xterm consumption. The
// IPC-layer counterparts (the burst absorber between PTY host and renderer) live
// in electron/services/pty/types.ts: IPC_MAX_QUEUE_BYTES (3MB ceiling),
// IPC_HIGH_WATERMARK_PERCENT (67, pause PTY), IPC_LOW_WATERMARK_PERCENT (33,
// resume PTY). These two layers are independent: the IPC queue absorbs PTY
// bursts, these watermarks pace how fast xterm drains them.
const RENDERER_HIGH_WATERMARK_BYTES = 128 * 1024;
const RENDERER_LOW_WATERMARK_BYTES = 32 * 1024;
const COALESCE_BATCH_CAP_BYTES = 256 * 1024;
const IPC_LOOKBACK_CHARS = 32;
const INK_ERASE_LINE_PATTERN = "\x1b[2K\x1b[1A";

type TerminalIngestQueue = {
  chunks: Array<string | Uint8Array>;
  queuedBytes: number;
  inFlightBytes: number;
  recentChars: string;
  drainScheduled: boolean;
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
    ) => void
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
    if (queue.inFlightBytes <= RENDERER_LOW_WATERMARK_BYTES && queue.chunks.length > 0) {
      this.tryDrain(id, queue);
    }
  }

  public notifyParsed(id: string): void {
    const queue = this.queues.get(id);
    if (!queue || queue.chunks.length === 0 || queue.drainScheduled) return;
    this.tryDrain(id, queue);
  }

  /**
   * Drain any held bytes through tryDrain (not forceDrain) so the 256KB
   * COALESCE_BATCH_CAP_BYTES cap is respected — a backlog must not become a
   * single multi-MB xterm.write() that blocks the main thread (#4853).
   */
  public resumeFlush(id: string): void {
    const queue = this.queues.get(id);
    if (!queue || queue.chunks.length === 0) return;
    this.tryDrain(id, queue);
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
          this.tryDrain(id, queue);
        }, 0);
        return;
      }
    }

    if (!queue.drainScheduled) {
      this.tryDrain(id, queue);
    }
  }

  private tryDrain(id: string, queue: TerminalIngestQueue): void {
    while (queue.chunks.length > 0 && queue.inFlightBytes < RENDERER_HIGH_WATERMARK_BYTES) {
      const batch = this.coalesceBatch(queue);
      const batchBytes = this.chunkByteSize(batch.data);
      queue.inFlightBytes += batchBytes;
      this.writeToTerminal(id, batch.data, batch.chunkCount);
    }
  }

  // Merge the longest same-type chunk prefix into one write, capped at
  // COALESCE_BATCH_CAP_BYTES (#4853 — xterm yields between write-buffer
  // entries, not within one chunk, so an unbounded merge would block the main
  // thread). The first chunk is always taken even when it alone exceeds the
  // cap. Uint8Array prefixes merge into one freshly-allocated array — the
  // MessagePort path delivers binary chunks, so without this branch a
  // backpressure/wake backlog drains as hundreds of per-chunk writes.
  private coalesceBatch(queue: TerminalIngestQueue): CoalescedBatch {
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
      if (taken + size > COALESCE_BATCH_CAP_BYTES) break;
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
