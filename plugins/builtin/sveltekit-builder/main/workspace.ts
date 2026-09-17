import type { PluginFsApi } from "../../../../shared/types/plugin.js";
import type { EditApplyResult, SupportVerdict } from "../shared/protocol.js";
import type { EditReceipt } from "../shared/model.js";
import { EditJournal } from "./journal.js";
import type { TailwindCache } from "./tailwind.js";
import { SourceTracker } from "./tracker.js";

/**
 * One open source workspace: a worktree, the app inside it, and everything
 * main holds on its behalf. Every handler after `workspaceOpen` names its
 * workspace by session id; nothing consults the active project or worktree.
 */
export interface Workspace {
  readonly id: string;
  readonly projectId: string;
  readonly worktreeId: string;
  /** The dev preview panel whose builder opened this workspace; its pushes go there. */
  readonly previewPanelId: string;
  readonly worktreePath: string;
  readonly appRoot: string;
  readonly support: SupportVerdict;
  readonly fs: PluginFsApi;
  readonly journal: EditJournal;
  readonly tracker: SourceTracker;
  /** idempotencyKey → the outcome of that edit, joined while still in flight. */
  readonly edits: Map<
    string,
    { fingerprint: string; outcome: Promise<EditApplyResult>; settled: boolean }
  >;
  /** Transactions already reversed, so a retried undo answers the same way. */
  readonly reversals: Map<string, EditReceipt>;
  tailwind: TailwindCache | null;
}

/** Bounds on the per-workspace retry memory; the oldest keys go first. */
export const MAX_REMEMBERED_EDITS = 4096;
export const MAX_REMEMBERED_REVERSALS = 256;

/**
 * Open workspaces are cheap but not free (watchers, journals). A view that
 * never closes its workspace — a crashed renderer — must not leak forever, so
 * the least recently used one is released past this many.
 */
export const MAX_OPEN_WORKSPACES = 32;

export function trimOldest<K, V>(map: Map<K, V>, max: number): void {
  for (const key of map.keys()) {
    if (map.size <= max) return;
    map.delete(key);
  }
}

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();

  add(workspace: Workspace): void {
    this.workspaces.set(workspace.id, workspace);
    for (const [id, oldest] of this.workspaces) {
      if (this.workspaces.size <= MAX_OPEN_WORKSPACES) break;
      this.release(id, oldest);
    }
  }

  /** Looks a workspace up and marks it recently used. */
  get(id: string): Workspace | undefined {
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

  private release(id: string, workspace: Workspace): void {
    this.workspaces.delete(id);
    workspace.tracker.dispose();
    workspace.journal.clear();
    workspace.edits.clear();
    workspace.reversals.clear();
    workspace.tailwind = null;
  }
}
