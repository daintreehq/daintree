export interface LiteralMatchRange {
  start: number;
  end: number;
}

/**
 * Case-insensitive literal search that reports the match in `haystack`'s own
 * UTF-16 coordinates.
 *
 * Lowercasing can change a string's length (`İ` becomes `i` + U+0307), so an
 * offset found in `haystack.toLowerCase()` points at a different character once
 * it is applied to the original. Callers slice the original line with the
 * returned range, so it is mapped back here. A match that begins or ends inside
 * an expanded character snaps outward to the whole original character.
 */
export function findCaseInsensitiveLiteral(
  haystack: string,
  needle: string
): LiteralMatchRange | null {
  const loweredNeedle = needle.toLowerCase();
  if (loweredNeedle.length === 0) return null;

  // No lowercase mapping is shorter than its input, so a string that keeps its
  // length keeps every offset, and the lowered index is already an original one.
  const wholeLowered = haystack.toLowerCase();
  if (wholeLowered.length === haystack.length) {
    const idx = wholeLowered.indexOf(loweredNeedle);
    return idx === -1 ? null : { start: idx, end: idx + loweredNeedle.length };
  }

  // Each original code point's span in the lowered string. `toLowerCase()` is
  // context sensitive only for final sigma, which keeps its length, so the
  // per-code-point lengths add up to the whole-string length.
  const loweredEnds: number[] = [];
  const originalStarts: number[] = [];
  const originalEnds: number[] = [];
  const pieces: string[] = [];
  let loweredLength = 0;
  let originalOffset = 0;
  for (const cp of haystack) {
    const lowered = cp.toLowerCase();
    pieces.push(lowered);
    loweredLength += lowered.length;
    loweredEnds.push(loweredLength);
    originalStarts.push(originalOffset);
    originalOffset += cp.length;
    originalEnds.push(originalOffset);
  }

  const loweredHaystack = wholeLowered.length === loweredLength ? wholeLowered : pieces.join("");

  const idx = loweredHaystack.indexOf(loweredNeedle);
  if (idx === -1) return null;

  const first = codePointIndexAt(loweredEnds, idx);
  const last = codePointIndexAt(loweredEnds, idx + loweredNeedle.length - 1);
  return { start: originalStarts[first] ?? 0, end: originalEnds[last] ?? haystack.length };
}

/** Index of the code point whose lowered span contains lowered offset `offset`. */
function codePointIndexAt(loweredEnds: number[], offset: number): number {
  let lo = 0;
  let hi = loweredEnds.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((loweredEnds[mid] ?? 0) > offset) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
