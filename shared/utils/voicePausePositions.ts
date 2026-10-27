/**
 * Where the speaker paused, carried from the provider's transcript to the
 * cleanup request as character positions (#14897). A position sits straight
 * after the word before the pause, its punctuation included and any space
 * after it left out, so it stays on that word however the space around it
 * changes. Like the unsure words, each hop keeps positions, never text.
 */
import type { VoiceTextEdit } from "./voiceUncertainWords.js";

const SPACE_RE = /\s/;
// The same split the main process makes a completion's pieces with.
const LINE_SPLIT_RE = /\s*\n\s*/g;

/**
 * The positions in `text`, each moved back over the space before it, sorted
 * and without repeats. One that comes back to 0 has no word of its own before
 * it: it marks a pause after whatever came before `text`.
 */
export function normalizePausePositions(text: string, positions: readonly number[]): number[] {
  const placed = new Set<number>();
  for (const position of positions) {
    if (!Number.isInteger(position)) continue;
    let at = Math.min(Math.max(position, 0), text.length);
    while (at > 0 && SPACE_RE.test(text[at - 1]!)) at--;
    placed.add(at);
  }
  return [...placed].sort((a, b) => a - b);
}

/** Moves every position by `delta`. */
export function shiftPausePositions(positions: readonly number[], delta: number): number[] {
  return positions.map((position) => position + delta);
}

/**
 * The positions after `from` up to and including `to`, relative to `from`. A
 * pause on the edge between two slices ends the words before it, so it goes
 * with the earlier one.
 */
export function slicePausePositions(
  positions: readonly number[],
  from: number,
  to: number
): number[] {
  return positions.flatMap((position) =>
    position > from && position <= to ? [position - from] : []
  );
}

/**
 * Carries positions through known edits, given in order and not overlapping.
 * An edit before a position moves it, and one that ends at it leaves it at the
 * end of what the edit wrote. One that rewrote words around it leaves it at
 * the end of the rewrite too, since nothing in it can say where the pause
 * fell; an insertion right at it goes after it.
 */
export function carryPausePositionsThroughEdits(
  positions: readonly number[],
  edits: readonly VoiceTextEdit[]
): number[] {
  if (edits.length === 0) return [...positions];
  return positions.map((position) => {
    let delta = 0;
    for (const edit of edits) {
      if (edit.from >= position) break;
      if (edit.to > position) return edit.from + delta + edit.insert.length;
      delta += edit.insert.length - (edit.to - edit.from);
    }
    return position + delta;
  });
}

/**
 * The positions of each piece `text.split(/\s*\n\s*\/)` makes once trimmed,
 * relative to that piece. Normalized positions always end some piece's word,
 * so only one at 0 belongs to none.
 */
export function splitPausePositionsByLine(text: string, positions: readonly number[]): number[][] {
  const pieces: number[][] = [];
  const take = (from: number, to: number) => {
    const slice = text.slice(from, to);
    const lead = slice.length - slice.trimStart().length;
    pieces.push(slicePausePositions(positions, from + lead, from + slice.trimEnd().length));
  };
  let start = 0;
  for (const match of text.matchAll(LINE_SPLIT_RE)) {
    take(start, match.index);
    start = match.index + match[0].length;
  }
  take(start, text.length);
  return pieces;
}
