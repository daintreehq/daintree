import type { GitStatus } from "@shared/types";
import type { DiffChangeSetEntry } from "@shared/types/git";

// The entry shape moved to shared types when it became a field on
// `DiffPanelData` (shared/ cannot import from src/). Re-exported here so the
// sidebar, the pane, and every opener keep importing it from one place.
export type { DiffChangeSetEntry };

export const DIFF_STATUS_CONFIG: Record<GitStatus, { label: string; color: string }> = {
  modified: { label: "M", color: "text-status-warning-text" },
  added: { label: "A", color: "text-status-success-text" },
  deleted: { label: "D", color: "text-status-danger-text" },
  untracked: { label: "?", color: "text-status-success-text" },
  renamed: { label: "R", color: "text-status-info-text" },
  copied: { label: "C", color: "text-status-info-text" },
  ignored: { label: "I", color: "text-text-secondary" },
  conflicted: { label: "!", color: "text-status-danger-text" },
};

/** A directory band's label: the last few segments, so deep paths keep the part that differs. */
export function formatDiffDir(dir: string, maxSegments = 3): string {
  if (!dir || dir === ".") return "(root)";
  const segments = dir.split("/");
  if (segments.length <= maxSegments) return dir;
  return "…/" + segments.slice(-maxSegments).join("/");
}

export function summarizeChangeSet(files: DiffChangeSetEntry[]): {
  insertions: number;
  deletions: number;
} {
  let insertions = 0;
  let deletions = 0;
  for (const file of files) {
    insertions += file.insertions ?? 0;
    deletions += file.deletions ?? 0;
  }
  return { insertions, deletions };
}
