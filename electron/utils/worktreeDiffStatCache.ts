/**
 * Per-worktree retention of `git diff --numstat` results and untracked-file
 * line counts across status passes.
 *
 * One workspace host serves every worktree of a project, so a single shared
 * LRU let each worktree's pass evict the entries its siblings needed, and a
 * pass over a changeset larger than the LRU evicted its own next pass's hits.
 * Here every worktree root owns a partition holding exactly one entry per
 * dirty path: each completed pass replaces it with the identities it just
 * saw, so old identities of a re-edited path and paths that left the dirty
 * set are dropped, and no pass ever touches a sibling's partition.
 *
 * Memory is bounded by entry and estimated-byte caps per partition, a global
 * byte cap and a partition count. Past a cap the pass keeps a deterministic
 * prefix of its paths and stops admitting more; it never evicts another
 * partition to make room. Uncached paths are simply re-diffed, so results stay
 * exact whatever is retained.
 */

export interface DiffStatCounts {
  insertions: number | null;
  deletions: number | null;
}

export interface TrackedDiffIdentity {
  headOid: string;
  statusCode: string;
  mtimeMs: number;
  size: number;
}

interface TrackedEntry extends TrackedDiffIdentity {
  stat: DiffStatCounts;
}

interface UntrackedEntry {
  mtimeMs: number;
  size: number;
  insertions: number;
}

interface Partition {
  tracked: Map<string, TrackedEntry>;
  untracked: Map<string, UntrackedEntry>;
  bytes: number;
  publishedSeq: number;
}

export interface DiffStatCacheLimits {
  maxTrackedPerWorktree: number;
  maxUntrackedPerWorktree: number;
  maxBytesPerWorktree: number;
  maxTotalBytes: number;
  maxWorktrees: number;
}

// 10,000 covers the codemod/formatter-run sizes the cache exists for; 200
// untracked matches the status pass's own enrichment ceiling.
const DEFAULT_LIMITS: DiffStatCacheLimits = {
  maxTrackedPerWorktree: 10_000,
  maxUntrackedPerWorktree: 200,
  maxBytesPerWorktree: 4 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxWorktrees: 64,
};

// An estimate, not a heap reading: map slot, entry and stat objects, and the
// status-code string, plus two bytes per path code unit (the path is the only
// per-entry string of unbounded length; the HEAD OID is shared by the pass).
const ENTRY_OVERHEAD_BYTES = 160;
const PARTITION_OVERHEAD_BYTES = 256;

function entryBytes(path: string): number {
  return ENTRY_OVERHEAD_BYTES + path.length * 2;
}

let limits: DiffStatCacheLimits = DEFAULT_LIMITS;
const partitions = new Map<string, Partition>();
let totalBytes = 0;
let nextSeq = 0;
// Bumped by every release or clear, so a pass that began before it cannot
// publish afterwards and resurrect what was just dropped.
let epoch = 0;

export interface DiffStatPass {
  lookupTracked(absolutePath: string, identity: TrackedDiffIdentity): DiffStatCounts | undefined;
  keepTracked(absolutePath: string, identity: TrackedDiffIdentity, stat: DiffStatCounts): void;
  lookupUntracked(absolutePath: string, mtimeMs: number, size: number): number | undefined;
  keepUntracked(absolutePath: string, mtimeMs: number, size: number, insertions: number): void;
  /** Replace the worktree's retained entries with what this pass kept. */
  publish(): void;
}

/**
 * Start reading and collecting one status pass's entries for `root` (the
 * canonical worktree toplevel). Nothing is retained until `publish()`; an
 * abandoned pass leaves the previous snapshot untouched.
 */
