import { getChangeKey } from "react-diff-view";
import type { ChangeData, HunkData } from "react-diff-view";

/**
 * Client-side equivalent of `git diff --color-moved`: find blocks of deleted
 * lines that reappear verbatim as added lines elsewhere in the same file, so
 * the viewer can style relocation differently from genuine add/remove churn.
 *
 * Matching is exact-content (git's default mode) — re-indented moves are NOT
 * detected, which avoids false positives on indentation-only changes. A
 * matched run only qualifies when it carries at least MIN_MOVED_ALNUM
 * alphanumeric characters (git's MIN_ALNUM_COUNT), so trivial lines like
 * lone braces never light up as moves.
 */
const MIN_MOVED_ALNUM = 20;

/** Skip detection on pathological diffs; cost is O(inserts × candidates). */
const MAX_DETECTION_CHANGES = 4000;

/** Lines with this many verbatim duplicates are too common to anchor a run. */
const MAX_CANDIDATES_PER_LINE = 64;

const EMPTY_SET: ReadonlySet<string> = new Set();

function countAlnum(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      count++;
    }
  }
  return count;
}

export function detectMovedLines(hunks: HunkData[]): ReadonlySet<string> {
  const deletes: ChangeData[] = [];
  const inserts: ChangeData[] = [];
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      if (change.type === "delete") deletes.push(change);
      else if (change.type === "insert") inserts.push(change);
    }
  }
  if (!deletes.length || !inserts.length) return EMPTY_SET;
  if (deletes.length + inserts.length > MAX_DETECTION_CHANGES) return EMPTY_SET;

  const deleteIndexesByContent = new Map<string, number[]>();
  deletes.forEach((change, d) => {
    const list = deleteIndexesByContent.get(change.content);
    if (list) list.push(d);
    else deleteIndexesByContent.set(change.content, [d]);
  });

  const matchedDeletes = new Array<boolean>(deletes.length).fill(false);
  const moved = new Set<string>();

  let i = 0;
  while (i < inserts.length) {
    const anchor = inserts[i];
    // Runs anchor on a substantive line; blanks may extend a run but not start one.
    if (!anchor || !anchor.content.trim()) {
      i++;
      continue;
    }
    const candidates = deleteIndexesByContent.get(anchor.content);
    if (!candidates || candidates.length > MAX_CANDIDATES_PER_LINE) {
      i++;
      continue;
    }

    let bestStart = -1;
    let bestLength = 0;
    for (const d of candidates) {
      if (matchedDeletes[d]) continue;
      let length = 0;
      for (;;) {
        const insert = inserts[i + length];
        const del = deletes[d + length];
        if (!insert || !del || matchedDeletes[d + length] || insert.content !== del.content) {
          break;
        }
        length++;
      }
      if (length > bestLength) {
        bestLength = length;
        bestStart = d;
      }
    }

    if (bestStart >= 0) {
      let alnum = 0;
      for (let k = 0; k < bestLength; k++) {
        alnum += countAlnum(inserts[i + k]?.content ?? "");
      }
      if (alnum >= MIN_MOVED_ALNUM) {
        for (let k = 0; k < bestLength; k++) {
          const del = deletes[bestStart + k];
          const insert = inserts[i + k];
          matchedDeletes[bestStart + k] = true;
          if (del) moved.add(getChangeKey(del));
          if (insert) moved.add(getChangeKey(insert));
        }
        i += bestLength;
        continue;
      }
    }
    i++;
  }

  return moved;
}
