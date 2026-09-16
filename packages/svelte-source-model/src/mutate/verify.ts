import type { SourceRange } from "../types.js";

/**
 * The narrowest window of the original that the candidate could have changed,
 * derived from the common prefix and suffix of the two strings.
 *
 * This is the only way to check a protected range without being told how the
 * candidate was produced: every offset after an edit has shifted, so "the bytes
 * at 400..430 are unchanged" is a question about two different coordinate
 * systems. The window is a lower bound on the change — over-reporting is
 * impossible, under-reporting would be the dangerous direction — so a protected
 * range that misses it provably holds the same bytes, just at a known offset.
 */
export interface ChangeWindow {
  /** Range in the ORIGINAL that differs. Empty when the strings are equal. */
  original: SourceRange;
  /** Range in the CANDIDATE that differs. */
  candidate: SourceRange;
}

export function computeChangeWindow(original: string, candidate: string): ChangeWindow {
  const limit = Math.min(original.length, candidate.length);
  let prefix = 0;
  while (prefix < limit && original[prefix] === candidate[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < limit - prefix &&
    original[original.length - 1 - suffix] === candidate[candidate.length - 1 - suffix]
  ) {
    suffix++;
  }

  return {
    original: { start: prefix, end: original.length - suffix },
    candidate: { start: prefix, end: candidate.length - suffix },
  };
}

export type ProtectedRangeVerdict = { ok: true } | { ok: false; detail: string };

/**
 * Proves every protected range still holds byte-identical content.
 *
 * Ranges are given in original coordinates; those sitting after the change
 * window are compared at their shifted offsets, which is what makes "the
 * sibling element is untouched" a byte fact rather than an assumption about the
 * planner.
 */
export function verifyProtectedRanges(
  original: string,
  candidate: string,
  protectedRanges: readonly SourceRange[]
): ProtectedRangeVerdict {
  const window = computeChangeWindow(original, candidate);
  const delta = candidate.length - original.length;

  for (const range of protectedRanges) {
    if (range.start < 0 || range.end > original.length || range.end < range.start) {
      return {
        ok: false,
        detail: `Protected range [${range.start}, ${range.end}) is not in the original.`,
      };
    }
    if (range.end === range.start) continue;
    if (range.start < window.original.end && range.end > window.original.start) {
      return {
        ok: false,
        detail: `Protected range [${range.start}, ${range.end}) overlaps the edit.`,
      };
    }
    const shift = range.start >= window.original.end ? delta : 0;
    if (
      original.slice(range.start, range.end) !==
      candidate.slice(range.start + shift, range.end + shift)
    ) {
      return {
        ok: false,
        detail: `Protected range [${range.start}, ${range.end}) changed content.`,
      };
    }
  }
  return { ok: true };
}

/**
 * The complement of an edit: everything in the source the edit did not claim.
 *
 * Planners pass this as the protected set, which turns "my replacements are
 * minimal" from an intention into a checked property — if the spliced candidate
 * differs anywhere outside the ranges the plan declared, the plan is refused.
 */
export function complementOf(sourceLength: number, ranges: readonly SourceRange[]): SourceRange[] {
  if (ranges.length === 0) return [{ start: 0, end: sourceLength }];
  const start = Math.min(...ranges.map((r) => r.start));
  const end = Math.max(...ranges.map((r) => r.end));
  return [
    { start: 0, end: start },
    { start: end, end: sourceLength },
  ];
}
