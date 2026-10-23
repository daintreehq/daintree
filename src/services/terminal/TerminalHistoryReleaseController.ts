import { type ManagedTerminal, HISTORY_RELEASE_DWELL_MS, RELEASED_SCROLLBACK_LINES } from "./types";
import { restoreScrollback } from "./TerminalScrollbackController";
import { resumeXtermRender, suspendXtermRender } from "./xtermRenderSuspension";
import { usePerformanceModeStore } from "@/store/performanceModeStore";
import { logDebug, logInfo, logWarn } from "@/utils/logger";

export interface TerminalHistoryReleaseControllerDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  fetchAndRestore: (id: string) => Promise<boolean>;
  /** Whether this project view is active and its window can be seen. */
  isViewObservable: () => boolean;
  isWorkerIngestEnabled: () => boolean;
  /** Re-derive the pane's input lock after the refill's hold changes. */
  applyInputLock: (managed: ManagedTerminal) => void;
}

// A zero-length write still runs its callback in order; an empty string would
// end xterm's sync drain and drop what is queued behind it (see streamFence).
const WRITE_BARRIER = new Uint8Array(0);

// Paint-hold owner, distinct from a cached view's, so neither lifts the other.
const REFILL_PAINT_HOLD = "history-refill";

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
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
    if (this.isShown(managed)) {
      this.cancel(managed);
      if (managed.historyReleased || managed.historyRefillPending) this.refill(id, managed);
      return;
    }
    if (managed.historyReleased || managed.historyReleaseTimer !== undefined) return;
    this.arm(id, managed);
  }

  /**
   * The PTY exited. A failed session's host mirror is disposed with it, so
   * a released pane gets one last try at its history while the host may still
   * hold it, and nothing that has exited is released again.
   */
  noteExit(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;
    managed.ptyExited = true;
    this.cancel(managed);
    if (managed.historyReleased) this.refill(id, managed);
  }

  cancel(managed: ManagedTerminal): void {
    if (managed.historyReleaseTimer === undefined) return;
    clearTimeout(managed.historyReleaseTimer);
    managed.historyReleaseTimer = undefined;
  }

  // Visibility is authoritative for being on screen. Focus is read from the
  // DOM rather than `isFocused`, which a pane can leave set when it unmounts
  // while focused; real focus is also what an IME composition needs.
  private isShown(managed: ManagedTerminal): boolean {
    if (managed.isVisible) return true;
    const textarea = managed.terminal.textarea;
    return textarea !== undefined && textarea.ownerDocument.activeElement === textarea;
  }

  private arm(id: string, managed: ManagedTerminal): void {
    managed.historyReleaseTimer = setTimeout(() => {
      // A restart replaces the instance under the same id; a timer armed for
      // the old one has nothing to release.
      if (this.deps.getInstance(id) !== managed) return;
      managed.historyReleaseTimer = undefined;
      if (this.isShown(managed) || managed.historyReleased) return;
      if (this.canRelease(managed)) {
        this.release(managed);
        return;
      }
      // Blocked by something transient (a selection, a scrolled-back reader,
      // a hidden window); look again after another dwell.
      if (!managed.ptyExited) this.arm(id, managed);
    }, HISTORY_RELEASE_DWELL_MS);
  }

  private canRelease(managed: ManagedTerminal): boolean {
    if (!this.deps.isViewObservable()) return false;
    // Worker snapshots seed the worker's authority from this capacity, and
    // performance mode already keeps almost nothing to release.
    if (this.deps.isWorkerIngestEnabled()) return false;
    if (usePerformanceModeStore.getState().performanceMode) return false;
    // An exited session may have no host mirror left to refill from.
    if (managed.ptyExited) return false;
    if (managed.isAttaching || managed.attachRecoveryInFlight) return false;
    if (managed.isSerializedRestoreInProgress || managed.historyRefill) return false;
    if (managed.isUserScrolledBack || managed.isAltBuffer) return false;
    // Search results and a post-complete hook's marker live in the history a
    // trim would drop.
    if ((managed.historyPins ?? 0) > 0 || managed.postCompleteHook) return false;
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

  private refill(id: string, managed: ManagedTerminal): void {
    if (managed.historyRefill) return;
    managed.historyReleased = false;
    managed.historyRefillPending = true;
    // A hidden pane under a memory-pressure cap (an exit-time refill) keeps
    // the cap; its reveal lifts it.
    restoreScrollback(managed, {
      shrinkOnly: managed.scrollbackPressureCapped === true && !managed.isVisible,
    });
    logDebug(`Restoring released history for ${id}`);
    managed.historyRefill = this.runRefill(id, managed)
      .catch((error: unknown) => {
        logWarn("Could not restore released terminal history", { id, error });
      })
      .finally(() => {
        managed.historyRefill = undefined;
      });
  }

  /**
   * The live screen is already current, so the pane paints that first. Then
   * painting is held on that frame while the restore resets and replays the
   * snapshot underneath — a large one replays in chunks across several frames
   * — and typing is held with it, so nothing is sent against a buffer that is
   * mid-replay (bracketed paste is off until the snapshot's tail turns it back
   * on); the program's own queries are still answered. Output arriving
   * meanwhile is held by the restore window and replayed after the snapshot,
   * as on a cold project switch. The paint hold covers the whole refill, so a
   * pane hidden and shown again mid-replay never sees it either.
   */
  private async runRefill(id: string, managed: ManagedTerminal): Promise<void> {
    if (managed.isVisible) {
      // One frame for xterm to schedule its paint of the revealed pane, one
      // for that paint to land.
      await nextFrame();
      await nextFrame();
    }
    if (this.deps.getInstance(id) !== managed) return;

    const holdPaint = managed.isOpened;
    if (holdPaint) suspendXtermRender(managed.terminal, REFILL_PAINT_HOLD);
    managed.historyRefilling = true;
    this.deps.applyInputLock(managed);
    try {
      const restored = await this.deps.fetchAndRestore(id);
      // A small snapshot's restore resolves once queued. Its write callback
      // closes the window in a microtask and hands the held output to xterm;
      // the second barrier lands behind that output, so the modes it sets are
      // in force before typing resumes.
      await this.writeBarrier(managed, true);
      await this.writeBarrier(managed, false);
      // Nothing more will ever come for an exited session.
      if (restored || managed.ptyExited) managed.historyRefillPending = false;
    } finally {
      managed.historyRefilling = false;
      if (this.deps.getInstance(id) === managed) this.deps.applyInputLock(managed);
      if (holdPaint) resumeXtermRender(managed.terminal, REFILL_PAINT_HOLD);
    }
  }

  private writeBarrier(managed: ManagedTerminal, afterMicrotasks: boolean): Promise<void> {
    return new Promise((resolve) => {
      try {
        managed.terminal.write(WRITE_BARRIER, () =>
          afterMicrotasks ? queueMicrotask(resolve) : resolve()
        );
      } catch {
        resolve();
      }
    });
  }
}
