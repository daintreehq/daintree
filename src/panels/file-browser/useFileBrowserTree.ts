import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FileTreeNode } from "@shared/types";
import type { FileBrowserTreeSnapshot } from "@shared/types/panel";
import { fileBrowserClient } from "@/clients/fileBrowserClient";
import { logError } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  buildFolderListingRows,
  createVisibilityFilter,
  DEFAULT_FILE_SORT,
  findNodeInListings,
  flattenTree,
  isRowPathVisible,
  parentDirectoryOf,
  listingsFromSnapshot,
  pruneListings,
  refreshTargets,
  snapshotFromListings,
  snapshotMatchesSource,
  sourceIdentityKey,
  type FileBrowserSortOrder,
  type FileBrowserSource,
  type FlatTreeRow,
  type FolderListingRow,
} from "./fileBrowserTree";

/**
 * Ceiling on directory listings in flight at once.
 *
 * A restored panel can carry hundreds of expanded directories, and firing all
 * of them the instant the root lands would blow past the IPC channel's rate
 * limit — failing the overflow outright. Queuing keeps a wide tree slow rather
 * than broken.
 */
const MAX_CONCURRENT_LISTINGS = 6;

/**
 * Backoff schedule for silently retrying a failed *root* listing before
 * surfacing an error. Listings are routed to the sender view's own project
 * host (#11366), so window repointing during a switch is no longer a failure
 * source — the grace window covers what remains: a cold or restarting
 * workspace host, eviction, and transient IPC failures. Retrying instead of
 * immediately painting a red banner keeps those transients invisible; the
 * banner is reserved for a failure that persists across the whole schedule.
 *
 * 150ms first, because state queries coalesce their result for 150ms
 * (`STATES_INFLIGHT_COALESCE_WINDOW_MS`) — a sooner retry would only replay the
 * same stale empty answer. Then 400ms and 800ms: `switch.ts`'s own comment puts
 * the warm-`loadProject` window at "several hundred ms" (prune/list/status
 * sync/LFS probe), and a reporter saw the banner outlast a shorter budget, so
 * the schedule reaches ~1.35s of grace to clear that window with margin while
 * still surfacing a genuinely broken worktree in under ~1.5s.
 */
const ROOT_RETRY_DELAYS_MS = [150, 400, 800] as const;

export interface UseFileBrowserTreeArgs {
  /** What the tree is rooted at; null while nothing resolves (no tree, no fetches). */
  source: FileBrowserSource | null;
  expandedPaths: readonly string[];
  /** Hide dot-prefixed entries (the per-panel toggle). */
  hideDotfiles: boolean;
  /** App-global always-hidden basename globs (the junk list). */
  alwaysHiddenPatterns: readonly string[];
  /**
   * Directory to root the tree at, relative to the source base; "" = the base
   * itself. Changing it is an identity reset, the same as switching sources:
   * every listing outside the new root is meaningless to the new tree.
   */
  rootPath?: string;
  /**
   * Ticks whenever the worktree's change set is recomputed. Already coalesced
   * upstream by the worktree watcher's adaptive burst debounce, so a bulk write
   * (`npm install`, a generated asset batch) arrives as one tick rather than
   * hundreds — the tree does not need its own debounce on top.
   *
   * Always undefined for a `workspace` source: both tick sources are keyed by
   * worktree id in the worktree store, and a scratch or worktree-less project
   * has no entry there. Those roots are refresh-on-demand by design (#11482) —
   * wiring a passive tick for them needs a watcher lifecycle of its own, which
   * is deliberately not in scope here.
   */
  changeTick: number | undefined;
  /**
   * Last-known tree structure from the panel record (#11367). When it matches
   * the current identity, the identity reset seeds the listings from it and
   * paints instantly while the live refresh runs; a mismatch (other source,
   * other root) is ignored and the tree cold-starts as before.
   */
  treeSnapshot?: FileBrowserTreeSnapshot;
  /**
   * What every directory's entries are ordered by (#11620). Applied per level
   * to the tree and to the folder listing from this one value, so the two
   * columns can never disagree about the order of the same directory.
   */
  sort?: FileBrowserSortOrder;
  /**
   * The selected worktree-relative path, whatever kind it turns out to be.
   *
   * Resolved here rather than by the caller because deciding whether it names a
   * folder needs the listings map this hook owns — and if it does, that folder
   * is fetched on demand like an expansion, kept across an unrelated collapse,
   * and re-read on a change tick (#11620). A folder can be listed without being
   * expanded, so those three things have to be arranged for it explicitly.
   */
  selectedPath?: string | null;
}

/** What the viewer's folder listing is doing right now (#11620). */
export type FolderListingStatus = "pending" | "ready" | "error";

