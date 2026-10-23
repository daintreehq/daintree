import { type ManagedTerminal, HISTORY_RELEASE_DWELL_MS, RELEASED_SCROLLBACK_LINES } from "./types";
import { restoreScrollback } from "./TerminalScrollbackController";
import { usePerformanceModeStore } from "@/store/performanceModeStore";
import { logDebug, logInfo, logWarn } from "@/utils/logger";

export interface TerminalHistoryReleaseControllerDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  fetchAndRestore: (id: string) => Promise<boolean>;
  /** Whether this project view is active and its window can be seen. */
  isViewObservable: () => boolean;
  isWorkerIngestEnabled: () => boolean;
}

/**
 * Releases the renderer history of a pane hidden for a long time (#14220).
 *
 * The xterm itself stays: it keeps parsing every chunk at a small capacity,
 * so the current screen, modes, titles and agent-state readers are exactly as
 * current as before. Only the retained scrollback goes, which is where an
 * agent terminal's memory is. Showing the pane again restores the capacity and
 * refills history from the host mirror through the same cold restore a project
 * switch uses — never a suspend and resync (#10811).
 *
 * The dwell follows visibility rather than tier: a hidden agent's output lifts
 * it to BURST and back on every write, so a tier-driven timer would never run.
 */
export class TerminalHistoryReleaseController {
  constructor(private deps: TerminalHistoryReleaseControllerDeps) {}

  /** Re-derive the release state from the pane's current visibility. */
  sync(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;
    if (managed.isVisible || managed.isFocused) {
      this.cancel(managed);
      if (managed.historyReleased) this.reveal(id, managed);
      return;
    }
    if (managed.historyReleased || managed.historyReleaseTimer !== undefined) return;
    this.arm(id, managed);
  }

  cancel(managed: ManagedTerminal): void {
    if (managed.historyReleaseTimer === undefined) return;
    clearTimeout(managed.historyReleaseTimer);
    managed.historyReleaseTimer = undefined;
  }

  private arm(id: string, managed: ManagedTerminal): void {
    managed.historyReleaseTimer = window.setTimeout(() => {
      // A restart replaces the instance under the same id; a timer armed for
      // the old one has nothing to release.
      if (this.deps.getInstance(id) !== managed) return;
      managed.historyReleaseTimer = undefined;
      if (managed.isVisible || managed.isFocused || managed.historyReleased) return;
      if (this.canRelease(managed)) {
        this.release(managed);
        return;
      }
      // Blocked by something transient (a selection, a scrolled-back reader,
      // a hidden window); look again after another dwell.
      this.arm(id, managed);
    }, HISTORY_RELEASE_DWELL_MS);
  }

  private canRelease(managed: ManagedTerminal): boolean {
    if (!this.deps.isViewObservable()) return false;
    // Worker snapshots seed the worker's authority from this capacity, and
    // performance mode already keeps almost nothing to release.
    if (this.deps.isWorkerIngestEnabled()) return false;
    if (usePerformanceModeStore.getState().performanceMode) return false;
    if (managed.isAttaching || managed.attachRecoveryInFlight) return false;
    if (managed.isSerializedRestoreInProgress) return false;
    if (managed.isUserScrolledBack || managed.isAltBuffer) return false;
    // Reads from a buffer marker to the end, which a trim would dispose.
    if (managed.postCompleteHook) return false;
    const terminal = managed.terminal;
    if (terminal.hasSelection()) return false;
    return terminal.buffer.normal.length - terminal.rows > RELEASED_SCROLLBACK_LINES;
  }

  private release(managed: ManagedTerminal): void {
    const terminal = managed.terminal;
    const retained = terminal.buffer.normal.length - terminal.rows;
    try {
      terminal.options.scrollback = RELEASED_SCROLLBACK_LINES;
    } catch (error) {
      logWarn("Could not release terminal history", { error });
      return;
    }
    managed.historyReleased = true;
    logInfo("Released history of a long-hidden terminal", {
      retainedLines: retained,
      keptLines: RELEASED_SCROLLBACK_LINES,
      cols: terminal.cols,
      kind: managed.kind,
    });
  }

  private reveal(id: string, managed: ManagedTerminal): void {
    managed.historyReleased = false;
    restoreScrollback(managed);
    logDebug(`Restoring released history for ${id}`);
    // The live screen is already current; this only brings the history back.
    // Output arriving meanwhile is held by the restore window and replayed
    // after the snapshot, as on a cold project switch.
    void this.deps.fetchAndRestore(id).catch((error: unknown) => {
      logWarn("Could not restore released terminal history", { id, error });
    });
  }
}
