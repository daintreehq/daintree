import { terminalClient } from "@/clients";
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from "@shared/types/terminal-output-worker-messages";
import { PERF_MARKS } from "@shared/perf/marks";
import { markRendererPerformance } from "@/utils/performance";

const IPC_STANDARD_FLUSH_DELAY_MS = 8;
const IPC_INK_REDRAW_FLUSH_DELAY_MS = 25;
const IPC_LOOKBACK_CHARS = 32;
const INK_ERASE_LINE_PATTERN = "\x1b[2K\x1b[1A";

type IpcBufferEntry = {
  chunks: Array<string | Uint8Array>;
  recentChars: string;
  timeoutId: number | null;
  flushAt: number;
};

export class TerminalOutputIngestService {
  private worker: Worker | null = null;
  private sabAvailable = false;
  private pollingActive = false;
  private initializePromise: Promise<void> | null = null;
  private perfSampleCounter = 0;
  private ipcBuffers = new Map<string, IpcBufferEntry>();

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
              this.writeToTerminal(batch.id, batch.data);
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

  public boost(): void {
    // No-op: Atomics.wait-based worker doesn't need manual polling boost
  }

  public bufferData(id: string, data: string | Uint8Array): void {
    if (this.pollingActive) return;
    this.markTerminalDataReceived(id, data);
    this.bufferIpcData(id, data);
  }

  public markInteractive(_id: string, _ttlMs: number = 1000): void {
    // Coalescer removed from active pipeline; keep method for API compatibility.
  }

  public resetForTerminal(id: string): void {
    if (!this.pollingActive || !this.worker) {
      this.clearIpcBuffer(id);
      return;
    }
    const message: WorkerInboundMessage = {
      type: "RESET_TERMINAL",
      id,
    };
    this.worker.postMessage(message);
  }

  public setDirectMode(_id: string, _enabled: boolean): void {
    // Coalescer removed from active pipeline; keep method for API compatibility.
  }

  public flushForTerminal(id: string): void {
    if (!this.pollingActive || !this.worker) {
      this.flushIpcBuffer(id);
      return;
    }
    const message: WorkerInboundMessage = {
      type: "FLUSH_TERMINAL",
      id,
    };
    this.worker.postMessage(message);
  }

  public stopPolling(): void {
    for (const id of this.ipcBuffers.keys()) {
      this.flushIpcBuffer(id);
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

  private bufferIpcData(id: string, data: string | Uint8Array): void {
    const now = Date.now();
    const entry = this.ipcBuffers.get(id) ?? {
      chunks: [],
      recentChars: "",
      timeoutId: null,
      flushAt: 0,
    };
    const stringData = typeof data === "string" ? data : "";
    const scanWindow = entry.recentChars + stringData;
    const containsInkErase = scanWindow.includes(INK_ERASE_LINE_PATTERN);
    const combinedRecent = scanWindow.slice(-IPC_LOOKBACK_CHARS);
    const delayMs = containsInkErase ? IPC_INK_REDRAW_FLUSH_DELAY_MS : IPC_STANDARD_FLUSH_DELAY_MS;
    const targetFlushAt = now + delayMs;

    entry.recentChars = combinedRecent;
    entry.chunks.push(data);

    if (entry.timeoutId === null) {
      entry.flushAt = targetFlushAt;
      entry.timeoutId = globalThis.setTimeout(
        () => this.flushIpcBuffer(id),
        Math.max(0, entry.flushAt - Date.now())
      ) as unknown as number;
    } else if (targetFlushAt > entry.flushAt) {
      globalThis.clearTimeout(entry.timeoutId);
      entry.flushAt = targetFlushAt;
      entry.timeoutId = globalThis.setTimeout(
        () => this.flushIpcBuffer(id),
        Math.max(0, entry.flushAt - Date.now())
      ) as unknown as number;
    }

    this.ipcBuffers.set(id, entry);
  }

  private clearIpcBuffer(id: string): void {
    const entry = this.ipcBuffers.get(id);
    if (!entry) return;
    if (entry.timeoutId !== null) {
      globalThis.clearTimeout(entry.timeoutId);
    }
    this.ipcBuffers.delete(id);
  }

  private flushIpcBuffer(id: string): void {
    const entry = this.ipcBuffers.get(id);
    if (!entry) return;
    if (entry.timeoutId !== null) {
      globalThis.clearTimeout(entry.timeoutId);
    }
    this.ipcBuffers.delete(id);

    if (entry.chunks.length === 0) return;
    if (entry.chunks.length === 1) {
      this.writeToTerminal(id, entry.chunks[0]);
      return;
    }

    const allStrings = entry.chunks.every((chunk) => typeof chunk === "string");
    if (allStrings) {
      this.writeToTerminal(id, (entry.chunks as string[]).join(""));
      return;
    }

    for (const chunk of entry.chunks) {
      this.writeToTerminal(id, chunk);
    }
  }
}