export interface UseFileBrowserTreeResult {
  rows: FlatTreeRow[];
  /** True only before the root listing has ever resolved. */
  isInitialLoading: boolean;
  /** Set when the root listing failed; per-directory failures are silent. */
  rootError: string | null;
  /**
   * Whether the current root holds dot-prefixed entries the dotfile toggle is
   * governing — i.e. turning the toggle off would reveal something. Lets the
   * empty state offer "Show dotfiles" only when it can actually help.
   */
  hasHiddenDotfiles: boolean;
  /** Fetch a directory if it isn't already loaded or in flight. */
  ensureLoaded: (dirPath: string) => void;
  /**
   * Re-list the root and every reachable expanded directory. Pass
   * `{ manual: true }` for a user-initiated refresh so the toolbar spinner
   * runs; background (change-tick) refreshes leave it dormant.
   */
  refresh: (options?: { manual?: boolean }) => void;
  /**
   * True while a *manual* refresh's listings are still in flight. Drives the
   * toolbar Refresh spinner; stays false for passive change-tick refreshes so
   * the button doesn't spin on every filesystem change.
   */
  isRefreshing: boolean;
  /**
   * Structure-only snapshot of the current tree for persistence (#11367), or
   * null when there is nothing worth keeping (root never loaded, or the tree
   * exceeds the persistence bounds). Synchronous and side-effect free — the
   * pane calls it at going-away points (view hidden, unmount), never on a
   * change tick, so persistence writes stay off the refresh path.
   */
  captureSnapshot: () => FileBrowserTreeSnapshot | null;
  /**
   * The node `selectedPath` names, looked up through its parent directory's
   * listing, or undefined when that parent has not been read. Resolved this way
   * rather than from the rendered tree rows because the folder listing can
   * select an entry whose parent is collapsed in the tree (#11620) — such an
   * entry has no row, and asking `rows` would report a real file as unknown.
   */
  selectedNode: FileTreeNode | undefined;
  /**
   * The folder currently being listed, or null when the selection is a file,
   * nothing, or hidden by the current filters.
   */
  listingPath: string | null;
  /**
   * Rows for `listingPath`'s contents, or null when no folder is being listed.
   * Empty array and null are deliberately different answers: empty is a folder
   * that really holds nothing, null is no folder selected.
   */
  listingRows: FolderListingRow[] | null;
  /**
   * Raw state of `listingPath`'s fetch — never gated by an anti-flicker timer.
   * A gated flag cannot tell "still loading" from "loaded and empty", so the
   * consumer branches on this and uses its own deferred flag only to decide
   * whether a skeleton paints (#10083).
   */
  listingStatus: FolderListingStatus;
  /**
   * Whether the dotfile toggle is hiding something in the folder being listed,
   * so its empty state can offer "Show dotfiles" only when that would help.
   */
  listingHasHiddenDotfiles: boolean;
}

interface QueueEntry {
  dirPath: string;
  generation: number;
}

/**
 * Tracks the current root-failure streak. Keyed by the generation that owns it
 * so a retry scheduled under a previous identity can't consume the new one's
 * budget; `nextDelayIndex` walks `ROOT_RETRY_DELAYS_MS` and is reset to 0 on any
 * root success or identity reset.
 */
