import type { HunkData, HunkTokens, TokenNode } from "react-diff-view";

/**
 * Rows committed per staged slice. A slice is one React commit plus the style
 * and layout it triggers, so this bounds the longest frame a giant hunk can
 * cost. Chosen from Chromium measurements of 5,000-row tables (#15677): 200
 * kept every slice of an added file under the 50 ms long-frame line, where
 * 400 and 800 let the full-file split view's slices reach 90-115 ms.
 */
export const DIFF_ROW_BATCH = 200;

/**
 * Whether a set of this many rows is staged at all. A set within one batch
 * renders in full on its first commit, exactly as an unstaged table would.
 */
export function shouldStageRows(rows: number): boolean {
  return rows > DIFF_ROW_BATCH;
}

/** Rows a hunk set renders, counted in changes (the unit a hunk is sliced by). */
export function countHunkRows(hunks: readonly HunkData[]): number {
  let rows = 0;
  for (const hunk of hunks) rows += hunk.changes.length;
  return rows;
}

/**
 * The prefix of `hunks` holding at most `budget` changes: whole hunks while
 * they fit, then the start of the hunk that doesn't. Returns `hunks` itself
 * when everything fits, so a finished stage hands the table the same array it
 * would have had without staging.
 *
 * Split view draws a delete and the insert straight after it on one row
 * (react-diff-view's `groupElements`), so a cut never lands between them: the
 * slice takes the insert too rather than drawing half a row that the next slice
 * would redraw paired.
 */
export function sliceHunksToRowBudget(hunks: HunkData[], budget: number): HunkData[] {
  if (budget >= countHunkRows(hunks)) return hunks;
  const out: HunkData[] = [];
  let remaining = Math.max(0, budget);
  for (const hunk of hunks) {
    if (remaining <= 0) break;
    if (hunk.changes.length <= remaining) {
      out.push(hunk);
      remaining -= hunk.changes.length;
      continue;
    }
    let cut = remaining;
    if (hunk.changes[cut - 1]?.type === "delete" && hunk.changes[cut]?.type === "insert") cut++;
    out.push({ ...hunk, changes: hunk.changes.slice(0, cut) });
    break;
  }
  return out;
}

function lineCount(lines: readonly unknown[] | undefined): number {
  return lines?.length ?? 0;
}

/**
 * Tokens for the first `budget` rows from `target`, the rest from `base` (the
 * pass already on screen, or nothing). Each row keeps the exact per-line token
 * array it would get from either pass, so react-diff-view's memoized rows only
 * re-render where the line actually changed hands; rows with no tokens get an
 * explicit `null`, the same value they see when the table has no tokens at all.
 */
export function stageTokens(
  hunks: readonly HunkData[],
  target: HunkTokens,
  base: HunkTokens | null,
  budget: number
): HunkTokens {
  const size = (side: "old" | "new") =>
    Math.max(lineCount(target[side]), lineCount(base?.[side]));
  const old: (TokenNode[] | null)[] = new Array<TokenNode[] | null>(size("old")).fill(null);
  const next: (TokenNode[] | null)[] = new Array<TokenNode[] | null>(size("new")).fill(null);
  let row = 0;
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      const from = row < budget ? target : base;
      row++;
      if (!from) continue;
      if (change.type === "insert") {
        next[change.lineNumber - 1] = from.new[change.lineNumber - 1] ?? null;
      } else if (change.type === "delete") {
        old[change.lineNumber - 1] = from.old[change.lineNumber - 1] ?? null;
      } else {
        old[change.oldLineNumber - 1] = from.old[change.oldLineNumber - 1] ?? null;
        next[change.newLineNumber - 1] = from.new[change.newLineNumber - 1] ?? null;
      }
    }
  }
  return { old: old as TokenNode[][], new: next as TokenNode[][] };
}
