import type { ManagedTerminal } from "./types";
import { PERF_MARKS } from "@shared/perf/marks";
import { markRendererPerformance } from "@/utils/performance";

// Reused across writes — TextEncoder holds no state between encode() calls, so
// a single module-level instance avoids re-allocating one per write.
const utf8Encoder = new TextEncoder();

/**
 * UTF-8 byte length of a string chunk — the unit the pty-host's IPC
 * flow-control ledger is denominated in (the host charges
 * `Buffer.byteLength(data, "utf8")` before sending). The renderer must
 * acknowledge in the SAME unit; using JS `string.length` (UTF-16 code units)
 * under-reports every non-ASCII char — box-drawing/CJK are 3 UTF-8 bytes vs 1
 * code unit, emoji are 4 vs 2 — so the host queue drifts toward its high
 * watermark and triggers spurious backpressure pauses (#9893).
 */
function utf8ByteLength(data: string): number {
  return utf8Encoder.encode(data).byteLength;
}

export interface WriteControllerDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  acknowledgePortData: (id: string, bytes: number) => void;
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

  constructor(deps: WriteControllerDeps) {
    this.deps = deps;
  }

  write(id: string, data: string | Uint8Array): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;

    if (managed.isHibernated) {
      const bytes = typeof data === "string" ? data.length : data.byteLength;
      this.deps.acknowledgePortData(id, bytes);
      // Hibernated output is dropped, never replayed — IPC-delivered chunks
      // (always strings) were charged to the host's IPC ledger, so ack them
      // here in UTF-8 bytes or the ledger leaks into permanent backpressure.
      if (typeof data === "string") {
        this.deps.acknowledgeData(id, utf8ByteLength(data));
      }
      this.deps.notifyWriteComplete(id, bytes);
      return;
    }

    if (managed.isSerializedRestoreInProgress) {
      managed.deferredOutput.push(data);
      const deferredBytes = typeof data === "string" ? data.length : data.byteLength;
      this.deps.acknowledgePortData(id, deferredBytes);
      this.deps.notifyWriteComplete(id, deferredBytes);
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
    terminal.write(data, () => {
      if (this.deps.getInstance(id) !== managed) return;

      managed.pendingWrites = Math.max(0, (managed.pendingWrites ?? 1) - 1);
      managed.lastWriteAt = Date.now();

      this.deps.acknowledgePortData(id, renderedBytes);
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
        managed.lastActivityMarker?.dispose();
        managed.lastActivityMarker = terminal.registerMarker(0);
      }
    });
  }
}