interface RootRetryState {
  generation: number;
  nextDelayIndex: number;
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
  source,
  expandedPaths,
  hideDotfiles,
  alwaysHiddenPatterns,
  rootPath = "",
  changeTick,
  treeSnapshot,
  sort = DEFAULT_FILE_SORT,
  selectedPath = null,
}: UseFileBrowserTreeArgs): UseFileBrowserTreeResult {
  // A primitive standing in for `source` in effect dependency lists: the pane
  // rebuilds the object every render, so depending on it directly would reset
  // the tree's identity on each pass.
  const sourceKey = sourceIdentityKey(source);
  // Never published during render, and never ahead of the generation it belongs
  // to: the identity-reset effect below is the only writer. A render naming a
  // new source can be abandoned (a suspended or superseded transition) without
  // that effect ever running, so a render-time write would leave requests still
  // queued under the old identity reading the new source — their generation
  // check would pass and commit another folder's listing into this tree.
  // Publishing inside the reset also keeps it behind the outgoing cleanups,
  // which is what lets the pane capture the tree it is leaving rather than
  // tagging those rows with the source that replaced them.
  const sourceRef = useRef(source);
  // Staged in the layout phase — which only runs for a render that actually
  // committed — so the identity effect below publishes the source React kept,
  // never one an abandoned render wrote. Nothing else reads this.
  const committedSourceRef = useRef(source);
  useLayoutEffect(() => {
    committedSourceRef.current = source;
  }, [source]);
  // Seeded via lazy initializers, not just the identity effect: passive
  // effects run after paint, so an effect-only seed would commit one loading
  // frame before the last-known tree appears — the exact flash #11367 exists
  // to remove. The initializers read props (immutable for this render), so
  // StrictMode's double-invoke is harmless; identity *changes* re-seed in the
  // identity-reset effect below.
  const [listings, setListings] = useState<Map<string, readonly FileTreeNode[]>>(
    () => seedListings(treeSnapshot, source, rootPath) ?? new Map()
  );
  const [loadingPaths, setLoadingPaths] = useState<ReadonlySet<string>>(new Set());
  // Non-root directories whose last fetch failed. Per-directory failures are
  // otherwise silent by design (only the root gets a banner), which leaves a
  // folder listing with no way to tell "failed" from "still loading" — it would
  // sit on a skeleton forever. Kept as state, not a ref, because the listing
  // has to re-render when a fetch fails; cleared on success and on any identity
  // reset.
  const [failedListings, setFailedListings] = useState<ReadonlySet<string>>(new Set());
  const [rootError, setRootError] = useState<string | null>(null);
  const [hasLoadedRoot, setHasLoadedRoot] = useState(false);
  // True when the current identity's listings were seeded from a persisted
  // snapshot (#11367). Distinct from `hasLoadedRoot`, which stays false until
  // the *live* root lands: the seeded tree suppresses the skeleton, while
  // change-tick deferral and the expansion effect still wait for real data.
  const [hasSeededRoot, setHasSeededRoot] = useState(
    () => seedListings(treeSnapshot, source, rootPath) !== null
  );
  // True from a manual refresh press until its listings fully drain. A ref
  // mirrors it so the drain check in `pump` (which runs off refs, not state)
  // can decide whether a completed drain belongs to a manual refresh.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const isRefreshingRef = useRef(false);

  // Generation counter, bumped whenever the identity of what we are listing
  // changes (worktree switch, root change). Every in-flight response carries
  // the generation it was issued under and is dropped if it no longer matches,
  // so a slow listing from the previous worktree can't land in the new one's
  // tree. Visibility (junk list, dotfile toggle) is deliberately NOT part of
  // identity — it filters the cached raw listing at render time, no refetch.
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

  // Silent-retry bookkeeping for a failed *root* listing. The timer handle lets
  // us both cancel a pending retry (unmount / identity reset) and detect on fire
  // whether it was superseded; the state carries the streak's generation and its
  // position in `ROOT_RETRY_DELAYS_MS`. See `fetchDirectory`'s root catch branch.
  const rootRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRetryStateRef = useRef<RootRetryState>({ generation: 0, nextDelayIndex: 0 });

  // Re-keyed on its two primitives rather than used directly: the pane builds a
  // fresh object each render, so depending on the prop would invalidate the row
  // memos below on every pass — the exact cost virtualization exists to avoid.
  const sortKeyed = useMemo(
    () => ({ key: sort.key, direction: sort.direction }),
    [sort.key, sort.direction]
  );

  const expandedSet = useMemo(() => new Set(expandedPaths), [expandedPaths]);
  const expandedSetRef = useRef(expandedSet);

  // Latest persisted snapshot, read only inside the identity-reset effect. A
  // ref rather than a dependency: capture writes a fresh snapshot object into
  // the panel record on every hide, and re-running the identity reset for it
  // would wipe the live tree the snapshot was just taken of.
  const treeSnapshotRef = useRef(treeSnapshot);

  // Per-entry visibility for the current junk list + dotfile toggle. Filters
  // rows at render time, but is also read by the fetch machinery (through
  // `isVisibleRef`) so a hidden directory's subtree is never re-listed — it has
  // no row, so paying for its listing on every tick is pure waste.
  const isVisible = useMemo(
    () => createVisibilityFilter({ hideDotfiles, alwaysHiddenPatterns }),
    [hideDotfiles, alwaysHiddenPatterns]
  );
  const isVisibleRef = useRef(isVisible);

  // The directory whose listing answers what the selection is. Held onto
  // through the prune below: picking a file out of a folder listing collapses
  // that folder's role from "being listed" to "merely the parent", and dropping
  // it right then would forget the file's own kind the moment it was clicked.
  const selectionParent = selectedPath === null ? null : parentDirectoryOf(selectedPath);

  // What the selection actually is, answered by its parent directory's listing
  // rather than by the rendered rows — the folder listing can select an entry
  // whose parent is collapsed in the tree, and that entry has no row (#11620).
  const selectedNode = useMemo(
    () => (selectedPath === null ? undefined : findNodeInListings(listings, selectedPath)),
    [listings, selectedPath]
  );

  // The folder to list: positively a directory, and still reachable under the
  // current filters. A folder the dotfile toggle has just hidden keeps its
  // stale `browserSelectedPath` but has no row to select, so it must stop
  // driving a listing rather than keep one on screen the tree can't show.
  const listingPath =
    selectedPath !== null &&
    selectedNode?.isDirectory === true &&
    isRowPathVisible(selectedPath, rootPath, isVisible)
      ? selectedPath
      : null;
  /**
   * Directories the viewer depends on that expansion alone would not keep: the
   * folder being listed, and the parent that resolves what the selection is.
   * One set, so the prune, the fetch-completion guard and the refresh cannot
   * drift apart — a guard stricter than the prune drops results for entries
   * that are then kept forever stale, and a prune stricter than the guard
   * evicts what is on screen.
   */
  const retainedPaths = useMemo(
    () => [listingPath, selectionParent].filter((path): path is string => path !== null),
    [listingPath, selectionParent]
  );

  // Read inside `fetchDirectory`'s completion guard and the prune, both of
  // which run outside the render that knows the current targets. Kept in sync
  // in the same layout effect as `expandedSetRef` so the two are never read at
  // different vintages.
  const listingPathRef = useRef(listingPath);
  const retainedPathsRef = useRef(retainedPaths);

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

  const clearRootRetryTimer = useCallback((): void => {
    if (rootRetryTimerRef.current !== null) {
      clearTimeout(rootRetryTimerRef.current);
      rootRetryTimerRef.current = null;
    }
  }, []);

  // Replenish the retry budget for a fresh streak under `generation` and drop
  // any retry still pending from the old one.
  const resetRootRetryState = useCallback(
    (generation: number): void => {
      clearRootRetryTimer();
      rootRetryStateRef.current = { generation, nextDelayIndex: 0 };
    },
    [clearRootRetryTimer]
  );

  const enqueueTargets = useCallback((targets: readonly string[], generation: number): void => {
    for (const dirPath of targets) {
      if (inFlightRef.current.has(dirPath)) continue;
      if (queueRef.current.some((entry) => entry.dirPath === dirPath)) continue;
      queueRef.current.push({ dirPath, generation });
    }
  }, []);

  const fetchDirectory = useCallback(
    async (dirPath: string, generation: number): Promise<void> => {
      const activeSource = sourceRef.current;
      if (!activeSource || disposedRef.current) return;
      inFlightRef.current.set(dirPath, generation);
      physicalInFlightRef.current += 1;
      setLoadingPaths((previous) => {
        const next = new Set(previous);
        next.add(dirPath);
        return next;
      });

      try {
        // A workspace source names no root at all: main derives it from the
        // sender's own binding, so omitting the id is what keeps the renderer
        // unable to ask for a folder its view isn't bound to (#11482).
        const nodes = await fileBrowserClient.listDirectory({
          ...(activeSource.kind === "worktree" && { worktreeId: activeSource.worktreeId }),
          ...(dirPath !== "" && { dirPath }),
        });
        if (generation !== generationRef.current) return;

        // A directory collapsed while its listing was in flight has already
        // been pruned; re-inserting it here would resurrect a cache entry the
        // user closed, and re-expanding later would show that stale snapshot
        // instead of re-reading.
        //
        // Tested against the same retained set the prune keeps, not just
        // against expansion: the viewer depends on two unexpanded directories
        // (#11620), and a guard stricter than the prune would drop a result for
        // a listing that is about to be kept — leaving it permanently stale
        // with nothing queued to replace it.
        if (
          dirPath !== rootPath &&
          !retainedPathsRef.current.includes(dirPath) &&
          !expandedSetRef.current.has(dirPath)
        )
          return;

        setListings((previous) => {
          const next = new Map(previous);
          next.set(dirPath, nodes);
          return next;
        });
        // A directory that has just been read is no longer failed, whether or
        // not it ever was — clearing unconditionally would churn a new Set on
        // every listing, so only an actual member triggers a write.
        setFailedListings((previous) => {
          if (!previous.has(dirPath)) return previous;
          const next = new Set(previous);
          next.delete(dirPath);
          return next;
        });
        if (dirPath === rootPath) {
          resetRootRetryState(generation);
          setRootError(null);
          setHasLoadedRoot(true);
        }
      } catch (error) {
        if (generation !== generationRef.current) return;
        // Recorded rather than surfaced: the tree still shows nothing for this
        // directory, exactly as before, but a folder listing pointed at it can
        // now tell a failure from a fetch still in flight (#11620).
        //
        // Only for a directory something still wants, tested the same way the
        // success path tests it. A request that fails *after* the user collapsed
        // its directory would otherwise leave a failure nothing goes on to
        // clear — the prune's clearing pass has already run for that collapse —
        // and the expansion effect would then refuse to re-request it, making
        // re-expanding the folder silently do nothing.
        const stillWanted =
          dirPath === rootPath ||
          retainedPathsRef.current.includes(dirPath) ||
          expandedSetRef.current.has(dirPath);
        if (dirPath !== rootPath && stillWanted) {
          setFailedListings((previous) => {
            if (previous.has(dirPath)) return previous;
            const next = new Set(previous);
            next.add(dirPath);
            return next;
          });
        }
        if (dirPath === rootPath) {
          // Only the root surfaces an error: it is the difference between "the
          // browser works" and "it doesn't". A single directory that failed
          // (deleted mid-expand, permissions) just stays unloaded, and the next
          // refresh retries it.
          //
          // But a root failure right after switching back to an idle project is
          // usually transient — the workspace host is still being repointed to
          // this window — so retry silently on a short backoff, staying in the
          // skeleton, and only paint the banner once the budget is spent.
          if (rootRetryStateRef.current.generation !== generation) {
            rootRetryStateRef.current = { generation, nextDelayIndex: 0 };
          }
          const attempt = rootRetryStateRef.current.nextDelayIndex;
          const delay = ROOT_RETRY_DELAYS_MS[attempt];
          if (delay !== undefined) {
            rootRetryStateRef.current.nextDelayIndex = attempt + 1;
            clearRootRetryTimer();
            const handle = setTimeout(() => {
              // Guard on fire, not just via cleanup: `clearTimeout` can't recall
              // a callback the event loop already dequeued, and a superseding
              // success/refresh nulls the handle out from under it. The identity
              // switch is covered separately by the layout-effect cancel below.
              if (
                generation !== generationRef.current ||
                disposedRef.current ||
                rootRetryTimerRef.current !== handle
              ) {
                return;
              }
              rootRetryTimerRef.current = null;
              // Route the retry through the shared queue rather than calling
              // fetchDirectory directly: it dedups against any root work a manual
              // refresh already queued or put in flight, and honours the
              // concurrency ceiling instead of firing a seventh request past it.
              // Front of the queue, though — a seeded restore can have hundreds
              // of descendant re-lists waiting, and the backoff schedule's whole
              // point is resolving the root's fate quickly (#11367). A root a
              // manual refresh already queued mid-backoff is promoted rather
              // than left at its tail position.
              if (!inFlightRef.current.has(rootPath)) {
                const queuedAt = queueRef.current.findIndex((entry) => entry.dirPath === rootPath);
                if (queuedAt >= 0) queueRef.current.splice(queuedAt, 1);
                queueRef.current.unshift({ dirPath: rootPath, generation });
              }
              pumpRef.current();
            }, delay);
            rootRetryTimerRef.current = handle;
            return;
          }
          // Budget spent: the failure is real. Surface it exactly as before.
          clearRootRetryTimer();
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
    [rootPath, clearRootRetryTimer, resetRootRetryState]
  );

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
      // A target hidden after it was queued (junk list edited, or dotfiles
      // toggled while it waited for a slot) renders no row — drop it rather
      // than spend a listing. Re-shown, the expansion effect re-enqueues it.
      if (!isRowPathVisible(next.dirPath, rootPath, isVisibleRef.current)) continue;
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
      enqueueTargets(
        refreshTargets(
          listingsRef.current,
          expandedSetRef.current,
          rootPath,
          isVisibleRef.current,
          listingPathRef.current
        ),
        generation
      );
      pumpRef.current();
    } else if (
      isRefreshingRef.current &&
      physicalInFlightRef.current === 0 &&
      queueRef.current.length === 0 &&
      rootRetryTimerRef.current === null
    ) {
      // A manual refresh's listings have fully drained (no deferred replay per
      // the branch above, and no silent root-retry still armed) — end the spin
      // cycle. `else if` keeps the flag up while a collision replay is still
      // queued; the `rootRetryTimerRef` guard keeps it up across a transient
      // root failure's backoff so the spin doesn't stop then resume on retry.
      isRefreshingRef.current = false;
      setIsRefreshing(false);
    }
  }, [fetchDirectory, enqueueTargets, rootPath]);

  // Published in a layout effect, never during render: an abandoned concurrent
  // render would otherwise publish a pump (and an expansion set) belonging to a
  // worktree the committed UI never switched to, and a request settling in that
  // window would act on it. Layout effects run before the passive effects that
  // start any request, so the refs are always current by the time one settles.
  useLayoutEffect(() => {
    listingsRef.current = listings;
    expandedSetRef.current = expandedSet;
    isVisibleRef.current = isVisible;
    pumpRef.current = pump;
    treeSnapshotRef.current = treeSnapshot;
    listingPathRef.current = listingPath;
    retainedPathsRef.current = retainedPaths;
  }, [listings, expandedSet, isVisible, pump, treeSnapshot, listingPath, retainedPaths]);

  // Cancel a pending root retry synchronously when the identity changes or the
  // panel unmounts. The generation bump that would invalidate the retry lives in
  // a *passive* effect, so between this commit and that effect there is a window
  // where the old timer could still fire, pass its generation guard, and briefly
  // repaint the previous worktree's error. A layout-effect cleanup runs during
  // commit — before that passive effect and before the loop yields to any timer
  // — closing the window. (Same reasoning as the ref publish above.)
  useLayoutEffect(() => {
    return () => {
      clearRootRetryTimer();
    };
  }, [sourceKey, rootPath, clearRootRetryTimer]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      queueRef.current = [];
      refreshPendingRef.current = false;
      // Drop any pending root retry so it can't fire into an unmounted panel.
      clearRootRetryTimer();
      // Invalidate everything still in the air so a late response can't commit
      // into a store the panel no longer owns.
      generationRef.current += 1;
    };
  }, [clearRootRetryTimer]);

  const ensureLoaded = useCallback(
    (dirPath: string): void => {
      if (listingsRef.current.has(dirPath)) return;
      enqueueTargets([dirPath], generationRef.current);
      pump();
    },
    [enqueueTargets, pump]
  );

  const refresh = useCallback(
    (options?: { manual?: boolean }): void => {
      const generation = generationRef.current;
      const targets = refreshTargets(
        listingsRef.current,
        expandedSetRef.current,
        rootPath,
        isVisibleRef.current,
        listingPathRef.current
      );
      // A user press should spin the toolbar icon until the re-list drains. Set
      // this before `pump` so the flag is up if fetches start synchronously; a
      // no-op refresh (no worktree, no targets) drains inside `pump` and clears
      // it again in the same batch, so the icon never flickers.
      if (options?.manual) {
        isRefreshingRef.current = true;
        setIsRefreshing(true);
      }
      // A target already in flight read the filesystem before this refresh was
      // asked for, so its result may not reflect the change that triggered us.
      // Defer rather than accept that response as final.
      if (targets.some((target) => inFlightRef.current.has(target))) {
        refreshPendingRef.current = true;
      }
      enqueueTargets(targets, generation);
      pump();
    },
    [enqueueTargets, pump, rootPath]
  );

  // Identity reset — only a worktree switch or a root change, not a visibility
  // change: the listing is the same raw filesystem either way, so the junk
  // list and dotfile toggle filter the cache in place rather than refetching.
  useEffect(() => {
    // Publish and bump together: anything reading the ref between the two would
    // issue a request for the incoming source under the outgoing generation.
    sourceRef.current = committedSourceRef.current;
    generationRef.current += 1;
    // Fresh identity, fresh retry budget — and cancel any retry still pending
    // for the previous one so it can't leak an error into this tree.
    resetRootRetryState(generationRef.current);
    inFlightRef.current.clear();
    queueRef.current = [];
    refreshPendingRef.current = false;
    // A worktree switch abandons any in-flight manual refresh; its drain will
    // never complete for this identity, so end the spin here rather than leave
    // the icon stuck.
    isRefreshingRef.current = false;
    setIsRefreshing(false);
    // Stale-while-revalidate (#11367): a persisted snapshot captured under
    // this exact identity seeds the listings so the tree paints instantly;
    // anything else — no snapshot, another worktree, another root — starts
    // from the empty map and the skeleton, exactly as before. On mount this
    // re-derives what the lazy initializers already seeded (same content),
    // which keeps a single code path for mount and identity change.
    const seeded = seedListings(treeSnapshotRef.current, sourceRef.current, rootPath);
    const seededRoot = seeded !== null;
    setListings(seeded ?? new Map());
    setLoadingPaths(new Set());
    // A failure belongs to the identity it happened under: carrying it across
    // would leave a folder permanently unfetchable in a worktree that never
    // failed to list it.
    setFailedListings(new Set());
    setRootError(null);
    setHasLoadedRoot(false);
    setHasSeededRoot(seededRoot);
    if (!sourceRef.current) return;
    if (seeded !== null) {
      // Revalidate everything the seed painted — the root plus every seeded
      // expanded directory — through the shared queue so a wide restored tree
      // honours the concurrency ceiling. The refs read here are published in a
      // layout effect, so they are current before this passive effect runs.
      enqueueTargets(
        // The listed folder is revalidated alongside the root and the seeded
        // expansions: a snapshot can carry a selected-but-collapsed folder
        // (the prune keeps it), and its seeded rows are structure-only — no
        // size, no mtime. Leaving it out of the revalidation would paint that
        // folder's listing as a column of em-dashes until something unrelated
        // happened to refresh it.
        refreshTargets(
          seeded,
          expandedSetRef.current,
          rootPath,
          isVisibleRef.current,
          listingPathRef.current
        ),
        generationRef.current
      );
      pumpRef.current();
    } else {
      void fetchDirectory(rootPath, generationRef.current);
    }
  }, [sourceKey, rootPath, fetchDirectory, resetRootRetryState, enqueueTargets]);

  // Expanding a directory is what triggers its fetch; a restored panel expands
  // several at once, and each is requested the first time it becomes visible.
  // Gated on the root having landed for this generation so an expansion can't
  // be judged reachable against the previous identity's listings.
  useEffect(() => {
    if (!hasLoadedRoot) return;
    const pendingTargets: string[] = [];
    for (const dirPath of expandedSet) {
      if (listings.has(dirPath) || inFlightRef.current.has(dirPath)) continue;
      // A directory whose last fetch failed is in neither of those, so without
      // this it would be re-requested every time any sibling listing lands and
      // rebuilds the map. On a restored tree with hundreds of expansions and
      // one unreadable directory, that is hundreds of redundant calls against
      // a shared IPC rate limit. Collapsing it clears the flag (see the prune
      // effect), and an explicit Refresh re-queues it directly.
      if (failedListings.has(dirPath)) continue;
      // Only fetch directories the tree can actually reach. A persisted
      // expansion whose parent is collapsed (or gone) would otherwise fire a
      // request for a folder the user cannot see.
      if (!isReachable(listings, expandedSet, dirPath, rootPath)) continue;
      // Nor fetch a directory the junk list / dotfile toggle currently hides:
      // it renders no row, so its listing is unused. Showing it later re-runs
      // this effect (isVisible is a dependency) and fetches it then.
      if (!isRowPathVisible(dirPath, rootPath, isVisible)) continue;
      pendingTargets.push(dirPath);
    }
    if (pendingTargets.length === 0) return;
    enqueueTargets(pendingTargets, generationRef.current);
    pump();
  }, [
    expandedSet,
    listings,
    failedListings,
    hasLoadedRoot,
    rootPath,
    isVisible,
    enqueueTargets,
    pump,
  ]);

  // The folder the viewer is listing is fetched on demand, the same way an
  // expansion is — selecting a folder from the keyboard, or from the listing
  // itself, never expands it, so nothing else would ask for its contents.
  // Gated on the root having landed for the same reason the expansion effect
  // is, and skipped once a fetch has failed: a failed directory is in neither
  // `listings` nor `inFlightRef`, so without that check this would re-request
  // it on every render.
  useEffect(() => {
    if (!hasLoadedRoot || listingPath === null) return;
    if (listings.has(listingPath) || failedListings.has(listingPath)) return;
    if (inFlightRef.current.has(listingPath)) return;
    if (!isRowPathVisible(listingPath, rootPath, isVisible)) return;
    enqueueTargets([listingPath], generationRef.current);
    pump();
  }, [
    listingPath,
    listings,
    failedListings,
    hasLoadedRoot,
    rootPath,
    isVisible,
    enqueueTargets,
    pump,
  ]);

  // Forget collapsed subtrees so re-expanding re-reads rather than replaying a
  // listing that may be minutes stale on an actively-written worktree. The
  // folder on screen in the viewer is retained even when collapsed (#11620) —
  // it is being read right now, so it is not the unused cache entry this drops.
  useEffect(() => {
    setListings((previous) => {
      const next = pruneListings(previous, expandedSet, rootPath, retainedPaths);
      return next.size === previous.size ? previous : next;
    });
    // Collapsing a directory clears any recorded failure for it, so the natural
    // collapse-then-expand gesture retries rather than being refused forever by
    // the expansion effect's skip below.
    setFailedListings((previous) => {
      if (previous.size === 0) return previous;
      const next = new Set<string>();
      for (const path of previous) {
        if (expandedSet.has(path) || retainedPaths.includes(path)) next.add(path);
      }
      return next.size === previous.size ? previous : next;
    });
  }, [expandedSet, rootPath, retainedPaths]);

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
    () => flattenTree(listings, expandedSet, loadingPaths, rootPath, isVisible, sortKeyed),
    [listings, expandedSet, loadingPaths, rootPath, isVisible, sortKeyed]
  );

  const listingRows = useMemo(
    () =>
      listingPath === null
        ? null
        : buildFolderListingRows(listings, listingPath, isVisible, sortKeyed),
    [listings, listingPath, isVisible, sortKeyed]
  );

  // Raw, never anti-flicker-gated: a gated flag collapses "still loading" and
  // "loaded and empty" into one value, and the consumer needs them apart to
  // pick between a skeleton and an empty state (#10083). The gate belongs in
  // the consumer, deciding only whether the skeleton paints.
  //
  // Rows win over a recorded failure deliberately. A failure with rows already
  // on screen is a *refresh* that failed, and blanking readable content for an
  // error banner is the thing the tree's own root-error branch refuses to do —
  // the last-known contents stay, exactly as a non-root directory failure is
  // already silent for the tree. Only a folder with nothing to show reports the
  // error, because that is the only case where the error is the whole story.
  //
  // "Nothing to show" means no rows, not merely no listing: a folder cached as
  // empty whose re-read then fails has nothing to protect, and reporting it as
  // ready would put "Nothing in this folder yet" on screen for a folder we in
  // fact failed to read — a confident claim built on a failure.
  const listingStatus: FolderListingStatus =
    listingPath === null || (listingRows !== null && listingRows.length > 0)
      ? "ready"
      : failedListings.has(listingPath)
        ? "error"
        : listingRows !== null
          ? "ready"
          : "pending";

  // Would toggling the dotfile filter off reveal anything at this root? A
  // root-level dot entry that the junk list is *not* already hiding.
  const hasHiddenDotfiles = useMemo(
    () => directoryHasHiddenDotfiles(listings, rootPath, alwaysHiddenPatterns),
    [listings, rootPath, alwaysHiddenPatterns]
  );

  // The same question asked of the folder being listed rather than of the root
  // (#11620) — its empty state offers "Show dotfiles" only when that would
  // actually put something on screen.
  const listingHasHiddenDotfiles = useMemo(
    () =>
      listingPath === null
        ? false
        : directoryHasHiddenDotfiles(listings, listingPath, alwaysHiddenPatterns),
    [listings, listingPath, alwaysHiddenPatterns]
  );

  // Keyed on `sourceKey` for two reasons: the pane runs its going-away capture
  // in an effect keyed on this callback, so without it a source change that
  // left `rootPath` alone would re-point the tree without ever capturing the
  // outgoing one — and comparing it against the ref refuses to tag these
  // listings with a source they did not come from.
  const captureSnapshot = useCallback((): FileBrowserTreeSnapshot | null => {
    const activeSource = sourceRef.current;
    if (!activeSource || sourceIdentityKey(activeSource) !== sourceKey) return null;
    return snapshotFromListings(listingsRef.current, activeSource, rootPath);
  }, [sourceKey, rootPath]);

  return {
    rows,
    // A seeded tree is content, not loading: the skeleton is reserved for
    // genuinely having nothing to paint (#11367).
    isInitialLoading: source !== null && !hasLoadedRoot && !hasSeededRoot,
    rootError,
    hasHiddenDotfiles,
    ensureLoaded,
    refresh,
    isRefreshing,
    captureSnapshot,
    selectedNode,
    listingPath,
    listingRows,
    listingStatus,
    listingHasHiddenDotfiles,
  };
}

