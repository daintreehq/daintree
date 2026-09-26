import path from "path";
import { watch as fsWatch, type FSWatcher } from "fs";
import { fingerprintPaths, type PathFingerprint } from "./pathFingerprint.js";

/**
 * Shared filesystem observation, so cost scales with the set of watched paths
 * rather than with the number of things watching them.
 *
 * Two surfaces sit here, both de-duplication over machinery that already
 * exists:
 *
 * - {@link sampleCoalesced} folds *concurrent* fingerprint requests for the
 *   same path onto one read. Every file surface polls on the same 2s cadence
 *   through one shared ticker (`useSharedPollTick`), so a window showing a
 *   dozen panes over one project issues its requests in the same task and they
 *   genuinely overlap.
 * - {@link watchShared} gives one `fs.watch` per resolved path no matter how
 *   many subscribers want it. `host.fs.watch` previously minted a watcher per
 *   plugin per path, so five plugins watching one worktree meant five native
 *   watchers and five sets of file descriptors for identical events.
 *
 * The polled fingerprint model is deliberately preserved — see
 * `pathFingerprint.ts`'s module comment for why the sample is its own reconcile
 * and why Main holds no persistent native watcher for it.
 *
 * **Only in-flight reads are shared; nothing is cached past completion.** An
 * earlier revision also memoised settled fingerprints for a short TTL, which
 * bought little once the pollers were phase-aligned and cost real correctness:
 * a caller polling on a different phase could be handed a value sampled before
 * its own request began and miss a change that happened and reverted in
 * between. Joining a read already in flight has a bounded, explainable version
 * of the same skew — you get the answer from a read that started at most one
 * batch ago — and that is the whole of the sharing this module does.
 */

/**
 * `${rootPath}\0${path}` → a read in flight that other callers may join.
 * Entries live only for the duration of the underlying batch.
 */
const pendingSamples = new Map<string, Promise<PathFingerprint>>();

function cacheKey(rootPath: string, target: string): string {
  // NUL cannot appear in either component — it is rejected by every path
  // validator upstream and is not a legal filename byte — so the join is
  // unambiguous without escaping.
  return `${rootPath}\0${target}`;
}

/**
 * Fingerprint `paths` under `rootPath`, joining any read of the same path that
 * is already in flight rather than issuing a second one.
 *
 * Contract is {@link fingerprintPaths}' exactly — same length, same order, same
 * `null` semantics, same containment — and a rejection still propagates to
 * every caller, so a non-filesystem failure surfaces rather than being folded
 * into a plausible-looking `null`.
 */
export async function sampleCoalesced(
  rootPath: string,
  paths: readonly string[]
): Promise<PathFingerprint[]> {
  if (paths.length === 0) return [];

  const results = new Array<PathFingerprint>(paths.length).fill(null);
  /** Index in `paths` → the promise that will settle it. */
  const awaited = new Map<number, Promise<PathFingerprint>>();
  /** Unique paths this call is responsible for reading, in read order. */
  const toRead: string[] = [];
  /** Read position in `toRead` → every index in `paths` wanting that value. */
  const readTargets = new Map<string, number[]>();

  for (let index = 0; index < paths.length; index++) {
    const target = paths[index];
    if (target === undefined) continue;
    const key = cacheKey(rootPath, target);

    const inFlight = pendingSamples.get(key);
    if (inFlight !== undefined) {
      awaited.set(index, inFlight);
      continue;
    }

    // Deduplicate within this call too: `[x, x]` must not ask the filesystem
    // twice. The pending map cannot do it, because entries are only installed
    // once the batch below exists.
    const already = readTargets.get(key);
    if (already !== undefined) {
      already.push(index);
      continue;
    }
    readTargets.set(key, [index]);
    toRead.push(target);
  }

  if (toRead.length > 0) {
    // One batch for everything this call owns: `fingerprintPaths` resolves the
    // root's realpath and checks its cooldown once per call, so splitting the
    // batch would pay that per path.
    const batch = fingerprintPaths(rootPath, toRead);
    // The batch promise is awaited below, but the per-path slices installed
    // into `pendingSamples` may end up with no joiner at all. Mark the batch
    // handled so a rejection cannot surface as an unhandled rejection while
    // still rejecting every caller that does await it.
    void batch.catch(() => {});

    // Install each path's slice before awaiting, so a caller arriving mid-read
    // joins this work rather than starting its own. The installed promise is
    // remembered so the cleanup below only removes entries this call owns.
    const installed = new Map<string, Promise<PathFingerprint>>();
    toRead.forEach((target, position) => {
      const key = cacheKey(rootPath, target);
      const slice = batch.then((values) => values[position] ?? null);
      void slice.catch(() => {});
      installed.set(key, slice);
      pendingSamples.set(key, slice);
    });

    try {
      const values = await batch;
      toRead.forEach((target, position) => {
        const value = values[position] ?? null;
        for (const index of readTargets.get(cacheKey(rootPath, target)) ?? []) {
          results[index] = value;
        }
      });
    } finally {
      // Only clear entries this call installed — a later call may already have
      // replaced one, and dropping that would strand its joiners.
      for (const [key, promise] of installed) {
        if (pendingSamples.get(key) === promise) pendingSamples.delete(key);
      }
    }
  }

  if (awaited.size > 0) {
    await Promise.all(
      Array.from(awaited, async ([index, promise]) => {
        results[index] = await promise;
      })
    );
  }

  return results;
}

