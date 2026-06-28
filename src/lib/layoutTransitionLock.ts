/**
 * Process-wide signal that a sidebar slot is currently animating its width.
 * During the lock window the panel-grid `<main flex:1>` reflows every frame
 * as the flex container redistributes available space. Any consumer that
 * derives geometry from a ResizeObserver (grid width, grid dimensions,
 * keyboard-nav column count) must skip its updates while this lock is active
 * — otherwise React commits mid-animation widths into `grid-template-columns`
 * and the grid edge visibly jitters (regression of #5735, tracked in #6979).
 *
 * The lock complements the per-PTY suppression in
 * `TerminalInstanceService.suppressResizesDuringLayoutTransition`: that one
 * stops xterm from resizing the PTY host; this one stops React renders that
 * would re-snap the visual grid layout. Both are needed because xterm
 * suppression doesn't address layout-driven re-renders.
 *
 * Single renderer = single lock. Module-level state is safe — each project
 * view is a distinct WebContentsView with its own V8 context (see
 * `ProjectViewManager`), so there is exactly one grid per module scope.
 *
 * A second, independent lock (`hydrationLocked`) covers the startup window
 * before the persisted sidebar width is restored. At mount the sidebar sits at
 * `DEFAULT_SIDEBAR_WIDTH`; the real width arrives ~50–100ms later when the
 * async `appClient.getState()` restore resolves (see `AppLayout`). Measuring
 * the grid in that window captures the wrong (narrow) `<main>` width and the
 * grid visibly snaps once the restore lands (#10827). Unlike the transition
 * lock this one is one-shot: it starts `true`, is released exactly once when
 * hydration completes, and never re-arms. The `isSidebarMeasurementLocked()`
 * combiner is the single query every measurement site should use so neither
 * lock can be forgotten.
 */

let locked = false;
let timer: number | undefined;
const listeners = new Set<() => void>();

let hydrationLocked = true;
const hydrationListeners = new Set<() => void>();

export function isSidebarLayoutTransitionLocked(): boolean {
  return locked;
}

/**
 * True while the persisted sidebar width is still being restored on startup.
 * Starts `true`, flips to `false` exactly once via `unlockSidebarHydration()`.
 */
export function isSidebarHydrationLocked(): boolean {
  return hydrationLocked;
}

/**
 * Single query for "is any width-affecting operation in flight?" — the union of
 * the user-triggered transition lock and the one-shot startup hydration lock.
 * Every grid/pane measurement site should gate on this rather than either lock
 * alone, so adding a new lock can't silently bypass an existing measure path.
 */
export function isSidebarMeasurementLocked(): boolean {
  return locked || hydrationLocked;
}

export function lockSidebarLayoutTransition(durationMs: number): void {
  locked = true;
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  timer = window.setTimeout(() => {
    timer = undefined;
    locked = false;
    // Snapshot listeners — a callback may unsubscribe during iteration.
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch {
        // Swallow per-listener errors so one bad subscriber can't block others.
      }
    }
  }, durationMs);
}

export function subscribeSidebarLayoutTransitionUnlock(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Release the startup hydration lock and notify subscribers. Idempotent and
 * one-shot: a second call after the lock has cleared is a no-op (no double
 * fire). Listeners are cleared after firing — hydration happens once per
 * renderer lifetime, so a late subscriber takes the already-unlocked fast path
 * in `subscribeSidebarHydrationUnlock` instead.
 */
export function unlockSidebarHydration(): void {
  if (!hydrationLocked) return;
  hydrationLocked = false;
  // Snapshot — a callback may unsubscribe (or this set is cleared) mid-iteration.
  for (const listener of Array.from(hydrationListeners)) {
    try {
      listener();
    } catch {
      // Swallow per-listener errors so one bad subscriber can't block others.
    }
  }
  hydrationListeners.clear();
}

/**
 * Subscribe to the one-shot hydration unlock. If hydration has already
 * completed the listener fires synchronously and the returned cleanup is a
 * no-op — a measurement effect that mounts after restore still gets its
 * deferred remeasure rather than silently dropping it.
 */
export function subscribeSidebarHydrationUnlock(listener: () => void): () => void {
  if (!hydrationLocked) {
    try {
      listener();
    } catch {
      // Mirror unlockSidebarHydration's throw-safety so a bad subscriber on the
      // already-unlocked fast path can't escape into the caller's effect.
    }
    return () => {};
  }
  hydrationListeners.add(listener);
  return () => {
    hydrationListeners.delete(listener);
  };
}

export function __resetSidebarLayoutTransitionLockForTests(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  locked = false;
  listeners.clear();
}

export function __resetSidebarHydrationLockForTests(): void {
  hydrationLocked = true;
  hydrationListeners.clear();
}
