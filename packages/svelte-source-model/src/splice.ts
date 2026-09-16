/**
 * The edit buffer.
 *
 * Every deterministic source change in the Site Builder is expressed as a set
 * of replacements over ranges of the *original* file, applied in one pass. That
 * shape is what keeps an edit source-preserving: whitespace, comments, quote
 * style and every unrelated byte outside the replaced ranges survive verbatim,
 * which whole-file AST printing cannot promise.
 *
 * Offsets are UTF-16 code-unit indices into the original string — the same
 * units Svelte's parser reports — and they always refer to the original, never
 * to a partially-edited intermediate. That is the property that lets several
 * independent replacements be planned against one parse and applied together.
 */

export interface Replacement {
  /** Inclusive start offset in the ORIGINAL source. */
  start: number;
  /** Exclusive end offset in the ORIGINAL source. `start === end` inserts. */
  end: number;
  text: string;
}

export type SpliceErrorCode = "OUT_OF_BOUNDS" | "INVERTED_RANGE" | "OVERLAPPING_RANGES";

export class SpliceError extends Error {
  readonly code: SpliceErrorCode;
  constructor(code: SpliceErrorCode, message: string) {
    super(message);
    this.name = "SpliceError";
    this.code = code;
  }
}

/**
 * Applies replacements to `source` and returns the new string.
 *
 * Rejects rather than guesses: a range outside the source, an inverted range,
 * or two ranges that overlap are all errors. Overlap is the important one — two
 * plans that both claim the same bytes mean the caller resolved a conflict
 * incorrectly, and silently letting the later one win is how a "change padding"
 * control quietly eats an unrelated class.
 *
 * Pure insertions (`start === end`) at the same offset are permitted and are
 * applied in the order given, because they claim no bytes and so cannot
 * contradict one another. An insertion at the boundary of a replaced range is
 * likewise allowed: touching is not overlapping.
 */
export function applyReplacements(source: string, replacements: readonly Replacement[]): string {
  if (replacements.length === 0) return source;

  for (const r of replacements) {
    if (r.end < r.start) {
      throw new SpliceError(
        "INVERTED_RANGE",
        `Replacement end ${r.end} precedes start ${r.start}.`
      );
    }
    if (r.start < 0 || r.end > source.length) {
      throw new SpliceError(
        "OUT_OF_BOUNDS",
        `Replacement [${r.start}, ${r.end}) falls outside source of length ${source.length}.`
      );
    }
  }

  // Stable sort by start, then by end, so an insertion at offset N is applied
  // before a replacement that begins at N and the caller's order is preserved
  // among insertions at the same point.
  const ordered = replacements
    .map((r, index) => ({ ...r, index }))
    .sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);

  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    // Zero-width ranges claim no bytes, so they can never overlap anything.
    const previousClaimsBytes = previous.end > previous.start;
    const currentClaimsBytes = current.end > current.start;
    if (previousClaimsBytes && currentClaimsBytes && current.start < previous.end) {
      throw new SpliceError(
        "OVERLAPPING_RANGES",
        `Replacement [${current.start}, ${current.end}) overlaps [${previous.start}, ${previous.end}).`
      );
    }
  }

  let out = "";
  let cursor = 0;
  for (const r of ordered) {
    if (r.start > cursor) out += source.slice(cursor, r.start);
    out += r.text;
    // A zero-width insertion must not rewind the cursor past bytes an earlier
    // replacement already consumed.
    cursor = Math.max(cursor, r.end);
  }
  out += source.slice(cursor);
  return out;
}

/**
 * True when applying `replacements` would leave `source` byte-identical.
 *
 * A no-op edit must not reach disk: it would churn the file's revision, wake
 * the dev server, and add a history entry the user cannot distinguish from a
 * real change.
 */
export function isNoOp(source: string, replacements: readonly Replacement[]): boolean {
  return replacements.every((r) => source.slice(r.start, r.end) === r.text);
}

/**
 * Converts a 1-indexed line and 0-indexed column — the shape Svelte's dev
 * runtime reports on `__svelte_meta.loc` — into a UTF-16 offset.
 *
 * Returns `null` when the position does not exist in this source, which is the
 * expected outcome when the file changed underneath a stale selection. The
 * caller must treat that as "reselect", never as "use the nearest line".
 *
 * Line breaks are counted as LF, with a CR immediately preceding an LF treated
 * as part of that break, so a CRLF file yields the same offsets the parser used.
 */
export function lineColumnToOffset(source: string, line: number, column: number): number | null {
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 0) return null;

  let offset = 0;
  let currentLine = 1;
  while (currentLine < line) {
    const next = source.indexOf("\n", offset);
    if (next === -1) return null;
    offset = next + 1;
    currentLine++;
  }

  const lineEnd = source.indexOf("\n", offset);
  const hardEnd = lineEnd === -1 ? source.length : lineEnd;
  const target = offset + column;
  // Allow the position one past the last character of the line (a column at the
  // line break itself), but never past the break into the following line.
  return target <= hardEnd ? target : null;
}
