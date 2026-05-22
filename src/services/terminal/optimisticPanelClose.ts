// Renderer-only coordinator that makes panel close feel instant.
//
// Closing a panel canonically (trash the group, kill/park the PTY, reconcile
// focus/persistence, reflow + resize every surviving xterm) is O(N) work. Run
// synchronously inside the click it gates the frame the user is waiting on, so
// rapid closes stack and feel laggy.
//
// This coordinator splits the close in two:
//   1. Optimistic hide — the clicked panel id(s) land in `closingIds` and the
//      grid filters them out immediately, so the panel disappears in the same
//      frame with near-zero work (just a free CSS-grid reflow).
//   2. Deferred canonical commit — the real teardown runs after the browser
//      has painted the removal, coalesced so a burst of closes flushes once.
//
// State is module-local (not React state, not `panelStore`): close is invoked
// from the panel header, keybindings, the command palette and actions, and the
// cheap optimistic hide must not run every panelStore subscriber selector.
import { panelStoreApi } from "@/store";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { logError } from "@/utils/logger";

// The canonical teardown runs in idle time — after the optimistic removal has
// painted — so it never competes with the close interaction or a burst of
// closes. `FLUSH_MAX_WAIT_MS` caps the wait so undo and canonical state stay
// responsive even if the main thread never goes idle.
const FLUSH_MAX_WAIT_MS = 160;

const supportsIdleCallback =
  typeof window !== "undefined" && typeof window.requestIdleCallback === "function";

/** Schedule `cb` for the next idle slot, or `FLUSH_MAX_WAIT_MS` at the latest. */
function scheduleIdle(cb: () => void): number {
  return supportsIdleCallback
    ? window.requestIdleCallback(cb, { timeout: FLUSH_MAX_WAIT_MS })
    : window.setTimeout(cb, FLUSH_MAX_WAIT_MS);
}

function cancelIdle(handle: number): void {
  if (supportsIdleCallback) window.cancelIdleCallback(handle);
  else window.clearTimeout(handle);
}

export interface PanelCloseRequest {
  /** Panel ids to hide from the grid immediately. */
  hideIds: string[];
  /** The canonical teardown, run once after paint (e.g. `trashPanelGroup`). */
  commit: () => void;
}

const EMPTY: ReadonlySet<string> = new Set<string>();
let closingIds: ReadonlySet<string> = EMPTY;
let pending: PanelCloseRequest[] = [];
let flushTimer: number | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch (error) {
      logError("optimisticPanelClose listener threw", error);
    }
  }
}

/** Subscribe to `closingIds` changes — wired into `useSyncExternalStore`. */
export function subscribeOptimisticClose(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot for `useSyncExternalStore` — identity changes only on edit. */
export function getClosingIdsSnapshot(): ReadonlySet<string> {
  return closingIds;
}

export function isOptimisticallyClosing(id: string): boolean {
  return closingIds.has(id);
}

export function hasPendingOptimisticCloses(): boolean {
  return pending.length > 0;
}

function setClosingIds(next: Set<string>): void {
  closingIds = next.size === 0 ? EMPTY : next;
  emit();
}

// Closing the focused panel must advance `focusedId` synchronously: keybinding
// closes (Cmd+W) resolve their target from `focusedId`, so without this a rapid
// Cmd+W stream would keep re-targeting the same already-closing panel. The
// deferred canonical commit re-reconciles focus properly; this just needs to
// land on *a* valid survivor in the same worktree.
function advanceFocusPastClosing(hideIds: string[]): void {
  const state = panelStoreApi.getState();
  const focusedId = state.focusedId;
  if (!focusedId || !hideIds.includes(focusedId)) return;

  const closingWorktreeId = state.panelsById[hideIds[0] ?? ""]?.worktreeId;
  let next: string | null = null;
  for (const id of state.panelIds) {
    if (closingIds.has(id)) continue;
    const terminal = state.panelsById[id];
    if (!terminal) continue;
    if (terminal.location !== "grid" && terminal.location !== undefined) continue;
    if (terminal.worktreeId !== closingWorktreeId) continue;
    next = id;
    break;
  }
  state.setFocused(next);
  if (next) {
    // Move DOM focus too — the closed pane's xterm textarea is unmounting, so
    // without this keyboard focus falls to <body> until the user clicks. Defer
    // it past paint: xterm `.focus()` restores the viewport scroll position,
    // real work that must not block the close frame. The logical `setFocused`
    // above already retargets a rapid Cmd+W stream synchronously.
    const focusTarget = next;
    requestAnimationFrame(() => {
      // Re-check before the deferred focus lands: a rapid close burst or a
      // click elsewhere may have moved focus on, or closed this target too.
      const current = panelStoreApi.getState().focusedId;
      if (current === focusTarget && !closingIds.has(focusTarget)) {
        terminalInstanceService.focus(focusTarget);
      }
    });
  }
}

function scheduleFlush(): void {
  // A burst of closes coalesces: the first schedules the flush, the rest just
  // queue into `pending` — `runFlush` drains every queued request at once.
  if (flushTimer !== undefined) return;
  flushTimer = scheduleIdle(runFlush);
}

function runFlush(): void {
  flushTimer = undefined;
  if (pending.length === 0) return;

  const batch = pending;
  pending = [];
  for (const request of batch) {
    try {
      request.commit();
    } catch (error) {
      logError("optimistic panel close commit failed", error);
    }
  }

  // The canonical commit moved these panels to trash, so the grid derivations
  // exclude them on their own now — drop them from the optimistic overlay.
  if (closingIds.size > 0) {
    const next = new Set(closingIds);
    for (const request of batch) {
      for (const id of request.hideIds) next.delete(id);
    }
    setClosingIds(next);
  }
}

/**
 * Run every queued close immediately. Used before undo (so the close is in
 * `trashedTerminals` for `restoreLastTrashed`) and on renderer teardown (so a
 * close intent is never lost to a mid-debounce unload).
 */
export function flushOptimisticCloses(): void {
  if (flushTimer !== undefined) {
    cancelIdle(flushTimer);
    flushTimer = undefined;
  }
  runFlush();
}

/**
 * Hide the requested panels from the grid now; run the canonical teardown
 * after paint, coalesced with any other close in the same burst.
 */
export function requestPanelClose(request: PanelCloseRequest): void {
  const fresh = request.hideIds.filter((id) => !closingIds.has(id));
  if (fresh.length === 0) return; // already closing — ignore the duplicate

  const next = new Set(closingIds);
  for (const id of request.hideIds) next.add(id);
  setClosingIds(next);

  advanceFocusPastClosing(request.hideIds);
  pending.push(request);
  scheduleFlush();
}

export function __resetOptimisticPanelCloseForTests(): void {
  if (flushTimer !== undefined) {
    cancelIdle(flushTimer);
    flushTimer = undefined;
  }
  pending = [];
  closingIds = EMPTY;
  listeners.clear();
}

// Never lose a close intent if the renderer is torn down mid-debounce.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushOptimisticCloses);
}
