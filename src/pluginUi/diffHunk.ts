import type { PluginDiffHunk } from "@shared/types/plugin-sdk-react";

function sideLines(text: string, count: number): string[] | null {
  if (count === 0) return text === "" ? [] : null;
  const lines = text.split("\n");
  return lines.length === count ? lines : null;
}

/**
 * `text` with one `DiffView` hunk undone: the hunk's new lines swapped back
 * for its old ones. `text` is the diff's `newText` (or a later copy of it the
 * hunk still matches); null when those lines no longer read as the hunk's new
 * side, or the hunk does not hold together, so a stale hunk is never spliced
 * into the wrong place. A hunk with no new lines (a pure deletion drawn with
 * no context) has nothing to check against and is put back where it says.
 * Whether the file ends in a newline is not part of a hunk: the text keeps
 * its own.
 */
export function revertHunk(text: string, hunk: PluginDiffHunk): string | null {
  if (typeof text !== "string" || typeof hunk !== "object" || hunk === null) return null;
  const { newStart, newCount, oldCount, oldText, newText } = hunk;
  if (
    !Number.isInteger(newStart) ||
    !Number.isInteger(newCount) ||
    !Number.isInteger(oldCount) ||
    newStart < 0 ||
    newCount < 0 ||
    oldCount < 0 ||
    typeof oldText !== "string" ||
    typeof newText !== "string"
  ) {
    return null;
  }
  const oldLines = sideLines(oldText, oldCount);
  const newLines = sideLines(newText, newCount);
  if (oldLines === null || newLines === null) return null;
  const lines = text.split("\n");
  // An empty side starts at the line before it, as `@@ -3,2 +2,0 @@` prints.
  const at = newCount === 0 ? newStart : newStart - 1;
  if (at < 0 || at + newCount > lines.length) return null;
  for (let offset = 0; offset < newCount; offset++) {
    if (lines[at + offset] !== newLines[offset]) return null;
  }
  // Concatenated rather than spliced: a spread of a very large hunk's lines
  // would pass every one of them as an argument.
  return lines
    .slice(0, at)
    .concat(oldLines, lines.slice(at + newCount))
    .join("\n");
}
