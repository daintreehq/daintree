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
 * The branch a worktree can be compared by, or undefined when it has none. The
 * monitor keeps the last branch name on a snapshot whose HEAD has since been
 * detached, so the branch's presence alone would compare the old tip while the
 * checkout sits at another commit.
 */
export function comparableBranch(
  wt: Pick<WorktreeSnapshot, "branch" | "isDetached"> | null | undefined
): string | undefined {
  if (!wt || wt.isDetached) return undefined;
  return wt.branch || undefined;
}

/**
 * The comparison is branch against branch, so the branch is what an option
 * names. A detached worktree has none to compare and is offered disabled
 * rather than accepted and silently ignored.
 */
export function worktreeOptionLabel(wt: WorktreeSnapshot): string {
  const branch = comparableBranch(wt);
  if (!branch) return `${wt.name} (detached)`;
  return wt.isMainWorktree ? `${branch} (main worktree)` : branch;
}

export type ComparisonSide = "base" | "compare";

export type ComparisonBlocker =
  | { kind: "unchosen" }
  | { kind: "missing"; side: ComparisonSide }
  | { kind: "detached"; side: ComparisonSide; name: string }
  | { kind: "same-branch"; branch: string };

/**
 * Why the chosen pair can't be compared, or null when it can. A chosen side
 * that has since left the store or lost its branch is reported ahead of a side
 * not chosen yet: it is what explains a comparison that was on screen.
 */
export function comparisonBlocker(
  baseId: string | null,
  base: WorktreeSnapshot | null,
  compareId: string | null,
  compare: WorktreeSnapshot | null
): ComparisonBlocker | null {
  if (baseId && !base) return { kind: "missing", side: "base" };
  if (compareId && !compare) return { kind: "missing", side: "compare" };
  if (base && !comparableBranch(base)) return { kind: "detached", side: "base", name: base.name };
  if (compare && !comparableBranch(compare)) {
    return { kind: "detached", side: "compare", name: compare.name };
  }
  const baseBranch = comparableBranch(base);
  const compareBranch = comparableBranch(compare);
  if (!baseBranch || !compareBranch) return { kind: "unchosen" };
  if (baseBranch === compareBranch) return { kind: "same-branch", branch: baseBranch };
  return null;
}

/**
 * Unchanged lines asked for when the compare side's file text is wanted:
 * enough that git emits the whole file as one hunk.
 */
export const WHOLE_FILE_CONTEXT_LINES = 100_000;

/** The blob ids a single-file diff's `index` line names, as [base, compare]. */
function diffBlobIds(diff: string): [string, string] | null {
  const match = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/m.exec(diff);
  return match ? [match[1]!, match[2]!] : null;
}

/**
 * The compare side's committed text for `patch`, out of a whole-file diff of
 * the same file read separately. Each read resolves the branches on its own,
 * so a commit landing between them leaves the two describing different blobs,
 * and that source would reveal lines the patch never compared: the viewer's
 * hunk check only sees the lines both share. Null when they disagree; both
 * reads print full ids, and an abbreviation is never trusted as a prefix.
 */
export function committedSourceForPatch(fullDiff: string | null, patch: string): string | null {
  if (fullDiff === null) return null;
  const patchBlobs = diffBlobIds(patch);
  const fullBlobs = diffBlobIds(fullDiff);
  if (
    patchBlobs &&
    fullBlobs &&
    (patchBlobs[0] !== fullBlobs[0] || patchBlobs[1] !== fullBlobs[1])
  ) {
    return null;
  }
  return committedSourceFromFullDiff(fullDiff);
}

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
