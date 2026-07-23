import { worktreeClient } from "@/clients";
import type { FileChangeDetail, WorktreeChanges } from "@shared/types/git";

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
  return { ...summarizeWorktreeChanges(changes), changes };
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
 * Render a change set as capped, glyph-prefixed file rows (`  M src/app.ts`),
 * shared by the local delete dialog and the MCP preview so both show the same
 * actual content (the D2 "a count is insufficient" rule). Ignored files are
 * dropped — they're not part of what a delete discards.
 */
export function formatWorktreeChangeRows(
  changes: FileChangeDetail[],
  limit: number = PREVIEW_FILE_LIMIT
): string[] {
  const shown = changes.filter((c) => c.status !== "ignored");
  const rows = shown.slice(0, limit).map((c) => `  ${STATUS_GLYPH[c.status] ?? "?"} ${c.path}`);
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
    return ["⚠ Could not verify current changes — proceed with caution."];
  }
  const { trackedChangeCount, untrackedFileCount, changes } = preview;
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
  return [`${parts.join(" and ")}:`, ...formatWorktreeChangeRows(changes)];
}
