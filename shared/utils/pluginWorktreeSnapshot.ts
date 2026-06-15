import type {
  PluginWorktreeFileState,
  PluginWorktreeLinked,
  PluginWorktreeLinkedIssue,
  PluginWorktreeLinkedPR,
  PluginWorktreeSnapshot,
  PluginWorktreeStatus,
  PluginWorktreeStatusFile,
} from "../types/plugin.js";
import type { GitStatus, WorktreeChanges } from "../types/git.js";
import type { NormalizedPRState, ResourceRef } from "../types/forge.js";
import type { WorktreeSnapshot } from "../types/workspace-host.js";
import { BUILTIN_GITHUB_PROVIDER_ID } from "./forgeProviderIds.js";

/**
 * Collapse the internal {@link GitStatus} vocabulary down to the five
 * plugin-facing states. `copied` reads as `added`, `conflicted` as `modified`;
 * `ignored` returns `null` so the file is dropped from the projection entirely
 * (a plugin scanning "what changed" never wants ignored noise).
 */
function projectFileState(status: GitStatus): PluginWorktreeFileState | null {
  switch (status) {
    case "added":
    case "copied":
      return "added";
    case "modified":
    case "conflicted":
      return "modified";
    case "deleted":
      return "deleted";
    case "untracked":
      return "untracked";
    case "renamed":
      return "renamed";
    case "ignored":
      return null;
  }
}

/**
 * Project the host's already-polled {@link WorktreeChanges} down to the
 * read-only {@link PluginWorktreeStatus} allowlist, then deep-freeze it. Reuses
 * the status the host polled — never shells out. Returns `null` when the host
 * has not computed changes for this worktree yet. Files are sorted by path so
 * consumers get a stable order to diff against.
 */
export function toPluginWorktreeStatus(
  changes: WorktreeChanges | null | undefined
): PluginWorktreeStatus | null {
  if (changes == null) return null;

  const counts: Record<PluginWorktreeFileState, number> = {
    added: 0,
    modified: 0,
    deleted: 0,
    untracked: 0,
    renamed: 0,
  };
  const files: PluginWorktreeStatusFile[] = [];
  for (const change of changes.changes) {
    const state = projectFileState(change.status);
    if (state === null) continue;
    counts[state] += 1;
    files.push(Object.freeze({ path: change.path, state }));
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return Object.freeze({
    files: Object.freeze(files),
    changedFileCount: files.length,
    counts: Object.freeze(counts),
  });
}

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
    linked: buildLinkedProjection(snapshot),
    mood: snapshot.mood,
    lastActivityTimestamp: snapshot.lastActivityTimestamp ?? null,
    createdAt: snapshot.createdAt,
    status: toPluginWorktreeStatus(snapshot.worktreeChanges),
  };
  return Object.freeze(projection);
}

/**
 * Project the worktree's linked forge resources for plugins. `snapshot.linked`
 * is the source of truth (#8452): when present it is passed through verbatim
 * (deep-cloned then frozen so the host's live `_linked` reference is never
 * mutated). Only legacy snapshots that never populated `linked` fall back to
 * synthesizing it from the flat GitHub-shaped fields, stamping the canonical
 * built-in GitHub provider id (see `forgeProviderIds.ts`) and leaving
 * `owner`/`repo` empty because those snapshots predate canonical repo identity
 * on the payload.
 */
function buildLinkedProjection(snapshot: WorktreeSnapshot): PluginWorktreeLinked | null {
  if (snapshot.linked != null) {
    return freezeLinked(snapshot.linked);
  }

  const hasPR = typeof snapshot.prNumber === "number";
  const hasIssue = typeof snapshot.issueNumber === "number";
  if (!hasPR && !hasIssue) return null;

  const providerId = BUILTIN_GITHUB_PROVIDER_ID;
  const linked: {
    providerId: string;
    issue?: PluginWorktreeLinkedIssue;
    pr?: PluginWorktreeLinkedPR;
  } = {
    providerId,
  };

  if (hasIssue) {
    const issueRef: ResourceRef = {
      providerId,
      owner: "",
      repo: "",
      number: snapshot.issueNumber as number,
      rawData: null,
    };
    linked.issue = Object.freeze({
      ref: Object.freeze(issueRef),
      title: snapshot.issueTitle,
    });
  }

  if (hasPR) {
    const prRef: ResourceRef = {
      providerId,
      owner: "",
      repo: "",
      number: snapshot.prNumber as number,
      rawData: null,
    };
    // WorktreeSnapshot.prState ("open" | "merged" | "closed") is a strict
    // subtype of NormalizedPRState (adds "declined"); a direct cast is safe.
    linked.pr = Object.freeze({
      ref: Object.freeze(prRef),
      title: snapshot.prTitle,
      url: snapshot.prUrl ?? "",
      state: (snapshot.prState ?? "open") as NormalizedPRState,
    });
  }

  return Object.freeze(linked);
}

/**
 * Deep-clone then freeze a host-provided `linked` projection. Cloning is
 * mandatory: freezing the live `WorktreeMonitor._linked` reference directly
 * would make the host's own internal state immutable and break subsequent
 * `setLinked()` merges.
 */
function freezeLinked(linked: PluginWorktreeLinked): PluginWorktreeLinked {
  const cloned: {
    providerId: string;
    issue?: PluginWorktreeLinkedIssue;
    pr?: PluginWorktreeLinkedPR;
  } = { providerId: linked.providerId };

  if (linked.issue) {
    cloned.issue = Object.freeze({
      ref: Object.freeze({ ...linked.issue.ref }),
      title: linked.issue.title,
    });
  }
  if (linked.pr) {
    cloned.pr = Object.freeze({
      ref: Object.freeze({ ...linked.pr.ref }),
      title: linked.pr.title,
      url: linked.pr.url,
      state: linked.pr.state,
      ...(linked.pr.ciStatus ? { ciStatus: linked.pr.ciStatus } : {}),
      ...(linked.pr.baseRef ? { baseRef: linked.pr.baseRef } : {}),
    });
  }

  return Object.freeze(cloned);
}
