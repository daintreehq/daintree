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
  readonly watcher: FSWatcher;
  readonly registrations: Set<WatchRegistration>;
  /**
   * Whether a failure of this watcher may still be repaired by rebinding its
   * registrations onto a fresh one. Cleared on the replacement so a path that
   * fails repeatedly cannot spin.
   */
  readonly rebindable: boolean;
}

/** Resolved absolute path → the single watcher serving every subscriber of it. */
const sharedWatchers = new Map<string, SharedWatcher>();

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

function createWatcher(
  resolvedPath: string,
  registrations: Set<WatchRegistration>,
  rebindable: boolean
): SharedWatcher {
  const watcher = fsWatch(resolvedPath, { persistent: false }, (_event, filename) => {
    const changed =
      typeof filename === "string" && filename.length > 0
        ? path.join(resolvedPath, filename)
        : resolvedPath;
    dispatch(registrations, changed);
  });
  const entry: SharedWatcher = { watcher, registrations, rebindable };
  watcher.on("error", (error) => {
    console.error(`[FileObservationService] watch error for ${resolvedPath}:`, error);
    handleWatcherError(resolvedPath, entry, watcher);
  });
  return entry;
}

/**
 * A shared watcher failing takes every subscriber of that path down with it,
 * which per-plugin watchers did not. Rather than leave them silently
 * subscribed to nothing, rebind them onto a fresh watcher once; if even that
 * fails the path is genuinely gone, which is itself a change worth reporting,
 * so they get one final notification before the entry is dropped.
 */
function handleWatcherError(resolvedPath: string, entry: SharedWatcher, failed: FSWatcher): void {
  // Already replaced or torn down by someone else — nothing to repair.
  if (sharedWatchers.get(resolvedPath) !== entry || entry.watcher !== failed) return;

  sharedWatchers.delete(resolvedPath);
  try {
    failed.close();
  } catch {
    // best-effort
  }

  if (entry.registrations.size === 0) return;

  if (entry.rebindable) {
    try {
      // The replacement carries the same registration set, so live subscribers
      // keep receiving events and their existing disposers keep working. It is
      // not itself rebindable: a path whose watcher dies immediately must not
      // spin creating replacements.
      sharedWatchers.set(resolvedPath, createWatcher(resolvedPath, entry.registrations, false));
      return;
    } catch {
      // Fall through to the final notification below.
    }
  }

  dispatch(entry.registrations, resolvedPath);
}

/**
 * Watch one already-resolved, already-authorised absolute path, sharing a single
 * `fs.watch` with every other subscriber of the same path.
 *
 * Semantics are `fs.watch`'s: non-recursive, `{ persistent: false }`, the joined
 * child path when the platform reports a filename and the watched path
 * otherwise. Callers are responsible for containment and capability checks
 * before calling — this module deliberately knows nothing about plugin scopes.
 *
 * Every call is an independent registration, including two calls passing the
 * same listener function, and each returns its own disposer. The underlying
 * watcher is closed when the last registration leaves.
 *
 * One native handle fanned out to N subscribers cannot reproduce N handles'
 * exact event count, ordering or failure independence. `fs.watch` is a
 * best-effort stream regardless, so callbacks must be treated as invalidation
 * hints that prompt a re-read, never as a complete event log.
 */
export function watchShared(
  resolvedPath: string,
  listener: (changedPath: string) => void
): () => void {
  let entry = sharedWatchers.get(resolvedPath);

  if (entry === undefined) {
    // `fsWatch` throws synchronously for a missing path; that propagates to the
    // caller exactly as it did when each caller made its own watcher.
    entry = createWatcher(resolvedPath, new Set<WatchRegistration>(), true);
    sharedWatchers.set(resolvedPath, entry);
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
    // The registration set survives a rebind, so the live entry for this path
    // may be a replacement carrying the same set. Close whichever watcher is
    // current, and only drop the map entry if it is still one of ours.
    const current = sharedWatchers.get(resolvedPath);
    const live = current?.registrations === owner.registrations ? current : owner;
    if (current === live) sharedWatchers.delete(resolvedPath);
    try {
      live.watcher.close();
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
