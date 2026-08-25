/**
 * Upper bound on remembered workspaces. Deep enough that no real session walks
 * off the end, shallow enough that the list stays trivial to scan.
 */
const MAX_ENTRIES = 50;

/**
 * The workspaces a window has visited, most recent first.
 *
 * This exists to answer exactly one question — "what was the last workspace?" —
 * because the shortcut it feeds is a toggle, not a walk. Going back and going
 * again returns you to where you started, from any number of workspaces. That
 * self-inverse property is the entire value of the key: it is the only
 * workspace navigation you can perform without looking, since you never have to
 * know where in a sequence you currently are.
 *
 * A cursor that advanced on every press loses it. From a third workspace two
 * presses land somewhere new rather than back where you started, so the key
 * stops being a reflex and becomes a guess — precisely when there are enough
 * workspaces for the guess to be wrong.
 *
 * Ids are opaque here, and that is what lets projects and scratches share one
 * list (#11936). The two id spaces are disjoint, so callers decide what an
 * entry means: every read takes an `exists` predicate that resolves the id
 * against whichever store owns it. What the user is toggling between matters
 * less than that the toggle inverts, and a scratch is exactly the workspace
 * they most often want back.
 *
 * Reaching a workspace that isn't the last one belongs to the palette, and
 * deliberately so. A switch here swaps a `WebContentsView` and reloads
 * worktrees; it is far too expensive to spam blindly the way alt-tab spams
 * window focus. Anything past "the other one" should be picked from a list you
 * can see.
 *
 * Deliberately in-memory and per-window: a list restored across restarts would
 * be full of workspaces the user has since forgotten, and one shared between
 * windows would make Back in one window jump to something another window
 * visited. Windows navigate independently, like browser tabs.
 *
 * There is no "am I navigating" flag. {@link record} takes any completed switch
 * and folds it in, so the list stays correct no matter which route the switch
 * arrived by — a menu, the palette, a plugin, or a cross-project agent jump.
 */
export class ProjectHistoryService {
  private entries: string[] = [];
  private disposed = false;

  /**
   * Promote a workspace to the head of the list.
   *
   * Re-recording the workspace already at the head is a no-op, which is what
   * lets callers seed defensively: the switch path records the outgoing
   * workspace before the incoming one, and the IPC layer records wherever the
   * window currently is, without either needing to know what the other already
   * did.
   */
  record(workspaceId: string): void {
    if (this.disposed || !workspaceId) return;
    if (this.entries[0] === workspaceId) return;

    const existing = this.entries.indexOf(workspaceId);
    if (existing > 0) this.entries.splice(existing, 1);
    this.entries.unshift(workspaceId);

    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
  }

  /**
   * The workspace at the head — where the window is now. Null while empty.
   *
   * Pass `exists` when the answer is going to be acted on. Without it the head
   * can name a workspace deleted since the last switch, and a caller that
   * treats a missing workspace as "nowhere to go" then no-ops on every press
   * while a perfectly good one waits behind it.
   */
  current(exists?: (workspaceId: string) => boolean): string | null {
    if (exists) this.prune(exists);
    return this.entries[0] ?? null;
  }

  /**
   * The workspace to toggle to, or null when this window has only ever been in
   * one workspace.
   *
   * Prunes removed workspaces first rather than skipping over them, so one
   * deleted since the last switch demotes the next into its place instead of
   * leaving the toggle pointing at nothing.
   */
  peekLast(exists: (workspaceId: string) => boolean): string | null {
    this.prune(exists);
    return this.entries[1] ?? null;
  }

  private prune(exists: (workspaceId: string) => boolean): void {
    if (this.entries.every((workspaceId) => exists(workspaceId))) return;
    this.entries = this.entries.filter((workspaceId) => exists(workspaceId));
  }

  /**
   * Retire the list for good. Records that arrive afterwards are dropped rather
   * than rebuilding a history for a window that no longer exists.
   */
  dispose(): void {
    this.disposed = true;
    this.entries.length = 0;
  }

  /** Test/diagnostic view of the list. */
  snapshot(): { entries: string[] } {
    return { entries: [...this.entries] };
  }
}

const historyByWindow = new Map<number, ProjectHistoryService>();

/**
 * Ids of windows that have been unregistered.
 *
 * Every caller records *after* awaiting the view swap, so a window closed
 * mid-switch is already unregistered by the time its own switch records. An
 * unguarded lookup would then create a second entry that nothing disposes
 * again — a permanent one, and one that hands the next window to be given this
 * id a history it never visited. Cleared by {@link resetProjectHistory} when a
 * live window claims the id, which is the only way back to a recording history.
 */
const disposedWindowIds = new Set<number>();

/** Handed to callers that arrive after the window is gone. Records nothing. */
const inertHistory = new ProjectHistoryService();
inertHistory.dispose();

/** Per-window history, created on first use. */
export function getProjectHistory(windowId: number): ProjectHistoryService {
  if (disposedWindowIds.has(windowId)) return inertHistory;
  let history = historyByWindow.get(windowId);
  if (!history) {
    history = new ProjectHistoryService();
    historyByWindow.set(windowId, history);
  }
  return history;
}

/** Drop a closed window's history so it can't outlive the window. */
export function disposeProjectHistory(windowId: number): void {
  historyByWindow.get(windowId)?.dispose();
  historyByWindow.delete(windowId);
  disposedWindowIds.add(windowId);
}

/**
 * Hand a window id back a live, empty history. Called when a window registers,
 * so a recycled id records again from scratch instead of staying inert.
 */
export function resetProjectHistory(windowId: number): void {
  historyByWindow.delete(windowId);
  disposedWindowIds.delete(windowId);
}
