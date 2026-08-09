import { stableArgsSha256 } from "../utils/pluginMcpHash.js";
import {
  canonicalizeCopyTreeOptions,
  resolveCopyTreeRunName,
  sortCopyTreeHistory,
} from "../../shared/utils/copyTreeHistory.js";
import {
  COPY_TREE_HISTORY_MAX_RECORDS,
  type CopyTreeHistoryAppendInput,
  type CopyTreeHistoryRecord,
} from "../../shared/types/ipc/copyTreeHistory.js";
import type { CopyTreeOptions } from "../../shared/types/ipc/copyTree.js";

/**
 * Dedupe key for a run: SHA-256 over the canonicalized runtime options and
 * nothing else.
 *
 * Name, source, worktree, stats, delivery mode and timestamps all stay out —
 * the issue's requirement is that identical *options* collapse into one entry,
 * and that renaming an entry can never fork it.
 */
export function copyTreeOptionsDedupeKey(options?: CopyTreeOptions): string {
  return stableArgsSha256(canonicalizeCopyTreeOptions(options));
}

/**
 * Fold a completed run into the project's history.
 *
 * Pure: takes the current newest-first list and returns a new one, never
 * mutating its input or the records inside it.
 *
 * On a dedupe hit the entry is bumped rather than duplicated — `runCount` rises,
 * `lastUsedAt` moves to now, and the mutable facts (options, source, worktree,
 * stats) adopt the newest run so a frequently-reused entry never shows stale
 * size or duration. `id` and `createdAt` survive, so the entry keeps its
 * identity for anything holding a reference to it.
 *
 * Name resolution is asymmetric on purpose: an explicit name overwrites (that
 * is what a rename looks like from here), while an absent one preserves
 * whatever is stored. Without that, the next unnamed run would quietly reset a
 * user-supplied name back to the derived label.
 */
export function applyCopyTreeRun(
  records: CopyTreeHistoryRecord[],
  input: CopyTreeHistoryAppendInput,
  stamp: { id: string; now: number }
): CopyTreeHistoryRecord[] {
  const dedupeKey = copyTreeOptionsDedupeKey(input.options);
  const existing = records.find((record) => record.dedupeKey === dedupeKey);
  const suppliedName = input.name?.trim();

  const updated: CopyTreeHistoryRecord = existing
    ? {
        ...existing,
        name: suppliedName ? resolveCopyTreeRunName(suppliedName, input.options) : existing.name,
        options: input.options,
        source: input.source,
        worktreeId: input.worktreeId,
        stats: input.stats,
        lastUsedAt: stamp.now,
        runCount: existing.runCount + 1,
      }
    : {
        id: stamp.id,
        dedupeKey,
        name: resolveCopyTreeRunName(input.name, input.options),
        options: input.options,
        source: input.source,
        worktreeId: input.worktreeId,
        stats: input.stats,
        createdAt: stamp.now,
        lastUsedAt: stamp.now,
        runCount: 1,
      };

  const rest = records.filter((record) => record.dedupeKey !== dedupeKey);
  // Front-load the touched record before sorting so it also wins ties — a
  // second run inside the same millisecond must not fall behind the entry it
  // just overtook. `sortCopyTreeHistory` is stable, so the position holds.
  return sortCopyTreeHistory([updated, ...rest]).slice(0, COPY_TREE_HISTORY_MAX_RECORDS);
}
