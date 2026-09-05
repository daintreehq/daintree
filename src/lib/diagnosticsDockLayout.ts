import { terminalInstanceService } from "@/services/terminal/TerminalInstanceService";
import { getSidebarAffectedTerminalIds } from "./sidebarToggle";
import { DIAGNOSTICS_DOCK_TRANSITION_MS } from "./terminalLayout";

/**
 * The diagnostics dock's half of the layout-transition protocol every other
 * piece of layout-changing chrome already implements.
 *
 * The dock is a flex sibling of the sidebar/main row, so opening it shrinks
 * `<main>` and every panel in the grid. CSS alone gets the boxes right; what
 * the dock was missing is the two JS obligations that come with any reflow of
 * that row (issue #12264):
 *
 *  1. Suppress PTY resize propagation for the transition window, exactly as
 *     `suppressSidebarResizes` does. Without it a dock drag-resize delivers one
 *     SIGWINCH per mousemove to every agent pane. More importantly the
 *     suppression's unlock pass is the corrective refit: a resize dropped while
 *     the lock is armed is SKIPPED, not deferred (see
 *     `TerminalResizePassScheduler.batchResize`), and ResizeObserver does not
 *     retroactively fire when a lock releases.
 *  2. Tell the grid to remeasure. `useContentGridContext`'s ResizeObserver
 *     already covers most of this, but a height-only change that leaves
 *     `isScrollMode`/`scrollRowHeight` untouched schedules no grid-level
 *     terminal correction at all, and the first open resolves a lazy chunk —
 *     the store flips before any dock DOM exists.
 *
 * Single renderer = single signal, mirroring `layoutTransitionLock`: each
 * project view is its own WebContentsView with its own V8 context, so there is
 * exactly one grid per module scope.
 *
 * This is deliberately NOT a measurement lock. The dock's height transition is
 * a user-visible resize the grid should track live; only the PTY traffic needs
 * gating.
 */

const listeners = new Set<() => void>();

/**
 * Publish a committed dock geometry change: open, close, or a new height. Call
 * this AFTER React has committed the dock's DOM, so subscribers measure the
 * settled layout rather than the frame before it.
 */
export function signalDiagnosticsDockLayoutChange(): void {
  const ids = getSidebarAffectedTerminalIds();
  terminalInstanceService.suppressResizesDuringLayoutTransition(
    ids,
    DIAGNOSTICS_DOCK_TRANSITION_MS
  );
  // Snapshot — a callback may unsubscribe during iteration.
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch {
      // Swallow per-listener errors so one bad subscriber can't block others.
    }
  }
}

export function subscribeDiagnosticsDockLayoutChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function __resetDiagnosticsDockLayoutForTests(): void {
  listeners.clear();
}
