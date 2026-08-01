import path from "path";
import fs from "fs/promises";
import { createHash } from "crypto";
import { TimeoutError, withTimeout } from "../utils/withTimeout.js";
import { isPathInside } from "../../shared/utils/path.js";

/**
 * A change signal for paths no git watcher covers.
 *
 * Worktrees get their liveness from `GitFileWatcher`'s recursive
 * `@parcel/watcher` subscription in the workspace-host subprocess. A scratch
 * folder, a worktree-less project and a file picked from anywhere else on disk
 * have no host and no watcher, so the file surfaces that render them had no
 * tick to subscribe to at all (#11590).
 *
 * Rather than start a second native watcher — in Main, where a persistent
 * FSEvents/inotify thread is an app-quit teardown hazard and every existing
 * `@parcel/watcher` call site deliberately lives in a subprocess — this reduces
 * each watched path to a cheap fingerprint the renderer polls and diffs. The
 * poll IS the reconcile, so the two failure modes a watcher would bring with it
 * (silently dropped overflow events, and a subscription that cannot report the
 * deletion of its own root) simply don't exist here.
 */

/** Bounds a single hung `fs.stat`/`fs.readdir` — see `withTimeout`'s module comment. */
const FS_TIMEOUT_MS = 2_000;

/**
 * How many `stat`/`readdir` calls may be in flight at once.
 *
 * libuv's threadpool is 4 threads by default and `fs.stat` takes no
 * AbortSignal, so a timed-out call keeps its worker until the OS gives up.
 * Staying at or below the pool size means one wedged path can't starve
 * unrelated fs work process-wide.
 */
const FS_CONCURRENCY = 4;

/**
 * `null` means "nothing readable here" — absent, permission-denied, outside the
 * root, or a hung mount. It is a legitimate fingerprint value, not an error: a
 * path going from present to absent is exactly the change a caller wants to see,
 * and the root's own deletion registers the same way.
 */
export type PathFingerprint = string | null;

/**
 * An order-independent digest of a directory's entries.
 *
 * XOR and modular addition are both commutative, so folding each entry's own
 * hash makes `readdir`'s platform-dependent ordering irrelevant without paying
 * for a sort — which is what a per-poll digest of a wide directory would
 * otherwise cost. Entry names within a directory are unique, so the usual XOR
 * hazard of a duplicated pair cancelling out cannot arise, and the running sum
 * alongside it means two sets would have to collide under both folds at once.
 * This is cache invalidation, not authentication: a collision costs a missed
 * refresh, so incidental strength is enough and an adversary is not in scope.
 */
function digestEntries(entries: string[]): string {
  const accumulator = Buffer.alloc(20);
  let sum = 0n;
  for (const entry of entries) {
    const digest = createHash("sha1").update(entry).digest();
    for (let index = 0; index < accumulator.length; index++) {
      accumulator[index] ^= digest[index] as number;
    }
    sum = (sum + digest.readBigUInt64BE(0)) & 0xffffffffffffffffn;
  }
  return `${accumulator.toString("hex").slice(0, 16)}.${sum.toString(16)}`;
}

/**
 * Directories are fingerprinted by their direct children, not just `mtimeNs`.
 *
 * A directory's mtime moves when an entry is added or removed, which covers
 * most of what a file tree renders — but a rename that keeps the entry count
 * the same, or two operations inside one filesystem timestamp granule, can land
 * on an identical mtime. Digesting the `name` + entry-kind list closes that gap
 * for the one level the tree actually shows. Deliberately non-recursive: a
 * collapsed subtree isn't rendered, and re-expanding it re-reads from scratch
 * anyway.
 *
 * Every directory is digested regardless of width. An earlier revision skipped
 * the digest past a size threshold, which put the rename blind spot straight
 * back for exactly the wide build-output directories that threshold targeted —
 * and `readdir` has already paid the dominant enumeration cost by then.
 */
async function fingerprintDirectory(target: string, mtime: bigint): Promise<PathFingerprint> {
  const entries = await withTimeout(
    fs.readdir(target, { withFileTypes: true }),
    FS_TIMEOUT_MS,
    `readdir timed out: ${target}`
  );
  const names = entries.map((entry) => `${entry.name}/${entry.isDirectory() ? "d" : "f"}`);
  return `d:${mtime}:${entries.length}:${digestEntries(names)}`;
}

/**
 * `onHang` fires when a call under this path timed out, so the caller can put
 * the whole root on cooldown. A dead mount below a live root — a network share
 * inside a browsed folder, or the file a `FilePane` happens to hold — hangs here
 * while the root itself keeps answering instantly, and nothing in the root-level
 * probe would ever notice.
 */