/**
 * One registration. A record rather than the bare function so two subscriptions
 * passing the *same* function reference stay independent — a `Set` of functions
 * would collapse them, and then either disposer would close the watcher out
 * from under the other.
 */
interface WatchRegistration {
  readonly notify: (changedPath: string) => void;
}

interface SharedWatcher {
  /** Replaced in place by a rebind, so every disposer reaches the live handle. */
  watcher: FSWatcher;
  readonly registrations: Set<WatchRegistration>;
  readonly recursive: boolean;
  /**
   * Whether a failure of this watcher may still be repaired by rebinding its
   * registrations onto a fresh one. Cleared by the rebind so a path that fails
   * repeatedly cannot spin.
   */
  rebindable: boolean;
  /**
   * The `dev:ino` of the directory this watcher was opened on, when the
   * subscriber that created it knew it. `fs.watch` binds to the inode, not the
   * path, so this is what tells a watcher on a since-replaced directory apart
   * from one on the directory standing there now.
   */
  identity: string | undefined;
}

/**
 * {@link watcherKey} → the single watcher serving every subscriber of that path
 * in that mode. An entry superseded by a newer directory at the same path
 * leaves this map but lives on for the registrations it already holds.
 */
const sharedWatchers = new Map<string, SharedWatcher>();

/**
 * A recursive and a plain subscriber to one directory need different native
 * watchers: sharing the recursive one would hand the plain subscriber events
 * from every depth, and sharing the plain one would starve the recursive one.
 * NUL cannot appear in a path, so the suffix is unambiguous.
 */
function watcherKey(resolvedPath: string, recursive: boolean): string {
  return recursive ? `${resolvedPath}\0recursive` : resolvedPath;
}

function dispatch(registrations: Set<WatchRegistration>, changedPath: string): void {
  // Snapshot before dispatch: a listener that disposes itself while being
  // notified would otherwise mutate the set mid-iteration.
  for (const registration of Array.from(registrations)) {
    // ...but an entry the snapshot still holds may have been released by an
    // earlier listener in this same pass, and a released listener must not be
    // called again.
    if (!registrations.has(registration)) continue;
    try {
      registration.notify(changedPath);
    } catch (error) {
      console.error(`[FileObservationService] watch listener threw for ${changedPath}:`, error);
    }
  }
}

function openWatcher(
  resolvedPath: string,
  recursive: boolean,
  registrations: Set<WatchRegistration>,
  onError: (failed: FSWatcher) => void
): FSWatcher {
  // A recursive watch reports `filename` relative to the watched root at any
  // depth, so the same join yields the absolute changed path.
  const watcher = fsWatch(resolvedPath, { persistent: false, recursive }, (_event, filename) => {
    const changed =
      typeof filename === "string" && filename.length > 0
        ? path.join(resolvedPath, filename)
        : resolvedPath;
    dispatch(registrations, changed);
  });
  watcher.on("error", (error) => {
    console.error(`[FileObservationService] watch error for ${resolvedPath}:`, error);
    onError(watcher);
  });
  return watcher;
}

function createWatcher(
  resolvedPath: string,
  recursive: boolean,
  identity: string | undefined
): SharedWatcher {
  const registrations = new Set<WatchRegistration>();
  const entry: SharedWatcher = {
    watcher: openWatcher(resolvedPath, recursive, registrations, (failed) =>
      handleWatcherError(resolvedPath, entry, failed)
    ),
    registrations,
    recursive,
    rebindable: true,
    identity,
  };
  return entry;
}

