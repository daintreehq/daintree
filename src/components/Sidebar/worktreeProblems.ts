import { visibleAttachmentChips } from "@/components/Worktree/WorktreeCard/attachmentState";
import { deriveSetupAlarm } from "@/components/Worktree/WorktreeCard/setupAlarm";
import type { DerivedWorktreeMeta } from "@/lib/worktreeFilters";
import type { WorktreeState } from "@/types";

export type WorktreeProblemTone = "error" | "warning";

/**
 * Whether a worktree reports something broken that no agent is asking about:
 * a merge conflict, failing CI on a live PR, a failed or unapproved setup, a
 * failed attachment, a failed sign-in to the forge. The same causes the card
 * raises in its title-row attention column, read straight off the worktree so
 * the offscreen bands can count rows that are not mounted.
 */
export function worktreeProblemTone(
  worktree: WorktreeState,
  meta: DerivedWorktreeMeta | undefined
): WorktreeProblemTone | null {
  if (meta?.hasMergeConflict) return "error";
  const pr = worktree.linked?.pr;
  const prLive =
    pr !== undefined && pr !== null && pr.state !== "closed" && pr.state !== "declined";
  if (prLive && pr.ciStatus?.state === "failure") return "error";
  const setup = deriveSetupAlarm(worktree, null, worktree.lifecycleStatus?.state === "running");
  if (setup) return setup.tone;
  if (visibleAttachmentChips(worktree.attachments).some((chip) => chip.state.tone === "error")) {
    return "error";
  }
  // Only where the card itself raises it: a sign-in failure against a forge.
  if (
    worktree.fetchAuthFailed &&
    (worktree.matchedForgeProviderId != null || worktree.linked?.providerId != null)
  ) {
    return "warning";
  }
  return null;
}
