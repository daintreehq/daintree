import type { File } from "gitdiff-parser";
import { isGeneratedDiffFile } from "./generatedFileClassifier";

export const DIFF_SOFT_COLLAPSE_BYTES = 256 * 1024;

export function getFilePath(file: File): string {
  if (file.newPath && file.newPath !== "/dev/null") return file.newPath;
  if (file.oldPath && file.oldPath !== "/dev/null") return file.oldPath;
  return "";
}

/**
 * Only what a byte estimate reads. Typed structurally because the parsed diff
 * and the rendered hunks come from different packages — gitdiff-parser's
 * `Hunk` and react-diff-view's `HunkData` differ in their change shapes, and
 * this measure applies to both.
 */
interface MeasurableHunk {
  content: string;
  changes: readonly { content: string }[];
}

/**
 * Byte estimate for an arbitrary hunk set. Split out from
 * `estimateFileDiffBytes` so the same measure can be taken of the hunks
 * actually being rendered, which context expansion grows well past the parsed
 * diff's own size.
 */
export function estimateHunksBytes(hunks: readonly MeasurableHunk[]): number {
  let bytes = 0;
  for (const hunk of hunks) {
    bytes += hunk.content.length;
    for (const change of hunk.changes) {
      bytes += change.content.length;
    }
  }
  return bytes;
}

export function estimateFileDiffBytes(file: File): number {
  return estimateHunksBytes(file.hunks ?? []);
}

export function shouldCollapseByDefault(file: File): {
  collapse: boolean;
  reason: "generated" | "large" | null;
} {
  if (isGeneratedDiffFile(file)) {
    return { collapse: true, reason: "generated" };
  }
  if (estimateFileDiffBytes(file) > DIFF_SOFT_COLLAPSE_BYTES) {
    return { collapse: true, reason: "large" };
  }
  return { collapse: false, reason: null };
}
