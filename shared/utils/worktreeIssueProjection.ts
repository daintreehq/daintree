import type { PluginWorktreeLinked } from "../types/plugin.js";
import { BUILTIN_GITHUB_PROVIDER_ID, normalizeProviderId } from "./forgeProviderIds.js";

/**
 * Whether a worktree's detected issue number is really its linked PR's number
 * (#12381). GitHub gives issues and pull requests one number space per
 * repository, so a linked GitHub PR carrying the number proves no issue by that
 * number exists — a folder named `issue-12189` named the PR. Other forges number
 * the two separately (GitLab `#12` vs `!12`), and a linked issue is an explicit
 * association rather than a parse, so neither ever counts as a collision.
 */
export function issueNumberBelongsToLinkedPr(
  issueNumber: number | undefined,
  linked: PluginWorktreeLinked | null | undefined
): boolean {
  if (issueNumber === undefined || !linked?.pr || linked.issue) return false;
  if (linked.pr.ref.number !== issueNumber) return false;
  return normalizeProviderId(linked.providerId) === BUILTIN_GITHUB_PROVIDER_ID;
}