async function fingerprintOne(
  target: string,
  rootRealPath: string,
  onHang: () => void
): Promise<PathFingerprint> {
  try {
    // Resolved before anything is read: `stat` follows symlinks — including
    // intermediate ones — so a symlink inside the root pointing out of it would
    // otherwise turn this into an existence probe for arbitrary paths. Same
    // containment model `files:read` applies to the read itself.
    const realPath = await withTimeout(
      fs.realpath(target),
      FS_TIMEOUT_MS,
      `realpath timed out: ${target}`
    );
    // `isPathInside` already answers true for the root itself, which the file
    // browser watches as its first path.
    if (!isPathInside(realPath, rootRealPath)) return null;

    // `bigint: true` for nanosecond mtimes: a second-resolution timestamp
    // cannot distinguish two writes inside the same second, which is the common
    // case when an agent rewrites a file it just wrote.
    const stats = await withTimeout(
      fs.stat(realPath, { bigint: true }),
      FS_TIMEOUT_MS,
      `stat timed out: ${target}`
    );

    if (stats.isDirectory()) return await fingerprintDirectory(realPath, stats.mtimeNs);
    // `ctimeNs` alongside `mtimeNs`: a tool that rewrites a file in place and
    // then restores its timestamps (`touch -r`, some generators) leaves mtime,
    // size and inode all identical, and only the inode-change time still moves.
    if (stats.isFile()) {
      return `f:${stats.mtimeNs}:${stats.ctimeNs}:${stats.size}:${stats.ino}`;
    }
    // A socket, fifo or device has no content the file surfaces can render.
    return null;
  } catch (error) {
    // Every failure folds to the same "nothing readable" value on purpose. The
    // caller is diffing successive samples, and distinguishing ENOENT from
    // EACCES from a dead mount would only let a transient permission blip read
    // as a change. A hang is still reported sideways, because giving up waiting
    // does not release the libuv worker the syscall is sitting on.
    if (error instanceof TimeoutError) onHang();
    return null;
  }
}

/**
 * How long a root that just hung is skipped outright.
 *
 * `withTimeout` bounds how long *we* wait, not the syscall — `fs.realpath` takes
 * no AbortSignal, so a timed-out call keeps its libuv worker until the OS gives
 * up, which on a disconnected SMB share is a minute or more. Callers poll every
 * couple of seconds, so without a cooldown a single dead mount would queue
 * dozens of orphaned probes against a four-thread pool and stall unrelated
 * filesystem work process-wide. One probe per window instead of thirty.
 */
const ROOT_COOLDOWN_MS = 30_000;

/** Root real path → the time its cooldown lapses. Only timeouts are recorded. */
const hungRoots = new Map<string, number>();

/**
 * Fingerprint each path in `paths`, in order, so a caller can detect change by
 * comparing successive results.
 *
 * Every path is confined to `rootPath`; anything resolving outside it comes back
 * `null` rather than throwing, so one bad entry can't discard the batch's answer
 * for the rest.
 */
export async function fingerprintPaths(
  rootPath: string,
  paths: readonly string[]
): Promise<PathFingerprint[]> {
  if (paths.length === 0) return [];
  if (!path.isAbsolute(rootPath)) return paths.map(() => null);

  // Swept on every call rather than only when the same root comes back: a root
  // that hung once and was then closed would otherwise sit in the map forever,
  // and the map is only ever as large as the set of roots that timed out inside
  // one cooldown window, so the walk is trivial.
  if (hungRoots.size > 0) {
    const now = Date.now();
    for (const [hungRoot, until] of hungRoots) {
      if (now >= until) hungRoots.delete(hungRoot);
    }
    // A remounted share therefore starts answering on its own rather than
    // staying dead until the app restarts.
    if (hungRoots.has(rootPath)) return paths.map(() => null);
  }

  const rootRealPath = await withTimeout(
    fs.realpath(rootPath),
    FS_TIMEOUT_MS,
    `realpath timed out: ${rootPath}`
  ).catch((error: unknown) => {
    // Only a hang earns a cooldown. A merely missing root is cheap to re-probe,
    // and suppressing it for half a minute would delay noticing it came back.
    if (error instanceof TimeoutError) hungRoots.set(rootPath, Date.now() + ROOT_COOLDOWN_MS);
    return null;
  });
  if (rootRealPath === null) return paths.map(() => null);

  const results: PathFingerprint[] = new Array<PathFingerprint>(paths.length).fill(null);
  let next = 0;
  // A fixed pool rather than `Promise.all` over every path: the batch is capped
  // at the IPC boundary, but even a capped batch issued at once would occupy
  // more libuv workers than the process has.
  const workers = Array.from({ length: Math.min(FS_CONCURRENCY, paths.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= paths.length) return;
      const target = paths[index];
      results[index] =
        target !== undefined && path.isAbsolute(target)
          ? await fingerprintOne(target, rootRealPath, () =>
              hungRoots.set(rootPath, Date.now() + ROOT_COOLDOWN_MS)
            )
          : null;
    }
  });
  await Promise.all(workers);
  return results;
}
