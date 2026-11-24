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
 * a character whose lowercase form is longer snaps outward to the whole
 * original character.
 *
 * Matching itself is the whole-string `toLowerCase().indexOf()` it replaced, so
 * context-sensitive casing (final sigma) and first-occurrence behave as before.
 */
export function findCaseInsensitiveLiteral(
  haystack: string,
  needle: string
): LiteralMatchRange | null {
  const loweredNeedle = needle.toLowerCase();
  if (loweredNeedle.length === 0) return null;

  const loweredHaystack = haystack.toLowerCase();
  const loweredStart = loweredHaystack.indexOf(loweredNeedle);
  if (loweredStart === -1) return null;
  const loweredEnd = loweredStart + loweredNeedle.length;

  // No lowercase mapping is shorter than its input, so a string that keeps its
  // length keeps every offset.
  if (loweredHaystack.length === haystack.length) {
    return { start: loweredStart, end: loweredEnd };
  }

  // Lowering a single code point never depends on its neighbours except for
  // final sigma, which keeps its length, so per-code-point lengths track the
  // whole-string offsets. Only a code point that grew is atomic; inside one that
  // kept its length the offset is shifted by the growth seen so far.
  let loweredOffset = 0;
  let originalOffset = 0;
  let growth = 0;
  let start = -1;
  for (const codePoint of haystack) {
    const loweredLength = codePoint.toLowerCase().length;
    const grew = loweredLength !== codePoint.length;
    const nextLowered = loweredOffset + loweredLength;
    const nextOriginal = originalOffset + codePoint.length;
    if (start === -1 && nextLowered > loweredStart) {
      start = grew ? originalOffset : loweredStart - growth;
    }
    if (nextLowered >= loweredEnd) {
      return { start, end: grew ? nextOriginal : loweredEnd - growth };
    }
    growth += loweredLength - codePoint.length;
    loweredOffset = nextLowered;
    originalOffset = nextOriginal;
  }
  return null;
}
