import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FileTreeNode } from "@shared/types";
import { fileBrowserClient } from "@/clients/fileBrowserClient";
import { logError } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { flattenTree, pruneListings, refreshTargets, type FlatTreeRow } from "./fileBrowserTree";

/**
 * Ceiling on directory listings in flight at once.
 *
 * A restored panel can carry hundreds of expanded directories, and firing all
 * of them the instant the root lands would both blow past the IPC channel's
 * rate limit — failing the overflow outright — and hand the workspace host a
 * `git check-ignore` child process per request. Queuing keeps a wide tree slow
 * rather than broken.
 */
const MAX_CONCURRENT_LISTINGS = 6;

export interface UseFileBrowserTreeArgs {
  worktreeId: string | undefined;
  expandedPaths: readonly string[];
  showIgnored: boolean;
  /**
   * Ticks whenever the worktree's change set is recomputed. Already coalesced
   * upstream by the worktree watcher's adaptive burst debounce, so a bulk write
   * (`npm install`, a generated asset batch) arrives as one tick rather than
   * hundreds — the tree does not need its own debounce on top.
   */
  changeTick: number | undefined;
}

export interface UseFileBrowserTreeResult {
  rows: FlatTreeRow[];
  /** True only before the root listing has ever resolved. */
  isInitialLoading: boolean;
  /** Set when the root listing failed; per-directory failures are silent. */
  rootError: string | null;
  /** Fetch a directory if it isn't already loaded or in flight. */
  ensureLoaded: (dirPath: string) => void;
  /** Re-list the root and every reachable expanded directory. */
  refresh: () => void;
}

interface QueueEntry {
  dirPath: string;
  generation: number;
}

/**
 * Owns the lazily-fetched directory listings behind the tree.
 *
 * Listings are component state rather than panel data: they are a cache of the
 * filesystem, not user intent. Expansion and selection — the parts the user
 * chose — live in the panel record so they survive both persistence and the
 * dialog → grid promotion, which remounts this hook under the same panel id.
 */