/** Drop `entry` from the map, unless a newer entry has already taken its key. */
function detach(resolvedPath: string, entry: SharedWatcher): void {
  const key = watcherKey(resolvedPath, entry.recursive);
  if (sharedWatchers.get(key) === entry) sharedWatchers.delete(key);
}

/**
 * A shared watcher failing takes every subscriber of that path down with it,
 * which per-plugin watchers did not. Rather than leave them silently
 * subscribed to nothing, rebind them onto a fresh watcher once; if even that
 * fails the path is genuinely gone, which is itself a change worth reporting,
 * so they get one final notification before the entry is dropped.
 */
function handleWatcherError(resolvedPath: string, entry: SharedWatcher, failed: FSWatcher): void {
  // Already rebound, or torn down by its last disposer — nothing to repair.
  if (entry.watcher !== failed || entry.registrations.size === 0) return;

  try {
    failed.close();
  } catch {
    // best-effort
  }

  if (entry.rebindable) {
    try {
      // Rebinding in place keeps the registration set and every disposer
      // pointed at the live handle. The replacement is not itself rebindable:
      // a path whose watcher dies immediately must not spin creating
      // replacements. What it opens may not be the inode the failed one had,
      // so its identity is unknown.
      entry.watcher = openWatcher(resolvedPath, entry.recursive, entry.registrations, (next) =>
        handleWatcherError(resolvedPath, entry, next)
      );
      entry.rebindable = false;
      entry.identity = undefined;
      return;
    } catch {
      // Fall through to the final notification below.
    }
  }

  detach(resolvedPath, entry);
  dispatch(entry.registrations, resolvedPath);
}

/**
 * Watch one already-resolved, already-authorised absolute path, sharing a single
 * `fs.watch` with every other subscriber of the same path.
 *
 * Semantics are `fs.watch`'s: `{ persistent: false }`, the joined child path
 * when the platform reports a filename and the watched path otherwise.
 * Non-recursive unless `options.recursive` asks otherwise, in which case the
 * joined path is the changed entry at whatever depth it sits. Recursive and
 * plain subscribers of one path never share a native watcher. Callers are responsible for containment and capability checks
 * before calling — this module deliberately knows nothing about plugin scopes.
 *
 * Every call is an independent registration, including two calls passing the
 * same listener function, and each returns its own disposer. The underlying
 * watcher is closed when the last registration leaves.
 *
 * `options.identity` is the `dev:ino` the caller just saw at the path. A caller
 * passing one only joins a watcher known to be on that same directory;
 * otherwise it gets a fresh watcher that takes over the path's entry, and the
 * superseded one lives on only for the registrations it already has. Without
 * it, a subscriber re-attaching after a directory was replaced would join the
 * watcher another subscriber keeps alive on the old inode.
 *
 * One native handle fanned out to N subscribers cannot reproduce N handles'
 * exact event count, ordering or failure independence. `fs.watch` is a
 * best-effort stream regardless, so callbacks must be treated as invalidation
 * hints that prompt a re-read, never as a complete event log.
 */
export function watchShared(
  resolvedPath: string,
  listener: (changedPath: string) => void,
  options?: { recursive?: boolean; identity?: string }
): () => void {
  const recursive = options?.recursive === true;
  const identity = options?.identity;
  const key = watcherKey(resolvedPath, recursive);
  let entry = sharedWatchers.get(key);

  if (entry === undefined || (identity !== undefined && entry.identity !== identity)) {
    // `fsWatch` throws synchronously for a missing path; that propagates to the
    // caller exactly as it did when each caller made its own watcher.
    entry = createWatcher(resolvedPath, recursive, identity);
    sharedWatchers.set(key, entry);
  }

  const owner = entry;
  const registration: WatchRegistration = { notify: listener };
  owner.registrations.add(registration);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    owner.registrations.delete(registration);
    if (owner.registrations.size > 0) return;
    detach(resolvedPath, owner);
    try {
      owner.watcher.close();
    } catch {
      // best-effort
    }
  };
}

/** Live shared-watcher count. Diagnostics and tests only. */
export function sharedWatcherCount(): number {
  return sharedWatchers.size;
}

/** Total registrations across every shared watcher. Diagnostics and tests only. */
export function sharedWatcherListenerCount(): number {
  let total = 0;
  for (const entry of sharedWatchers.values()) total += entry.registrations.size;
  return total;
}

/** Drops every in-flight sample record. Tests only. */
export function __resetSampleCacheForTests(): void {
  pendingSamples.clear();
}
