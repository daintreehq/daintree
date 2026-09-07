import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { useDndMonitor } from "@dnd-kit/core";

interface UseSidebarVirtuosoResetParams {
  /** Length of the flat item array backing the Virtuoso surface. */
  itemCount: number;
  /**
   * The query the list is actually filtered by — the deferred one, not the live
   * input value, so it moves in the same commit the list narrows.
   */
  searchQuery: string;
  /**
   * The uncommitted input value. Only ever compared against `searchQuery`: while
   * the two disagree a deferred render is still owed, so the query is in motion
   * even on a commit that changed neither the count nor the filter.
   */
  liveQuery: string;
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
 * Replaces the sidebar's Virtuoso instance whenever the list shrinks (#12094).
 *
 * react-virtuoso keys its size and offset trees by index, not by
 * `computeItemKey` — that only steers React reconciliation. `firstItemIndex` is
 * the sole remap path and exists for prepending, `restoreStateFrom` restores the
 * measurements rather than clearing them, and `VirtuosoHandle` has no imperative
 * reset. So a shrink leaves the trees describing the old layout, and the failure
 * is self-sustaining: a row left outside the computed visible range never
 * mounts, so its ResizeObserver never fires, so its stale entry is never
 * corrected. Remounting is the only way to discard those trees.
 *
 * Growth is safe — appended entries extend an already-valid prefix-sum tree —
 * so only shrinks are worth reacting to. Correlating a shrink with the deletion
 * that caused it was tried and abandoned: with a quick-state filter active, a
 * deleted worktree stops matching the filter in the urgent commit (its terminals
 * leave `useWorktreeIds` immediately) while `deferredWorktrees` still lists it,
 * so the shrink and the id removal land in *different* commits and no
 * single-commit correlation holds. Treating every shrink as suspect fails open
 * instead: a needless remount costs one frame and restores its own scroll
 * offset, where a missed one leaves the row stranded for good.
 *
 * The single exception is typing. Narrowing a search shrinks the list on most
 * keystrokes, and a full teardown per keystroke would put exactly the work this
 * file defers out of the input path (#10908) back into it — for a list the user
 * is about to change again anyway. That shrink is deferred, not forgiven: it
 * stays owed and fires on the first commit the query holds still, so a deletion
 * that merely coincided with a keystroke still gets its reset.
 *
 * "Holds still" has to mean *settled*, not merely unchanged since the last
 * commit. Each keystroke lands as two commits: an urgent one carrying the new
 * input with the filtered list still stale, then the deferred one that actually
 * narrows it. On that urgent commit the deferred query has not moved, so an
 * unchanged-since-last-commit test reads it as quiet and pays off the previous
 * keystroke's owed reset — one remount per keystroke, lagged by one, which is
 * the very teardown this exemption exists to prevent. Comparing the live query
 * against the deferred one is what identifies those commits.
 */
function useSidebarVirtuosoReset({
  itemCount,
  searchQuery,
  liveQuery,
  scrollerRef,
}: UseSidebarVirtuosoResetParams): UseSidebarVirtuosoResetReturn {
  const [reset, setReset] = useState<ResetState>(INITIAL_STATE);
  // `null` until the first commit — there is no previous layout to have
  // stranded anything, so the first pass only records a baseline.
  const prevItemCountRef = useRef<number | null>(null);
  const prevQueryRef = useRef(searchQuery);
  const pendingRef = useRef(false);
  const draggingRef = useRef(false);
  // Stays set from the drop until dnd-kit has finished restoring focus. Without
  // it a shrink landing inside that window would flush straight through, since
  // the drag itself is already over.
  const settlingRef = useRef(false);
  const rafRef = useRef<number | null>(null);

  const cancelScheduled = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const flush = useCallback(() => {
    if (!pendingRef.current || draggingRef.current || settlingRef.current) return;
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

  // Deliberately un-gated: an owed reset has to be retried on plain commits
  // too. Keying this to the inputs would strand a shrink that arrived on the
  // same commit as the user's last keystroke, because the next commit that
  // could pay it off often changes neither the count nor the query.
  useLayoutEffect(() => {
    const prevCount = prevItemCountRef.current;
    const prevQuery = prevQueryRef.current;
    prevItemCountRef.current = itemCount;
    prevQueryRef.current = searchQuery;
    if (prevCount === null) return;
    if (itemCount < prevCount) pendingRef.current = true;
    // Hold while the query is still moving — either it moved on this commit, or
    // a deferred render is still owed and it is about to. Keep the shrink owed
    // rather than dropping it: a deletion that happens to land in the same
    // commit as a keystroke is structural, and nothing later would report it
    // again.
    if (searchQuery !== prevQuery || liveQuery !== searchQuery) return;
    flush();
  });

  const releaseAfterDrag = useCallback(() => {
    draggingRef.current = false;
    settlingRef.current = true;
    cancelScheduled();
    // dnd-kit restores focus to the drag activator a frame after the drop
    // settles; remounting first would destroy the node it is about to focus
    // (past lesson #8478). Hold the swap — including one that arrives inside
    // this window — until that frame has passed.
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        settlingRef.current = false;
        flush();
      });
    });
  }, [cancelScheduled, flush]);

  useDndMonitor({
    onDragStart() {
      draggingRef.current = true;
      settlingRef.current = false;
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