export function beginDiffStatPass(root: string): DiffStatPass {
  const seq = ++nextSeq;
  const startEpoch = epoch;
  const previous = partitions.get(root);
  const nextTracked = new Map<string, TrackedEntry>();
  const nextUntracked = new Map<string, UntrackedEntry>();

  return {
    lookupTracked(absolutePath, identity) {
      const entry = previous?.tracked.get(absolutePath);
      if (
        !entry ||
        entry.headOid !== identity.headOid ||
        entry.statusCode !== identity.statusCode ||
        entry.mtimeMs !== identity.mtimeMs ||
        entry.size !== identity.size
      ) {
        return undefined;
      }
      return entry.stat;
    },
    keepTracked(absolutePath, identity, stat) {
      nextTracked.set(absolutePath, {
        headOid: identity.headOid,
        statusCode: identity.statusCode,
        mtimeMs: identity.mtimeMs,
        size: identity.size,
        stat,
      });
    },
    lookupUntracked(absolutePath, mtimeMs, size) {
      const entry = previous?.untracked.get(absolutePath);
      if (!entry || entry.mtimeMs !== mtimeMs || entry.size !== size) return undefined;
      return entry.insertions;
    },
    keepUntracked(absolutePath, mtimeMs, size, insertions) {
      nextUntracked.set(absolutePath, { mtimeMs, size, insertions });
    },
    publish() {
      if (epoch !== startEpoch) return;
      const current = partitions.get(root);
      // Passes for one worktree can overlap (different cancellation owners);
      // a slower, older pass must not replace a newer pass's snapshot.
      if (current && current.publishedSeq > seq) return;
      publishPartition(root, current, seq, nextTracked, nextUntracked);
    },
  };
}

function publishPartition(
  root: string,
  current: Partition | undefined,
  seq: number,
  nextTracked: Map<string, TrackedEntry>,
  nextUntracked: Map<string, UntrackedEntry>
): void {
  const currentBytes = current?.bytes ?? 0;
  if (nextTracked.size === 0 && nextUntracked.size === 0) {
    // A clean worktree frees its slot instead of holding an empty partition.
    if (current) {
      partitions.delete(root);
      totalBytes -= currentBytes;
    }
    return;
  }
  if (!current && partitions.size >= limits.maxWorktrees) return;

  // Growth draws only on free global capacity, never on a sibling's bytes.
  const budget = Math.min(
    limits.maxBytesPerWorktree,
    limits.maxTotalBytes - (totalBytes - currentBytes)
  );
  let bytes = PARTITION_OVERHEAD_BYTES + root.length * 2;
  if (bytes > budget) {
    if (current) {
      partitions.delete(root);
      totalBytes -= currentBytes;
    }
    return;
  }

  // Insertion order is the pass's traversal order, so truncation keeps a
  // stable prefix: the same paths stay cached pass after pass instead of
  // churning at the boundary.
  const tracked = new Map<string, TrackedEntry>();
  for (const [path, entry] of nextTracked) {
    if (tracked.size >= limits.maxTrackedPerWorktree) break;
    const cost = entryBytes(path);
    if (bytes + cost > budget) break;
    tracked.set(path, entry);
    bytes += cost;
  }
  const untracked = new Map<string, UntrackedEntry>();
  for (const [path, entry] of nextUntracked) {
    if (untracked.size >= limits.maxUntrackedPerWorktree) break;
    const cost = entryBytes(path);
    if (bytes + cost > budget) break;
    untracked.set(path, entry);
    bytes += cost;
  }

  partitions.set(root, { tracked, untracked, bytes, publishedSeq: seq });
  totalBytes += bytes - currentBytes;
}

/** Drop one worktree's retained entries (worktree removed or no longer monitored). */
export function releaseWorktreeDiffStats(root: string): void {
  epoch++;
  const partition = partitions.get(root);
  if (!partition) return;
  partitions.delete(root);
  totalBytes -= partition.bytes;
}

export function clearWorktreeDiffStatCache(): void {
  epoch++;
  partitions.clear();
  totalBytes = 0;
}

export interface DiffStatCacheStats {
  worktrees: number;
  trackedEntries: number;
  untrackedEntries: number;
  estimatedBytes: number;
}

export function getWorktreeDiffStatCacheStats(): DiffStatCacheStats {
  let trackedEntries = 0;
  let untrackedEntries = 0;
  for (const partition of partitions.values()) {
    trackedEntries += partition.tracked.size;
    untrackedEntries += partition.untracked.size;
  }
  return {
    worktrees: partitions.size,
    trackedEntries,
    untrackedEntries,
    estimatedBytes: totalBytes,
  };
}

/** Test-only: shrink the caps so their edges are reachable; `undefined` restores defaults. */
export function __setDiffStatCacheLimitsForTesting(overrides?: Partial<DiffStatCacheLimits>): void {
  limits = overrides ? { ...DEFAULT_LIMITS, ...overrides } : DEFAULT_LIMITS;
}
