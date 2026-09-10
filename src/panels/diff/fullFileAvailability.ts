import type { GitStatus } from "@shared/types/git";
import type { DiffPanelData } from "@shared/types/panel";

/**
 * Whether the full-file scope can be offered for one file, and why not when it
 * can't. Three independent things disqualify a file, so all are checked here
 * rather than in the toolbar: the entry may not be a file at all (a submodule
 * gitlink), the diff may already carry the whole file (an addition has no
 * hidden context to reveal), or the new side may not be readable from disk.
 */
export type FullFileAvailability = { available: true } | { available: false; reason: string };

const AVAILABLE: FullFileAvailability = { available: true };

/**
 * Statuses whose new side is a modification of an existing file — the only ones
 * with unchanged regions to expand into. Mirrors the `modify | rename | copy`
 * gate `DiffViewer` applies to the parsed diff, so the toolbar never offers a
 * scope the renderer would then refuse.
 */
const EXPANDABLE_STATUSES: ReadonlySet<GitStatus> = new Set<GitStatus>([
  "modified",
  "renamed",
  "copied",
]);

/**
 * Diff sources whose new side is the file on disk, so `files:read` reaches the
 * exact content the diff was generated against.
 *
 * `staged` is deliberately absent: a staged diff's new side is the index blob,
 * which diverges from disk as soon as the file is edited again after staging.
 * Reading disk there would show content the diff was never generated from.
 */
const DISK_BACKED_SOURCES: ReadonlySet<string> = new Set(["working-tree", "unstaged"]);

export function getFullFileAvailability(
  diffSource: DiffPanelData["diffSource"],
  fileStatus: GitStatus | undefined,
  isGitlink = false
): FullFileAvailability {
  // Outranks every status and source reason below: a gitlink's new side is a
  // commit reference, so the path on disk is the submodule's own working
  // directory. Offering the scope sends `files:read` at a directory, which
  // fails with a message no retry can clear (#12309).
  if (isGitlink) {
    return {
      available: false,
      reason: "This is a submodule — its diff is a commit reference, not file contents",
    };
  }

  // Mirrors `buildSubject`, which defaults a missing status the same way.
  const status = fileStatus ?? "modified";

  if (status === "added" || status === "untracked") {
    return { available: false, reason: "This diff already shows the file's full contents" };
  }
  if (status === "deleted") {
    return { available: false, reason: "This file was deleted, so there's no current version" };
  }
  if (!EXPANDABLE_STATUSES.has(status)) {
    return { available: false, reason: "Full file isn't available for this file" };
  }

  if (diffSource === "base-branch") {
    return {
      available: false,
      reason:
        "Full file isn't available for base-branch diffs — the file at that ref isn't what's on disk",
    };
  }
  if (diffSource === "staged") {
    return {
      available: false,
      reason:
        "Full file isn't available for staged diffs — staged content lives in the index, not on disk",
    };
  }
  // `buildSubject` treats a missing source as working-tree; match it.
  if (diffSource !== undefined && !DISK_BACKED_SOURCES.has(diffSource)) {
    return { available: false, reason: "Full file isn't available for this diff" };
  }

  return AVAILABLE;
}
