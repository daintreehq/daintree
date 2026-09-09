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

import type { ProjectViewManager } from "./ProjectViewManager.js";
import type { WindowRegistry } from "./WindowRegistry.js";
import { getActiveShutdown } from "../lifecycle/shutdownCoordinator.js";
import {
  MAX_BACKGROUND_PROJECTS_PER_WINDOW,
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
  /**
   * Workspaces with at least one live terminal, whatever window (if any) has a
   * view for them. Injected rather than imported so the tracker stays testable
   * without a pty-host, and optional so a boot that has not wired PtyClient yet
   * degrades to view-only capture rather than throwing (#12320).
   */
  liveWorkspaceIds?: () => ReadonlySet<string>;
}

/**
 * Background projects a window is still restoring, keyed by window id (#12320).
 *
 * Load-bearing for one narrow window of time: `restoreWindowFleet` releases the
 * save suppression as soon as window *setup* finishes, while the background
 * restore pass is still booting renderers. At that instant those projects have
 * neither a view nor a live terminal, so a manifest built from live state alone
 * would persist the fleet without them — and if the app then died, the next
 * launch would restore strictly less than this one did. Holding the intent here
 * keeps the manifest describing what the session is *becoming*, not the partial
 * state it happens to be in mid-boot.
 */
const pendingBackgroundRestores = new Map<number, string[]>();

/**
 * Replace a window's pending background set. Called with the remaining ids as
 * each restore settles, and with an empty list when the pass finishes — at
 * which point the restored projects are represented by their own views.
 */
export function setPendingBackgroundRestores(windowId: number, ids: readonly string[]): void {
  if (ids.length === 0) {
    pendingBackgroundRestores.delete(windowId);
    return;
  }
  pendingBackgroundRestores.set(windowId, [...ids]);
}

export function clearPendingBackgroundRestores(windowId: number): void {
  pendingBackgroundRestores.delete(windowId);
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
  liveWorkspaceIds?: () => ReadonlySet<string>;
}): void {
  state = {
    registry: opts.registry,
    readOnly: opts.readOnly,
    liveWorkspaceIds: opts.liveWorkspaceIds,
  };
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
  excludeWindowId?: number,
  liveWorkspaceIds?: ReadonlySet<string>
): OpenWindowRecord[] {
  // Two passes, because a window's background list must exclude every OTHER
  // window's foreground project, and focus order gives no way to know a later
  // window's project while building an earlier one's list. Assigning a project
  // to two windows would cold-start two renderers for it on the next launch,
  // each burning a warm-cache slot.
  const windows: Array<{ windowId: number; projectId: string | null; pvm?: ProjectViewManager }> =
    [];
  const claimed = new Set<string>();

  for (const ctx of registry.focusOrder()) {
    if (ctx.windowId === excludeWindowId) continue;
    if (ctx.browserWindow.isDestroyed()) continue;

    let projectId: string | null;
    let pvm: ProjectViewManager | undefined;
    try {
      pvm = ctx.services.projectViewManager;
      projectId = pvm?.getActiveProjectId() ?? null;
    } catch {
      // A disposing manager can throw. Persist the window as a picker window
      // rather than dropping it — losing the window is worse than losing which
      // project it was on. Its background list goes with it: a manager that
      // cannot answer for its active view cannot be trusted for its cached ones.
      projectId = null;
      pvm = undefined;
    }

    if (projectId !== null) claimed.add(projectId);
    windows.push({ windowId: ctx.windowId, projectId, pvm });
    if (windows.length >= MAX_RESTORED_WINDOWS) break;
  }

  const records: OpenWindowRecord[] = [];
  for (const win of windows) {
    let backgroundProjectIds: string[];
    try {
      backgroundProjectIds = collectWindowBackgroundIds(win.pvm, win.windowId, claimed);
    } catch {
      backgroundProjectIds = [];
    }
    // Claimed as we go, so the next window — and the orphan sweep below — can
    // see what this one already took.
    for (const id of backgroundProjectIds) claimed.add(id);
    records.push(
      backgroundProjectIds.length > 0
        ? { projectId: win.projectId, backgroundProjectIds }
        : { projectId: win.projectId }
    );
  }

  return attachOrphanedLiveWorkspaces(records, claimed, liveWorkspaceIds);
}

/**
 * A window's own background workspaces, most-recently-used first: its cached
 * views, plus whatever it is still restoring.
 *
 * `lastUsed` descending rather than insertion order — it is the same recency
 * signal `EvictionController` scores against, so the projects the manifest
 * keeps under the per-window cap are the ones the user actually rotates
 * through. Pending restores follow the live views and hold their persisted
 * order, which is already a recency ordering from the previous session.
 */
function collectWindowBackgroundIds(
  pvm: ProjectViewManager | undefined,
  windowId: number,
  claimed: ReadonlySet<string>
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  const push = (id: string): void => {
    if (seen.has(id) || claimed.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  const views = pvm?.getAllViews() ?? [];
  for (const entry of [...views].sort((a, b) => b.lastUsed - a.lastUsed)) {
    push(entry.projectId);
  }
  for (const id of pendingBackgroundRestores.get(windowId) ?? []) push(id);

  return ids.slice(0, MAX_BACKGROUND_PROJECTS_PER_WINDOW);
}

/**
 * Give the most-recently-focused window any workspace whose agents are still
 * running but which no window has claimed.
 *
 * This is the case view-based capture cannot see at all: LRU eviction and
 * memory-pressure reclaim destroy renderers while their PTYs keep running, so
 * a project the user left working an hour ago is live, unrepresented, and
 * exactly what "restore all live projects" means. Ownership goes to the
 * primary window because it is the one the fleet restore brings up first and
 * awaits alone; spreading orphans across windows would only decide which
 * renderer boots them, at the cost of a second ordering rule.
 */
function attachOrphanedLiveWorkspaces(
  records: OpenWindowRecord[],
  claimed: ReadonlySet<string>,
  liveWorkspaceIds: ReadonlySet<string> | undefined
): OpenWindowRecord[] {
  if (!liveWorkspaceIds || liveWorkspaceIds.size === 0) return records;
  if (records.length === 0) return records;

  const orphans = [...liveWorkspaceIds].filter((id) => !claimed.has(id));
  if (orphans.length === 0) return records;

  const primary = records[0];
  const merged = [...(primary.backgroundProjectIds ?? []), ...orphans].slice(
    0,
    MAX_BACKGROUND_PROJECTS_PER_WINDOW
  );
  records[0] = { ...primary, backgroundProjectIds: merged };
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
    let liveWorkspaceIds: ReadonlySet<string> | undefined;
    try {
      liveWorkspaceIds = state.liveWorkspaceIds?.();
    } catch {
      // A disposing PtyClient must cost the orphan sweep, not the manifest.
      liveWorkspaceIds = undefined;
    }
    const records = buildOpenWindowRecords(state.registry, excludeWindowId, liveWorkspaceIds);
    // On Windows and Linux the last window closing IS the quit: its `closed`
    // listener runs before `window-all-closed` reaches `app.quit()`, so an
    // empty record set here never describes a session the user chose to keep
    // — it describes the one they are leaving. Writing it would replace the
    // fleet the previous save captured with nothing, and the next launch would
    // fall back to a single project (#12320). macOS survives windowless, so an
    // empty set there is a real state and still lands.
    if (records.length === 0 && process.platform !== "darwin") return;
    writeOpenWindowsManifest(records);
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
  pendingBackgroundRestores.clear();
}
