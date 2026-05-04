import type { ManagedTerminal } from "./types";
import { PERF_MARKS } from "@shared/perf/marks";
import { markRendererPerformance } from "@/utils/performance";

export interface WriteControllerDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  acknowledgePortData: (id: string, bytes: number) => void;
  acknowledgeData: (id: string, bytes: number) => void;
  notifyWriteComplete: (id: string, bytes: number) => void;
  incrementUnseen: (id: string, isScrolledBack: boolean) => void;
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

    this.deps.incrementUnseen(id, managed.isUserScrolledBack);

    this.perfWriteSampleCounter += 1;
    const shouldSample = this.perfWriteSampleCounter % 64 === 0;

    const sampledBytes = shouldSample
      ? typeof data === "string"
        ? data.length
        : data.byteLength
      : 0;
    const acknowledgedBytes = typeof data === "string" ? data.length : data.byteLength;

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

      this.deps.acknowledgePortData(id, acknowledgedBytes);
      this.deps.acknowledgeData(id, acknowledgedBytes);
      this.deps.notifyWriteComplete(id, acknowledgedBytes);

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
