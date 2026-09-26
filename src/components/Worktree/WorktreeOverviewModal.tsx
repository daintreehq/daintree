import React, { useCallback, useEffect, useEffectEvent, useRef, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  AppPaletteDialog,
  PaletteFooterHints,
  type PaletteCloseReason,
} from "@/components/ui/AppPaletteDialog";
import { FocusHandoffGuard } from "./FocusHandoffGuard";
import { PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { cn } from "@/lib/utils";
import { useShallow } from "zustand/react/shallow";
import { QuickStateFilterBar } from "./QuickStateFilterBar";
import { WorktreeSidebarSearchBar } from "./WorktreeSidebarSearchBar";
import { WorktreeOverviewColumnHeaders, WorktreeOverviewRow } from "./WorktreeOverviewRow";
import { useWorktreeBulkRemove } from "./useWorktreeBulkRemove";
import { WorktreeBulkRemoveDialog } from "./WorktreeBulkRemoveDialog";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  useWorktreeOverviewKeyboard,
  getWorktreeOverviewCellId,
} from "./useWorktreeOverviewKeyboard";
import type { WorktreeState } from "@/types";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { useWorktreeDevServerStore } from "@/store/worktreeDevServerStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { actionService } from "@/services/ActionService";
import { useKeybindingDisplay } from "@/hooks/useKeybinding";
import { describeActiveFacets } from "@/lib/worktreeFilterOptions";
import {
  matchesFilters,
  matchesQuickStateFilter,
  sortWorktrees,
  groupByType,
  computeChipCounts,
  type DerivedWorktreeMeta,
  type FilterState,
  type GroupedSection,
  type QuickStateFilter,
} from "@/lib/worktreeFilters";
import { Button } from "@/components/ui/button";
import { isAgentTerminal } from "@/utils/terminalType";
import { isTerminalVisible } from "@/lib/terminalVisibility";
import { useWorktreeIds } from "@/hooks/useTerminalSelectors";
import { computeChipState } from "@/components/Worktree/utils/computeChipState";
import { LazyOtherHostsWorktrees } from "@/components/Hosts/Overview/LazyHostOverviewParts";

const LIST_ID = "worktree-overview-list";

const noop = () => {};

const EMPTY_META: DerivedWorktreeMeta = {
  terminalCount: 0,
  hasWorkingAgent: false,
  hasWaitingAgent: false,
  hasCompletedAgent: false,
  hasExitedAgent: false,
  hasMergeConflict: false,
  chipState: null,
};

export interface WorktreeOverviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  worktrees: WorktreeState[];
  isLoading?: boolean;
  activeWorktreeId: string | null;
  onSelectWorktree: (worktreeId: string) => void;
}

/**
 * The worktree overview: every worktree as one row of the sidebar's own
 * vocabulary, with the columns the sidebar has no room for — which agents are
 * in it and what the one that needs you is on, the size of the change, how old
 * it is. A palette at the `overview` tier, the same box as the agent overview,
 * because it is the same kind of surface: a keyboard-driven table you open,
 * read, act on and leave.
 */