/**
 * Whether one loaded directory holds a dot-prefixed entry the junk list is not
 * already hiding — i.e. whether turning the dotfile toggle off would reveal
 * anything there. False for a directory that has not been listed: nothing is
 * known to be hidden in a folder nothing is known about.
 */
function directoryHasHiddenDotfiles(
  listings: ReadonlyMap<string, readonly FileTreeNode[]>,
  dirPath: string,
  alwaysHiddenPatterns: readonly string[]
): boolean {
  const nodes = listings.get(dirPath);
  if (!nodes) return false;
  const notJunk = createVisibilityFilter({ hideDotfiles: false, alwaysHiddenPatterns });
  return nodes.some((node) => node.name.startsWith(".") && notJunk(node.name));
}

/**
 * The listings to seed a fresh identity from, or null to cold-start: the
 * snapshot must exist, match the identity it was captured under exactly, and
 * carry its own root listing (#11367).
 */
function seedListings(
  snapshot: FileBrowserTreeSnapshot | undefined,
  source: FileBrowserSource | null,
  rootPath: string
): Map<string, readonly FileTreeNode[]> | null {
  if (!source || snapshot === undefined || !snapshotMatchesSource(snapshot, source, rootPath)) {
    return null;
  }
  const seeded = listingsFromSnapshot(snapshot);
  return seeded.has(rootPath) ? seeded : null;
}

