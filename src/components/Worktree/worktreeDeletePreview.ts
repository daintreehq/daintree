import { worktreeClient } from "@/clients";
import type { FileChangeDetail, WorktreeChanges } from "@shared/types/git";
import { MCP_PREVIEW_CAUTION_PREFIX } from "@/lib/mcpPreviewLines";

/**
 * Canonical fresh preview for the worktree-delete confirm surfaces (#11343).
 *
 * Both the local `WorktreeDeleteDialog` and the MCP confirm surface must decide
 * the D2/D3 tier and render the changed-file preview from a LIVE git status —
 * a backgrounded worktree's cached snapshot can be ~30s stale, which is exactly
 * what lets a force-delete skip the typed-name gate and discard uncommitted
 * work. This module owns the one fresh fetch and the tracked/untracked
 * classification both surfaces share.
 */

/** Counts derived from a change set, split the way the D3 tier gate needs. */
export interface WorktreeChangeSummary {
  /** Tracked (non-untracked, non-ignored) changes — the D3 escalation input. */
  trackedChangeCount: number;
  /** Untracked files (D2-relevant, never D3 on their own — see #4927). */
  untrackedFileCount: number;
  hasTrackedChanges: boolean;
  hasUntrackedFiles: boolean;
}

/** A fresh delete preview: the change summary plus the raw file list. */
export interface WorktreeDeletePreview extends WorktreeChangeSummary {
  changes: FileChangeDetail[];
  /**
   * Absolute worktree root, carried so previews can render each file relative
   * to it. `FileChangeDetail.path` arrives ABSOLUTE from the only producer
   * (`electron/utils/git.ts` resolves every entry against the git root), which
   * is why the rest of the renderer derives a `relativePath` before display —
   * see `src/lib/workingTreeDiff.ts`. Without the root, a preview repeats the
   * whole worktree path on every row and buries the filename.
   */
  rootPath: string;
}

/**
 * Split a change set into tracked/untracked counts. Ignored files never count
 * (they aren't part of the working tree the user cares about); untracked files
 * are surfaced separately because they gate the D2 preview but must NOT drive
 * the D3 typed-name gate on their own (regressing that collapse is #4927).
 */
export function summarizeWorktreeChanges(
  changes: FileChangeDetail[] | null | undefined
): WorktreeChangeSummary {
  const list = changes ?? [];
  const trackedChangeCount = list.filter(
    (c) => c.status !== "untracked" && c.status !== "ignored"
  ).length;
  const untrackedFileCount = list.filter((c) => c.status === "untracked").length;
  return {
    trackedChangeCount,
    untrackedFileCount,
    hasTrackedChanges: trackedChangeCount > 0,
    hasUntrackedFiles: untrackedFileCount > 0,
  };
}

/**
 * Force a fresh `git status` for the worktree and return its delete preview.
 *
 * Rejects if the fresh fetch fails or times out — callers MUST fail closed on
 * rejection (escalate the tier / warn), never silently fall back to the stale
 * cached snapshot, which would recreate the exact bug being fixed. Resolves
 * `null` only when the worktree's monitor no longer exists (already removed),
 * which callers may treat as "nothing to gate".
 */
export async function buildWorktreeDeletePreview(
  worktreeId: string
): Promise<WorktreeDeletePreview | null> {
  const fresh: WorktreeChanges | null = await worktreeClient.getFreshChanges(worktreeId);
  if (!fresh) return null;
  const changes = fresh.changes ?? [];
  return { ...summarizeWorktreeChanges(changes), changes, rootPath: fresh.rootPath };
}

/** Max file rows shown in a compact preview before collapsing the tail. */
export const PREVIEW_FILE_LIMIT = 12;

const STATUS_GLYPH: Record<FileChangeDetail["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  conflicted: "U",
  untracked: "?",
  ignored: "!",
};

/**
 * Strip the worktree root off an absolute change path.
 *
 * `FileChangeDetail.path` is absolute (see {@link WorktreeDeletePreview.rootPath}),
 * so a preview that renders it raw repeats the entire worktree path on every
 * row and pushes the only distinguishing part — the filename — past the wrap.
 * Mirrors `getRelativePath` in `src/lib/workingTreeDiff.ts`; a path that
 * escapes the root (or a root we weren't given) is left alone rather than
 * mangled, because showing a wrong path here is worse than showing a long one.
 */
function toDisplayPath(filePath: string, rootPath: string | undefined): string {
  if (!rootPath) return filePath;
  const root = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
  return filePath.startsWith(root) ? filePath.slice(root.length) : filePath;
}

/**
 * Render a change set as capped, glyph-prefixed file rows (`  M src/app.ts`),
 * shared by the local delete dialog and the MCP preview so both show the same
 * actual content (the D2 "a count is insufficient" rule). Ignored files are
 * dropped — they're not part of what a delete discards.
 *
 * Pass `rootPath` to get worktree-relative rows; without it the raw (absolute)
 * paths are rendered, which is the legacy behaviour.
 */
export function formatWorktreeChangeRows(
  changes: FileChangeDetail[],
  limit: number = PREVIEW_FILE_LIMIT,
  rootPath?: string
): string[] {
  const shown = changes.filter((c) => c.status !== "ignored");
  const rows = shown
    .slice(0, limit)
    .map((c) => `  ${STATUS_GLYPH[c.status] ?? "?"} ${toDisplayPath(c.path, rootPath)}`);
  if (shown.length > limit) {
    rows.push(`  …and ${shown.length - limit} more`);
  }
  return rows;
}

/**
 * Render a preview as plain lines for the MCP confirm surface — a header
 * naming the tracked/untracked counts, then the actual file list (capped), so
 * the approver sees the real content a force-delete would discard rather than
 * just raw args (the #11343 MCP gap, and the D2 "preview of actual content"
 * rule). `null` means the fresh fetch could not be verified: surface that
 * explicitly rather than implying a clean tree.
 */
export function formatWorktreeDeletePreviewLines(preview: WorktreeDeletePreview | null): string[] {
  if (preview === null) {
    return [
      `${MCP_PREVIEW_CAUTION_PREFIX}Could not verify current changes — proceed with caution.`,
    ];
  }
  const { trackedChangeCount, untrackedFileCount, changes, rootPath } = preview;
  if (changes.length === 0) {
    return ["No uncommitted changes."];
  }
  const parts: string[] = [];
  if (trackedChangeCount > 0) {
    parts.push(
      `${trackedChangeCount} uncommitted tracked file${trackedChangeCount === 1 ? "" : "s"}`
    );
  }
  if (untrackedFileCount > 0) {
    parts.push(`${untrackedFileCount} untracked file${untrackedFileCount === 1 ? "" : "s"}`);
  }
  return [
    `${parts.join(" and ")}:`,
    ...formatWorktreeChangeRows(changes, PREVIEW_FILE_LIMIT, rootPath),
  ];
}
