import { usePanelStore } from "@/store/panelStore";
import { getDeletedWorktreeTerminalIds, useWorktreeSelectionStore } from "@/store/worktreeStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useTerminalPendingDestructiveActionStore } from "@/store/terminalPendingDestructiveActionStore";
import { isPtyPanel } from "@shared/types/panel";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { getTerminalAgentDisplayState } from "@/utils/terminalAgentDisplayState";
import { notify } from "@/lib/notify";

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
 * - ANY drag is in progress. Dragging a terminal out IS the rescue gesture and
 *   expiring mid-drag would yank the source away, but the drag flag
 *   (`documentElement.dataset.dragging`, set by DndProvider) carries no
 *   identity — the dragged panel's owning row is React state inside the
 *   provider, not something this module-level sweep can read. So every ghost
 *   row holds for the duration of any drag anywhere. Drags are short and
 *   deliberate, so the over-broad hold is cheap; the alternative (plumbing the
 *   active drag's worktree out of DndProvider) buys nothing at this cost.
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
  // The grouped clear previews several rows at once, so every previewed member
  // holds while the user reads the dialog — expiring one mid-read would trash
  // terminals the confirm is still offering to spare (#11260).
  if (
    pending?.kind === "deletedWorktreeGroupDismiss" &&
    pending.preview?.some((entry) => entry.worktreeId === worktreeId)
  ) {
    return true;
  }
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

/**
 * The sweep is the one path that closes terminals with nobody watching: the
 * row vanishes and the trash TTL kills the PTYs shortly after, so a user who
 * stepped away would otherwise have no record it happened and no chance at the
 * only inverse (restore from trash). Inbox-only — the event is unattended by
 * definition, so a toast would interrupt whatever the user moved on to.
 */
interface SweptRow {
  worktreeId: string;
  title: string;
  count: number;
}

/**
 * One inbox entry per sweep pass, not per row (#11260). A burst of deletions is
 * armed with the same TTL at the same moment, so its rows all expire on one
 * tick — announcing each of them wrote N entries describing a single event. The
 * low-priority inbox path skips `notify`'s rate limiter and coalescing
 * entirely, so collapsing the burst has to happen here, at the call site.
 */
function notifySweepTrashed(swept: readonly SweptRow[]): void {
  if (swept.length === 0) return;
  const terminalCount = swept.reduce((n, row) => n + row.count, 0);
  const terminalNoun = terminalCount === 1 ? "terminal" : "terminals";
  const single = swept.length === 1 ? swept[0]! : null;
  let message: string;
  if (single === null) {
    message = `${swept.length} deleted worktrees still had ${terminalCount} ${terminalNoun} open — they moved to trash and close shortly.`;
  } else if (single.count === 1) {
    message = `${single.title} still had 1 terminal open — it moved to trash and closes shortly.`;
  } else {
    message = `${single.title} still had ${single.count} terminals open — they moved to trash and close shortly.`;
  }
  notify({
    type: "info",
    title: single ? "Deleted worktree cleaned up" : "Deleted worktrees cleaned up",
    message,
    // `agent` is the right domain (these are agent sessions) but its policy
    // baseline is active/high; pin low so the unattended record stays a record
    // and never interrupts whatever the user moved on to.
    priority: "low",
    // A multi-row sweep has no single worktree to attribute, and pinning one
    // member's id would make the entry navigate somewhere arbitrary.
    context: { ...(single ? { worktreeId: single.worktreeId } : {}), eventKind: "agent" },
  });
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
  const swept: SweptRow[] = [];

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
      // Count first — the executor mirrors this exact filter, and once it runs
      // the panels have already left the row.
      const trashedCount = getDeletedWorktreeTerminalIds(entry.id).length;
      usePanelStore.getState().bulkTrashByWorktree(entry.id);
      if (trashedCount > 0) {
        swept.push({ worktreeId: entry.id, title: entry.title, count: trashedCount });
      }
    }
  }

  notifySweepTrashed(swept);
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
