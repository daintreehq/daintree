import type { WorktreeSnapshot, WorktreeTick } from "../types/workspace-host.js";

/**
 * Snapshot fields that advance on events which change nothing else — a quiet
 * status poll, a raw watcher flush, the build time itself. The renderer keeps
 * all but `timestamp` in side maps rather than on the row (see
 * `createWorktreeStore`), so a snapshot that differs from the last one sent
 * only here travels as a {@link WorktreeTick} instead of a full re-send.
 */
export const WORKTREE_SNAPSHOT_VOLATILE_KEYS = [
  "timestamp",
  "lastGitStatusCheckedAt",
  "workingTreeChangedAt",
  "workingTreeChangedDirs",
] as const satisfies readonly (keyof WorktreeSnapshot)[];

const VOLATILE_KEYS: ReadonlySet<string> = new Set(WORKTREE_SNAPSHOT_VOLATILE_KEYS);

function isPlainRecord(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valuesEqual(a[i], b[i])) return false;
    }
    return true;
  }
  // Anything but a plain record (a Date, a Map) compares by identity only, so
  // an unexpected type errs toward sending the snapshot whole.
  if (Array.isArray(b) || !isPlainRecord(a) || !isPlainRecord(b)) return false;
  return recordsEqual(a, b, null);
}

// Own keys only. An absent key and a key holding `undefined` compare equal:
// both clone to the same observable value for every reader.
function recordsEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  skip: ReadonlySet<string> | null
): boolean {
  for (const key of Object.keys(a)) {
    if (skip?.has(key)) continue;
    if (!valuesEqual(a[key], Object.hasOwn(b, key) ? b[key] : undefined)) return false;
  }
  for (const key of Object.keys(b)) {
    if (skip?.has(key) || Object.hasOwn(a, key)) continue;
    if (b[key] !== undefined) return false;
  }
  return true;
}

/**
 * Structural equality over every snapshot field except the volatile stamps.
 * Deliberately exhaustive rather than a field list, so a field added to
 * `WorktreeSnapshot` later can never be silently dropped from the wire.
 */
export function worktreeSnapshotContentEqual(a: WorktreeSnapshot, b: WorktreeSnapshot): boolean {
  return recordsEqual(
    a as unknown as Record<string, unknown>,
    b as unknown as Record<string, unknown>,
    VOLATILE_KEYS
  );
}

export function toWorktreeTick(snapshot: WorktreeSnapshot): WorktreeTick {
  return {
    worktreeId: snapshot.id,
    path: snapshot.path,
    generation: snapshot.generation,
    timestamp: snapshot.timestamp,
    lastGitStatusCheckedAt: snapshot.lastGitStatusCheckedAt,
    workingTreeChangedAt: snapshot.workingTreeChangedAt,
    workingTreeChangedDirs: snapshot.workingTreeChangedDirs,
  };
}

/** Rebuild the full snapshot a tick stands for from the last full one. */
export function applyWorktreeTick(base: WorktreeSnapshot, tick: WorktreeTick): WorktreeSnapshot {
  return {
    ...base,
    timestamp: tick.timestamp,
    lastGitStatusCheckedAt: tick.lastGitStatusCheckedAt,
    workingTreeChangedAt: tick.workingTreeChangedAt,
    workingTreeChangedDirs: tick.workingTreeChangedDirs,
  };
}

/** A tick only applies to the monitor incarnation whose snapshot it amends. */
export function worktreeTickMatches(base: WorktreeSnapshot, tick: WorktreeTick): boolean {
  return base.id === tick.worktreeId && base.generation === tick.generation;
}