/**
 * Whether `dirPath` sits under a chain of loaded, expanded directories rooted
 * at the browser root — i.e. whether a row for it is (or is about to be) on
 * screen.
 */
function isReachable(
  listings: ReadonlyMap<string, readonly FileTreeNode[]>,
  expandedPaths: ReadonlySet<string>,
  dirPath: string,
  rootPath: string
): boolean {
  // The root itself is fetched by the identity effect, never via expansion;
  // and a persisted expansion outside the current root has no row to reach.
  if (dirPath === rootPath) return false;
  const prefix = rootPath === "" ? "" : `${rootPath}/`;
  if (prefix !== "" && !dirPath.startsWith(prefix)) return false;

  const segments = dirPath.slice(prefix.length).split("/").filter(Boolean);
  let parent = rootPath;
  for (let i = 0; i < segments.length; i += 1) {
    const children = listings.get(parent);
    if (!children) return false;
    const current = prefix + segments.slice(0, i + 1).join("/");
    if (!children.some((node) => node.isDirectory && node.path === current)) return false;
    // Every directory on the way down except the target itself must also be
    // expanded, otherwise the target is hidden inside a collapsed branch.
    if (i < segments.length - 1 && !expandedPaths.has(current)) return false;
    parent = current;
  }
  return segments.length > 0;
}
