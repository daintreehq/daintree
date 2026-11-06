import type { WorktreeSnapshot } from "@shared/types";

export function sortWorktreesForComparison(
  worktrees: Iterable<WorktreeSnapshot>
): WorktreeSnapshot[] {
  return Array.from(worktrees).sort((a, b) => {
    if (a.isMainWorktree && !b.isMainWorktree) return -1;
    if (!a.isMainWorktree && b.isMainWorktree) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * The comparison is branch against branch, so the branch is what an option
 * names. A detached worktree has none to compare and is offered disabled
 * rather than accepted and silently ignored.
 */
export function worktreeOptionLabel(wt: WorktreeSnapshot): string {
  if (!wt.branch) return `${wt.name} (detached)`;
  return wt.isMainWorktree ? `${wt.branch} (main worktree)` : wt.branch;
}

/**
 * Unchanged lines asked for when the compare side's file text is wanted:
 * enough that git emits the whole file as one hunk.
 */
export const WHOLE_FILE_CONTEXT_LINES = 100_000;

/**
 * The compare side's committed text, read back out of a diff generated with
 * whole-file context: every context and added line, in order. Comes from the
 * same refs as the patch on screen rather than from a checkout that may carry
 * uncommitted edits. Null when the diff isn't one hunk covering the file from
 * its first line (a sentinel, a binary file, a file longer than the context).
 */
export function committedSourceFromFullDiff(diff: string): string | null {
  const lines = diff.split("\n");
  const header = lines.findIndex((line) => line.startsWith("@@"));
  if (header === -1) return null;
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[header] ?? "");
  if (!match || (match[1] !== "1" && match[1] !== "0")) return null;
  const body = lines.slice(header + 1);
  // A content line always carries a prefix, so a second header is a real one.
  if (body.some((line) => line.startsWith("@@"))) return null;
  const source: string[] = [];
  for (const line of body) {
    // "-" lines are the base side's; "\" marks a missing final newline.
    if (line.startsWith(" ") || line.startsWith("+")) source.push(line.slice(1));
  }
  return source.join("\n");
}
