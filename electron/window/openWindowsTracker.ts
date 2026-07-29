/**
 * Keeps the persisted open-window manifest in step with the live window set
 * (#11492).
 *
 * Continuous persistence rather than a snapshot at quit: our own force-quit
 * action goes through `app.exit(0)`, which skips `before-quit` entirely, and a
 * main-process crash skips everything. Those are exactly the exits where you
 * most want the window set back, so the manifest has to already be correct on
 * disk before the process dies. Mirrors what windowState.ts does for bounds.
 *
 * Three rules make that safe:
 *
 *  1. Freeze once a shutdown owns the process. `getActiveShutdown()` goes
 *     non-null the moment a quit is committed, and the updater then closes
 *     windows one at a time — un-frozen, those closes would walk the persisted
 *     list down to empty and the next launch would restore nothing.
 *  2. Snapshot before freezing. `runShutdownChain()` calls
 *     `freezeAndSnapshotOpenWindows()`, which bypasses rule 1 exactly once to
 *     capture whatever a pending debounce still owed — switch a project and
 *     quit 200ms later and that change would otherwise be lost.
 *  3. Never save during a recovery launch. Safe mode restores one window on
 *     purpose; persisting that would overwrite the user's real fleet with it.
 */

import type { WindowRegistry } from "./WindowRegistry.js";
import { getActiveShutdown } from "../lifecycle/shutdownCoordinator.js";
import {
  MAX_RESTORED_WINDOWS,
  type OpenWindowRecord,
} from "../services/persistence/windowManifest.js";
import { writeOpenWindowsManifest } from "../services/persistence/windowManifestStore.js";

/** Matches windowState.ts's bounds debounce — same class of chatty signal. */
const SAVE_DEBOUNCE_MS = 500;

interface TrackerState {
  registry: WindowRegistry;
  /** Recovery launches observe but never write. */
  readOnly: boolean;
}

let state: TrackerState | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Latched at shutdown. Permanent by design — nothing resumes after it. */
let frozen = false;
/**
 * Held across the startup restore fan-out. Windows 2..N register while window
 * 1's debounce is pending, and a save landing mid-fan-out would persist a
 * partial fleet — harmless if startup completes, authoritative for the next
 * launch if it doesn't.
 */
let suppressed = false;

export function initOpenWindowsTracker(opts: {
  registry: WindowRegistry;
  readOnly: boolean;
}): void {
  state = { registry: opts.registry, readOnly: opts.readOnly };
}

/**
 * Build the manifest from the live windows, most-recently-focused first.
 *
 * Each window's project comes from its ProjectViewManager, never from
 * `WindowContext.projectPath` — that is stamped once at registration and is
 * never updated when the window switches project, so it goes stale on the first
 * switch and would persist the project the window *opened* with rather than the
 * one it is showing.
 *
 * @param excludeWindowId A window whose teardown is already committed. The
 *   `closed` listener fires after WindowRegistry unregisters, so this is belt
 *   and braces — but a save triggered from anywhere else during teardown must
 *   not resurrect a window the user deliberately closed.
 */
export function buildOpenWindowRecords(
  registry: WindowRegistry,
  excludeWindowId?: number
): OpenWindowRecord[] {
  const records: OpenWindowRecord[] = [];

  for (const ctx of registry.focusOrder()) {
    if (ctx.windowId === excludeWindowId) continue;
    if (ctx.browserWindow.isDestroyed()) continue;

    let projectId: string | null;
    try {
      projectId = ctx.services.projectViewManager?.getActiveProjectId() ?? null;
    } catch {
      // A disposing manager can throw. Persist the window as a picker window
      // rather than dropping it — losing the window is worse than losing which
      // project it was on.
      projectId = null;
    }

    records.push({ projectId });
    if (records.length >= MAX_RESTORED_WINDOWS) break;
  }

  return records;
}

function canSave(): boolean {
  if (!state) return false;
  if (frozen || suppressed || state.readOnly) return false;
  // A shutdown owns the process: the window set is being torn down, not changed.
  return getActiveShutdown() === null;
}

function cancelPendingSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

function persist(excludeWindowId?: number): void {
  if (!state) return;
  try {
    writeOpenWindowsManifest(buildOpenWindowRecords(state.registry, excludeWindowId));
  } catch (error) {
    // Losing the manifest costs the user a manual window next launch. It must
    // never take down a window close or the shutdown chain with it.
    console.warn("[openWindowsTracker] Failed to persist the open-window manifest:", error);
  }
}

/** Coalesce chatty signals — focus changes, project switches, window opens. */
export function scheduleOpenWindowsSave(): void {
  if (!canSave()) return;
  cancelPendingSave();
  saveTimer = setTimeout(() => {
    saveTimer = null;
    // Re-check: a shutdown or a freeze can land inside the debounce window.
    if (!canSave()) return;
    persist();
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Write immediately, dropping any pending debounce.
 *
 * Used by the window `closed` listener: better-sqlite3 writes inline, so this
 * leaves no unawaited promise in flight while the window tears down.
 */
export function saveOpenWindowsNow(excludeWindowId?: number): void {
  cancelPendingSave();
  if (!canSave()) return;
  persist(excludeWindowId);
}

/** Hold saves across the startup restore fan-out. Balanced by `resume`. */
export function suppressOpenWindowsSaves(): void {
  suppressed = true;
  cancelPendingSave();
}

/**
 * Release the fan-out hold.
 *
 * @param persistNow Write one full snapshot on the way out. Passed false when
 *   the fan-out died partway, so a partial fleet never overwrites the manifest
 *   that is still correct on disk.
 */
export function resumeOpenWindowsSaves(persistNow: boolean): void {
  suppressed = false;
  if (persistNow) saveOpenWindowsNow();
}

/**
 * Capture the final window set, then latch saves off for good.
 *
 * Called at the top of `runShutdownChain()`, before its first await. Bypasses
 * the active-shutdown gate deliberately — by the time the chain runs,
 * `startShutdown()` has already claimed the process, so an ordinary save would
 * refuse and any debounce still owing would be dropped. This is the one write
 * allowed to see a shutdown in progress; every later one is refused, which is
 * what stops the updater's window-by-window close from emptying the list.
 */
export function freezeAndSnapshotOpenWindows(): void {
  cancelPendingSave();

  if (state && !frozen && !suppressed && !state.readOnly) {
    persist();
  }

  frozen = true;
}

/** Test-only: the module singleton outlives tests that don't reset modules. */
export function resetOpenWindowsTrackerForTests(): void {
  cancelPendingSave();
  state = null;
  frozen = false;
  suppressed = false;
}
