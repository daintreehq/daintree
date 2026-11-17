import type { BranchInfo, CreateWorktreeOptions } from "@shared/types";
import type { PR } from "@shared/types/forge";
import { extractClosingIssueNumber } from "./closingIssueRef";

/**
 * The remote-tracking branch that carries a PR's head, or undefined when the
 * name can't be trusted to identify it.
 *
 * Any remote may carry the head — on a fork layout the forge is `upstream`,
 * not `origin` (#11747). Matched as an exact `<remote>/<headRef>` rather than a
 * suffix, so a head named `x` can't match `origin/feature/x`.
 *
 * A branch name is not a PR identity. When two remotes both carry the name
 * they may be different commits, and nothing here can tell which repo the PR
 * belongs to, so picking either could build the worktree from the wrong
 * commit. The caller falls through to the PR-number fetch, which is
 * authoritative. One match is unambiguous enough to keep the fast path.
 */
export function findUnambiguousPrRemoteBranch(
  branches: readonly BranchInfo[],
  headRef: string
): BranchInfo | undefined {
  const candidates = branches.filter((b) => b.remote && b.name === `${b.remote}/${headRef}`);
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Collapse the normalized forge PR state to the workspace-host form (declined folds into closed). */
export function normalizeSourcePrState(state: PR["state"]): "open" | "closed" | "merged" {
  switch (state) {
    case "merged":
      return "merged";
    case "closed":
    case "declined":
      return "closed";
    default:
      return "open";
  }
}

/**
 * Worktree-create options that capture the source PR so the host seeds the
 * worktree's linked PR (and closing issue) eagerly instead of waiting for
 * branch-name polling to rediscover it (#8888). Every path that creates a
 * worktree from a PR spreads this, so the card headline and PR badge don't
 * depend on which entry point made it.
 */
export function buildSourcePrOptions(
  pr: Pick<PR, "number" | "title" | "url" | "state" | "body">
): Pick<
  CreateWorktreeOptions,
  "sourcePrNumber" | "sourcePrTitle" | "sourcePrUrl" | "sourcePrState" | "sourcePrLinkedIssueNumber"
> {
  return {
    sourcePrNumber: pr.number,
    sourcePrTitle: pr.title,
    sourcePrUrl: pr.url,
    sourcePrState: normalizeSourcePrState(pr.state),
    sourcePrLinkedIssueNumber: extractClosingIssueNumber(pr.body),
  };
}
