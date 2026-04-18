import type { WorkerInboundMessage } from "@shared/types/terminal-output-worker-messages";
import { PERF_MARKS } from "@shared/perf/marks";
import { markRendererPerformance } from "@/utils/performance";
import { logDebug } from "@/utils/logger";

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

export class TerminalOutputIngestService {
  private worker: Worker | null = null;
  private sabAvailable = false;
  private pollingActive = false;
  private initializePromise: Promise<void> | null = null;
  private perfSampleCounter = 0;
  private queues = new Map<string, TerminalIngestQueue>();

  constructor(private readonly writeToTerminal: (id: string, data: string | Uint8Array) => void) {}

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

  public resetForTerminal(id: string): void {
    this.clearQueue(id);
    if (!this.pollingActive || !this.worker) return;
    const message: WorkerInboundMessage = {
      type: "RESET_TERMINAL",
      id,
    };
    this.worker.postMessage(message);
  }

  public flushForTerminal(id: string): void {
    this.forceDrain(id);
    if (!this.pollingActive || !this.worker) return;
    const message: WorkerInboundMessage = {
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
    const message: WorkerInboundMessage = {
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
      const scanWindow = queue.recentChars + stringData;
      const containsInkErase = scanWindow.includes(INK_ERASE_LINE_PATTERN);
      queue.recentChars = scanWindow.slice(-IPC_LOOKBACK_CHARS);

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
      const batchBytes = this.chunkByteSize(batch);
      queue.inFlightBytes += batchBytes;
      this.writeToTerminal(id, batch);
    }
  }

  private coalesceBatch(queue: TerminalIngestQueue): string | Uint8Array {
    if (queue.chunks.length === 1) {
      const chunk = queue.chunks[0]!;
      queue.chunks.length = 0;
      queue.queuedBytes = 0;
      return chunk;
    }

    const allStrings = queue.chunks.every((c) => typeof c === "string");
    if (allStrings) {
      if (queue.queuedBytes <= COALESCE_BATCH_CAP_BYTES) {
        const merged = (queue.chunks as string[]).join("");
        queue.chunks.length = 0;
        queue.queuedBytes = 0;
        return merged;
      }
      let taken = 0;
      let i = 0;
      do {
        taken += (queue.chunks[i] as string).length;
        i++;
      } while (
        i < queue.chunks.length &&
        taken + (queue.chunks[i] as string).length <= COALESCE_BATCH_CAP_BYTES
      );
      const merged = (queue.chunks.splice(0, i) as string[]).join("");
      queue.queuedBytes -= merged.length;
      return merged;
    }

    const chunk = queue.chunks.shift()!;
    queue.queuedBytes -= this.chunkByteSize(chunk);
    return chunk;
  }

  private clearQueue(id: string): void {
    this.queues.delete(id);
  }

  private forceDrain(id: string): void {
    const queue = this.queues.get(id);
    if (!queue || queue.chunks.length === 0) return;

    if (queue.chunks.length === 1) {
      this.writeToTerminal(id, queue.chunks[0]!);
    } else {
      const allStrings = queue.chunks.every((c) => typeof c === "string");
      if (allStrings) {
        this.writeToTerminal(id, (queue.chunks as string[]).join(""));
      } else {
        for (const chunk of queue.chunks) {
          this.writeToTerminal(id, chunk);
        }
      }
    }

    this.queues.delete(id);
  }
}
