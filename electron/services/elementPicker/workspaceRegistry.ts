import type { SourceRoots } from "./sourceAccess.js";
import type { SourceTracker } from "./sourceTracker.js";

/**
 * One source workspace main holds authority over: the roots every read in it
 * is contained to, and what it is watching. The host process never sees it,
 * only its id.
 */
export interface PickerWorkspace {
  readonly id: string;
  readonly roots: SourceRoots;
  /** The origin source maps may be fetched from, as `URL.origin` gives it; null when none was registered. */
  readonly previewOrigin: string | null;
  /**
   * Aborted when the workspace is released, by its owner or by the LRU. Every
   * resolve in it carries the signal, so a queued one leaves the queue and a
   * running one is cancelled instead of finishing for a view that is gone.
   */
  readonly lifetime: AbortController;
  readonly tracker: SourceTracker;
}

/**
 * Open workspaces are cheap but not free (each watches directories). An owner
 * that never releases its workspace, a crashed renderer, must not leak it
 * forever, so the least recently used one is released past this many.
 */
export const MAX_OPEN_WORKSPACES = 32;

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, PickerWorkspace>();

  add(workspace: PickerWorkspace): void {
    this.workspaces.set(workspace.id, workspace);
    for (const [id, oldest] of this.workspaces) {
      if (this.workspaces.size <= MAX_OPEN_WORKSPACES) break;
      this.release(id, oldest);
    }
  }

  /** Looks a workspace up and marks it recently used. */
  get(id: string): PickerWorkspace | undefined {
    const workspace = this.workspaces.get(id);
    if (workspace) {
      this.workspaces.delete(id);
      this.workspaces.set(id, workspace);
    }
    return workspace;
  }

  close(id: string): boolean {
    const workspace = this.workspaces.get(id);
    if (!workspace) return false;
    this.release(id, workspace);
    return true;
  }

  closeAll(): void {
    for (const [id, workspace] of this.workspaces) this.release(id, workspace);
  }

  private release(id: string, workspace: PickerWorkspace): void {
    this.workspaces.delete(id);
    workspace.lifetime.abort();
    workspace.tracker.dispose();
  }
}
