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

/** Original change-set indices in the shelf's display order. */
export function diffDisplayOrder(groups: readonly DiffDirGroup[]): number[] {
  return groups.flatMap((group) => group.files.map((file) => file.index));
}

/**
 * The shelf as it stood the last time the open file was in it. Held after the
 * file leaves the set so the stepper can find the gap it left by whichever of
 * its old neighbours survive, rather than by a position that every other
 * removal shifts.
 */
export interface DiffFileAnchor {
  files: readonly DiffChangeSetEntry[];
  /** `files` indices in display order. */
  order: readonly number[];
  /** The open file's place in `order`. */
  position: number;
}

export interface DiffFileNavigation {
  /** The open file's place among the shown files; null when it isn't one of them. */
  position: number | null;
  /** How many files the shelf shows. */
  total: number;
  /** Change-set index of the shown file before the open one. */
  previousIndex: number | null;
  /** Change-set index of the shown file after the open one. */
  nextIndex: number | null;
}

// The side splits a partially staged file's twins, which share a Viewed key.
function entryIdentity(entry: DiffChangeSetEntry): string {
  return `${entry.side ?? ""}\0${entry.viewedKey}`;
}

/** The display position the missing open file's gap sits before. */
function findGap(
  files: readonly DiffChangeSetEntry[],
  order: readonly number[],
  anchor: DiffFileAnchor | null
): number {
  if (!anchor) return 0;
  const positionByIdentity = new Map<string, number>();
  order.forEach((index, position) => {
    const entry = files[index];
    if (!entry) return;
    const identity = entryIdentity(entry);
    if (!positionByIdentity.has(identity)) positionByIdentity.set(identity, position);
  });
  const positionOf = (anchorPosition: number): number | undefined => {
    const entry = anchor.files[anchor.order[anchorPosition] ?? -1];
    return entry ? positionByIdentity.get(entryIdentity(entry)) : undefined;
  };
  for (let i = anchor.position + 1; i < anchor.order.length; i++) {
    const position = positionOf(i);
    if (position !== undefined) return position;
  }
  for (let i = anchor.position - 1; i >= 0; i--) {
    const position = positionOf(i);
    if (position !== undefined) return position + 1;
  }
  return Math.min(anchor.position, order.length);
}

/**
 * Where the stepper stands and where each direction goes. `fullOrder` is every
 * file in display order and `visibleOrder` the ones the shelf's filter keeps.
 * An open file the filter hides steps to the nearest shown file on each side
 * of its own place; one that left the set steps from the gap it left, so the
 * file that slid into its place is the next one rather than skipped.
 */
export function resolveDiffFileNavigation(
  files: readonly DiffChangeSetEntry[],
  fullOrder: readonly number[],
  visibleOrder: readonly number[],
  currentIndex: number,
  anchor: DiffFileAnchor | null
): DiffFileNavigation {
  const total = visibleOrder.length;
  const visiblePosition = currentIndex === -1 ? -1 : visibleOrder.indexOf(currentIndex);
  if (visiblePosition !== -1) {
    return {
      position: visiblePosition,
      total,
      previousIndex: visibleOrder[visiblePosition - 1] ?? null,
      nextIndex: visibleOrder[visiblePosition + 1] ?? null,
    };
  }

  // Shown files strictly before `previousBelow` lie behind the open file, and
  // those from `nextFrom` on lie ahead of it.
  const fullPosition = currentIndex === -1 ? -1 : fullOrder.indexOf(currentIndex);
  const previousBelow = fullPosition !== -1 ? fullPosition : findGap(files, fullOrder, anchor);
  const nextFrom = fullPosition !== -1 ? fullPosition + 1 : previousBelow;
  const fullPositionByIndex = new Map(fullOrder.map((index, position) => [index, position]));
  let previousIndex: number | null = null;
  let nextIndex: number | null = null;
  for (const index of visibleOrder) {
    const position = fullPositionByIndex.get(index);
    if (position === undefined) continue;
    if (position < previousBelow) previousIndex = index;
    else if (position >= nextFrom) {
      nextIndex = index;
      break;
    }
  }
  return { position: null, total, previousIndex, nextIndex };
}