export function WorktreeOverviewModal({
  isOpen,
  onClose,
  worktrees,
  isLoading = false,
  activeWorktreeId,
  onSelectWorktree,
}: WorktreeOverviewModalProps) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const overviewShortcut = useKeybindingDisplay("worktree.overview");

  const {
    liveQuery,
    orderBy,
    groupByType: isGroupedByType,
    statusFilters,
    typeFilters,
    prIssueFilters,
    sessionFilters,
    activityFilters,
    devServerFilters,
    alwaysShowActive,
    alwaysShowWaiting,
    pinnedWorktrees,
    manualOrder,
    quickStateFilter,
  } = useWorktreeFilterStore(
    useShallow((state) => ({
      // The field's own value, not the debounced persisted `query`: the list has
      // to agree with what the field says the moment it says it, or a fast
      // type-then-Enter acts on the previous query's results.
      liveQuery: state.liveQuery,
      orderBy: state.orderBy,
      groupByType: state.groupByType,
      statusFilters: state.statusFilters,
      typeFilters: state.typeFilters,
      prIssueFilters: state.prIssueFilters,
      sessionFilters: state.sessionFilters,
      activityFilters: state.activityFilters,
      devServerFilters: state.devServerFilters,
      alwaysShowActive: state.alwaysShowActive,
      alwaysShowWaiting: state.alwaysShowWaiting,
      pinnedWorktrees: state.pinnedWorktrees,
      manualOrder: state.manualOrder,
      quickStateFilter: state.quickStateFilter,
    }))
  );
  const devServerSessions = useWorktreeDevServerStore((s) => s.sessionsByWorktreeId);
  const clearAllFilters = useWorktreeFilterStore((state) => state.clearAll);
  const hasFacetFilters = useWorktreeFilterStore((state) => state.hasFacetFilters);
  const hasFacetFiltersActive = hasFacetFilters();
  const setQuickStateFilter = useWorktreeFilterStore((state) => state.setQuickStateFilter);

  const panelsById = usePanelStore((state) => state.panelsById);
  const panelIdsByWorktreeId = usePanelStore((state) => state.panelIdsByWorktreeId);
  const isInTrash = usePanelStore((state) => state.isInTrash);
  const worktreeIds = useWorktreeIds();

  const derivedMetaMap = useMemo(() => {
    const map = new Map<string, DerivedWorktreeMeta>();
    for (const worktree of worktrees) {
      let terminalCount = 0;
      let waitingTerminalCount = 0;
      let hasWorkingAgent = false;
      let hasWaitingAgent = false;
      let hasCompletedAgent = false;
      let hasExitedAgent = false;
      for (const id of panelIdsByWorktreeId[worktree.id] ?? []) {
        const t = panelsById[id];
        if (!t || !isTerminalVisible(t, isInTrash, worktreeIds)) continue;
        terminalCount++;
        if (!isAgentTerminal(t)) continue;
        if (!isPtyPanel(t)) continue;
        if (t.agentState === "working") hasWorkingAgent = true;
        if (t.agentState === "waiting") {
          hasWaitingAgent = true;
          waitingTerminalCount++;
        }
        if (t.agentState === "completed") hasCompletedAgent = true;
        if (t.agentState === "exited") hasExitedAgent = true;
      }
      const hasChanges = (worktree.worktreeChanges?.changedFileCount ?? 0) > 0;
      const isComplete =
        !!worktree.issueNumber &&
        !!worktree.linked?.pr &&
        worktree.linked.pr.state !== "closed" &&
        worktree.linked.pr.state !== "declined" &&
        !hasChanges &&
        worktree.worktreeChanges !== null;
      let lifecycleStage: "in-review" | "merged" | "ready-for-cleanup" | null = null;
      if (!worktree.isMainWorktree && worktree.worktreeChanges !== null) {
        if (worktree.linked?.pr?.state === "merged") {
          lifecycleStage = worktree.issueNumber ? "ready-for-cleanup" : "merged";
        } else if (worktree.linked?.pr?.state === "open") {
          lifecycleStage = "in-review";
        }
      }
      const chipState = computeChipState({
        waitingTerminalCount,
        lifecycleStage,
        isComplete,
        hasActiveAgent: hasWorkingAgent,
      });
      map.set(worktree.id, {
        terminalCount,
        hasWorkingAgent,
        hasWaitingAgent,
        hasCompletedAgent,
        hasExitedAgent,
        hasMergeConflict:
          worktree.worktreeChanges?.changes.some((c) => c.status === "conflicted") ?? false,
        chipState,
      });
    }
    return map;
  }, [worktrees, panelsById, panelIdsByWorktreeId, isInTrash, worktreeIds]);

  const facetFilters = useMemo<FilterState>(
    () => ({
      query: liveQuery,
      statusFilters,
      typeFilters,
      prIssueFilters,
      sessionFilters,
      activityFilters,
      devServerFilters,
    }),
    [
      liveQuery,
      statusFilters,
      typeFilters,
      prIssueFilters,
      sessionFilters,
      activityFilters,
      devServerFilters,
    ]
  );

  const chipCounts = useMemo(
    () =>
      computeChipCounts(
        worktrees,
        derivedMetaMap,
        activeWorktreeId,
        facetFilters,
        devServerSessions
      ),
    [worktrees, derivedMetaMap, activeWorktreeId, facetFilters, devServerSessions]
  );

  const hasNonMainWorktrees = useMemo(() => worktrees.some((w) => !w.isMainWorktree), [worktrees]);

  const { filteredWorktrees, groupedSections, quickStateCounts } = useMemo(() => {
    const hasActiveQuery = liveQuery.trim().length > 0;
    // Counted over what the search and facets leave, before the quick-state
    // narrowing, so each segment says how many rows pressing it would show.
    const counts: Record<QuickStateFilter, number> = {
      all: 0,
      working: 0,
      waiting: 0,
      finished: 0,
    };

    const filtered = worktrees.filter((worktree) => {
      const derived = derivedMetaMap.get(worktree.id) ?? EMPTY_META;
      const isActive = worktree.id === activeWorktreeId;
      const matchesScope = matchesFilters(
        worktree,
        facetFilters,
        derived,
        isActive,
        devServerSessions
      );
      if (matchesScope) {
        counts.all++;
        if (matchesQuickStateFilter("working", derived)) counts.working++;
        if (matchesQuickStateFilter("waiting", derived)) counts.waiting++;
        if (matchesQuickStateFilter("finished", derived)) counts.finished++;
      }

      const bypassesNarrowing =
        !hasActiveQuery && quickStateFilter === "all" && !hasFacetFiltersActive;
      if (alwaysShowActive && isActive && bypassesNarrowing) return true;
      if (alwaysShowWaiting && derived.hasWaitingAgent && bypassesNarrowing) return true;

      if (quickStateFilter !== "all" && !matchesQuickStateFilter(quickStateFilter, derived)) {
        return false;
      }

      return matchesScope;
    });

    const existingWorktreeIds = new Set(worktrees.map((w) => w.id));
    const validPinnedWorktrees = pinnedWorktrees.filter((id) => existingWorktreeIds.has(id));
    const sorted = sortWorktrees(filtered, orderBy, validPinnedWorktrees, manualOrder);

    return {
      filteredWorktrees: sorted,
      groupedSections: isGroupedByType ? groupByType(sorted, orderBy, validPinnedWorktrees) : null,
      quickStateCounts: counts,
    };
  }, [
    worktrees,
    liveQuery,
    facetFilters,
    orderBy,
    isGroupedByType,
    devServerSessions,
    alwaysShowActive,
    alwaysShowWaiting,
    pinnedWorktrees,
    manualOrder,
    derivedMetaMap,
    activeWorktreeId,
    quickStateFilter,
    hasFacetFiltersActive,
  ]);

  // ── Multi-select state ────────────────────────────────────────────────
  // Selection lives on the modal so it resets naturally when the modal
  // unmounts. Persistent stores would outlive the modal session and
  // re-surface stale selection on reopen.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Anchor for contiguous range selection. Survives filter changes by design
  // (lesson #4729) — only deliberate actions reset it.
  const selectionAnchorRef = useRef<string | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  // Must mirror DOM render order so keyboard navigation indexes into the right
  // row. When grouped, the DOM flattens groupedSections in section order; the
  // flat sorted order in filteredWorktrees does not match.
  const visibleIds = useMemo(
    () =>
      groupedSections
        ? groupedSections.flatMap((s) => s.worktrees.map((w) => w.id))
        : filteredWorktrees.map((w) => w.id),
    [groupedSections, filteredWorktrees]
  );
  const visibleIdSet = useMemo(() => new Set(visibleIds), [visibleIds]);

  // Drop selections that are no longer visible (filter narrowed). The anchor is
  // deliberately not reset — re-widening the filter resumes range selection.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visibleIdSet.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [visibleIdSet]);

  const toggleSelection = useCallback((worktreeId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(worktreeId)) {
        next.delete(worktreeId);
      } else {
        next.add(worktreeId);
      }
      return next;
    });
  }, []);

  const selectRangeBetween = useCallback(
    (anchorId: string, targetId: string) => {
      const anchorIdx = visibleIds.indexOf(anchorId);
      const targetIdx = visibleIds.indexOf(targetId);
      if (anchorIdx === -1 || targetIdx === -1) return;
      const [lo, hi] = anchorIdx <= targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
      setSelectedIds(new Set(visibleIds.slice(lo, hi + 1)));
    },
    [visibleIds]
  );

  const selectAllVisible = useCallback(() => {
    setSelectedIds(new Set(visibleIds));
  }, [visibleIds]);

  const clearSelection = useCallback(() => {
    selectionAnchorRef.current = null;
    setSelectedIds(new Set());
  }, []);

  const activateWorktree = useCallback(
    (worktreeId: string) => {
      onSelectWorktree(worktreeId);
      onClose();
    },
    [onSelectWorktree, onClose]
  );

  const hasSelection = selectedIds.size > 0;

  // Snapshot lookup for the bulk-remove hook, taken at confirm-click time
  // rather than re-derived from the filtered list (lesson #4729 — reactive
  // derivations silently shrink as deletes land).
  const worktreeMap = useMemo(() => {
    const map = new Map<string, WorktreeState>();
    for (const w of worktrees) map.set(w.id, w);
    return map;
  }, [worktrees]);

  const bulkRemove = useWorktreeBulkRemove({
    selectedIds,
    worktreeMap,
    clearSelection,
  });

  // D1 close-sessions confirm. The id set is snapshotted at click time (lesson
  // #4729) so a selection change before the confirm cannot retarget it.
  const [isCloseSessionsConfirmOpen, setIsCloseSessionsConfirmOpen] = useState(false);
  const closeSessionsIdsRef = useRef<readonly string[]>([]);
  const [closeSessionsCount, setCloseSessionsCount] = useState(0);

  const handleCloseSessionsClick = useCallback(() => {
    const snapshot = Array.from(selectedIds);
    closeSessionsIdsRef.current = snapshot;
    setCloseSessionsCount(snapshot.length);
    setIsCloseSessionsConfirmOpen(true);
  }, [selectedIds]);

  const handleCloseSessionsConfirm = useCallback(() => {
    const state = usePanelStore.getState();
    const count = closeSessionsIdsRef.current.length;
    for (const id of closeSessionsIdsRef.current) {
      state.bulkCloseByWorktree(id);
    }
    closeSessionsIdsRef.current = [];
    setIsCloseSessionsConfirmOpen(false);
    clearSelection();
    useAnnouncerStore
      .getState()
      .announce(
        count === 1 ? "Closed sessions for 1 worktree" : `Closed sessions for ${count} worktrees`
      );
  }, [clearSelection]);

  const handleCloseSessionsCancel = useCallback(() => {
    closeSessionsIdsRef.current = [];
    setIsCloseSessionsConfirmOpen(false);
  }, []);

  /** ArrowDown out of the search field hands keyboard control to the list. */
  const handleArrowIntoResults = useCallback(() => {
    gridRef.current?.focus({ preventScroll: true });
  }, []);

  /**
   * The way back: ArrowUp off the top row, `/`, or any printable character
   * typed while the list holds focus. The character is appended rather than
   * dropped, so a user who arrows into the results and then decides to refine
   * the query simply keeps typing.
   */
  const handleReturnToSearch = useCallback((char?: string) => {
    const input = searchInputRef.current;
    if (!input) return;
    input.focus();
    if (char === undefined) return;
    // Through the prototype's native setter so React's onChange sees it —
    // assigning `.value` directly on a controlled input is swallowed.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, input.value + char);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, []);

  // Section sizes drive section-aware navigation across the header breaks.
  const sectionSizes = useMemo<readonly number[] | undefined>(
    () =>
      groupedSections
        ? groupedSections.map((s: GroupedSection<WorktreeState>) => s.worktrees.length)
        : undefined,
    [groupedSections]
  );

  const { activeDescendantId, handleGridKeyDown, handleGridFocus, setActiveWorktreeId } =
    useWorktreeOverviewKeyboard({
      worktreeIds: visibleIds,
      sectionSizes,
      gridRef,
      selectionAnchorRef,
      onActivate: activateWorktree,
      onToggleSelection: toggleSelection,
      onSelectRange: selectRangeBetween,
      onSelectAll: selectAllVisible,
      onClearSelection: clearSelection,
      // Left to the palette's layer-aware backstop, which yields to an open
      // tooltip or menu; closing from here would bypass it.
      onEscapeWithoutSelection: noop,
      onReturnToSearch: handleReturnToSearch,
      hasSelection,
    });

  const handleRowToggleSelect = useCallback(
    (worktreeId: string, event: React.MouseEvent) => {
      // A click inside an `aria-activedescendant` composite must move the
      // cursor to what was clicked AND pull DOM focus onto the container, or
      // the container's key handler never fires afterwards (APG keyboard
      // interface). Focus first: the focus handler seeds a cursor when there is
      // none, and it must not beat the row the pointer named.
      gridRef.current?.focus({ preventScroll: true });
      setActiveWorktreeId(worktreeId);

      if (event.shiftKey && selectionAnchorRef.current !== null) {
        selectRangeBetween(selectionAnchorRef.current, worktreeId);
        return;
      }
      selectionAnchorRef.current = worktreeId;
      toggleSelection(worktreeId);
    },
    [selectRangeBetween, toggleSelection, setActiveWorktreeId]
  );

  // `aria-activedescendant` is not DOM focus, so the browser does no scrolling
  // of its own — keep the cursor row on screen.
  useEffect(() => {
    if (!isOpen || !activeDescendantId) return;
    const cell = gridRef.current?.querySelector<HTMLElement>(
      `[id="${CSS.escape(activeDescendantId)}"]`
    );
    cell?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [isOpen, activeDescendantId]);

  // Reset the range anchor when the window loses focus (lesson #4591), so a
  // stuck Shift after Cmd+Tab cannot produce a phantom range on the next click.
  useEffect(() => {
    if (!isOpen) return;
    const handleWindowBlur = () => {
      selectionAnchorRef.current = null;
    };
    window.addEventListener("blur", handleWindowBlur);
    return () => window.removeEventListener("blur", handleWindowBlur);
  }, [isOpen]);

  // Cmd/Ctrl+A outside the list (the search field excepted, where it selects
  // the text). The list handles its own.
  const handleKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
      const target = e.target as HTMLElement | null;
      const isEditable =
        !!target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (isEditable) return;
      e.preventDefault();
      e.stopPropagation();
      selectionAnchorRef.current = visibleIds[0] ?? null;
      selectAllVisible();
    }
  });

  useEffect(() => {
    if (!isOpen) return;
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  // Escape's first press clears a selection; the second closes. The palette
  // routes Escape and a scrim click through the same `onClose` and says which,
  // and only the key is two-stage — a scrim click leaves in one.
  /**
   * Where focus goes when the control holding it leaves — the bulk bar, a
   * row's sessions changing shape, a confirmation closing: the list, or the
   * field if the list went too.
   */
  const handOffFocusToList = useCallback(() => {
    const grid = gridRef.current;
    if (grid?.isConnected) grid.focus({ preventScroll: true });
    else searchInputRef.current?.focus();
  }, []);

  const handleDismiss = useCallback(
    (reason?: PaletteCloseReason) => {
      if (reason === "escape" && hasSelection) {
        clearSelection();
        return;
      }
      onClose();
    },
    [hasSelection, clearSelection, onClose]
  );

  const resolveListFocusTarget = useCallback(
    () => (gridRef.current?.isConnected ? gridRef.current : searchInputRef.current),
    []
  );

  /**
   * The row menu for the keyboard. The list keeps DOM focus while the cursor is
   * an `aria-activedescendant`, so Shift+F10 and the Menu key land here rather
   * than on a row: forward them as a contextmenu event on the cursor row, at the
   * row's own position, which is what opens its menu for a pointer.
   */
  const handleListKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const isMenuKey = e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");
      if (isMenuKey && e.target === e.currentTarget && activeDescendantId) {
        const row = document.getElementById(activeDescendantId);
        if (row && gridRef.current?.contains(row)) {
          e.preventDefault();
          e.stopPropagation();
          const box = row.getBoundingClientRect();
          row.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: box.left + 32,
              clientY: box.top + box.height / 2,
            })
          );
          return;
        }
      }
      handleGridKeyDown(e);
    },
    [activeDescendantId, handleGridKeyDown]
  );

  const handleSearchEscape = useCallback(() => {
    if (!hasSelection) return false;
    clearSelection();
    return true;
  }, [hasSelection, clearSelection]);

  /**
   * Enter in the search field switches to the top result — the one row the
   * user can see it will act on. The list's cursor is not painted while the
   * field has focus, so preferring it here would switch to a row nothing on
   * screen had pointed at.
   */
  const handleSearchSubmit = useCallback(() => {
    const target = visibleIds[0];
    if (target) activateWorktree(target);
  }, [visibleIds, activateWorktree]);

  /**
   * Focus the field before the reset: the button that asked for it unmounts as
   * the results come back, and focus would otherwise fall to the document.
   */
  const handleClearAllFilters = useCallback(() => {
    searchInputRef.current?.focus();
    clearAllFilters();
  }, [clearAllFilters]);

  const activeFacetText = describeActiveFacets({
    statusFilters,
    typeFilters,
    prIssueFilters,
    sessionFilters,
    activityFilters,
    devServerFilters,
  });

  const createWorktree = useCallback(() => {
    void actionService.dispatch("worktree.createDialog.open", undefined, { source: "user" });
  }, []);

  const countLabel =
    filteredWorktrees.length === worktrees.length
      ? `${worktrees.length} ${worktrees.length === 1 ? "worktree" : "worktrees"}`
      : `${filteredWorktrees.length} of ${worktrees.length}`;

  const renderRow = (worktree: WorktreeState, isLast: boolean) => (
    <WorktreeOverviewRow
      key={worktree.id}
      worktree={worktree}
      cellId={getWorktreeOverviewCellId(worktree.id)}
      chipState={derivedMetaMap.get(worktree.id)?.chipState ?? null}
      isCurrent={worktree.id === activeWorktreeId}
      isSelected={selectedIds.has(worktree.id)}
      isCursor={activeDescendantId === getWorktreeOverviewCellId(worktree.id)}
      isSelecting={hasSelection}
      isLast={isLast}
      onActivate={activateWorktree}
      onToggleSelect={handleRowToggleSelect}
      onBeforeMenuAction={onClose}
      onFocusLost={handOffFocusToList}
    />
  );

  return (
    <>
      <AppPaletteDialog
        isOpen={isOpen}
        onClose={handleDismiss}
        ariaLabel="Worktrees"
        tier="workspace"
        // The whole box is budgeted, not just the results: the palette sits
        // 15vh down, so a 60vh list plus header, facet summary and footer ran
        // the footer off a laptop-height window.
        className="flex max-h-[calc(85dvh-16px)] flex-col"
        initialFocusRef={searchInputRef}
      >
        <div data-testid="worktree-overview-modal" className="flex min-h-0 flex-1 flex-col">
          {/* Selection is a mode change, and a screen reader has to hear it. The
              region exists before its text changes, and is atomic so "3 of 13
              selected" is read as one phrase. */}
          <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {hasSelection ? `${selectedIds.size} of ${filteredWorktrees.length} selected` : ""}
          </div>

          <AppPaletteDialog.Header
            className="shrink-0"
            label="Worktrees"
            shortcut={overviewShortcut}
            trailing={countLabel}
          >
            <WorktreeSidebarSearchBar
              variant="palette"
              inputRef={searchInputRef}
              onArrowIntoResults={handleArrowIntoResults}
              chipCounts={chipCounts}
              onEscape={handleSearchEscape}
              onSubmit={handleSearchSubmit}
              filterSummaryText={activeFacetText || null}
            />
            {/* The sidebar's own quick-state bar, full-bleed under the field
                like the agent overview's, so the header's rule closes the
                narrowing block. */}
            {hasNonMainWorktrees && (
              <div className="-mx-3 -mb-2 mt-2 border-t border-border-default">
                <QuickStateFilterBar
                  className="border-b-0"
                  value={quickStateFilter}
                  onChange={setQuickStateFilter}
                  counts={quickStateCounts}
                  showLabels
                />
              </div>
            )}
          </AppPaletteDialog.Header>

          {filteredWorktrees.length > 0 && <WorktreeOverviewColumnHeaders />}

          <ScrollShadow className="min-h-0 flex-1 max-h-[60vh]" scrollClassName="scroll-py-2">
            {isLoading && worktrees.length === 0 ? (
              <Skeleton label="Loading worktrees" className="flex flex-col">
                {Array.from({ length: 4 }).map((_, i) => (
                  <SkeletonBone key={i} heightPx={60} className="border-b border-divider" />
                ))}
              </Skeleton>
            ) : worktrees.length === 0 ? (
              <AppPaletteDialog.Empty query="" emptyMessage="Create a worktree to start">
                <Button variant="subtle" size="sm" onClick={createWorktree}>
                  Create worktree
                </Button>
              </AppPaletteDialog.Empty>
            ) : filteredWorktrees.length === 0 ? (
              <AppPaletteDialog.Empty
                query={liveQuery}
                {...(liveQuery.trim()
                  ? {}
                  : // `filterLabel` is what puts the empty state in its narrowed
                    // branch; without it a filter-only miss read "No items
                    // available" and lost its recovery button.
                    { filterLabel: "filters", noMatchMessage: "No worktrees match these filters" })}
                noMatchContent={
                  <Button variant="subtle" size="sm" onClick={handleClearAllFilters}>
                    Clear all filters
                  </Button>
                }
              />
            ) : (
              <div
                id={LIST_ID}
                ref={gridRef}
                role="grid"
                aria-label="Worktrees"
                tabIndex={0}
                aria-multiselectable="true"
                // Shift+F10 and the Menu key open the cursor row's own menu; the
                // marker tells the global handler not to take them for the
                // focused terminal first.
                data-row-menu=""
                aria-activedescendant={activeDescendantId}
                onKeyDown={handleListKeyDown}
                onFocus={handleGridFocus}
                className={cn(
                  "group/overview-grid grid grid-cols-1",
                  // The container must not paint its own ring — it spans the
                  // whole list. The cursor row paints the indicator instead,
                  // gated on this element's focus (see `WorktreeOverviewRow`).
                  "focus:outline-hidden"
                )}
              >
                {groupedSections
                  ? groupedSections.flatMap((section: GroupedSection<WorktreeState>) => [
                      <div
                        key={`section-header-${section.type}`}
                        role="presentation"
                        className="flex items-baseline gap-1.5 px-3 pt-3 pb-1 border-b border-divider"
                      >
                        <span className={PALETTE_SECTION_LABEL_CLASS}>{section.displayName}</span>
                        <span className="text-3xs tabular-nums text-text-secondary">
                          {section.worktrees.length}
                        </span>
                      </div>,
                      ...section.worktrees.map((worktree, i) =>
                        renderRow(worktree, i === section.worktrees.length - 1)
                      ),
                    ])
                  : filteredWorktrees.map((worktree, i) =>
                      renderRow(worktree, i === filteredWorktrees.length - 1)
                    )}
              </div>
            )}
          </ScrollShadow>

          <LazyOtherHostsWorktrees onNavigate={onClose} />

          {/* The footer is the action bar: the keyboard contract at rest, the
              bulk actions while a selection is active — next to the count they
              apply to. */}
          {hasSelection ? (
            <AppPaletteDialog.Footer className="shrink-0 justify-between">
              <FocusHandoffGuard onFocusLeaving={handOffFocusToList}>
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-text-primary font-medium tabular-nums">
                    {selectedIds.size} selected
                  </span>
                  <button
                    type="button"
                    onClick={clearSelection}
                    className={cn(
                      "rounded-[var(--radius-sm)] px-1.5 py-0.5 text-xs text-text-secondary",
                      "hover:bg-overlay-soft hover:text-text-primary transition-colors",
                      "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
                    )}
                  >
                    Clear
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="subtle"
                    size="sm"
                    onClick={handleCloseSessionsClick}
                    data-testid="worktree-bulk-close-sessions"
                  >
                    Close sessions
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={bulkRemove.handleRemoveClick}
                    disabled={bulkRemove.isExecuting}
                    data-testid="worktree-bulk-remove"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Remove worktrees
                  </Button>
                </div>
              </FocusHandoffGuard>
            </AppPaletteDialog.Footer>
          ) : filteredWorktrees.length > 0 ? (
            <AppPaletteDialog.Footer className="shrink-0">
              <PaletteFooterHints
                primaryHint={{ keys: ["↵"], label: "to switch" }}
                hints={[
                  { keys: ["↑", "↓"], label: "navigate" },
                  { keys: ["Space"], label: "select" },
                  { keys: ["F2"], label: "sessions" },
                  { keys: ["⇧", "F10"], label: "actions" },
                  { keys: ["Esc"], label: "close" },
                ]}
              />
            </AppPaletteDialog.Footer>
          ) : null}
        </div>
      </AppPaletteDialog>

      <ConfirmDialog
        isOpen={isCloseSessionsConfirmOpen}
        restoreFocusTo={resolveListFocusTarget}
        onClose={handleCloseSessionsCancel}
        title={
          closeSessionsCount === 1
            ? "Close sessions for 1 worktree?"
            : `Close sessions for ${closeSessionsCount} worktrees?`
        }
        description="Every grid and dock session for the selected worktrees will end. Scrollback is lost for each terminal."
        confirmLabel="Close sessions"
        cancelLabel="Cancel"
        variant="default"
        zIndex="nested"
        onConfirm={handleCloseSessionsConfirm}
      />

      {/* Bulk remove: typed-name gate and a fresh per-target delete preview
          (#12416), so the confirmation shows the files it is about to discard. */}
      <WorktreeBulkRemoveDialog bulkRemove={bulkRemove} restoreFocusTo={resolveListFocusTarget} />
    </>
  );
}
