import { computeNewLineNumber, computeOldLineNumber } from "react-diff-view";
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

/**
 * Tokens for the first `budget` rows from `target`, the rest from `base` (the
 * pass already on screen, or nothing). Each row keeps the exact per-line token
 * array it would get from either pass, so react-diff-view's memoized rows only
 * re-render where the line actually changed hands. Lines with nothing to show
 * stay holes, which a row reads as `undefined` — the same value a staged table
 * hands every row before any pass arrives (see `useStagedDiffRows`), so a row
 * the cursor hasn't reached sees no prop change.
 */
export function stageTokens(
  hunks: readonly HunkData[],
  target: HunkTokens,
  base: HunkTokens | null,
  budget: number
): HunkTokens {
  const old: TokenNode[][] = [];
  const next: TokenNode[][] = [];
  let row = 0;
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      const from = row < budget ? target : base;
      row++;
      if (!from) continue;
      // The same line lookups react-diff-view's rows make for their token props.
      const oldLine = computeOldLineNumber(change);
      const newLine = computeNewLineNumber(change);
      const oldTokens = oldLine > 0 ? from.old[oldLine - 1] : undefined;
      const newTokens = newLine > 0 ? from.new[newLine - 1] : undefined;
      if (oldTokens) old[oldLine - 1] = oldTokens;
      if (newTokens) next[newLine - 1] = newTokens;
    }
  }
  return { old, new: next };
}
