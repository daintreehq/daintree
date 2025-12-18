import { terminalClient } from "@/clients";
import { TerminalOutputCoalescer } from "./TerminalOutputCoalescer";
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from "@shared/types/terminal-output-worker-messages";

export class TerminalOutputIngestService {
  private worker: Worker | null = null;
  private sabAvailable = false;
  private pollingActive = false;
  private initializePromise: Promise<void> | null = null;
  private ipcCoalescer: TerminalOutputCoalescer;

  constructor(private readonly writeToTerminal: (id: string, data: string | Uint8Array) => void) {
    this.ipcCoalescer = new TerminalOutputCoalescer(
      (cb, ms) => window.setTimeout(cb, ms),
      (id) => window.clearTimeout(id),
      () => Date.now(),
      ({ id, data }) => this.writeToTerminal(id, data)
    );
  }

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
              const dataLen = typeof batch.data === "string" ? batch.data.length : batch.data.byteLength;
              console.log(`[TERM_FLOW] SAB worker batch: ${batch.id} ${dataLen}b`);
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
      }
    } catch (error) {
      console.warn("[TerminalOutputIngestService] Failed to initialize SharedArrayBuffer:", error);
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
    this.ipcCoalescer.bufferData(id, data);
  }

  public markInteractive(id: string, ttlMs: number = 1000): void {
    if (!this.pollingActive || !this.worker) {
      this.ipcCoalescer.markInteractive(id, ttlMs);
      return;
    }
    const message: WorkerInboundMessage = {
      type: "SET_INTERACTIVE",
      id,
      ttlMs,
    };
    this.worker.postMessage(message);
  }

  public resetForTerminal(id: string): void {
    if (!this.pollingActive || !this.worker) {
      this.ipcCoalescer.resetForTerminal(id);
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
      this.ipcCoalescer.flushForTerminal(id);
      return;
    }
    const message: WorkerInboundMessage = {
      type: "FLUSH_TERMINAL",
      id,
    };
    this.worker.postMessage(message);
  }

  public stopPolling(): void {
    this.pollingActive = false;
    if (!this.worker) return;
    const message: WorkerInboundMessage = {
      type: "STOP",
    };
    this.worker.postMessage(message);
    setTimeout(() => {
      this.worker?.terminate();
      this.worker = null;
    }, 50);
  }
}
