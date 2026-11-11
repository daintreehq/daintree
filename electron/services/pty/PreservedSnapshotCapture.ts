import type { TerminalInfo } from "./types.js";
import type { AnalysisBackend } from "./analysis/AnalysisBackend.js";
import type { SerializedTerminalSnapshot } from "../../../shared/types/terminal.js";
import { headlessMirrorScheduler } from "./HeadlessMirrorScheduler.js";
import {
  TERMINAL_SESSION_PERSISTENCE_ENABLED,
  claimSessionWrite,
  isSessionPersistSuppressed,
  persistSessionSnapshotAsync,
  releaseSessionWrite,
  type SessionWriteClaim,
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
  // The exit write's claim until the capture hands it on or gives it up.
  private claim: SessionWriteClaim | null = null;

  constructor(private readonly host: PreservedSnapshotCaptureHost) {}

  /**
   * Give up the exit write when the capture will never land: a cleared mirror
   * queue drops its flush callback, so nothing else would release the claim.
   */
  cancel(): void {
    const claim = this.takeClaim();
    if (claim) releaseSessionWrite(claim);
  }

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
    this.claimFinalWrite();
    // Route the drain-sentinel through the scheduler: it fires only after all
    // feeds held for this terminal have been released AND parsed, preserving
    // the "tail of the output must land in the buffer" contract now that
    // chunks can be held outside xterm's own write queue.
    headlessMirrorScheduler.flush(this.host.id, headless, () => {
      if (terminal.headlessTerminal !== headless || !terminal.serializeAddon) {
        this.cancel();
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
        this.cancel();
        return;
      }
      // sessionSnapshotter.dispose() already ran in the onExit handler,
      // cancelling any debounced write — write the final state to disk so
      // crash recovery sees the post-exit buffer (#3177). Banner-aware like
      // flushSyncOnKill. Async: a sync write of up to 5 MB here stalls every
      // terminal on this pty-host (#16806).
      const claim = this.takeClaim();
      if (claim) {
        let payload: SerializedTerminalSnapshot | null;
        try {
          payload = this.host.serializeForPersistence() ?? snapshot;
        } catch {
          // best-effort only: no write beats one with the restore banner baked in
          payload = null;
        }
        if (payload) this.persistFinal(claim, payload);
        else releaseSessionWrite(claim);
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
    this.claimFinalWrite();
    void this.host.analysis.captureFinalSnapshot().then(
      ({ snapshot, persistence }) => {
        // dispose() may have run while the capture was in flight (LRU eviction,
        // app shutdown) — the slot is already released and the registry entry
        // may be gone; a late snapshot must not resurrect preserved state or
        // fire onPreserved. Mirrors the in-thread capture's same-headless-
        // instance guard.
        if (this.host.isDisposed || snapshot === null) {
          this.cancel();
          return;
        }
        const claim = this.takeClaim();
        if (claim) this.persistFinal(claim, persistence ?? snapshot);
        terminal.preservedSnapshot = snapshot;
        terminal.preservedAt = Date.now();
        terminal.contentEpoch++;
        terminal.pendingHeadlessWrites = 0;
        this.host.analysis.release();
        this.host.onPreserved();
      },
      (error: unknown) => {
        // Kept live, as on an in-thread serialize failure.
        console.error(
          `[TerminalProcess] Failed to capture final snapshot for ${this.host.id}:`,
          error
        );
        this.cancel();
      }
    );
  }

  // Claimed at exit rather than when the capture lands: killing an exited
  // terminal neither disposes it nor stops the capture, so a delete (a close,
  // or a respawn of this id) can arrive while the drain or worker round trip
  // is still out. The delete voids this claim, and the late capture then
  // leaves the file deleted. Same gates as every crash-recovery write; agent
  // sessions are never replayed by crash recovery.
  private claimFinalWrite(): void {
    if (
      !TERMINAL_SESSION_PERSISTENCE_ENABLED ||
      isSessionPersistSuppressed() ||
      this.host.terminalInfo.launchAgentId
    ) {
      return;
    }
    this.claim = claimSessionWrite(this.host.id);
  }

  private takeClaim(): SessionWriteClaim | null {
    const claim = this.claim;
    this.claim = null;
    return claim;
  }

  private persistFinal(claim: SessionWriteClaim, payload: SerializedTerminalSnapshot): void {
    if (isSessionPersistSuppressed()) {
      releaseSessionWrite(claim);
      return;
    }
    void persistFinalSnapshot(this.host.id, payload, claim);
  }
}

async function persistFinalSnapshot(
  id: string,
  payload: SerializedTerminalSnapshot,
  claim: SessionWriteClaim
): Promise<void> {
  try {
    await persistSessionSnapshotAsync(id, payload, claim);
  } catch {
    // best-effort only
  }
}
