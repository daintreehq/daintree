import type { ManagedTerminal } from "./types";
import { PERF_MARKS } from "@shared/perf/marks";
import { markRendererPerformance } from "@/utils/performance";

/**
 * UTF-8 byte length of a string chunk — the unit the pty-host's IPC
 * flow-control ledger is denominated in (the host charges
 * `Buffer.byteLength(data, "utf8")` before sending). The renderer must
 * acknowledge in the SAME unit; using JS `string.length` (UTF-16 code units)
 * under-reports every non-ASCII char — box-drawing/CJK are 3 UTF-8 bytes vs 1
 * code unit, emoji are 4 vs 2 — so the host queue drifts toward its high
 * watermark and triggers spurious backpressure pauses (#9893).
 *
 * Counted without TextEncoder.encode(): encoding allocates a throwaway
 * Uint8Array up to ~3x the chunk length per write on the hot path. Matches
 * Buffer.byteLength/TextEncoder semantics exactly — lone surrogates count as
 * 3 bytes (U+FFFD), valid pairs as 4.
 */
/**
 * Max size of a single xterm write-buffer entry. xterm's WriteBuffer enforces
 * its 12ms parse budget only BETWEEN entries — one entry is parsed atomically,
 * so a 256KB coalesced batch handed to `terminal.write()` as one entry becomes
 * a 10-50ms unyieldable main-thread task that starves wheel/keystroke dispatch
 * (the "scrolled TUI locks itself up" mechanism). Slicing the batch into
 * ≤32KB entries keeps each parse task under a frame while xterm's own
 * scheduler yields between them; Chromium then dispatches pending input
 * between the macrotask continuations.
 */
const WRITE_SLICE_BYTES = 32 * 1024;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/**
 * Split a chunk into ≤WRITE_SLICE_BYTES pieces without splitting a UTF-16
 * surrogate pair (string) or mid-UTF-8-sequence (Uint8Array). xterm's stream
 * decoders hold interim state across writes, so boundary safety is defensive
 * rather than load-bearing; the backoff is a handful of comparisons per slice.
 * Uint8Array slices are zero-copy subarray views.
 */
function sliceChunk(data: string | Uint8Array): Array<string | Uint8Array> {
  const total = typeof data === "string" ? data.length : data.byteLength;
  if (total <= WRITE_SLICE_BYTES) return [data];

  const slices: Array<string | Uint8Array> = [];
  let start = 0;
  while (start < total) {
    let end = Math.min(start + WRITE_SLICE_BYTES, total);
    if (end < total) {
      if (typeof data === "string") {
        if (isHighSurrogate(data.charCodeAt(end - 1))) end--;
      } else {
        let backoff = 0;
        while (end > start + 1 && backoff < 3 && isUtf8Continuation(data[end]!)) {
          end--;
          backoff++;
        }
      }
      if (end <= start) end = Math.min(start + WRITE_SLICE_BYTES, total);
    }
    slices.push(typeof data === "string" ? data.slice(start, end) : data.subarray(start, end));
    start = end;
  }
  return slices;
}

