import type { GitStatus } from "@shared/types";
import type { DiffChangeSetEntry } from "@shared/types/git";
import { dirname } from "@shared/utils/path";

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

export interface IndexedDiffEntry extends DiffChangeSetEntry {
  /** Position in the original change set, whatever the display order. */
  index: number;
}

export interface DiffDirGroup {
  dir: string;
  files: IndexedDiffEntry[];
}

/**
 * The shelf's display order: root files first, then folders alphabetically,
 * each folder's files in change-set order, keeping only paths that contain the
 * filter. The pane's stepper walks the same order, so both read it from here.
 */
export function groupDiffChangeSet(
  files: readonly DiffChangeSetEntry[],
  filter = ""
): DiffDirGroup[] {
  const query = filter.trim().toLowerCase();
  const grouped = new Map<string, IndexedDiffEntry[]>();
  files.forEach((file, index) => {
    if (query && !file.path.toLowerCase().includes(query)) return;
    const dir = dirname(file.path);
    const key = !dir || dir === "." ? "" : dir;
    const bucket = grouped.get(key);
    if (bucket) bucket.push({ ...file, index });
    else grouped.set(key, [{ ...file, index }]);
  });
  return Array.from(grouped.entries())
    .map(([dir, groupFiles]) => ({ dir, files: groupFiles }))
    .sort((a, b) => {
      if (a.dir === "") return -1;
      if (b.dir === "") return 1;
      return a.dir.localeCompare(b.dir);
    });
}
