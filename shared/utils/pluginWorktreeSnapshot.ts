import type {
  PluginWorktreeLinked,
  PluginWorktreeLinkedIssue,
  PluginWorktreeLinkedPR,
  PluginWorktreeSnapshot,
} from "../types/plugin.js";
import type { NormalizedPRState, ResourceRef } from "../types/forge.js";
import type { WorktreeSnapshot } from "../types/workspace-host.js";
import { BUILTIN_GITHUB_PROVIDER_ID } from "./forgeProviderIds.js";

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
