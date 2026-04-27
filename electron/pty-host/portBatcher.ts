import {
  PORT_BATCH_THRESHOLD_BYTES,
  PORT_BATCH_THROUGHPUT_DELAY_MS,
} from "../services/pty/types.js";
import type { PortQueueManager } from "./portQueue.js";

export interface PortBatcherDeps {
  portQueueManager: PortQueueManager;
  postMessage: (id: string, data: Uint8Array, bytes: number) => void;
  onError: (error: unknown) => void;
}

interface PendingTerminal {
  chunks: Uint8Array[];
  bytes: number;
}

type FlushMode = "idle" | "latency" | "throughput";

export class PortBatcher {
  private pendingChunks = new Map<string, PendingTerminal>();
  private totalPendingBytes = 0;
  private immediateHandle: ReturnType<typeof setImmediate> | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private mode: FlushMode = "idle";
  private disposed = false;

  constructor(private readonly deps: PortBatcherDeps) {}

  write(id: string, data: Uint8Array, byteCount: number): boolean {
    if (this.disposed) return false;

    const terminalPending = this.pendingChunks.get(id)?.bytes ?? 0;
    if (this.deps.portQueueManager.isAtCapacity(id, terminalPending + byteCount)) {
      // Flush any pending data for this terminal before rejecting to prevent
      // split-channel delivery (buffered data on MessagePort + rejected data on SAB/IPC)
      if (terminalPending > 0) {
        this.flushTerminal(id);
      }
      return false;
    }

    let entry = this.pendingChunks.get(id);
    if (!entry) {
      entry = { chunks: [], bytes: 0 };
      this.pendingChunks.set(id, entry);
    }
    entry.chunks.push(data);
    entry.bytes += byteCount;
    this.totalPendingBytes += byteCount;

    if (this.totalPendingBytes >= PORT_BATCH_THRESHOLD_BYTES) {
      this.flush();
      return true;
    }

    if (this.mode === "idle") {
      this.immediateHandle = setImmediate(() => this.flush());
      this.mode = "latency";
    } else if (this.mode === "latency") {
      if (this.immediateHandle !== null) {
        clearImmediate(this.immediateHandle);
        this.immediateHandle = null;
      }
      this.timeoutHandle = setTimeout(() => this.flush(), PORT_BATCH_THROUGHPUT_DELAY_MS);
      this.mode = "throughput";
    }
    // throughput mode: timer already scheduled, nothing to do

    return true;
  }

  flush(): void {
    const snapshot = this.pendingChunks;
    this.pendingChunks = new Map();
    this.totalPendingBytes = 0;
    this.cancelTimers();
    this.mode = "idle";

    for (const [id, { chunks, bytes }] of snapshot) {
      try {
        const data = mergeChunks(chunks, bytes);
        this.deps.postMessage(id, data, bytes);
        this.deps.portQueueManager.addBytes(id, bytes);
        this.deps.portQueueManager.applyBackpressure(
          id,
          this.deps.portQueueManager.getUtilization(id)
        );
      } catch (error) {
        this.deps.onError(error);
        return;
      }
    }
  }

  flushTerminal(id: string): void {
    const entry = this.pendingChunks.get(id);
    if (!entry) return;

    this.pendingChunks.delete(id);
    this.totalPendingBytes -= entry.bytes;

    // If buffer is now empty, reset mode and cancel stale timers
    if (this.pendingChunks.size === 0) {
      this.cancelTimers();
      this.mode = "idle";
    }

    try {
      const data = mergeChunks(entry.chunks, entry.bytes);
      this.deps.postMessage(id, data, entry.bytes);
      this.deps.portQueueManager.addBytes(id, entry.bytes);
      this.deps.portQueueManager.applyBackpressure(
        id,
        this.deps.portQueueManager.getUtilization(id)
      );
    } catch (error) {
      this.deps.onError(error);
    }
  }

  dispose(): void {
    this.cancelTimers();
    this.pendingChunks.clear();
    this.totalPendingBytes = 0;
    this.mode = "idle";
    this.disposed = true;
  }

  private cancelTimers(): void {
    if (this.immediateHandle !== null) {
      clearImmediate(this.immediateHandle);
      this.immediateHandle = null;
    }
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }
}

// Concatenate chunks into a freshly-allocated Uint8Array whose ArrayBuffer is
// not aliased by any other Buffer. This is required so the caller can place
// `merged.buffer` in a postMessage transfer list — node-pty Buffers under 4KB
// share an 8KB pool slab, and transferring a slab-backed buffer would detach
// the slab and corrupt every other Buffer that aliases it (PR #4639).
function mergeChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
