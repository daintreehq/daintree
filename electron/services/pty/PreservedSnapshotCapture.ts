import type { TerminalInfo } from "./types.js";
import type { AnalysisBackend } from "./analysis/AnalysisBackend.js";
import type { SerializedTerminalSnapshot } from "../../../shared/types/terminal.js";
import { headlessMirrorScheduler } from "./HeadlessMirrorScheduler.js";
import {
  TERMINAL_SESSION_PERSISTENCE_ENABLED,
  isSessionPersistSuppressed,
  persistSessionSnapshotSync,
} from "./terminalSessionPersistence.js";

export interface PreservedSnapshotCaptureHost {
  readonly id: string;
  readonly terminalInfo: TerminalInfo;
  readonly analysis: AnalysisBackend;
  readonly isDisposed: boolean;
  serializeForPersistence(): SerializedTerminalSnapshot | null;
  disposeHeadless(): void;
  onPreserved(): void;
}

export class PreservedSnapshotCapture {
  constructor(private readonly host: PreservedSnapshotCaptureHost) {}

  /**
   * Preserved exited terminals don't need a live headless xterm — the buffer
   * is final. Serialize it once, cache the string on `terminalInfo`, and
   * dispose the headless instance (Unicode11 + SerializeAddon + scrollback
   * CircularList, ~15-30 MB per exited terminal). Serialization runs inside a
   * sentinel `write("")` callback so xterm's async parser queue is fully
   * drained first — the tail of the output must land in the buffer, and
   * disposing with queued writes throws against the torn-down core.
   *
   * On serialize failure the live headless instance is kept: serving the
   * existing buffer beats serving nothing, at the cost of the memory.
   */
  snapshotAndDispose(): void {
    if (this.host.analysis.kind === "worker") {
      this.snapshotAndDisposeViaWorker();
      return;
    }
    const terminal = this.host.terminalInfo;
    const headless = terminal.headlessTerminal;
    if (!headless || !terminal.serializeAddon) {
      return;
    }
    // Route the drain-sentinel through the scheduler: it fires only after all
    // feeds held for this terminal have been released AND parsed, preserving
    // the "tail of the output must land in the buffer" contract now that
    // chunks can be held outside xterm's own write queue.
    headlessMirrorScheduler.flush(this.host.id, headless, () => {
      if (terminal.headlessTerminal !== headless || !terminal.serializeAddon) {
        return;
      }
      let snapshot: SerializedTerminalSnapshot;
      try {
        // Geometry read in the same tick as the serialize: the headless mirror
        // is disposed a few lines below, so this is the last moment the grid
        // behind the payload is knowable (#11552).
        snapshot = {
          data: terminal.serializeAddon.serialize(),
          cols: headless.cols,
          rows: headless.rows,
        };
      } catch (error) {
        console.error(
          `[TerminalProcess] Failed to snapshot preserved terminal ${this.host.id}:`,
          error
        );
        return;
      }
      // sessionSnapshotter.dispose() already ran in the onExit handler,
      // cancelling any debounced write — flush the final state to disk
      // directly so crash recovery sees the post-exit buffer (#3177).
      // Banner-aware like flushSyncOnKill; same gates (agent sessions are
      // never replayed by crash recovery).
      if (
        TERMINAL_SESSION_PERSISTENCE_ENABLED &&
        !isSessionPersistSuppressed() &&
        !terminal.launchAgentId
      ) {
        try {
          persistSessionSnapshotSync(this.host.id, this.host.serializeForPersistence() ?? snapshot);
        } catch {
          // best-effort only
        }
      }
      terminal.preservedSnapshot = snapshot;
      // Stamp capture time so eviction (issue #10839) sorts oldest-first. Do
      // NOT seed preservedSnapshotLastAccessedAt here: a freshly-captured
      // snapshot has not been viewed, and treating it as recently-accessed
      // would shield a burst of just-exited terminals from the cap. The access
      // stamp is set only on a real serialize request.
      terminal.preservedAt = Date.now();
      // The buffer is final from here on: bump the epoch so the next wake
      // serves the preserved snapshot, and zero the parse counter (disposed
      // headless write callbacks never fire) so that serve can serve-mark.
      terminal.contentEpoch++;
      terminal.pendingHeadlessWrites = 0;
      this.host.disposeHeadless();
      // Bound the in-memory preserved-snapshot count now that this terminal's
      // snapshot is actually present — counting it (unlike an onExit-time sweep)
      // keeps the cap accurate under bursts of simultaneous exits.
      this.host.onPreserved();
    });
  }

  // Worker-mode counterpart of the in-thread capture above: the drain +
  // serialize happens in the worker slot; on failure the slot is kept alive
  // (serving the live buffer beats serving nothing), matching the in-thread
  // keep-on-serialize-failure semantics.
  private snapshotAndDisposeViaWorker(): void {
    const terminal = this.host.terminalInfo;
    void this.host.analysis.captureFinalSnapshot().then(({ snapshot, persistence }) => {
      // dispose() may have run while the capture was in flight (LRU eviction,
      // app shutdown) — the slot is already released and the registry entry
      // may be gone; a late snapshot must not resurrect preserved state or
      // fire onPreserved. Mirrors the in-thread capture's same-headless-
      // instance guard.
      if (this.host.isDisposed) {
        return;
      }
      if (snapshot === null) {
        return;
      }
      if (
        TERMINAL_SESSION_PERSISTENCE_ENABLED &&
        !isSessionPersistSuppressed() &&
        !terminal.launchAgentId
      ) {
        try {
          persistSessionSnapshotSync(this.host.id, persistence ?? snapshot);
        } catch {
          // best-effort only
        }
      }
      terminal.preservedSnapshot = snapshot;
      terminal.preservedAt = Date.now();
      terminal.contentEpoch++;
      terminal.pendingHeadlessWrites = 0;
      this.host.analysis.release();
      this.host.onPreserved();
    });
  }
}
