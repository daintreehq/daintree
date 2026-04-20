import type { PluginWorktreeSnapshot } from "../types/plugin.js";
import type { WorktreeSnapshot } from "../types/workspace-host.js";

/**
 * Project an internal `WorktreeSnapshot` down to the read-only
 * `PluginWorktreeSnapshot` allowlist, then freeze it.
 *
 * Explicit field assignment — do NOT spread. Internal shape changes must not
 * implicitly leak to third-party plugins.
 */
export function toPluginWorktreeSnapshot(snapshot: WorktreeSnapshot): PluginWorktreeSnapshot {
  const projection: PluginWorktreeSnapshot = {
    id: snapshot.id,
    worktreeId: snapshot.worktreeId,
    path: snapshot.path,
    name: snapshot.name,
    isCurrent: snapshot.isCurrent,
    branch: snapshot.branch,
    isMainWorktree: snapshot.isMainWorktree,
    aheadCount: snapshot.aheadCount,
    behindCount: snapshot.behindCount,
    issueNumber: snapshot.issueNumber,
    issueTitle: snapshot.issueTitle,
    prNumber: snapshot.prNumber,
    prUrl: snapshot.prUrl,
    prState: snapshot.prState,
    prTitle: snapshot.prTitle,
    mood: snapshot.mood,
    lastActivityTimestamp: snapshot.lastActivityTimestamp ?? null,
    createdAt: snapshot.createdAt,
  };
  return Object.freeze(projection);
}
