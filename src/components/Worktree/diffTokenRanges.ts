import type { ChangeData, HunkData, RangeTokenNode } from "react-diff-view";

/**
 * Range builders for the `pickRanges` tokenize enhancer. Ranges are keyed by
 * 1-based file line numbers per side: old ranges by old line numbers, new
 * ranges by new line numbers (normal lines exist on both sides).
 */
export interface SideRanges {
  old: RangeTokenNode[];
  new: RangeTokenNode[];
}

/** Token-tree growth guard for pathological queries (e.g. one space). */
const MAX_SEARCH_MATCHES = 2000;

function oldLineOf(change: ChangeData): number | undefined {
  return change.type === "delete" ? change.lineNumber : change.oldLineNumber;
}

function newLineOf(change: ChangeData): number | undefined {
  return change.type === "insert" ? change.lineNumber : change.newLineNumber;
}

/**
 * Case-insensitive plain-text matches of `query` across every rendered line.
 * Returns null when the query is empty or only matches nothing. Matches past
 * MAX_SEARCH_MATCHES are dropped (the highlight layer caps; counts shown to
 * the user come from the rendered DOM, so they stay consistent).
 */
export function computeSearchRanges(hunks: HunkData[], query: string): SideRanges | null {
  if (!query) return null;
  const needle = query.toLowerCase();
  const ranges: SideRanges = { old: [], new: [] };
  let total = 0;

  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      const haystack = change.content.toLowerCase();
      let index = haystack.indexOf(needle);
      while (index !== -1 && total < MAX_SEARCH_MATCHES) {
        const node = {
          type: "search",
          start: index,
          length: needle.length,
          className: "diff-search-match",
        };
        const oldLine = change.type !== "insert" ? oldLineOf(change) : undefined;
        const newLine = change.type !== "delete" ? newLineOf(change) : undefined;
        if (oldLine !== undefined) ranges.old.push({ ...node, lineNumber: oldLine });
        if (newLine !== undefined) ranges.new.push({ ...node, lineNumber: newLine });
        total++;
        index = haystack.indexOf(needle, index + needle.length);
      }
      if (total >= MAX_SEARCH_MATCHES) break;
    }
    if (total >= MAX_SEARCH_MATCHES) break;
  }

  return total > 0 ? ranges : null;
}

/**
 * Trailing whitespace on added lines (the classic lint git highlights in
 * red). Whitespace-only lines are skipped — flagging an indented blank line
 * is noise, not signal.
 */
export function computeTrailingWsRanges(hunks: HunkData[]): RangeTokenNode[] {
  const ranges: RangeTokenNode[] = [];
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "insert" || change.lineNumber === undefined) continue;
      const match = /[ \t]+$/.exec(change.content);
      if (!match || match.index === 0) continue;
      ranges.push({
        type: "trailing-ws",
        lineNumber: change.lineNumber,
        start: match.index,
        length: match[0].length,
        className: "diff-ws-trailing",
      });
    }
  }
  return ranges;
}
