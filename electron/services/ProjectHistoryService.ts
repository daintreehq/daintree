/**
 * Upper bound on remembered projects. Deep enough that no real session walks off
 * the end, shallow enough that the list stays trivial to scan.
 */
const MAX_ENTRIES = 50;

/**
 * The projects a window has visited, most recent first.
 *
 * This exists to answer exactly one question — "what was the last project?" —
 * because the shortcut it feeds is a toggle, not a walk. Going back and going
 * again returns you to where you started, from any number of projects. That
 * self-inverse property is the entire value of the key: it is the only project
 * navigation you can perform without looking, since you never have to know
 * where in a sequence you currently are.
 *
 * A cursor that advanced on every press loses it. From a third project two
 * presses land somewhere new rather than back where you started, so the key
 * stops being a reflex and becomes a guess — precisely when there are enough
 * projects for the guess to be wrong.
 *
 * Reaching a project that isn't the last one belongs to the palette, and
 * deliberately so. A switch here swaps a `WebContentsView` and reloads
 * worktrees; it is far too expensive to spam blindly the way alt-tab spams
 * window focus. Anything past "the other one" should be picked from a list you
 * can see.
 *
 * Deliberately in-memory and per-window: a list restored across restarts would
 * be full of projects the user has since forgotten, and one shared between
 * windows would make Back in one window jump to something another window
 * visited. Windows navigate independently, like browser tabs.
 *
 * There is no "am I navigating" flag. {@link record} takes any completed switch
 * and folds it in, so the list stays correct no matter which route the switch
 * arrived by — a menu, the palette, a plugin, or a cross-project agent jump.
 */
export class ProjectHistoryService {
  private entries: string[] = [];

  /**
   * Promote a project to the head of the list.
   *
   * Re-recording the project already at the head is a no-op, which is what lets
   * callers seed defensively: the switch path records the outgoing project
   * before the incoming one, and the IPC layer records wherever the window
   * currently is, without either needing to know what the other already did.
   */
  record(projectId: string): void {
    if (!projectId) return;
    if (this.entries[0] === projectId) return;

    const existing = this.entries.indexOf(projectId);
    if (existing > 0) this.entries.splice(existing, 1);
    this.entries.unshift(projectId);

    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
  }

  /**
   * The project at the head — where the window is now. Null while empty.
   *
   * Pass `exists` when the answer is going to be acted on. Without it the head
   * can name a project deleted since the last switch, and a caller that treats
   * a missing project as "nowhere to go" then no-ops on every press while a
   * perfectly good project waits behind it.
   */
  current(exists?: (projectId: string) => boolean): string | null {
    if (exists) this.prune(exists);
    return this.entries[0] ?? null;
  }

  /**
   * The project to toggle to, or null when this window has only ever been in
   * one project.
   *
   * Prunes removed projects first rather than skipping over them, so a project
   * deleted since the last switch demotes the next one into its place instead
   * of leaving the toggle pointing at nothing.
   */
  peekLast(exists: (projectId: string) => boolean): string | null {
    this.prune(exists);
    return this.entries[1] ?? null;
  }

  private prune(exists: (projectId: string) => boolean): void {
    if (this.entries.every((projectId) => exists(projectId))) return;
    this.entries = this.entries.filter((projectId) => exists(projectId));
  }

  /** Test/diagnostic view of the list. */
  snapshot(): { entries: string[] } {
    return { entries: [...this.entries] };
  }
}

const historyByWindow = new Map<number, ProjectHistoryService>();

/** Per-window history, created on first use. */
export function getProjectHistory(windowId: number): ProjectHistoryService {
  let history = historyByWindow.get(windowId);
  if (!history) {
    history = new ProjectHistoryService();
    historyByWindow.set(windowId, history);
  }
  return history;
}

/** Drop a closed window's history so it can't outlive the window. */
export function disposeProjectHistory(windowId: number): void {
  historyByWindow.delete(windowId);
}
