/**
 * The merged-worktree rule (#17321): a project's opt-in to have the worktrees
 * Daintree created removed once their PR has merged and they hold nothing to
 * lose. Every field here is something read from git, the forge, or the app's
 * own records at the time of the read; nothing is inferred from agent state.
 */

/** How long after the forge's `mergedAt` a worktree becomes removable. Fixed, not a setting. */
export const MERGED_WORKTREE_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Why a worktree isn't removable. `unverified` is a read that couldn't answer
 * (git, the forge, the terminal census, the saved layout), which always leaves
 * the worktree alone.
 */
export type MergedWorktreeSkipReason =
  | "detached"
  | "missing"
  | "not-created-by-daintree"
  | "has-changes"
  | "has-terminals"
  | "has-panels"
  | "active"
  | "no-pr"
  | "pr-not-merged"
  | "head-moved"
  | "teardown"
  | "submodules"
  | "removal-pending"
  | "unverified";

export interface MergedWorktreePR {
  number: number;
  title: string;
  url: string;
  /** The forge's merge time, ms since epoch. Absent until the PR is read as merged. */
  mergedAt?: number;
}

/**
 * One linked worktree as the rule reads it now. `removable` means the next
 * sweep would remove it; `waiting` means only the grace period stands in the
 * way, until `removableAt`.
 */
export type MergedWorktreeCandidate =
  | {
      worktreePath: string;
      branch: string;
      status: "removable";
      pr: MergedWorktreePR & { mergedAt: number };
      /** The commit the worktree is on, which is the one the PR merged. */
      head: string;
    }
  | {
      worktreePath: string;
      branch: string;
      status: "waiting";
      pr: MergedWorktreePR & { mergedAt: number };
      head: string;
      removableAt: number;
    }
  | {
      worktreePath: string;
      branch: string | null;
      status: "skipped";
      reason: MergedWorktreeSkipReason;
      pr?: MergedWorktreePR;
      /** What failed, for `unverified`. */
      detail?: string;
    };

export interface MergedWorktreeCleanupPreview {
  enabled: boolean;
  checkedAt: number;
  /** Every linked worktree, main excluded. Empty when `error` is set. */
  worktrees: MergedWorktreeCandidate[];
  /** The worktree list itself couldn't be read, so nothing could be checked. */
  error?: string;
}

/** A removal the rule made, kept until a window has put it in the notification inbox. */
export interface MergedWorktreeRemovalReceipt {
  id: string;
  /**
   * Written before git is asked, so a removal whose answer is lost (a quit, a
   * host that died) is still accounted for on the next start. Never handed to
   * a view while set.
   */
  pending?: true;
  projectId: string;
  projectName: string;
  worktreePath: string;
  branch: string;
  prNumber: number;
  prUrl: string;
  removedAt: number;
}

export interface MergedWorktreeCleanupPreviewPayload {
  projectId: string;
}

export interface MergedWorktreeCleanupSetEnabledPayload {
  projectId: string;
  enabled: boolean;
}

export interface MergedWorktreeCleanupAckReceiptsPayload {
  ids: string[];
}
