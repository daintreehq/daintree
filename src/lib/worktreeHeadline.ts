import type { Worktree, WorktreeState } from "@shared/types/worktree";
import { isStandardBranch } from "@shared/config/branchPrefixes";

/**
 * What a worktree row is called, as data rather than markup. The sidebar card
 * renders these four branches through its badges; `label` is the same headline
 * flattened to one line, for a surface too compact to draw a badge. Both come
 * from here so the two cannot drift apart.
 *
 * `label` is the one place the two intentionally differ: a row with nothing but
 * a blank branch reads as `"Untitled worktree"` rather than as empty, matching
 * the context menu. The card can afford to render nothing there because the
 * rest of the card still says which worktree it is; a one-line row cannot.
 */
export type WorktreeHeadline =
  | { kind: "pr"; number: number; title: string | undefined; label: string }
  | { kind: "issue"; number: number; title: string; label: string }
  | { kind: "main"; label: string }
  | { kind: "branch"; label: string };

/**
 * The branch name a worktree row shows, falling back to the worktree's own
 * name when there is no branch to show. Returned raw: callers that need a
 * non-empty string supply their own fallback, because inventing one here would
 * put words in the mouth of every caller that renders this verbatim.
 */
export function getWorktreeBranchLabel(worktree: Worktree | WorktreeState): string {
  // Detached HEAD keeps the pre-detach branch on the snapshot — a name the
  // worktree no longer has checked out — so main falls back to its own name.
  if (worktree.isMainWorktree && (!worktree.branch || worktree.isDetached)) {
    return worktree.name;
  }
  return worktree.branch ?? worktree.name;
}

/**
 * Main sitting on a standard branch, where the row names the project rather
 * than the branch — `main` on `main` says nothing the row does not already.
 */
export function isMainWorktreeOnStandardBranch(worktree: Worktree | WorktreeState): boolean {
  return !!(
    worktree.isMainWorktree &&
    worktree.branch &&
    !worktree.isDetached &&
    isStandardBranch(worktree.branch)
  );
}

export function getWorktreeHeadline(worktree: Worktree | WorktreeState): WorktreeHeadline {
  // PR-originated worktrees (created from the PR dropdown, #8888) invert the
  // default issue-first headline. `sourcePrNumber` is the in-memory
  // discriminator seeded at creation time, and the headline renders even before
  // the title has been fetched — the cold gap shows just "#NNN".
  const prNumber = worktree.sourcePrNumber;
  if (prNumber) {
    const title = worktree.linked?.pr?.title ?? worktree.prTitle;
    return {
      kind: "pr",
      number: prNumber,
      title,
      label: title ? `#${prNumber} ${title}` : `#${prNumber}`,
    };
  }

  // An issue headline needs both halves: a number with no title anywhere falls
  // through to the branch, rather than rendering a bare "#456".
  const issueNumber = worktree.issueNumber;
  const issueTitle = worktree.issueTitle ?? worktree.branchDerivedTitle;
  if (issueNumber && issueTitle) {
    return {
      kind: "issue",
      number: issueNumber,
      title: issueTitle,
      label: `#${issueNumber} ${issueTitle}`,
    };
  }

  if (isMainWorktreeOnStandardBranch(worktree)) {
    return { kind: "main", label: worktree.name };
  }

  return {
    kind: "branch",
    label: getWorktreeBranchLabel(worktree).trim() || "Untitled worktree",
  };
}
