import { usePanelStore } from "@/store/panelStore";
import { getDeletedWorktreeTerminalIds, useWorktreeSelectionStore } from "@/store/worktreeStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useTerminalPendingDestructiveActionStore } from "@/store/terminalPendingDestructiveActionStore";
import { isPtyPanel } from "@shared/types/panel";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { getTerminalAgentDisplayState } from "@/utils/terminalAgentDisplayState";

export const DELETED_WORKTREE_SWEEP_INTERVAL_MS = 1000;

/**
 * Auto-cleanup for deleted-worktree rows (#11232): a row's surviving terminals
 * are moved to trash after `deletedWorktreeCleanupSeconds` (default 60s, 0 =
 * never), after which the row prunes itself. Deleted worktrees are deliberately
 * ephemeral — they never persist across restarts, and without this sweep a bulk
 * worktree cleanup would leave ghost rows pinned in the sidebar forever.
 *
 * The countdown is armed at deletion time (WorktreeStoreContext's
 * worktree-removed handler stamps `expiresAt`) and runs to zero by default —
 * the row's visible countdown is the user's window to rescue terminals. It
 * defers (holds at full) only while firing would actively break something:
 * - a drag is in progress (dragging a terminal out IS the rescue gesture —
 *   expiring mid-drag would yank the source away),
 * - any surviving terminal's agent is still `working` (the Codespaces model:
 *   active output resets the idle clock),
 * - the row's own close-confirm dialog is open.
 *
 * Terminals go through `bulkTrashByWorktree` — the same executor as the row's
 * manual close button — so auto-cleanup lands in the trash with its usual
 * restore window rather than hard-killing anything immediately.
 */
interface SweepDeps {
  now: () => number;
  isDragActive: () => boolean;
}

function defaultIsDragActive(): boolean {
  return document.documentElement.dataset.dragging === "true";
}

const DEFAULT_DEPS: SweepDeps = {
  now: () => Date.now(),
  isDragActive: defaultIsDragActive,
};

function hasWorkingAgent(worktreeId: string): boolean {
  const { panelsById } = usePanelStore.getState();
  return getDeletedWorktreeTerminalIds(worktreeId).some((id) => {
    const panel = panelsById[id];
    if (panel == null || !isPtyPanel(panel)) return false;
    // Same display-state coercion as the sidebar badges: a panel whose chrome
    // no longer renders an agent (exited, errored, plain shell) must not defer
    // cleanup forever on a stale `working` heuristic.
    const displayState = getTerminalAgentDisplayState(
      deriveTerminalChrome(panel),
      panel.agentState
    );
    return displayState === "working";
  });
}

function isCountdownDeferred(worktreeId: string, deps: SweepDeps): boolean {
  const pending = useTerminalPendingDestructiveActionStore.getState().pending;
  if (pending?.kind === "deletedWorktreeDismiss" && pending.worktreeId === worktreeId) return true;
  if (deps.isDragActive()) return true;
  return hasWorkingAgent(worktreeId);
}

// A row whose cleanup has been dispatched must not re-fire on the next tick —
// the trash commit and the row prune land asynchronously. Entries clear when
// the row leaves the map (or the sweep resets, in tests).
const firedIds = new Set<string>();

// TTL each row's deadline was armed with, so changing the preference mid-
// countdown re-arms the row to `now + newTTL` instead of honoring a deadline
// computed from the old value (30→300 would otherwise still fire at 30s, and
// the card's progress bar — which divides by the CURRENT TTL — would lie).
const armedTtlMs = new Map<string, number>();

export function resetDeletedWorktreeCleanupState(): void {
  firedIds.clear();
  armedTtlMs.clear();
}

export function sweepDeletedWorktreeCleanup(deps: SweepDeps = DEFAULT_DEPS): void {
  const selection = useWorktreeSelectionStore.getState();
  const { deletedWorktrees, setDeletedWorktreeExpiry } = selection;

  for (const id of firedIds) {
    if (!deletedWorktrees.has(id)) firedIds.delete(id);
  }
  for (const id of armedTtlMs.keys()) {
    if (!deletedWorktrees.has(id)) armedTtlMs.delete(id);
  }
  if (deletedWorktrees.size === 0) return;

  const ttlSeconds = usePreferencesStore.getState().deletedWorktreeCleanupSeconds;
  const now = deps.now();

  for (const entry of deletedWorktrees.values()) {
    // An unarmed entry is a fresh (or re-recorded) row — any stale fired flag
    // from a previous row under the same id must not suppress its countdown.
    if (entry.expiresAt === null) firedIds.delete(entry.id);
    else if (firedIds.has(entry.id)) continue;

    if (ttlSeconds === 0) {
      if (entry.expiresAt !== null) setDeletedWorktreeExpiry(entry.id, null);
      armedTtlMs.delete(entry.id);
      continue;
    }

    const ttlMs = ttlSeconds * 1000;
    const armedWith = armedTtlMs.get(entry.id);
    if (
      entry.expiresAt === null ||
      (armedWith !== undefined && armedWith !== ttlMs) ||
      isCountdownDeferred(entry.id, deps)
    ) {
      // Arm the countdown (fresh row or TTL preference change), or hold it at
      // full while activity defers it.
      setDeletedWorktreeExpiry(entry.id, now + ttlMs);
      armedTtlMs.set(entry.id, ttlMs);
      continue;
    }
    // A deadline this sweep didn't arm (unknown provenance) is adopted at the
    // current TTL so a later preference change still re-arms it.
    armedTtlMs.set(entry.id, ttlMs);

    if (now >= entry.expiresAt) {
      firedIds.add(entry.id);
      // Same executor as the row's manual close: terminals land in trash
      // (restorable until trash GC), and trashing the last one prunes the row.
      usePanelStore.getState().bulkTrashByWorktree(entry.id);
    }
  }
}

/**
 * Start the 1 Hz cleanup sweep. The interval is throttled by Chromium while
 * the view is hidden, so a visibility-restore sweep catches up immediately on
 * reveal (mirrors the trash slice's `sweepExpiredTrash`).
 */
export function startDeletedWorktreeCleanup(): () => void {
  const interval = setInterval(
    () => sweepDeletedWorktreeCleanup(),
    DELETED_WORKTREE_SWEEP_INTERVAL_MS
  );
  const onVisibilityChange = () => {
    if (!document.hidden) sweepDeletedWorktreeCleanup();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    clearInterval(interval);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
