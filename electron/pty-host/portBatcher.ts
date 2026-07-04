import {
  PORT_BATCH_THRESHOLD_BYTES,
  PORT_BATCH_THROUGHPUT_DELAY_MS,
} from "../services/pty/types.js";
import type { PortQueueManager } from "./portQueue.js";

// Throughput-mode flush window, profile-tunable via set-resource-profile
// (resourceConfig handler). Module-level so the main batcher and every
// per-window mirror batcher share the cadence without plumbing. Already
// scheduled timers keep their original delay; the new value applies from the
// next batch.
let throughputDelayMs = PORT_BATCH_THROUGHPUT_DELAY_MS;

export function setPortBatchThroughputDelayMs(ms: number): void {
  if (Number.isFinite(ms) && ms > 0) {
    throughputDelayMs = ms;
  }
}

export interface PortBatcherDeps {
  portQueueManager: PortQueueManager;
  postMessage: (id: string, data: Uint8Array, bytes: number) => void;
  onError: (error: unknown, failedBatches: PortBatcherFailedBatch[]) => void;
  /**
   * The UI-focused terminal id for this window, or null when none is focused.
   * When set and present in a flush, its pending entry is posted first so the
   * pane the user is watching lands ahead of noisy siblings. Optional: when
   * absent flush() uses plain Map insertion order (prior behaviour).
   */
  getFocusedTerminalId?: () => string | null;
}

interface PendingTerminal {
  chunks: Uint8Array[];
  bytes: number;
  mode: FlushMode;
  immediateHandle: ReturnType<typeof setImmediate> | null;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  // True only while every chunk pushed into this entry was delivered with
  // `owned: true` — i.e. this batcher is the sole consumer of the chunk's
  // backing ArrayBuffer and may transfer it without copying. Any non-owned
  // write flips this false for the rest of the entry's life.
  owned: boolean;
}

export interface PortBatcherFailedBatch {
  id: string;
  data: Uint8Array;
  bytes: number;
}

type FlushMode = "idle" | "latency" | "throughput";

export class PortBatcher {
  private pendingChunks = new Map<string, PendingTerminal>();
  private totalPendingBytes = 0;
  private disposed = false;

  constructor(private readonly deps: PortBatcherDeps) {}

  // `owned` signals that the caller hands sole ownership of `data`'s backing
  // ArrayBuffer to this batcher (no sibling batcher holds the same chunk), so a
  // single-chunk flush can transfer it instead of copying. Defaults to false:
  // the safe assumption is that the chunk is shared and must be copied at flush.
  // `interactive` marks output arriving just after renderer input (keystroke
  // echo): a throughput-mode entry swaps its 16ms timer for an immediate so the
  // echo isn't held a frame behind the flood it's interleaved with.
  write(
    id: string,
    data: Uint8Array,
    byteCount: number,
    owned = false,
    interactive = false
  ): boolean {
    if (this.disposed) return false;

    let entry = this.pendingChunks.get(id);
    const terminalPending = entry?.bytes ?? 0;
    if (this.deps.portQueueManager.isAtCapacity(id, terminalPending + byteCount)) {
      // Flush any pending data for this terminal before rejecting to prevent
      // split-channel delivery (buffered data on MessagePort + rejected data on SAB/IPC)
      if (terminalPending > 0) {
        this.flushTerminal(id);
      }
      return false;
    }

    if (!entry) {
      entry = {
        chunks: [],
        bytes: 0,
        mode: "idle",
        immediateHandle: null,
        timeoutHandle: null,
        owned,
      };
      this.pendingChunks.set(id, entry);
    } else {
      entry.owned = entry.owned && owned;
    }
    entry.chunks.push(data);
    entry.bytes += byteCount;
    this.totalPendingBytes += byteCount;

    if (this.totalPendingBytes >= PORT_BATCH_THRESHOLD_BYTES) {
      this.flush();
      return true;
    }

    // Per-terminal flush cadence: each terminal owns its own (mode, immediate, timeout)
    // so a quiet terminal's first write isn't stalled by a busy sibling's throughput timer.
    if (entry.mode === "idle") {
      entry.immediateHandle = setImmediate(() => this.flush());
      entry.mode = "latency";
    } else if (interactive) {
      // Echo fast-path: flush() drains the full pending map, so earlier queued
      // output for this terminal still lands ahead of the echo bytes — the
      // batch is accelerated, never reordered or bypassed. In latency mode the
      // immediate is already pending; in throughput mode swap the timer for an
      // immediate (mode stays "throughput" so the ladder won't re-escalate the
      // pending immediate back onto a 16ms timer).
      if (entry.timeoutHandle !== null) {
        clearTimeout(entry.timeoutHandle);
        entry.timeoutHandle = null;
        entry.immediateHandle = setImmediate(() => this.flush());
      }
    } else if (entry.mode === "latency") {
      if (entry.immediateHandle !== null) {
        clearImmediate(entry.immediateHandle);
        entry.immediateHandle = null;
      }
      entry.timeoutHandle = setTimeout(() => this.flush(), throughputDelayMs);
      entry.mode = "throughput";
    }
    // throughput mode: timer already scheduled, nothing to do

    return true;
  }

