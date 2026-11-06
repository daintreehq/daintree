/**
 * A path as its last two segments. What tells two worktrees apart is the tail —
 * the shared home or temp prefix is the same on every row — so an end-truncated
 * path spent the whole line on the part that never differs. Callers draw it with
 * `PathTail`, so a tail that still overflows gives way from its start, and keep
 * the full path in a tooltip.
 */
export function pathTail(path: string): string {
  return shortenPath(path).text;
}

export const PATH_TAIL_PREFIX = "…/";

/**
 * `pathTail` plus where the kept text starts in the original, so match ranges
 * computed against the full path can be moved onto the shortened line. The kept
 * tail is a verbatim slice, which is what makes the remap exact.
 */
export function shortenPath(path: string): { text: string; start: number } {
  let seen = 0;
  for (let i = path.length - 1; i > 0; i--) {
    const ch = path[i];
    if ((ch === "/" || ch === "\\") && i < path.length - 1) {
      seen++;
      if (seen === 2) {
        const rest = path.slice(0, i);
        // Nothing worth dropping ahead of the tail: show the path as-is.
        if (!/[^/\\]/.test(rest)) break;
        return { text: `${PATH_TAIL_PREFIX}${path.slice(i + 1)}`, start: i + 1 };
      }
    }
  }
  return { text: path, start: 0 };
}

/** Moves match ranges on the full path onto its `shortenPath` text. */
export function remapPathRanges(
  ranges: readonly (readonly [number, number])[] | undefined,
  start: number
): [number, number][] | undefined {
  if (!ranges) return undefined;
  const shift = start > 0 ? PATH_TAIL_PREFIX.length : 0;
  const moved: [number, number][] = [];
  for (const [s, e] of ranges) {
    if (e < start) continue;
    moved.push([Math.max(s, start) - start + shift, e - start + shift]);
  }
  return moved.length > 0 ? moved : undefined;
}
