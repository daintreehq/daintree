import path from "node:path";
import type { PR } from "../../../shared/types/forge.js";
import {
  MERGED_WORKTREE_GRACE_MS,
  type MergedWorktreeCandidate,
  type MergedWorktreePR,
  type MergedWorktreeSkipReason,
} from "../../../shared/types/mergedWorktreeCleanup.js";
import { isPathInside, pathComparisonKey } from "../../../shared/utils/path.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { WorktreeStatusObservation } from "../git/worktreeStatusObservation.js";
import type { WorktreeCreationStamp } from "../../utils/worktreeCreationStamp.js";

export interface ListedWorktree {
  path: string;
  branch: string;
  bare: boolean;
  isMainWorktree: boolean;
}

/**
 * The panels a project's saved layout holds, by the worktree, folder and
 * worktree git directory each was opened in (the last survives a
 * `git worktree move` that left the other two stale).
 */
export interface SavedLayout {
  panels: ReadonlyArray<{ worktreeId?: string; cwd?: string; worktreeGitDir?: string }>;
  activeWorktreeId?: string;
}

/** Why the project's workspace host would refuse the removal, read without changing anything. */
export type HostRefusal = "teardown" | "submodules";

/**
 * The two PR reads the rule needs from the project's code forge. A sweep's
 * `getPR` reads past every cache, since it acts on the answer; a dry run's
 * may take the provider's cached copy.
 */
export interface MergedWorktreeForge {
  findPRByBranch(branch: string): Promise<PR | null>;
  getPR(prNumber: number): Promise<PR | null>;
}

/** Every read the evaluation makes, so each can fail closed on its own. */
export interface MergedWorktreeReads {
  pathExists(worktreePath: string): Promise<boolean>;
  readGitDir(worktreePath: string): Promise<string>;
  readStamp(gitDir: string): Promise<WorktreeCreationStamp | null>;
  readStatus(worktreePath: string): Promise<WorktreeStatusObservation>;
  /**
   * How many terminal records, exited and trashed ones included, sit in the
   * worktree, and whether every record could be placed. Rejects when the
   * census itself is partial.
   */
  countTerminals(worktreePath: string): Promise<{ count: number; complete: boolean }>;
  /** Rejects when the saved layout couldn't be read in full. */
  readSavedLayout(): Promise<SavedLayout | null>;
  /** Rejects when the project's forge can't be reached or resolved. */
  resolveForge(): Promise<MergedWorktreeForge>;
  /**
   * The host's own refusal for a worktree that otherwise qualifies, so a dry
   * run doesn't list one the host will turn down every time. Null when the
   * host would go ahead, or when no host is running to ask; the removal
   * itself is checked by the host either way.
   */
  readHostRefusal?(worktreePath: string): Promise<HostRefusal | null>;
  now(): number;
}

const FULL_OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function skipped(
  worktree: ListedWorktree,
  reason: MergedWorktreeSkipReason,
  extra: { pr?: MergedWorktreePR; detail?: string } = {}
): MergedWorktreeCandidate {
  return {
    worktreePath: path.resolve(worktree.path),
    branch: worktree.branch || null,
    status: "skipped",
    reason,
    ...extra,
  };
}

function unverified(worktree: ListedWorktree, error: unknown, pr?: MergedWorktreePR) {
  return skipped(worktree, "unverified", {
    ...(pr ? { pr } : {}),
    detail: formatErrorMessage(error, "read failed"),
  });
}

/**
 * The local half: everything that needs no network. Returns the observed HEAD
 * for a worktree that passes, or the verdict for one that doesn't.
 */
async function checkLocal(
  worktree: ListedWorktree,
  reads: MergedWorktreeReads,
  layout: () => Promise<SavedLayout | null>
): Promise<{ headOid: string } | MergedWorktreeCandidate> {
  if (!worktree.branch) return skipped(worktree, "detached");
  const worktreePath = path.resolve(worktree.path);
  try {
    if (!(await reads.pathExists(worktreePath))) return skipped(worktree, "missing");
    const gitDir = await reads.readGitDir(worktreePath);
    const stamp = await reads.readStamp(gitDir);
    if (stamp === null) return skipped(worktree, "not-created-by-daintree");

    const status = await reads.readStatus(worktreePath);
    if (status.branch !== worktree.branch || status.headOid === null) {
      return skipped(worktree, "unverified", {
        detail: "git reported a different branch than the worktree list",
      });
    }
    const outstanding =
      status.staged +
      status.unstaged +
      status.untracked +
      status.conflicted +
      status.hiddenFromStatus;
    if (outstanding > 0) return skipped(worktree, "has-changes");

    const terminals = await reads.countTerminals(worktreePath);
    if (terminals.count > 0) return skipped(worktree, "has-terminals");
    if (!terminals.complete) {
      return skipped(worktree, "unverified", {
        detail: "some terminals couldn't be placed in a worktree",
      });
    }

    const saved = await layout();
    const compare = { caseInsensitive: process.platform === "win32" };
    const key = pathComparisonKey(worktreePath, compare);
    const gitDirKey = pathComparisonKey(gitDir, compare);
    if (saved?.activeWorktreeId && pathComparisonKey(saved.activeWorktreeId, compare) === key) {
      return skipped(worktree, "active");
    }
    const hasPanel = (saved?.panels ?? []).some(
      (panel) =>
        (panel.worktreeId !== undefined && pathComparisonKey(panel.worktreeId, compare) === key) ||
        (panel.worktreeGitDir !== undefined &&
          pathComparisonKey(panel.worktreeGitDir, compare) === gitDirKey) ||
        (panel.cwd !== undefined && isPathInside(pathComparisonKey(panel.cwd, compare), key))
    );
    if (hasPanel) return skipped(worktree, "has-panels");

    return { headOid: status.headOid };
  } catch (error) {
    return unverified(worktree, error);
  }
}

