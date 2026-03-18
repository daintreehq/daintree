import { terminalClient } from "@/clients";
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from "@shared/types/terminal-output-worker-messages";
import { PERF_MARKS } from "@shared/perf/marks";
import { markRendererPerformance } from "@/utils/performance";

const RENDERER_HIGH_WATERMARK_BYTES = 128 * 1024;
const RENDERER_LOW_WATERMARK_BYTES = 32 * 1024;
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
    try {
      const { visualBuffers, signalBuffer } = await terminalClient.getSharedBuffers();
      if (visualBuffers.length > 0 && signalBuffer) {
        this.sabAvailable = true;
        this.worker = new Worker(
          new URL("../../workers/terminalOutput.worker.ts", import.meta.url),
          { type: "module" }
        );

        this.worker.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => {
          const message = event.data;
          if (message.type === "OUTPUT_BATCH") {
            for (const batch of message.batches) {
              this.markTerminalDataReceived(batch.id, batch.data);
              this.enqueueChunk(batch.id, batch.data);
            }
          }
        };

        this.worker.onerror = (error) => {
          console.error("[TerminalOutputIngestService] Worker error:", error);
          this.pollingActive = false;
          this.sabAvailable = false;
          this.worker?.terminate();
          this.worker = null;
          this.initializePromise = null;
        };

        const initMessage: WorkerInboundMessage = {
          type: "INIT_BUFFER",
          buffers: visualBuffers,
          signalBuffer,
        };
        this.worker.postMessage(initMessage);
        this.pollingActive = true;
        console.log(
          `[TerminalOutputIngestService] Worker-based SAB ingestion enabled (${visualBuffers.length} shards)`
        );
      } else {
        console.log("[TerminalOutputIngestService] SharedArrayBuffer unavailable, using IPC");
        this.sabAvailable = false;
        this.pollingActive = false;
        this.worker = null;
        this.initializePromise = null;
      }
    } catch (error) {
      console.warn("[TerminalOutputIngestService] Failed to initialize SharedArrayBuffer:", error);
      this.sabAvailable = false;
      this.pollingActive = false;
      this.worker?.terminate();
      this.worker = null;
      this.initializePromise = null;
    }
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
    if (!this.pollingActive || !this.worker) {
      this.clearQueue(id);
      return;
    }
    const message: WorkerInboundMessage = {
      type: "RESET_TERMINAL",
      id,
    };
    this.worker.postMessage(message);
  }

  public flushForTerminal(id: string): void {
    if (!this.pollingActive || !this.worker) {
      this.forceDrain(id);
      return;
    }
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
    return typeof data === "string" ? data.length * 3 : data.byteLength;
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
      const chunk = queue.chunks[0];
      queue.chunks.length = 0;
      queue.queuedBytes = 0;
      return chunk;
    }

    const allStrings = queue.chunks.every((c) => typeof c === "string");
    if (allStrings) {
      const merged = (queue.chunks as string[]).join("");
      queue.chunks.length = 0;
      queue.queuedBytes = 0;
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
      this.writeToTerminal(id, queue.chunks[0]);
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
