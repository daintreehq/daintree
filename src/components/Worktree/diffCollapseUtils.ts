import type { File } from "gitdiff-parser";
import { isGeneratedDiffFile } from "./generatedFileClassifier";

export const DIFF_SOFT_COLLAPSE_BYTES = 256 * 1024;

export function getFilePath(file: File): string {
  if (file.newPath && file.newPath !== "/dev/null") return file.newPath;
  if (file.oldPath && file.oldPath !== "/dev/null") return file.oldPath;
  return "";
}

export function estimateFileDiffBytes(file: File): number {
  let bytes = 0;
  for (const hunk of file.hunks ?? []) {
    bytes += hunk.content.length;
    for (const change of hunk.changes) {
      bytes += change.content.length;
    }
  }
  return bytes;
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
