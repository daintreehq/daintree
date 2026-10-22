import type { PluginWorktreeLinked } from "../types/plugin.js";
import type { IssueLinkTarget } from "../types/ipc/forge.js";
import type { IssueProvenance } from "../types/ipc/worktree.js";
import { BUILTIN_GITHUB_PROVIDER_ID, normalizeProviderId } from "./forgeProviderIds.js";

/**
 * Whether a worktree's detected issue number is really its linked PR's number
 * (#12381). GitHub gives issues and pull requests one number space per
 * repository, so a linked GitHub PR carrying the number proves no issue by that
 * number exists — a folder named `issue-12189` named the PR. Other forges number
 * the two separately (GitLab `#12` vs `!12`), and a linked issue is an explicit
 * association rather than a parse, so neither ever counts as a collision.
 *
 * `issueProviderId` is the number's owner when an issues provider claimed it
 * (#13744). A tracker's `ENG-42` shares no number space with the GitHub PR #42,
 * so only a number GitHub itself owns can collide.
 */
export function issueNumberBelongsToLinkedPr(
  issueNumber: number | undefined,
  linked: PluginWorktreeLinked | null | undefined,
  issueProviderId?: string
): boolean {
  if (issueNumber === undefined || !linked?.pr || linked.issue) return false;
  if (linked.pr.ref.number !== issueNumber) return false;
  if (issueProviderId && normalizeProviderId(issueProviderId) !== BUILTIN_GITHUB_PROVIDER_ID) {
    return false;
  }
  return normalizeProviderId(linked.providerId) === BUILTIN_GITHUB_PROVIDER_ID;
}

/**
 * The {@link IssueLinkTarget} every read of a worktree's issue takes (#13744):
 * the link's own provider when it carries provenance, else the code forge — a
 * number without provenance is always the code forge's, whichever tracker the
 * project binds for issues now.
 */
export function worktreeIssueLinkTarget(link: IssueProvenance): IssueLinkTarget {
  if (!link.issueProviderId) return { role: "code" };
  return {
    issueProviderId: link.issueProviderId,
    ...(link.issueId ? { issueId: link.issueId } : {}),
    ...(link.issueKey ? { issueKey: link.issueKey } : {}),
  };
}
