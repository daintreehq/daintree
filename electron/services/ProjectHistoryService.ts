import type { ProjectHistoryDirection } from "../../shared/types/ipc/project.js";

export type { ProjectHistoryDirection };

/**
 * Upper bound on remembered projects. Deep enough that no real session walks off
 * the end, shallow enough that the array stays trivial to scan.
 */
const MAX_ENTRIES = 50;

/**
 * The projects a window has visited, as a ring the shortcuts cycle around.
 *
 * Replaces the old recency walk, which could not express the thing people
 * actually do. `lastOpened` is bumped by the very act of arriving, so "the most
 * recent project that isn't this one" always pointed back at where you came
 * from — two projects ping-ponged forever and a third was unreachable.
 *
 * A ring rather than a browser-style stack, because a switcher is not a
 * document history: nobody thinks "go forward", they think "take me back to the
 * other thing". Wrapping keeps two-project alternation on a single key — the
 * dominant use, and what the shortcut did before it grew a history — while
 * three or more cycle instead of dead-ending on a key press that does nothing.
 *
 * **Each project appears at most once.** That is what makes the cursor
 * unambiguous: with duplicates, a project sitting at both ends of the ring
 * cannot be told apart by id, and a step onto it lands on the wrong occurrence
 * or loops onto itself. Re-visiting a project already in the ring moves the
 * cursor to it rather than adding a second copy.
 *
 * Deliberately in-memory and per-window: a ring restored across restarts would
 * be full of projects the user has since forgotten, and one shared between
 * windows would make Back in one window jump to something another window
 * visited. Windows navigate independently, like browser tabs.
 *
 * There is no "am I navigating" flag. {@link record} takes any completed switch
 * and folds it in, so the ring stays correct no matter which route the switch
 * arrived by — a menu, the palette, a plugin, or a cross-project agent jump.
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
   * Fold a completed switch into the ring.
   *
   * A project already in the ring keeps its place and just takes the cursor —
   * that covers every step around the ring, and it means an explicit jump to
   * somewhere already visited reorders nothing. A project not in the ring is
   * inserted directly after the cursor, so Back still leads to where the user
   * came from rather than to whatever happened to be last.
   */
  record(projectId: string): void {
    if (!projectId) return;

    const existing = this.entries.indexOf(projectId);
    if (existing >= 0) {
      this.cursor = existing;
      return;
    }

    this.entries.splice(this.cursor + 1, 0, projectId);
    this.cursor += 1;

    if (this.entries.length > MAX_ENTRIES) {
      // Drop from the far side of the cursor so the projects nearest to where
      // the user is standing are the ones that survive.
      const dropIndex = this.cursor === 0 ? this.entries.length - 1 : 0;
      this.entries.splice(dropIndex, 1);
      if (dropIndex < this.cursor) this.cursor -= 1;
    }
  }

  /** The project the cursor is on, or null while the ring is empty. */
  current(): string | null {
    return this.entries[this.cursor] ?? null;
  }

  /**
   * The project a step would land on, or null when the ring is empty.
   *
   * Returns the current project when the ring holds only one — the caller reads
   * landing on yourself as nothing to do.
   *
   * Prunes removed projects before stepping rather than skipping over them, so
   * the answer is always the true neighbour.
   */
  peek(direction: ProjectHistoryDirection, exists: (projectId: string) => boolean): string | null {
    this.prune(exists);
    const index = this.step(direction);
    return index >= 0 ? (this.entries[index] ?? null) : null;
  }

  /**
   * Drop entries whose project no longer exists, keeping the cursor on the
   * project it was already pointing at.
   */
  private prune(exists: (projectId: string) => boolean): void {
    if (this.entries.every((projectId) => exists(projectId))) return;

    const previousCurrent = this.current();
    const kept = this.entries.filter((projectId) => exists(projectId));
    this.entries = kept;

    const currentIndex = previousCurrent !== null ? kept.indexOf(previousCurrent) : -1;
    // The cursor's own project may have been the removed one; land on whatever
    // survives rather than pointing past the end.
    this.cursor = currentIndex >= 0 ? currentIndex : Math.min(this.cursor, kept.length - 1);
    if (this.cursor < 0) this.cursor = kept.length - 1;
  }

  /** Test/diagnostic view of the ring. */
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
