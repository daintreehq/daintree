import type { Issue } from "@shared/types/forge";
import { getCurrentViewStore } from "@/store/createWorktreeStore";

/**
 * Persist an explicit link between a new worktree and the issue it was made
 * for, when that issue came from the project's issues provider rather than its
 * code forge (#13700 — the host stamps `providerId` only then).
 *
 * Without it the link rests on the branch name, which is read back as a code
 * forge number: a provider-suggested branch carries no `issue-N` to find, and
 * a fallback `issue-42-…` would name the code forge's #42. A no-op for
 * unstamped issues, so a project without an issues provider links exactly as
 * it always has.
 */
export function linkProviderIssue(worktreeId: string, issue: Issue | null | undefined): void {
  if (!issue?.providerId) return;
  getCurrentViewStore()
    .getState()
    .startAttachIssue({
      worktreeId,
      issueNumber: issue.number,
      issueTitle: issue.title,
      issueProviderId: issue.providerId,
      ...(issue.id ? { issueId: issue.id } : {}),
      ...(issue.key ? { issueKey: issue.key } : {}),
    });
}