  flush(): void {
    const snapshot = this.pendingChunks;
    this.pendingChunks = new Map();
    this.totalPendingBytes = 0;

    // Cancel each entry's per-terminal handles before processing so callbacks
    // already-queued can't fire after the snapshot is drained.
    for (const entry of snapshot.values()) {
      this.cancelEntryTimers(entry);
    }

    // Service the focused terminal's pending entry first so the pane the user
    // is watching lands ahead of noisy siblings. This is a pure iteration-order
    // change: each entry is still deleted from `snapshot` before it's processed
    // (so the catch block builds failedBatches from the failed entry plus only
    // the still-unprocessed remainder), and mergeChunks / the owned zero-copy
    // predicate are untouched (#8367).
    const focusedId = this.deps.getFocusedTerminalId?.() ?? null;
    if (focusedId !== null && snapshot.has(focusedId)) {
      if (!this.flushEntry(focusedId, snapshot)) return;
    }

    // Iterate the detached snapshot directly (no intermediate entries array on
    // the happy path); delete each entry as it's consumed so the catch block can
    // build failedBatches from the failed entry plus whatever remains.
    for (const id of snapshot.keys()) {
      if (!this.flushEntry(id, snapshot)) return;
    }
  }

  // Process one pending entry out of `snapshot`: delete it, merge/post/account.
  // Returns false when postMessage/merge threw and onError was invoked (the
  // caller must stop draining), true otherwise. Deleting before processing keeps
  // the failedBatches set (failed entry + whatever still remains in `snapshot`)
  // correct regardless of the order entries are serviced in.
  private flushEntry(id: string, snapshot: Map<string, PendingTerminal>): boolean {
    const entry = snapshot.get(id);
    if (!entry) return true;
    snapshot.delete(id);
    let data: Uint8Array = new Uint8Array(0);
    try {
      data = mergeChunks(entry.chunks, entry.bytes, entry.owned);
      this.deps.postMessage(id, data, entry.bytes);
      this.deps.portQueueManager.addBytes(id, entry.bytes);
      this.deps.portQueueManager.applyBackpressure(
        id,
        this.deps.portQueueManager.getUtilization(id)
      );
    } catch (error) {
      const failedBatches: PortBatcherFailedBatch[] = [{ id, data, bytes: entry.bytes }];
      for (const [failedId, pending] of snapshot) {
        failedBatches.push({
          id: failedId,
          data: mergeChunks(pending.chunks, pending.bytes, pending.owned),
          bytes: pending.bytes,
        });
      }
      this.deps.onError(error, failedBatches);
      return false;
    }
    return true;
  }

  /**
   * Per-terminal buffered-but-unflushed byte counts. Read by the host's
   * `disconnectWindow` before `dispose()` so bytes about to be dropped with
   * the closing port are accounted as data loss instead of vanishing
   * silently — dispose() discards `pendingChunks` without any drop
   * bookkeeping of its own.
   */
  getPendingByteSnapshot(): Array<{ id: string; bytes: number }> {
    const out: Array<{ id: string; bytes: number }> = [];
    for (const [id, entry] of this.pendingChunks) {
      if (entry.bytes > 0) out.push({ id, bytes: entry.bytes });
    }
    return out;
  }

  flushTerminal(id: string): void {
    const entry = this.pendingChunks.get(id);
    if (!entry) return;

    this.cancelEntryTimers(entry);
    this.pendingChunks.delete(id);
    this.totalPendingBytes -= entry.bytes;

    let data: Uint8Array = new Uint8Array(0);
    try {
      data = mergeChunks(entry.chunks, entry.bytes, entry.owned);
      this.deps.postMessage(id, data, entry.bytes);
      this.deps.portQueueManager.addBytes(id, entry.bytes);
      this.deps.portQueueManager.applyBackpressure(
        id,
        this.deps.portQueueManager.getUtilization(id)
      );
    } catch (error) {
      this.deps.onError(error, [{ id, data, bytes: entry.bytes }]);
    }
  }

  dispose(): void {
    for (const entry of this.pendingChunks.values()) {
      this.cancelEntryTimers(entry);
    }
    this.pendingChunks.clear();
    this.totalPendingBytes = 0;
    this.disposed = true;
  }

  private cancelEntryTimers(entry: PendingTerminal): void {
    if (entry.immediateHandle !== null) {
      clearImmediate(entry.immediateHandle);
      entry.immediateHandle = null;
    }
    if (entry.timeoutHandle !== null) {
      clearTimeout(entry.timeoutHandle);
      entry.timeoutHandle = null;
    }
  }
}

// Concatenate chunks into a freshly-allocated Uint8Array whose ArrayBuffer is
// not aliased by any other Buffer. This is required so the caller can place
// `merged.buffer` in a postMessage transfer list — node-pty Buffers under 4KB
// share an 8KB pool slab, and transferring a slab-backed buffer would detach
// the slab and corrupt every other Buffer that aliases it (PR #4639).
//
// Fast path: when `owned` is true the caller has guaranteed this is the only
// batcher holding this chunk, so no sibling will read it after we transfer it.
// A lone chunk that fully owns its ArrayBuffer (escaped the node-pty slab via
// `new Uint8Array(...)` at the pty-host ingestion site, byteOffset 0, occupies
// the whole buffer) is already a transfer-safe standalone buffer — return it
// directly and skip the per-flush allocate-and-copy. This retires the dominant
// single-chunk latency-mode allocation under agent-output floods (#8367) while
// preserving the PR #4639 invariant: the buffer is still never a slab alias.
function mergeChunks(chunks: Uint8Array[], totalBytes: number, owned: boolean): Uint8Array {
  if (owned && chunks.length === 1) {
    const chunk = chunks[0];
    if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength) {
      return chunk;
    }
  }
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