function toCandidatePR(pr: PR): MergedWorktreePR {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    ...(typeof pr.mergedAt === "number" && Number.isFinite(pr.mergedAt)
      ? { mergedAt: pr.mergedAt }
      : {}),
  };
}

/**
 * The forge half: the PR the branch opened must have merged, from
 * exactly the commit the worktree is on, more than the grace period ago by the
 * forge's own clock. A squash-merged PR whose head branch was deleted still
 * reports its head commit, so this holds where "on some remote ref" can't.
 */
async function checkForge(
  worktree: ListedWorktree,
  headOid: string,
  forge: MergedWorktreeForge,
  now: number
): Promise<MergedWorktreeCandidate> {
  let candidatePR: MergedWorktreePR | undefined;
  try {
    const found = await forge.findPRByBranch(worktree.branch);
    if (found === null) return skipped(worktree, "no-pr");
    const pr = await forge.getPR(found.number);
    if (pr === null) {
      return skipped(worktree, "unverified", { detail: "the forge didn't return the PR" });
    }
    candidatePR = toCandidatePR(pr);
    if (pr.headRef !== worktree.branch) {
      return skipped(worktree, "unverified", {
        pr: candidatePR,
        detail: "the PR's head branch isn't the worktree's",
      });
    }
    if (pr.state !== "merged" || pr.merged !== true) {
      return skipped(worktree, "pr-not-merged", { pr: candidatePR });
    }
    const headSha = pr.headSha?.toLowerCase();
    if (!headSha || !FULL_OID.test(headSha)) {
      return skipped(worktree, "unverified", {
        pr: candidatePR,
        detail: "the forge didn't report the commit the PR merged",
      });
    }
    if (headSha !== headOid.toLowerCase()) {
      return skipped(worktree, "head-moved", { pr: candidatePR });
    }
    const mergedAt = candidatePR.mergedAt;
    if (mergedAt === undefined) {
      return skipped(worktree, "unverified", {
        pr: candidatePR,
        detail: "the forge didn't report when the PR merged",
      });
    }
    const merged = { ...candidatePR, mergedAt };
    const removableAt = mergedAt + MERGED_WORKTREE_GRACE_MS;
    if (now < removableAt) {
      return {
        worktreePath: path.resolve(worktree.path),
        branch: worktree.branch,
        status: "waiting",
        pr: merged,
        head: headSha,
        removableAt,
      };
    }
    return {
      worktreePath: path.resolve(worktree.path),
      branch: worktree.branch,
      status: "removable",
      pr: merged,
      head: headSha,
    };
  } catch (error) {
    return unverified(worktree, error, candidatePR);
  }
}

async function checkHost(
  worktree: ListedWorktree,
  judged: MergedWorktreeCandidate,
  reads: MergedWorktreeReads
): Promise<MergedWorktreeCandidate> {
  if (!reads.readHostRefusal) return judged;
  const pr = judged.pr;
  try {
    const refusal = await reads.readHostRefusal(judged.worktreePath);
    return refusal === null ? judged : skipped(worktree, refusal, pr ? { pr } : {});
  } catch (error) {
    return unverified(worktree, error, pr);
  }
}

/**
 * Judge each of a project's linked worktrees against the rule. Every read
 * that can't answer leaves its worktree `unverified`, never removable. The
 * forge is resolved once, and only when some worktree passes the local
 * checks; a forge that can't be resolved leaves those worktrees unverified.
 */
export async function evaluateMergedWorktrees(
  worktrees: readonly ListedWorktree[],
  reads: MergedWorktreeReads
): Promise<MergedWorktreeCandidate[]> {
  let layoutRead: Promise<SavedLayout | null> | null = null;
  const layout = () => (layoutRead ??= reads.readSavedLayout());
  let forgeRead: Promise<MergedWorktreeForge> | null = null;
  const forge = () => (forgeRead ??= reads.resolveForge());

  const results: MergedWorktreeCandidate[] = [];
  for (const worktree of worktrees) {
    if (worktree.isMainWorktree || worktree.bare) continue;
    const local = await checkLocal(worktree, reads, layout);
    if (!("headOid" in local)) {
      results.push(local);
      continue;
    }
    let resolved: MergedWorktreeForge;
    try {
      resolved = await forge();
    } catch (error) {
      results.push(unverified(worktree, error));
      continue;
    }
    const judged = await checkForge(worktree, local.headOid, resolved, reads.now());
    results.push(judged.status === "skipped" ? judged : await checkHost(worktree, judged, reads));
  }
  return results;
}
