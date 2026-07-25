import type { ProjectHistoryDirection } from "../../shared/types/ipc/project.js";

export type { ProjectHistoryDirection };

/**
 * Upper bound on remembered visits. Deep enough that no real session walks off
 * the end, shallow enough that the array stays trivial to scan.
 */
const MAX_ENTRIES = 50;

/**
 * Back/forward history over visited projects, one instance per window.
 *
 * Replaces the old recency walk, which could not express the thing people
 * actually do. `lastOpened` is bumped by the very act of arriving, so "the most
 * recent project that isn't this one" always pointed back at where you came
 * from — two projects ping-ponged forever and a third was unreachable.
 *
 * Deliberately in-memory and per-window: a stack restored across restarts would
 * be full of projects the user has since forgotten, and a stack shared between
 * windows would make Back in one window jump to something another window
 * visited. Windows navigate independently, like browser tabs.
 *
 * There is no "am I navigating" flag. {@link record} infers it: a switch whose
 * destination is the neighbouring entry moves the cursor, anything else
 * truncates the forward branch and pushes. That inference is only sound because
 * {@link peek} prunes dead entries before stepping, so the target it offers is
 * always adjacent to the cursor by the time the switch lands. It also keeps the
 * service honest when a switch arrives from a route that never announced
 * itself — a menu, the palette, a plugin, or a cross-project agent jump.
 */
export class ProjectHistoryService {
  private entries: string[] = [];
  /** Index of the current project within {@link entries}; -1 while empty. */
  private cursor = -1;

  /** Index one step from `cursor`, wrapping around the ends. */
  private step(direction: ProjectHistoryDirection): number {
    const size = this.entries.length;
    if (size === 0) return -1;
    const offset = direction === "back" ? -1 : 1;
    return (this.cursor + offset + size) % size;
  }

  /**
   * Fold a completed switch into the history.
   *
   * Ordering matters: the "already here" check has to come first, because a
   * redundant switch to the current project must not be mistaken for a step
   * onto an identical neighbour and silently move the cursor.
   *
   * Neighbours are cyclic to match {@link peek}. A wrap lands on an entry that
   * isn't adjacent by index, and without this it would read as a jump off the
   * branch and rewrite the stack underneath the user.
   */
  record(projectId: string): void {
    if (!projectId) return;

    if (this.entries[this.cursor] === projectId) return;

    const forward = this.step("forward");
    if (forward >= 0 && this.entries[forward] === projectId) {
      this.cursor = forward;
      return;
    }

    const back = this.step("back");
    if (back >= 0 && this.entries[back] === projectId) {
      this.cursor = back;
      return;
    }

    // A jump off the ring entirely. Everything ahead of the cursor is now
    // unreachable, exactly as a browser discards forward history on navigation.
    this.entries = this.entries.slice(0, this.cursor + 1);
    this.entries.push(projectId);

    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(this.entries.length - MAX_ENTRIES);
    }
    this.cursor = this.entries.length - 1;
  }

  /** The project the cursor is on, or null while the stack is empty. */
  current(): string | null {
    return this.entries[this.cursor] ?? null;
  }

  /**
   * The project a step would land on, or null when the ring is empty.
   *
   * Wraps at both ends. Two projects then alternate on a single key — the
   * dominant way this shortcut is used, and what it did before it grew a
   * stack — while three or more cycle rather than dead-ending. A shortcut that
   * silently does nothing at the end of a list reads as broken, and there is no
   * HUD here to explain the refusal.
   *
   * Prunes removed projects before stepping rather than skipping over them.
   * Skipping would hand back a target two or more slots away, which
   * {@link record} could not recognise as a step — it would append a new branch
   * instead, stranding the cursor.
   */
  peek(direction: ProjectHistoryDirection, exists: (projectId: string) => boolean): string | null {
    this.prune(exists);
    const index = this.step(direction);
    return index >= 0 ? (this.entries[index] ?? null) : null;
  }

  /** Whether a step in this direction would land anywhere. */
  canGo(direction: ProjectHistoryDirection, exists: (projectId: string) => boolean): boolean {
    return this.peek(direction, exists) !== null;
  }

  /**
   * Drop entries whose project no longer exists, keeping the cursor on the
   * project it was already pointing at, and collapsing any duplicate neighbours
   * the removal exposes so that "the neighbour" stays a different project.
   */
  private prune(exists: (projectId: string) => boolean): void {
    if (this.entries.every((projectId) => exists(projectId))) return;

    const previousCurrent = this.current();
    const kept: string[] = [];
    let cursor = -1;
    for (const [index, projectId] of this.entries.entries()) {
      if (!exists(projectId)) continue;
      if (kept.at(-1) !== projectId) kept.push(projectId);
      if (index === this.cursor) cursor = kept.length - 1;
    }

    this.entries = kept;
    if (cursor >= 0) {
      this.cursor = cursor;
      return;
    }
    // The cursor's own project was removed. Land on whatever survives rather
    // than pointing past the end.
    const fallback = previousCurrent !== null ? kept.indexOf(previousCurrent) : -1;
    this.cursor = fallback >= 0 ? fallback : kept.length - 1;
  }

  /** Test/diagnostic view of the stack. */
  snapshot(): { entries: string[]; cursor: number } {
    return { entries: [...this.entries], cursor: this.cursor };
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
