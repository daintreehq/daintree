import type { Issue } from "@shared/types/forge";
import type { AttachIssuePayload } from "@shared/types/ipc/worktree";
import { getCurrentViewStore } from "@/store/createWorktreeStore";

/**
 * The attach payload for linking `issue` to a worktree, carrying the issue's
 * provenance when an issues provider served it (#13700 — the host stamps
 * `providerId` only then). Unstamped issues produce the legacy shape exactly.
 */
export function issueAttachPayload(worktreeId: string, issue: Issue): AttachIssuePayload {
  return {
    worktreeId,
    issueNumber: issue.number,
    issueTitle: issue.title,
    ...(issue.providerId ? { issueProviderId: issue.providerId } : {}),
    ...(issue.providerId && issue.id ? { issueId: issue.id } : {}),
    ...(issue.providerId && issue.key ? { issueKey: issue.key } : {}),
  };
}

/**
 * Persist an explicit link between a new worktree and the issue it was made
 * for, when that issue came from the project's issues provider rather than its
 * code forge.
 *
 * Without it the link rests on the branch name, which is read back as a code
 * forge number: a provider-suggested branch carries no `issue-N` to find, and
 * a fallback `issue-42-…` would name the code forge's #42. A no-op for
 * unstamped issues, so a project without an issues provider links exactly as
 * it always has.
 */
export function linkProviderIssue(worktreeId: string, issue: Issue | null | undefined): void {
  if (!issue?.providerId) return;
  getCurrentViewStore().getState().startAttachIssue(issueAttachPayload(worktreeId, issue));
}
