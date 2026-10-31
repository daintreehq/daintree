import { useCallback, useEffect, useRef, useState } from "react";
import { useDndMonitor } from "@dnd-kit/core";
import { isWorktreeSortDragData } from "@/components/DragDrop/SortableWorktreeCard";
import { applyManualWorktreeReorder } from "@/lib/worktreeReorder";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import type { WorktreeState } from "@/types";

const KEYBOARD_REORDER_ANNOUNCEMENT_DEBOUNCE_MS = 150;

interface UseSidebarReorderSessionOptions {
  worktrees: readonly WorktreeState[];
  /** The visible, pre-grouping worktree id order that a reorder moves within. */
  dragStartOrder: readonly string[];
  isGroupedByType: boolean;
  liveQuery: string;
}

/**
 * The sidebar's reorder session: Alt+Arrow keyboard reorder, the screen-reader
 * announcements for it, and the assertive interrupt for a cancelled worktree
 * drag. Drag sensors, drag-end commits and dnd-kit's own announcer stay in
 * `DndProvider`; this only listens, so it must render beneath it.
 */
export function useSidebarReorderSession({
  worktrees,
  dragStartOrder,
  isGroupedByType,
  liveQuery,
}: UseSidebarReorderSessionOptions) {
  // Latest dragStartOrder + sort-disabled state captured in refs so the
  // keyboard-reorder callback identity stays stable across renders without
  // missing new visible orders or going stale on group/search toggles.
  const dragStartOrderRef = useRef<readonly string[]>([]);
  const isSortDisabledRef = useRef(false);
  // Latest worktrees captured in a ref so the keyboard-reorder callback can
  // resolve the moved row's display name for the announcement without taking
  // `worktrees` as a dep (which would churn the callback identity every poll).
  const worktreesRef = useRef<readonly WorktreeState[]>([]);
  // Trailing debounce for the sr-only reorder announcement: OS key-repeat fires
  // Alt+Arrow at ~30Hz, and NVDA/JAWS queue every intermediate position on a
  // polite live region, so without this they keep reading stale slots long
  // after the row settles. Only the final resting position is announced.
  const reorderAnnouncementTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [keyboardReorderAnnouncement, setKeyboardReorderAnnouncement] = useState("");
  // Assertive sibling region for explicit Escape-cancel during a worktree-sort
  // drag. dnd-kit's built-in announcer is polite, so the cancel string can
  // queue behind backlogged movement announcements from Alt+Arrow. Setting
  // assertive state forces NVDA/JAWS to flush the speech buffer. The
  // clear-then-setTimeout pattern is required so a repeat cancel string
  // produces a fresh DOM mutation that AT actually treats as new content.
  const [keyboardCancelAnnouncement, setKeyboardCancelAnnouncement] = useState("");
  const cancelAnnouncementTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Any drag, not only a worktree sort: whatever is being dragged may be
  // dropped on a row, so nothing may cover the list while one is in flight.
  const [isDragActive, setIsDragActive] = useState(false);
  const handleKeyboardReorder = useCallback((worktreeId: string, delta: -1 | 1) => {
    // Grouped-by-type and active-search modes hide the drag handle; keyboard
    // reorder must mirror that — writing to manualOrder here would silently
    // mutate ordering the user can't see being applied.
    if (isSortDisabledRef.current) return;
    const visible = dragStartOrderRef.current;
    const currentIdx = visible.indexOf(worktreeId);
    if (currentIdx === -1) return;
    const targetIdx = currentIdx + delta;
    if (targetIdx < 0 || targetIdx >= visible.length) return;
    const filterStore = useWorktreeFilterStore.getState();
    const merged = applyManualWorktreeReorder(
      filterStore.manualOrder,
      visible,
      currentIdx,
      targetIdx
    );
    filterStore.setManualOrder(merged);
    filterStore.setOrderBy("manual");
    // Resolve the label through issueTitle → branch → name, matching the
    // drag-cancel announcer below and DndProvider.resolveWorktreeLabel, so a
    // keyboard reorder reads the same headline the user sees on the card rather
    // than the bare (rarely-visible) name (issue #10317).
    const wt = worktreesRef.current.find((w) => w.id === worktreeId);
    const label = wt?.issueTitle ?? wt?.branch ?? wt?.name ?? "worktree";
    const message = `Moved '${label}' to position ${targetIdx + 1} of ${visible.length}`;
    if (reorderAnnouncementTimerRef.current !== null) {
      clearTimeout(reorderAnnouncementTimerRef.current);
    }
    reorderAnnouncementTimerRef.current = setTimeout(() => {
      reorderAnnouncementTimerRef.current = null;
      setKeyboardReorderAnnouncement(message);
    }, KEYBOARD_REORDER_ANNOUNCEMENT_DEBOUNCE_MS);
  }, []);
  // Drop the cancel timer if the sidebar unmounts mid-flight so the trailing
  // setTimeout doesn't fire setState on an unmounted component.
  useEffect(() => {
    return () => {
      if (cancelAnnouncementTimerRef.current !== null) {
        clearTimeout(cancelAnnouncementTimerRef.current);
        cancelAnnouncementTimerRef.current = null;
      }
    };
  }, []);
  useDndMonitor({
    onDragStart() {
      setIsDragActive(true);
      // Drop any pending 50ms cancel-announcement timer from a previous drag
      // so a rapid Escape → pickup sequence can't speak stale cancel copy on
      // top of the new drag's pickup announcement.
      if (cancelAnnouncementTimerRef.current !== null) {
        clearTimeout(cancelAnnouncementTimerRef.current);
        cancelAnnouncementTimerRef.current = null;
      }
    },
    onDragEnd() {
      setIsDragActive(false);
    },
    onDragCancel({ active }) {
      setIsDragActive(false);
      // Only handle worktree-sort drags — other drag types live on their own
      // surfaces and don't compete with this region's polite Alt+Arrow queue.
      // Note: dnd-kit fires onDragCancel for both Escape presses and
      // cancelDrop-converted rejections (e.g., a grid-full rejection). The
      // assertive interrupt is appropriate for both since each ends the drag
      // without committing, and the user needs immediate audible feedback.
      if (!isWorktreeSortDragData(active.data.current as Record<string, unknown> | undefined)) {
        return;
      }
      const worktreeId = (active.data.current as { worktreeId?: string } | undefined)?.worktreeId;
      const wt = worktreeId ? worktreesRef.current.find((w) => w.id === worktreeId) : undefined;
      // Match DndProvider.resolveWorktreeLabel so the assertive interrupt
      // reads the same human-readable name the polite announcer would.
      const label = wt?.issueTitle ?? wt?.branch ?? wt?.name ?? "worktree";
      // Drop any pending trailing reorder announcement so the polite region
      // doesn't speak a stale "Moved to position N" after the cancel lands.
      if (reorderAnnouncementTimerRef.current !== null) {
        clearTimeout(reorderAnnouncementTimerRef.current);
        reorderAnnouncementTimerRef.current = null;
      }
      setKeyboardReorderAnnouncement("");
      // Clear → 50ms → set so repeated cancels still register as new content
      // in the AT speech buffer. Same DOM-mutation trick the polite region
      // doesn't need because its strings already differ between updates.
      setKeyboardCancelAnnouncement("");
      if (cancelAnnouncementTimerRef.current !== null) {
        clearTimeout(cancelAnnouncementTimerRef.current);
      }
      cancelAnnouncementTimerRef.current = setTimeout(() => {
        cancelAnnouncementTimerRef.current = null;
        setKeyboardCancelAnnouncement(`Drag cancelled. ${label} returned to its original position`);
      }, 50);
    },
  });
  useEffect(() => {
    worktreesRef.current = worktrees;
  }, [worktrees]);

  const isSortDisabledPrevRef = useRef(isGroupedByType || liveQuery.trim().length > 0);
  useEffect(() => {
    const current = isGroupedByType || liveQuery.trim().length > 0;
    const prev = isSortDisabledPrevRef.current;
    isSortDisabledPrevRef.current = current;
    if (prev && !current) {
      if (reorderAnnouncementTimerRef.current !== null) {
        clearTimeout(reorderAnnouncementTimerRef.current);
      }
      reorderAnnouncementTimerRef.current = setTimeout(() => {
        reorderAnnouncementTimerRef.current = null;
        setKeyboardReorderAnnouncement("Manual reorder available");
      }, KEYBOARD_REORDER_ANNOUNCEMENT_DEBOUNCE_MS);
    }
    return () => {
      if (reorderAnnouncementTimerRef.current !== null) {
        clearTimeout(reorderAnnouncementTimerRef.current);
        reorderAnnouncementTimerRef.current = null;
      }
    };
  }, [isGroupedByType, liveQuery]);

  useEffect(() => {
    dragStartOrderRef.current = dragStartOrder;
  }, [dragStartOrder]);

  // Drop a pending reorder announcement if the sidebar unmounts mid-key-repeat.
  useEffect(() => {
    return () => {
      if (reorderAnnouncementTimerRef.current !== null) {
        clearTimeout(reorderAnnouncementTimerRef.current);
      }
    };
  }, []);

  const hasQuery = liveQuery.trim().length > 0;
  const isSortDisabled = isGroupedByType || hasQuery;
  useEffect(() => {
    isSortDisabledRef.current = isSortDisabled;
  }, [isSortDisabled]);

  // Names drag reorder, not sorting: `sortWorktreesByRelevance` still honours the
  // chosen order as a tie-breaker within each relevance score, so "sorting
  // disabled" described neither what stops nor what this flag actually gates.
  const dragDisabledReason = hasQuery
    ? "Drag to reorder is off while searching"
    : isGroupedByType
      ? "Drag to reorder is off while grouped by type"
      : null;

  // Announce the sort-disabled reason whenever it appears or changes — covers
  // null → reason (sorting becomes disabled) and reason → reason (e.g. switching
  // from group-by-type to an active search). The reason → null re-enable
  // transition ("Manual reorder available") is owned by the isSortDisabledPrevRef
  // effect above, so we skip it here to avoid double-speaking. Initialising the
  // ref to the current value keeps mount silent: a sidebar that opens with a
  // persisted filter shows the visual text rather than announcing stale state.
  const prevDragDisabledReasonRef = useRef<string | null>(dragDisabledReason);
  useEffect(() => {
    const prev = prevDragDisabledReasonRef.current;
    prevDragDisabledReasonRef.current = dragDisabledReason;
    if (dragDisabledReason !== null && prev !== dragDisabledReason) {
      useAnnouncerStore.getState().announce(dragDisabledReason);
    }
  }, [dragDisabledReason]);

  return {
    handleKeyboardReorder,
    keyboardReorderAnnouncement,
    keyboardCancelAnnouncement,
    isSortDisabled,
    dragDisabledReason,
    isDragActive,
  };
}
