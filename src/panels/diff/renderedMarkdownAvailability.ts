import type { DiffPanelData } from "@shared/types/panel";
import type { FileReadErrorCode } from "@shared/types/ipc/files";
import { isMarkdownFilePath } from "@/components/Markdown/isMarkdownFile";
import { FILE_READ_ERROR_MESSAGES } from "@/components/FileViewer/fileReadErrors";
import type { MarkdownDiffFailure } from "@/components/Worktree/markdownBlockDiff";

/**
 * Whether the rendered-Markdown layout can be offered for one file, and why not
 * when it can't (issue #12171). Same split as `getFullFileAvailability`: a pure
 * verdict the toolbar renders, so the segment never looks live while being
 * inert and always explains itself.
 *
 * Three states rather than two, because "not a Markdown file" is different in
 * kind from "Markdown, but not this one". A rendered layout for a `.ts` file is
 * not a thing the user was denied, it is a thing that does not exist — offering
 * a permanently dead third segment on every source diff would be noise.
 */
export type RenderedMarkdownAvailability =
  | { visible: false }
  | { visible: true; enabled: true }
  | { visible: true; enabled: false; reason: string };

const VISIBLE_ENABLED: RenderedMarkdownAvailability = { visible: true, enabled: true };

/**
 * Diff sources whose new side is the file on disk. The old document is rebuilt
 * by reverse-applying the patch onto that file, so a source whose new side
 * lives anywhere else (the index, another ref) would be reconstructed from
 * content the patch was never generated against.
 *
 * Mirrors `fullFileAvailability`'s list for the same reason, and excludes
 * `staged` for the same reason: a staged diff's new side is the index blob,
 * which diverges from disk the moment the file is edited again after staging.
 */
const DISK_BACKED_SOURCES: ReadonlySet<string> = new Set(["working-tree", "unstaged"]);

/** Diff-content sentinels `useDiffContent` returns in place of patch text. */
const SENTINEL_REASONS: Record<string, string> = {
  NO_CHANGES: "There are no Markdown changes to render",
  ERROR: "Refresh the diff before using the rendered layout",
  FILE_TOO_LARGE: "This diff is too large to render",
  BINARY_FILE: "Rendered Markdown isn't available for binary content",
};

const FAILURE_REASONS: Record<MarkdownDiffFailure, string> = {
  "unsupported-patch": "This diff can't be rebuilt into a whole Markdown document",
  "source-required": "Rendered Markdown needs the current file, which couldn't be read",
  "source-mismatch": "The file changed after this diff loaded — refresh to render it",
  "too-large": "This document is too large to render",
};

export interface RenderedMarkdownAvailabilityInput {
  filePath: string | undefined;
  diffSource: DiffPanelData["diffSource"];
  /** Diff text or sentinel; undefined while loading. */
  content: string | undefined;
  /** The store saw the file change after the shown diff was fetched. */
  stale: boolean;
  /** Set when the whole-file read the reconstruction depends on failed. */
  sourceErrorCode: FileReadErrorCode | null;
  /** The engine's verdict on the diff currently shown, once it has one. */
  engineFailure: MarkdownDiffFailure | null;
}

/**
 * The half of the verdict that depends only on what is being diffed, not on the
 * diff itself.
 *
 * Split out because the fetch has to know before the content lands: the
 * rendered layout requests a whitespace-sensitive patch, and deciding that from
 * the full verdict would need the content the request is about to produce.
 */
export function isRenderedMarkdownSupported(
  filePath: string | undefined,
  diffSource: DiffPanelData["diffSource"]
): boolean {
  if (!filePath || !isMarkdownFilePath(filePath)) return false;
  // `buildSubject` treats a missing source as working-tree; match it.
  return diffSource === undefined || DISK_BACKED_SOURCES.has(diffSource);
}

export function getRenderedMarkdownAvailability({
  filePath,
  diffSource,
  content,
  stale,
  sourceErrorCode,
  engineFailure,
}: RenderedMarkdownAvailabilityInput): RenderedMarkdownAvailability {
  if (!filePath || !isMarkdownFilePath(filePath)) return { visible: false };

  if (!isRenderedMarkdownSupported(filePath, diffSource)) {
    return {
      visible: true,
      enabled: false,
      reason:
        diffSource === "staged"
          ? "Rendered Markdown isn't available for staged changes — staged content lives in the index, not on disk"
          : "Rendered Markdown isn't available for base-branch diffs — the file at that ref isn't what's on disk",
    };
  }

  // The patch and the file on disk must describe the same revision: the
  // reconstruction trusts the gaps between hunks, and once the store reports
  // the file changed they demonstrably disagree.
  if (stale) {
    return {
      visible: true,
      enabled: false,
      reason: "Refresh the diff before rendering the current Markdown",
    };
  }

  if (sourceErrorCode) {
    return {
      visible: true,
      enabled: false,
      reason: `Rendered Markdown needs the current file: ${FILE_READ_ERROR_MESSAGES[sourceErrorCode]}`,
    };
  }

  // Loading stays enabled: the segment is the user's choice, and the body shows
  // the same skeleton the source layouts do.
  if (content === undefined) return VISIBLE_ENABLED;

  const sentinel = SENTINEL_REASONS[content];
  if (sentinel) return { visible: true, enabled: false, reason: sentinel };

  if (engineFailure) {
    return { visible: true, enabled: false, reason: FAILURE_REASONS[engineFailure] };
  }

  // Every remaining status renders. Status deliberately isn't a gate here the
  // way it is for full file: a deletion's patch carries every line of the old
  // document, and an addition's is all inserts over an empty one, so both
  // reconstruct. Status only decides whether the new side needs a disk read,
  // which is the caller's business.
  return VISIBLE_ENABLED;
}
