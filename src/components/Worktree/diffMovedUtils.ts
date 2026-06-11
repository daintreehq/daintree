import { getChangeKey } from "react-diff-view";
import type { ChangeData, HunkData } from "react-diff-view";

/**
 * Client-side equivalent of `git diff --color-moved`, with
 * `--color-moved-ws=allow-indentation-change` semantics: find blocks of
 * deleted lines that reappear as added lines elsewhere in the file — verbatim,
 * or re-indented by the same uniform prefix across the whole run (the
 * moved-into-a-block case: wrapping code in a conditional re-indents every
 * line identically). Anything beyond a shared pure-prefix indentation change
 * breaks the run, so unrelated whitespace edits never pair. A matched run
 * only qualifies when it carries at least MIN_MOVED_ALNUM alphanumeric
 * characters (git's MIN_ALNUM_COUNT), so trivial lines like lone braces never
 * light up as moves.
 */
const MIN_MOVED_ALNUM = 20;

/** Skip detection on pathological diffs; cost is O(inserts × candidates). */
const MAX_DETECTION_CHANGES = 4000;

/** Lines with this many duplicates are too common to anchor a run. */
const MAX_CANDIDATES_PER_LINE = 64;

const EMPTY_SET: ReadonlySet<string> = new Set();

const INDENT_RE = /^[ \t]*/;

function splitIndent(content: string): [indent: string, rest: string] {
  const indent = INDENT_RE.exec(content)?.[0] ?? "";
  return [indent, content.slice(indent.length)];
}

/**
 * Uniform indentation delta between a deleted line and its inserted
 * counterpart: "" when identical, "+<prefix>" / "-<prefix>" when the inserted
 * side gained/lost a leading prefix, null when the indents aren't related by
 * a pure prefix (e.g. tabs swapped for spaces).
 */
function indentDelta(delIndent: string, insIndent: string): string | null {
  if (delIndent === insIndent) return "";
  if (insIndent.length > delIndent.length && insIndent.endsWith(delIndent)) {
    return `+${insIndent.slice(0, insIndent.length - delIndent.length)}`;
  }
  if (delIndent.length > insIndent.length && delIndent.endsWith(insIndent)) {
    return `-${delIndent.slice(0, delIndent.length - insIndent.length)}`;
  }
  return null;
}

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

  const deleteParts = deletes.map((change) => splitIndent(change.content));
  const insertParts = inserts.map((change) => splitIndent(change.content));

  // Indexed by indent-stripped content so re-indented copies still surface
  // as candidates; the per-run uniform-delta check below decides pairing.
  const deleteIndexesByRest = new Map<string, number[]>();
  deleteParts.forEach(([, rest], d) => {
    const list = deleteIndexesByRest.get(rest);
    if (list) list.push(d);
    else deleteIndexesByRest.set(rest, [d]);
  });

  const matchedDeletes = new Array<boolean>(deletes.length).fill(false);
  const moved = new Set<string>();

  let i = 0;
  while (i < inserts.length) {
    const anchor = insertParts[i];
    // Runs anchor on a substantive line; blanks may extend a run but not start one.
    if (!anchor || !anchor[1].trim()) {
      i++;
      continue;
    }
    const candidates = deleteIndexesByRest.get(anchor[1]);
    if (!candidates || candidates.length > MAX_CANDIDATES_PER_LINE) {
      i++;
      continue;
    }

    let bestStart = -1;
    let bestLength = 0;
    let bestDelta: string | null = null;
    for (const d of candidates) {
      const candidate = deleteParts[d];
      if (!candidate || matchedDeletes[d]) continue;
      const delta = indentDelta(candidate[0], anchor[0]);
      if (delta === null) continue;
      let length = 0;
      for (;;) {
        const ins = insertParts[i + length];
        const del = deleteParts[d + length];
        if (!ins || !del || matchedDeletes[d + length]) break;
        if (!ins[1].trim() && !del[1].trim()) {
          // Whitespace-only lines extend a run regardless of their indent.
          length++;
          continue;
        }
        if (ins[1] !== del[1] || indentDelta(del[0], ins[0]) !== delta) break;
        length++;
      }
      // Longest run wins; on ties an exact (un-re-indented) match is the
      // stronger claim.
      if (length > bestLength || (length === bestLength && delta === "" && bestDelta !== "")) {
        bestLength = length;
        bestStart = d;
        bestDelta = delta;
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
