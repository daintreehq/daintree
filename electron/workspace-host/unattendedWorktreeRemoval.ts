import { readWorktreeStatusObservation } from "../services/git/worktreeStatusObservation.js";
import type { UnattendedRemovalGuard } from "../../shared/types/workspace-host.js";

export type { UnattendedRemovalGuard };

/**
 * Re-read the checkout an unattended removal (#17321) is about to take and
 * refuse unless it is still exactly what main judged to lose nothing: on the
 * expected branch, at the commit the PR merged, with nothing staged, modified,
 * untracked, conflicted or hidden from status. Rejects when git can't answer.
 */
export async function verifyUnattendedCheckout(
  worktreePath: string,
  guard: UnattendedRemovalGuard,
  read: typeof readWorktreeStatusObservation = readWorktreeStatusObservation
): Promise<void> {
  const observed = await read(worktreePath);
  if (observed.branch !== guard.expectedBranch) {
    throw new Error("The worktree is no longer on the branch its PR merged");
  }
  if (observed.headOid !== guard.expectedHead) {
    throw new Error("The worktree's HEAD is not the commit its PR merged");
  }
  const outstanding =
    observed.staged +
    observed.unstaged +
    observed.untracked +
    observed.conflicted +
    observed.hiddenFromStatus;
  if (outstanding > 0) {
    throw new Error("The worktree has changes that aren't committed");
  }
}