export function useFileBrowserTree({
  worktreeId,
  expandedPaths,
  showIgnored,
  changeTick,
}: UseFileBrowserTreeArgs): UseFileBrowserTreeResult {
  const [listings, setListings] = useState<Map<string, readonly FileTreeNode[]>>(new Map());
  const [loadingPaths, setLoadingPaths] = useState<ReadonlySet<string>>(new Set());
  const [rootError, setRootError] = useState<string | null>(null);
  const [hasLoadedRoot, setHasLoadedRoot] = useState(false);

  // Generation counter, bumped whenever the identity of what we are listing
  // changes (worktree switch, ignored-filter flip). Every in-flight response
  // carries the generation it was issued under and is dropped if it no longer
  // matches, so a slow listing from the previous worktree can't land in the
  // new one's tree.
  const generationRef = useRef(0);
  const listingsRef = useRef(listings);

  // Keyed by directory path, valued by the generation that issued the request.
  // A bare Set would let a stale generation's cleanup delete the *current*
  // generation's marker, losing deduplication and letting two accepted
  // responses for the same directory land out of order.
  const inFlightRef = useRef<Map<string, number>>(new Map());
  const queueRef = useRef<QueueEntry[]>([]);

  // Requests physically outstanding, regardless of generation. `inFlightRef` is
  // cleared on an identity reset while those requests are still running, so
  // counting it would let a worktree switch start a second full batch on top of
  // the one still in the air.
  const physicalInFlightRef = useRef(0);

  // Set on unmount. Closing or promoting a panel with a deep queue would
  // otherwise keep pumping it — spending the channel's shared budget on a tree
  // nobody is looking at, and racing the replacement panel's own requests.
  const disposedRef = useRef(false);

  const expandedSet = useMemo(() => new Set(expandedPaths), [expandedPaths]);
  const expandedSetRef = useRef(expandedSet);

  // Set when a refresh could not run because its targets were already in
  // flight. Without it, a tick that arrives mid-flight is consumed by a request
  // that had already read the filesystem, and the tree stays stale until the
  // user touches it.
  const refreshPendingRef = useRef(false);

  // `pump` and `fetchDirectory` call each other: a settled request pumps the
  // queue, and the queue starts requests. Routing one direction through a
  // latest-value ref breaks the definition cycle without letting either side
  // capture a stale closure.
  const pumpRef = useRef<() => void>(() => {});

  const fetchDirectory = useCallback(
    async (dirPath: string, generation: number): Promise<void> => {
      if (!worktreeId || disposedRef.current) return;
      inFlightRef.current.set(dirPath, generation);
      physicalInFlightRef.current += 1;
      setLoadingPaths((previous) => {
        const next = new Set(previous);
        next.add(dirPath);
        return next;
      });

      try {
        const nodes = await fileBrowserClient.listDirectory({
          worktreeId,
          ...(dirPath !== "" && { dirPath }),
          ...(showIgnored && { includeIgnored: true }),
        });
        if (generation !== generationRef.current) return;

        // A directory collapsed while its listing was in flight has already
        // been pruned; re-inserting it here would resurrect a cache entry the
        // user closed, and re-expanding later would show that stale snapshot
        // instead of re-reading.
        if (dirPath !== "" && !expandedSetRef.current.has(dirPath)) return;

        setListings((previous) => {
          const next = new Map(previous);
          next.set(dirPath, nodes);
          return next;
        });
        if (dirPath === "") {
          setRootError(null);
          setHasLoadedRoot(true);
        }
      } catch (error) {
        if (generation !== generationRef.current) return;
        if (dirPath === "") {
          // Only the root surfaces an error: it is the difference between "the
          // browser works" and "it doesn't". A single directory that failed
          // (deleted mid-expand, permissions) just stays unloaded, and the next
          // refresh retries it.
          setRootError(formatErrorMessage(error, "Couldn't read this worktree"));
          setHasLoadedRoot(true);
        } else {
          logError("[fileBrowser] failed to list directory", error);
        }
      } finally {
        physicalInFlightRef.current -= 1;
        // Only clear our own marker: a newer generation may have re-requested
        // this directory while we were in flight.
        if (inFlightRef.current.get(dirPath) === generation) {
          inFlightRef.current.delete(dirPath);
        }
        if (generation === generationRef.current) {
          setLoadingPaths((previous) => {
            if (!previous.has(dirPath)) return previous;
            const next = new Set(previous);
            next.delete(dirPath);
            return next;
          });
        }
        pumpRef.current();
      }
    },
    [worktreeId, showIgnored]
  );

  const enqueueTargets = useCallback((targets: readonly string[], generation: number): void => {
    for (const dirPath of targets) {
      if (inFlightRef.current.has(dirPath)) continue;
      if (queueRef.current.some((entry) => entry.dirPath === dirPath)) continue;
      queueRef.current.push({ dirPath, generation });
    }
  }, []);

  const pump = useCallback((): void => {
    if (disposedRef.current) return;
    while (physicalInFlightRef.current < MAX_CONCURRENT_LISTINGS) {
      const next = queueRef.current.shift();
      if (!next) break;
      // Dropped rather than run: the queue can outlive the identity it was
      // built for, and requesting the old worktree's directories would only
      // produce responses the generation guard throws away.
      if (next.generation !== generationRef.current) continue;
      if (inFlightRef.current.has(next.dirPath)) continue;
      void fetchDirectory(next.dirPath, next.generation);
    }

    // A refresh that collided with in-flight work runs once the queue drains.
    if (
      refreshPendingRef.current &&
      physicalInFlightRef.current === 0 &&
      queueRef.current.length === 0
    ) {
      refreshPendingRef.current = false;
      const generation = generationRef.current;
      enqueueTargets(refreshTargets(listingsRef.current, expandedSetRef.current), generation);
      pumpRef.current();
    }
  }, [fetchDirectory, enqueueTargets]);

  // Published in a layout effect, never during render: an abandoned concurrent
  // render would otherwise publish a pump (and an expansion set) belonging to a
  // worktree the committed UI never switched to, and a request settling in that
  // window would act on it. Layout effects run before the passive effects that
  // start any request, so the refs are always current by the time one settles.
  useLayoutEffect(() => {
    listingsRef.current = listings;
    expandedSetRef.current = expandedSet;
    pumpRef.current = pump;
  }, [listings, expandedSet, pump]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      queueRef.current = [];
      refreshPendingRef.current = false;
      // Invalidate everything still in the air so a late response can't commit
      // into a store the panel no longer owns.
      generationRef.current += 1;
    };
  }, []);

  const ensureLoaded = useCallback(
    (dirPath: string): void => {
      if (listingsRef.current.has(dirPath)) return;
      enqueueTargets([dirPath], generationRef.current);
      pump();
    },
    [enqueueTargets, pump]
  );

  const refresh = useCallback((): void => {
    const generation = generationRef.current;
    const targets = refreshTargets(listingsRef.current, expandedSetRef.current);
    // A target already in flight read the filesystem before this refresh was
    // asked for, so its result may not reflect the change that triggered us.
    // Defer rather than accept that response as final.
    if (targets.some((target) => inFlightRef.current.has(target))) {
      refreshPendingRef.current = true;
    }
    enqueueTargets(targets, generation);
    pump();
  }, [enqueueTargets, pump]);

  // Identity reset. Flipping the ignored filter changes what every listing
  // contains, not just the root, so the whole cache is dropped rather than
  // patched — a partial cache would show ignored entries in the folders that
  // happened to reload and hide them everywhere else.
  useEffect(() => {
    generationRef.current += 1;
    inFlightRef.current.clear();
    queueRef.current = [];
    refreshPendingRef.current = false;
    setListings(new Map());
    setLoadingPaths(new Set());
    setRootError(null);
    setHasLoadedRoot(false);
    if (!worktreeId) return;
    void fetchDirectory("", generationRef.current);
  }, [worktreeId, showIgnored, fetchDirectory]);

  // Expanding a directory is what triggers its fetch; a restored panel expands
  // several at once, and each is requested the first time it becomes visible.
  // Gated on the root having landed for this generation so an expansion can't
  // be judged reachable against the previous identity's listings.
  useEffect(() => {
    if (!hasLoadedRoot) return;
    const pendingTargets: string[] = [];
    for (const dirPath of expandedSet) {
      if (listings.has(dirPath) || inFlightRef.current.has(dirPath)) continue;
      // Only fetch directories the tree can actually reach. A persisted
      // expansion whose parent is collapsed (or gone) would otherwise fire a
      // request for a folder the user cannot see.
      if (!isReachable(listings, expandedSet, dirPath)) continue;
      pendingTargets.push(dirPath);
    }
    if (pendingTargets.length === 0) return;
    enqueueTargets(pendingTargets, generationRef.current);
    pump();
  }, [expandedSet, listings, hasLoadedRoot, enqueueTargets, pump]);

  // Forget collapsed subtrees so re-expanding re-reads rather than replaying a
  // listing that may be minutes stale on an actively-written worktree.
  useEffect(() => {
    setListings((previous) => {
      const next = pruneListings(previous, expandedSet);
      return next.size === previous.size ? previous : next;
    });
  }, [expandedSet]);

  // Live updates. The tick is the worktree's own change signal, so this
  // inherits its coalescing.
  const lastTickRef = useRef(changeTick);
  useEffect(() => {
    if (changeTick === lastTickRef.current) return;
    // Deliberately does NOT record the tick: the initial listing is still in
    // flight, so consuming it here would let that pre-change response stand as
    // final. `hasLoadedRoot` is a dependency, so this re-runs when it lands.
    if (!hasLoadedRoot) return;
    lastTickRef.current = changeTick;
    refresh();
  }, [changeTick, hasLoadedRoot, refresh]);

  const rows = useMemo(
    () => flattenTree(listings, expandedSet, loadingPaths),
    [listings, expandedSet, loadingPaths]
  );

  return {
    rows,
    isInitialLoading: Boolean(worktreeId) && !hasLoadedRoot,
    rootError,
    ensureLoaded,
    refresh,
  };
}

/**
 * Whether `dirPath` sits under a chain of loaded, expanded directories rooted
 * at the browser root — i.e. whether a row for it is (or is about to be) on
 * screen.
 */
function isReachable(
  listings: ReadonlyMap<string, readonly FileTreeNode[]>,
  expandedPaths: ReadonlySet<string>,
  dirPath: string
): boolean {
  const segments = dirPath.split("/").filter(Boolean);
  let parent = "";
  for (let i = 0; i < segments.length; i += 1) {
    const children = listings.get(parent);
    if (!children) return false;
    const current = segments.slice(0, i + 1).join("/");
    if (!children.some((node) => node.isDirectory && node.path === current)) return false;
    // Every directory on the way down except the target itself must also be
    // expanded, otherwise the target is hidden inside a collapsed branch.
    if (i < segments.length - 1 && !expandedPaths.has(current)) return false;
    parent = current;
  }
  return segments.length > 0;
}
