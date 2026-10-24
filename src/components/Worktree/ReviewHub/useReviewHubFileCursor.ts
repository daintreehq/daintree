import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type { StagingFileEntry } from "@shared/types";
import type { VirtuosoHandle } from "react-virtuoso";
import {
  EMPTY_MOUNTED_RANGE,
  rangeCovers,
  sameRange,
  shouldVirtualizeFileList,
  type MountedRange,
} from "@/lib/fileListWindowing";
import { openFileRowMenuFromKeyboard } from "@/hooks/useFileRowMenuItems";
import type { FileStageRowSection } from "./FileStageRow";

export interface ReviewHubNavigableItem {
  section: FileStageRowSection;
  file: StagingFileEntry;
}

interface UseReviewHubFileCursorArgs {
  /** The flat staged-then-unstaged list, in render order. */
  navigableItems: ReviewHubNavigableItem[];
  /** How many of `navigableItems` are staged rows. */
  stagedCount: number;
  /**
   * Anything that leaves the working-tree rows off screen or under a diff: a
   * collapsed list, the base-branch view, an open diff. Cancels a held row
   * menu rather than replaying it.
   */
  menuReplayBlocked: boolean;
}

/**
 * The keyboard cursor over the working-tree file list and the windowing it
 * has to reveal through: the cursor follows its file across list mutations,
 * reveals only when it lands on a different file, and a row menu asked for on
 * an unmounted row is held until the reveal mounts it.
 */
