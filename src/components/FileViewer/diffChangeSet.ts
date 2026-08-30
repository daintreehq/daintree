import type { GitStatus } from "@shared/types";
import type { DiffChangeSetEntry } from "@shared/types/git";

// The entry shape moved to shared types when it became a field on
// `DiffPanelData` (shared/ cannot import from src/). Re-exported here so the
// sidebar, the pane, and every opener keep importing it from one place.
export type { DiffChangeSetEntry };

export const DIFF_STATUS_CONFIG: Record<GitStatus, { label: string; color: string }> = {
  modified: { label: "M", color: "text-status-warning" },
  added: { label: "A", color: "text-status-success" },
  deleted: { label: "D", color: "text-status-error" },
  untracked: { label: "?", color: "text-status-success" },
  renamed: { label: "R", color: "text-status-info" },
  copied: { label: "C", color: "text-status-info" },
  ignored: { label: "I", color: "text-text-secondary" },
  conflicted: { label: "!", color: "text-status-error" },
};

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