function utf8ByteLength(data: string): number {
  let bytes = 0;
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < data.length &&
      (data.charCodeAt(i + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export interface WriteControllerDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  // chunkCount: how many host-sent chunks this write coalesced — each maps to
  // one pending port-ack FIFO entry, so the ack must settle all of them.
  acknowledgePortData: (id: string, bytes: number, chunkCount: number) => void;
  acknowledgeData: (id: string, bytes: number) => void;
  notifyWriteComplete: (id: string, bytes: number) => void;
  incrementUnseen: (id: string, isScrolledBack: boolean) => void;
  // Synchronous notification that a real PTY write is about to paint —
  // fires only on the actual write path (after hibernated / deferred-restore
  // early-exits), before terminal.write(). Used by TerminalInstanceService
  // to drive the BURST refresh tier from real activity instead of focus.
  onWrite?: (id: string) => void;
}

/**
 * Owns the write fast-path: hibernation/restore acknowledgement shortcuts,
 * 1-in-64 perf sampling, the `terminal.write()` callback (with stale-identity
 * guard), and last-activity marker bookkeeping. Extracting it isolates the
 * sampling counter and keeps the per-write hot-path readable.
 *
 * The stale-identity guard `deps.getInstance(id) !== managed` is load-bearing:
 * the write callback is async w.r.t. `terminal.write()`, so the managed
 * instance can be replaced (or the terminal destroyed and re-created at the
 * same id) between schedule and fire. An id-only check would falsely accept
 * writes destined for the previous instance — see #4850.
 */
export class TerminalWriteController {
  private deps: WriteControllerDeps;
  private perfWriteSampleCounter = 0;
  // Activity-marker refresh is rAF-coalesced: each xterm marker registration
  // allocates a Marker plus four buffer emitter subscriptions and each dispose
  // unhooks them, so doing it per write callback churns hundreds of
  // alloc/dispose pairs per second under streaming output. The only consumer
  // (user-invoked scrollToLastActivity) needs at most one fresh position per
  // frame and already falls back to scrollToBottom on a disposed marker.
  private pendingMarkerRefresh = new Map<string, ManagedTerminal>();
  private markerRefreshScheduled = false;

  constructor(deps: WriteControllerDeps) {
    this.deps = deps;
  }

  private scheduleActivityMarkerRefresh(id: string, managed: ManagedTerminal): void {
    this.pendingMarkerRefresh.set(id, managed);
    if (this.markerRefreshScheduled) return;
    if (typeof requestAnimationFrame !== "function") {
      this.flushActivityMarkers();
      return;
    }
    this.markerRefreshScheduled = true;
    requestAnimationFrame(() => {
      this.markerRefreshScheduled = false;
      this.flushActivityMarkers();
    });
  }

  private flushActivityMarkers(): void {
    const entries = [...this.pendingMarkerRefresh];
    this.pendingMarkerRefresh.clear();
    for (const [id, managed] of entries) {
      // Same stale-identity guard as the write callback (#4850): the instance
      // can be replaced/destroyed between scheduling and the frame.
      if (this.deps.getInstance(id) !== managed) continue;
      if (managed.isAltBuffer) continue;
      managed.lastActivityMarker?.dispose();
      managed.lastActivityMarker = managed.terminal.registerMarker(0);
    }
  }

  write(id: string, data: string | Uint8Array, chunkCount = 1): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;

    if (managed.isSerializedRestoreInProgress) {
      // Defer WITHOUT settling any ledger. The batch's pending port-ack FIFO
      // entries, the host's queued-byte ledger, and the ingest inFlightBytes
      // all stay charged until the replay write (post-restore) completes and
      // runs the normal bookkeeping below. This is load-bearing twice over:
      // (1) acking here and again at replay double-debited the FIFO — each
      // replayed chunk stole an entry belonging to a chunk that arrived after
      // the restore, leaving the host ledger permanently inflated and every
      // subsequent backpressure pause degraded to its 10s safety timeout;
      // (2) holding the charge means the host's own watermarks pace the PTY
      // while the restore runs, so a flooding agent can no longer grow
      // deferredOutput without bound — the transport backpressure IS the cap,
      // and no bytes are dropped to enforce it.
      managed.deferredOutput.push({ data, chunkCount });
      return;
    }

    this.deps.onWrite?.(id);

    // First real byte to paint for this terminal — anchors the open→first-write
    // segment of the cold path (#9809). Gated to once; cheap no-op in prod
    // since markRendererPerformance early-returns without perf capture.
    if (!managed.hasEmittedFirstWriteMark) {
      managed.hasEmittedFirstWriteMark = true;
      markRendererPerformance(PERF_MARKS.TERMINAL_FIRST_WRITE, {
        terminalId: id,
        elapsedSinceOpenMs:
          managed.terminalOpenStartedAt !== undefined
            ? (typeof performance !== "undefined" ? performance.now() : Date.now()) -
              managed.terminalOpenStartedAt
            : undefined,
      });
    }

    this.deps.incrementUnseen(id, managed.isUserScrolledBack);

    this.perfWriteSampleCounter += 1;
    const shouldSample = this.perfWriteSampleCounter % 64 === 0;

    // renderedBytes (UTF-16 code units / raw byte length) denominates the
    // renderer-side ingest ledger (TerminalOutputIngestService.inFlightBytes,
    // incremented via the same chunkByteSize) and perf sampling. The host's
    // IPC flow-control ledger is a separate ledger in UTF-8 bytes — see
    // ackBytes below.
    const renderedBytes = typeof data === "string" ? data.length : data.byteLength;
    const sampledBytes = shouldSample ? renderedBytes : 0;
    // Only string chunks travel the IPC path (Uint8Array chunks arrive via
    // MessagePort and are acked through acknowledgePortData's queued count).
    // null = no IPC ack: sending one for a port-delivered chunk would
    // spuriously drain the host's IPC ledger.
    const ackBytes = typeof data === "string" ? utf8ByteLength(data) : null;

    if (shouldSample) {
      markRendererPerformance(PERF_MARKS.TERMINAL_DATA_PARSED, {
        terminalId: id,
        bytes: sampledBytes,
      });
    }

    const terminal = managed.terminal;
    managed.pendingWrites = (managed.pendingWrites ?? 0) + 1;
    const writeQueuedAt = shouldSample
      ? typeof performance !== "undefined"
        ? performance.now()
        : Date.now()
      : 0;
    // Feed the batch as multiple ≤32KB write-buffer entries (see
    // WRITE_SLICE_BYTES). Acks/bookkeeping ride the FINAL slice's callback:
    // xterm parses entries FIFO, so the last callback means the whole batch
    // has landed — the port-ack ledger and inFlightBytes stay batch-scoped
    // and no per-slice accounting is needed.
    const slices = sliceChunk(data);
    for (let i = 0; i < slices.length - 1; i++) {
      terminal.write(slices[i]!);
    }
    terminal.write(slices[slices.length - 1]!, () => {
      if (this.deps.getInstance(id) !== managed) return;

      managed.pendingWrites = Math.max(0, (managed.pendingWrites ?? 1) - 1);
      managed.lastWriteAt = Date.now();

      this.deps.acknowledgePortData(id, renderedBytes, chunkCount);
      if (ackBytes !== null) {
        this.deps.acknowledgeData(id, ackBytes);
      }
      this.deps.notifyWriteComplete(id, renderedBytes);

      if (shouldSample) {
        const writeDurationMs =
          (typeof performance !== "undefined" ? performance.now() : Date.now()) - writeQueuedAt;
        markRendererPerformance("terminal_write_duration_sample", {
          terminalId: id,
          bytes: sampledBytes,
          durationMs: Number(writeDurationMs.toFixed(3)),
          pendingWrites: managed.pendingWrites ?? 0,
        });
        markRendererPerformance(PERF_MARKS.TERMINAL_DATA_RENDERED, {
          terminalId: id,
          bytes: sampledBytes,
        });
      }

      if (!managed.isAltBuffer) {
        this.scheduleActivityMarkerRefresh(id, managed);
      }
    });
  }
}