export function useReviewHubFileCursor({
  navigableItems,
  stagedCount,
  menuReplayBlocked,
}: UseReviewHubFileCursorArgs) {
  // Keyboard-navigation focus across the flat staged+unstaged file list. -1 means
  // no row is keyboard-focused. Driven entirely by the capture-phase key handler;
  // `fileListRef` scopes the listbox + scroll-into-view, and `focusedItemKeyRef`
  // (a `section:path` key) preserves focus on the same file across list mutations.
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const fileListRef = useRef<HTMLDivElement | null>(null);
  const movingListFocusRef = useRef(false);
  // Reveal handles for the two windowed sections. Null on the static path,
  // where the DOM query below still finds every row.
  const stagedListRef = useRef<VirtuosoHandle | null>(null);
  const unstagedListRef = useRef<VirtuosoHandle | null>(null);
  // What each section currently has MOUNTED, in that section's OWN index space.
  // Deliberately not converted to flat coordinates on the way in: the staged
  // count shifts every unstaged row's flat index, and Virtuoso does not re-emit
  // an unchanged local range, so a stored flat range would silently describe
  // rows that had moved out from under it. `null` means no virtualizer has
  // reported yet — read as "nothing mounted", never as "everything".
  const [stagedRange, setStagedRange] = useState<MountedRange>(null);
  const [unstagedRange, setUnstagedRange] = useState<MountedRange>(null);
  // A row menu asked for on a row the window had scrolled past. Held until the
  // reveal mounts the row, then replayed — see the effect near the key handler.
  // Carries the file's identity as well as its index: a refresh can put a
  // DIFFERENT file at the same index, and opening that file's menu is worse
  // than dropping the key.
  const [pendingMenu, setPendingMenu] = useState<{ index: number; key: string } | null>(null);
  const focusedItemKeyRef = useRef<string | null>(null);
  // The same `section:path` value as the ref above, mirrored into state so it
  // can drive the reveal effect — a ref cannot. The ref stays the source of
  // truth because the reconciler reads it synchronously, before the render that
  // would publish new state. `writeCursorKey` keeps the two in step; nothing
  // may write one without the other.
  const [focusedCursorKey, setFocusedCursorKey] = useState<string | null>(null);
  const writeCursorKey = useCallback((key: string | null) => {
    focusedItemKeyRef.current = key;
    setFocusedCursorKey(key);
  }, []);

  // Reconcile `focusedIndex` when the list mutates (filter, sort, stage/unstage,
  // refresh). Preserve focus on the same file by `section:path`; if it left the
  // list, clamp to the nearest valid index so focus never points off the end.
  useEffect(() => {
    if (navigableItems.length === 0) {
      writeCursorKey(null);
      setFocusedIndex((prev) => (prev === -1 ? prev : -1));
      return;
    }
    const key = focusedItemKeyRef.current;
    if (key === null) return;
    const nextIdx = navigableItems.findIndex((item) => `${item.section}:${item.file.path}` === key);
    if (nextIdx === -1) {
      const clamped = Math.min(focusedIndex < 0 ? 0 : focusedIndex, navigableItems.length - 1);
      const clampedItem = navigableItems[clamped];
      writeCursorKey(clampedItem ? `${clampedItem.section}:${clampedItem.file.path}` : null);
      setFocusedIndex(clamped);
    } else if (nextIdx !== focusedIndex) {
      setFocusedIndex(nextIdx);
    }
  }, [navigableItems, focusedIndex, writeCursorKey]);

  // Whether the working-tree list windows. Decided across BOTH sections: they
  // share one scroll container and one cursor, so windowing one and not the
  // other would leave the cursor crossing a seam between two reveal mechanisms.
  const workingTreeVirtualized = shouldVirtualizeFileList(navigableItems.length);

  // Reveal, in two steps rather than one, because react-virtuoso cannot do the
  // first one correctly here.
  //
  // A MOUNTED row is scrolled natively, exactly as this list always did. That
  // is not a fallback: with `customScrollParent`, Virtuoso clamps its
  // section-local scrollTop to zero while keeping the PARENT's full viewport
  // height, so a section sitting below the fold believes its first rows are on
  // screen. `scrollIntoView`'s already-visible check reads those numbers and
  // no-ops on a row the user cannot see. The DOM knows the truth.
  //
  // An ABSENT row only the virtualizer can place, and `scrollToIndex` is the
  // right call there precisely because it skips that visibility check — the
  // destination it computes is in parent coordinates and is correct.
  const revealCursor = useEffectEvent(() => revealRow(focusedIndex));

  const revealRow = useCallback(
    (index: number) => {
      const row = fileListRef.current?.querySelector<HTMLElement>(`[data-row-index="${index}"]`);
      if (row) {
        row.scrollIntoView({ behavior: "instant", block: "nearest" });
        return;
      }
      if (!workingTreeVirtualized) return;
      const handle = index < stagedCount ? stagedListRef.current : unstagedListRef.current;
      handle?.scrollToIndex({
        index: index < stagedCount ? index : index - stagedCount,
        // `start`, never `center`: centring subtracts half the viewport height,
        // and the viewport height a `customScrollParent` list is given is
        // `parentHeight - max(0, listTop - parentTop)` — which goes NEGATIVE for a
        // section far below the fold and sends the scroll past the row entirely.
        // Aligning to the top needs no viewport arithmetic at all.
        align: "start",
        behavior: "auto",
      });
    },
    [workingTreeVirtualized, stagedCount]
  );

  // Reveal when the cursor lands on a DIFFERENT FILE — never merely because its
  // index moved. Reconciliation renumbers every row below a stage, an unstage
  // or a re-sort, so a stationary cursor takes a new index constantly, and
  // scrolling for that drags the view off whatever the user was looking at
  // (#11684).
  //
  // `focusedCursorKey` is the same `section:path` value `focusedItemKeyRef`
  // holds, mirrored into state because a ref cannot drive an effect. Keying on
  // it rather than on `focusedIndex` + `navigableItems` also settles the
  // ordering: a refresh swaps the list one commit before the reconcile effect
  // below moves the index to follow the file, and an effect that read the new
  // list at the old index would see a different file, reveal it, and reveal
  // again on the way back. Both writers below set the key and the index
  // together, so this only ever fires on a settled cursor.
  useLayoutEffect(() => {
    if (focusedCursorKey === null) return;
    revealCursor();
  }, [focusedCursorKey]);

  // A row menu requested on a row the window had scrolled past. `revealRow`
  // above has already asked for it; this fires on the commit that mounts it.
  // Dropped rather than retried if the row leaves the list first — a filter, a
  // stage or a refresh means the menu no longer names anything.
  useEffect(() => {
    if (pendingMenu === null) return;
    const item = navigableItems[pendingMenu.index];
    const key = item ? `${item.section}:${item.file.path}` : null;
    // Everything that makes the request meaningless cancels it. An armed
    // request that outlives its reason is the failure mode here: it would open
    // a menu the user never asked for, on whatever file happens to occupy that
    // index by the time a row mounts.
    if (pendingMenu.index !== focusedIndex || key !== pendingMenu.key || menuReplayBlocked) {
      setPendingMenu(null);
      return;
    }
    const row = fileListRef.current?.querySelector<HTMLElement>(
      `[data-row-index="${pendingMenu.index}"]`
    );
    if (!row) return;
    setPendingMenu(null);
    openFileRowMenuFromKeyboard(row);
  }, [pendingMenu, focusedIndex, navigableItems, menuReplayBlocked, stagedRange, unstagedRange]);

  // The keyboard's cursor move: the file's identity and its index together, as
  // every cursor writer must.
  const moveCursorTo = useCallback(
    (index: number) => {
      const item = navigableItems[index];
      if (!item) return;
      setFocusedIndex(index);
      writeCursorKey(`${item.section}:${item.file.path}`);
      // Move DOM focus to the listbox so assistive tech announces the active
      // option via aria-activedescendant. Scroll is handled by the layout effect.
      // Flagged so the listbox's Tab-entry seeding, which would read the index
      // from before this keypress, stands down for this focus.
      movingListFocusRef.current = true;
      fileListRef.current?.focus({ preventScroll: true });
      movingListFocusRef.current = false;
    },
    [navigableItems, writeCursorKey]
  );

  // Guarded rather than set unconditionally: Virtuoso fires `rangeChanged` on
  // every scroll frame, and re-rendering the hub at that cadence would cost far
  // more than the attribute it feeds is worth. Stable identities, so a changing
  // staged count cannot make Virtuoso resubscribe — it would not replay the
  // current range if it did.
  const handleStagedRangeChange = useCallback((range: MountedRange) => {
    setStagedRange((current) => (sameRange(current, range) ? current : range));
  }, []);
  const handleUnstagedRangeChange = useCallback((range: MountedRange) => {
    setUnstagedRange((current) => (sameRange(current, range) ? current : range));
  }, []);

  // Never point `aria-activedescendant` at a row that is not in the document.
  // On the static path every row is mounted and the answer is always yes; the
  // windowed path mounts a slice, so a cursor the user has scrolled away from
  // has an index in `navigableItems` and no DOM node at all.
  const focusedRowExists = focusedIndex >= 0 && focusedIndex < navigableItems.length;
  const focusedRowIsMounted =
    focusedRowExists &&
    (!workingTreeVirtualized ||
      (focusedIndex < stagedCount
        ? rangeCovers(stagedRange ?? EMPTY_MOUNTED_RANGE, focusedIndex)
        : rangeCovers(unstagedRange ?? EMPTY_MOUNTED_RANGE, focusedIndex - stagedCount)));

  return {
    focusedIndex,
    setFocusedIndex,
    writeCursorKey,
    moveCursorTo,
    fileListRef,
    movingListFocusRef,
    stagedListRef,
    unstagedListRef,
    handleStagedRangeChange,
    handleUnstagedRangeChange,
    workingTreeVirtualized,
    focusedRowExists,
    focusedRowIsMounted,
    revealRow,
    setPendingMenu,
  };
}
