import { useState } from "react";
import type { WorktreeChangedDirs } from "@/store/createWorktreeStore";

/**
 * The worktree-change inputs one open file needs to decide whether a tick is
 * about it: the combined tick, the git-status half of it, and the directories
 * behind the latest raw-filesystem burst (#12244).
 */
export interface FileChangeSignal {
  tick: number | undefined;
  gitTick: number | undefined;
  changedDirs: WorktreeChangedDirs | undefined;
}

interface Cursor {
  trigger: unknown;
  at: number | undefined;
  gitTick: number | undefined;
  count: number;
}

function foldPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/**
 * Whether a tick could have changed the file at `relativePath`. The same
 * bail-outs as the file tree's `scopeForTick`: anything short of a described
 * burst whose stamp is the tick that moved, chained to the last burst this
 * consumer saw, with no git-status pass in between, answers "re-read".
 *
 * A change in any ANCESTOR of the file's directory counts too, not only the
 * directory itself: the watcher reports a renamed or deleted directory under
 * its parent and nothing under it, so a rename two levels up names only the
 * grandparent. The comparison is case-insensitive because a false match only
 * costs a read, while a missed one leaves stale content on screen.
 */
export function tickMayTouchFile(
  signal: FileChangeSignal,
  lastAt: number | undefined,
  lastGitTick: number | undefined,
  relativePath: string
): boolean {
  const record = signal.changedDirs;
  if (record === undefined || record.dirs === null) return true;
  if (record.at !== signal.tick) return true;
  if (signal.gitTick !== lastGitTick) return true;
  if (lastAt === undefined || record.previousAt !== lastAt) return true;
  const path = foldPath(relativePath);
  const slash = path.lastIndexOf("/");
  const parent = slash === -1 ? "" : path.slice(0, slash);
  return record.dirs.some((dir) => {
    const candidate = foldPath(dir);
    return candidate === "" || candidate === parent || parent.startsWith(`${candidate}/`);
  });
}

/**
 * A counter that advances once for every move of `trigger` that could have
 * changed the open file — the read trigger for a viewer that would otherwise
 * re-read on every write anywhere in the worktree.
 *
 * `relativePath` is the file's worktree-relative path, or null when it has no
 * containing worktree (every tick counts). `scopable` is the caller's own veto:
 * false whenever the directories the watcher names might not be the ones the
 * file is read through (a symlinked ancestor), or when a re-read is wanted
 * regardless (the last read failed and any tick is a chance to recover).
 *
 * The cursor starts at whatever record is current on mount, because mounting
 * reads the file explicitly and so covers every burst up to it.
 */
export function useFileChangeCount(
  trigger: unknown,
  signal: FileChangeSignal | undefined,
  relativePath: string | null,
  scopable: boolean
): number {
  const [cursor, setCursor] = useState<Cursor>(() => ({
    trigger,
    at: signal?.changedDirs?.at,
    gitTick: signal?.gitTick,
    count: 0,
  }));
  if (Object.is(trigger, cursor.trigger)) return cursor.count;
  const touches =
    signal === undefined ||
    !relativePath ||
    !scopable ||
    tickMayTouchFile(signal, cursor.at, cursor.gitTick, relativePath);
  const next: Cursor = {
    trigger,
    at: signal?.changedDirs?.at,
    gitTick: signal?.gitTick,
    count: touches ? cursor.count + 1 : cursor.count,
  };
  setCursor(next);
  return next.count;
}
