import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { useDndMonitor } from "@dnd-kit/core";

interface UseSidebarVirtuosoResetParams {
  /** Length of the flat item array backing the Virtuoso surface. */
  itemCount: number;
  /**
   * Unfiltered live worktree ids, read from the same deferred timeline as the
   * items. A filtered order (`dragStartOrder`) would report every search
   * keystroke as a removal; the raw store list would run ahead of the items and
   * report removals a render early.
   */
  liveWorktreeIds: readonly string[];
  /** The live scroller element, so the pre-remount offset can be restored. */
  scrollerRef: RefObject<HTMLElement | null>;
}

interface UseSidebarVirtuosoResetReturn {
  /** Feed to Virtuoso's `key`. A change discards the stale geometry trees. */
  resetKey: number;
  /** Feed to Virtuoso's `initialScrollTop`. Transient — cleared once consumed. */
  initialScrollTop: number | undefined;
}

interface ResetState {
  key: number;
  scrollTop: number | undefined;
}

const INITIAL_STATE: ResetState = { key: 0, scrollTop: undefined };

/**
 * Replaces the sidebar's Virtuoso instance after a worktree deletion shrinks the
 * list (#12094).
 *
 * react-virtuoso keys its size and offset trees by index, not by
 * `computeItemKey` — that only steers React reconciliation. `firstItemIndex` is
 * the sole remap path and exists for prepending, `restoreStateFrom` restores the
 * measurements rather than clearing them, and `VirtuosoHandle` has no imperative
 * reset. So when the list shrinks, the trees keep describing the pre-deletion
 * layout, and the failure is self-sustaining: a row left outside the computed
 * visible range never mounts, so its ResizeObserver never fires, so its stale
 * entry is never corrected. Remounting is the only way to discard those trees.
 *
 * The trigger is deliberately narrow. A shrink alone is far too broad — search
 * and filter narrowing shrink the list, and so does `pruneDeletedWorktrees`
 * retiring a tombstone on its own, which would yank a scrolled user to the top
 * with no action on their part. Requiring that a live worktree id also
 * disappeared isolates real deletions: a lone deletion swaps a row for a
 * tombstone card and doesn't shrink at all, while a batch collapses several
 * tombstones into one group item and does.
 */
function useSidebarVirtuosoReset({
  itemCount,
  liveWorktreeIds,
  scrollerRef,
}: UseSidebarVirtuosoResetParams): UseSidebarVirtuosoResetReturn {
  const [reset, setReset] = useState<ResetState>(INITIAL_STATE);
  // `null` until the first commit — there is no previous layout to have
  // stranded anything, so the first pass only records a baseline.
  const prevItemCountRef = useRef<number | null>(null);
  // Held by reference, not copied: `liveWorktreeIds` arrives from a useMemo and
  // is never mutated in place.
  const prevIdsRef = useRef<readonly string[]>([]);
  const pendingRef = useRef(false);
  const draggingRef = useRef(false);
  const rafRef = useRef<number | null>(null);

  const cancelScheduled = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const flush = useCallback(() => {
    if (!pendingRef.current || draggingRef.current) return;
    pendingRef.current = false;
    const scroller = scrollerRef.current;
    // No scroller means Virtuoso is already unmounted — the empty-state branch
    // is showing, its geometry died with it, and the next mount is fresh.
    // Bumping the key here would only discard that healthy instance.
    if (!scroller) return;
    const { scrollTop } = scroller;
    setReset((prev) => ({
      key: prev.key + 1,
      scrollTop: scrollTop > 0 ? scrollTop : undefined,
    }));
  }, [scrollerRef]);

  useLayoutEffect(() => {
    const prevCount = prevItemCountRef.current;
    const prevIds = prevIdsRef.current;
    prevItemCountRef.current = itemCount;
    prevIdsRef.current = liveWorktreeIds;
    if (prevCount === null || itemCount >= prevCount) return;
    const live = new Set(liveWorktreeIds);
    // Membership, not counts: a removal landing alongside an addition in the
    // same update leaves the live id count unchanged while still deleting a
    // worktree, and the shrunk surface strands geometry all the same.
    if (!prevIds.some((id) => !live.has(id))) return;
    pendingRef.current = true;
    flush();
  }, [itemCount, liveWorktreeIds, flush]);

  const releaseAfterDrag = useCallback(() => {
    draggingRef.current = false;
    if (!pendingRef.current) return;
    cancelScheduled();
    // dnd-kit restores focus to the drag activator a frame after the drop
    // settles; remounting first would destroy the node it is about to focus
    // (past lesson #8478). Clear that frame before swapping the list out.
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        flush();
      });
    });
  }, [cancelScheduled, flush]);

  useDndMonitor({
    onDragStart() {
      draggingRef.current = true;
      cancelScheduled();
    },
    onDragEnd: releaseAfterDrag,
    onDragCancel: releaseAfterDrag,
  });

  // The keyed mount has consumed the offset. Drop it so a later natural remount
  // — the filter empty-state branch swapping back in — doesn't restore a
  // position from a list that no longer exists.
  useEffect(() => {
    if (reset.scrollTop === undefined) return;
    setReset((prev) => (prev.key === reset.key ? { ...prev, scrollTop: undefined } : prev));
  }, [reset]);

  useEffect(() => cancelScheduled, [cancelScheduled]);

  return { resetKey: reset.key, initialScrollTop: reset.scrollTop };
}

export { useSidebarVirtuosoReset };
export type { UseSidebarVirtuosoResetParams, UseSidebarVirtuosoResetReturn };
