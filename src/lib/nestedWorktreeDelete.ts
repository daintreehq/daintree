import {
  findNestedWorktreePaths,
  nestedWorktreeDeleteMessage,
} from "@shared/utils/nestedWorktrees";
import { isMac, isWindows } from "@/lib/platform";

/**
 * The host refuses to delete a worktree with a registered worktree nested
 * inside it (#12789), and that refusal is what protects the files. This one
 * runs first so a delete the host will refuse doesn't close the user's
 * terminals or stop their dev server on the way. Prunable entries are skipped
 * the way the host skips a nested folder that is already gone.
 */
export function nestedWorktreeDeleteRefusal(
  targetPath: string,
  worktrees: Iterable<{ path: string; isPrunable?: boolean }>
): string | null {
  const candidates: string[] = [];
  for (const worktree of worktrees) {
    if (!worktree.isPrunable) candidates.push(worktree.path);
  }
  const nested = findNestedWorktreePaths(targetPath, candidates, {
    caseInsensitive: isMac() || isWindows(),
  });
  return nested.length > 0 ? nestedWorktreeDeleteMessage(nested) : null;
}
