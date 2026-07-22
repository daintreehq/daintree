import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileTreeNode } from "@shared/types";
import { fileBrowserClient } from "@/clients/fileBrowserClient";
import { logError } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  flattenTree,
  pruneListings,
  refreshTargets,
  type FlatTreeRow,
} from "./fileBrowserTree";

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
  listingsRef.current = listings;
  const inFlightRef = useRef<Set<string>>(new Set());

  const expandedSet = useMemo(() => new Set(expandedPaths), [expandedPaths]);
  const expandedSetRef = useRef(expandedSet);
  expandedSetRef.current = expandedSet;

  const fetchDirectory = useCallback(
    async (dirPath: string, generation: number): Promise<void> => {
      if (!worktreeId) return;
      inFlightRef.current.add(dirPath);
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
        inFlightRef.current.delete(dirPath);
        if (generation === generationRef.current) {
          setLoadingPaths((previous) => {
            if (!previous.has(dirPath)) return previous;
            const next = new Set(previous);
            next.delete(dirPath);
            return next;
          });
        }
      }
    },
    [worktreeId, showIgnored]
  );

  const ensureLoaded = useCallback(
    (dirPath: string): void => {
      if (listingsRef.current.has(dirPath) || inFlightRef.current.has(dirPath)) return;
      void fetchDirectory(dirPath, generationRef.current);
    },
    [fetchDirectory]
  );

  const refresh = useCallback((): void => {
    const generation = generationRef.current;
    for (const target of refreshTargets(listingsRef.current, expandedSetRef.current)) {
      // Bypasses `ensureLoaded`'s already-loaded check by design — a refresh is
      // exactly the case where the cached listing is the thing being replaced.
      // The in-flight check still applies, so a tick arriving mid-fetch does
      // not stack a second request for the same directory.
      if (inFlightRef.current.has(target)) continue;
      void fetchDirectory(target, generation);
    }
  }, [fetchDirectory]);

  // Identity reset. Flipping the ignored filter changes what every listing
  // contains, not just the root, so the whole cache is dropped rather than
  // patched — a partial cache would show ignored entries in the folders that
  // happened to reload and hide them everywhere else.
  useEffect(() => {
    generationRef.current += 1;
    inFlightRef.current.clear();
    setListings(new Map());
    setLoadingPaths(new Set());
    setRootError(null);
    setHasLoadedRoot(false);
    if (!worktreeId) return;
    void fetchDirectory("", generationRef.current);
  }, [worktreeId, showIgnored, fetchDirectory]);

  // Expanding a directory is what triggers its fetch; a restored panel expands
  // several at once, and each is requested the first time it becomes visible.
  useEffect(() => {
    for (const dirPath of expandedSet) {
      if (listings.has(dirPath) || inFlightRef.current.has(dirPath)) continue;
      // Only fetch directories the tree can actually reach. A persisted
      // expansion whose parent is collapsed (or gone) would otherwise fire a
      // request for a folder the user cannot see.
      if (!isReachable(listings, expandedSet, dirPath)) continue;
      void fetchDirectory(dirPath, generationRef.current);
    }
  }, [expandedSet, listings, fetchDirectory]);

  // Forget collapsed subtrees so re-expanding re-reads rather than replaying a
  // listing that may be minutes stale on an actively-written worktree.
  useEffect(() => {
    setListings((previous) => {
      const next = pruneListings(previous, expandedSet);
      return next.size === previous.size ? previous : next;
    });
  }, [expandedSet]);

  // Live updates. The tick is the worktree's own change signal, so this
  // inherits its coalescing; the first tick is skipped because the identity
  // effect has already issued the initial listing.
  const lastTickRef = useRef(changeTick);
  useEffect(() => {
    if (changeTick === lastTickRef.current) return;
    lastTickRef.current = changeTick;
    if (!hasLoadedRoot) return;
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
