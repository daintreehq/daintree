import React, { useCallback, useEffect, useEffectEvent, useRef, useMemo, useState } from "react";
import { X, FilterX, AlertTriangle, Trash2, GitBranch } from "lucide-react";
import { Layers, Plug } from "@/components/icons";
import { cn } from "@/lib/utils";
import { useShallow } from "zustand/react/shallow";
import { WorktreeCard } from "./WorktreeCard";
import { WorktreeFilterPopover } from "./WorktreeFilterPopover";
import { WorktreeSidebarSearchBar } from "./WorktreeSidebarSearchBar";
import { useWorktreeBulkRemove } from "./useWorktreeBulkRemove";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  useWorktreeOverviewKeyboard,
  getWorktreeOverviewCellId,
} from "./useWorktreeOverviewKeyboard";
import type { WorktreeState, WorktreeSnapshot } from "@/types";
import type { UseAgentLauncherReturn } from "@/hooks/useAgentLauncher";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { useWorktreeDevServerStore } from "@/store/worktreeDevServerStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { AccessibilityAnnouncer } from "@/components/Accessibility/AccessibilityAnnouncer";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { actionService } from "@/services/ActionService";
import {
  matchesFilters,
  matchesQuickStateFilter,
  sortWorktrees,
  groupByType,
  computeChipCounts,
  type DerivedWorktreeMeta,
  type FilterState,
  type GroupedSection,
} from "@/lib/worktreeFilters";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isAgentTerminal } from "@/utils/terminalType";
import { isTerminalVisible } from "@/lib/terminalVisibility";
import { useWorktreeIds } from "@/hooks/useTerminalSelectors";
import { computeChipState } from "@/components/Worktree/utils/computeChipState";

interface OverviewWorktreeCardProps {
  worktreeId: string;
  activeWorktreeId: string | null;
  focusedWorktreeId: string | null;
  totalWorktreeCount: number;
  variant?: "sidebar" | "grid";
  onSelectWorktree: (worktreeId: string) => void;
  onOpenEditor: (worktree: WorktreeSnapshot) => void;
  onSaveLayout?: (worktree: WorktreeSnapshot) => void;
  onLaunchAgent?: (worktreeId: string, agentId: string) => void;
  agentAvailability?: UseAgentLauncherReturn["availability"];
  agentSettings?: UseAgentLauncherReturn["agentSettings"];
  homeDir?: string;
  onClose: () => void;
  isSelected?: boolean;
  onToggleSelect?: (worktreeId: string, event: React.MouseEvent) => void;
}

function OverviewWorktreeCard({
  worktreeId,
  activeWorktreeId,
  focusedWorktreeId,
  totalWorktreeCount,
  variant,
  onSelectWorktree,
  onOpenEditor,
  onSaveLayout,
  onLaunchAgent,
  agentAvailability,
  agentSettings,
  homeDir,
  onClose,
  isSelected,
  onToggleSelect,
}: OverviewWorktreeCardProps) {
  const worktreeSnap = useWorktreeStore((state) => state.worktrees.get(worktreeId));
  const worktree = useMemo(
    () =>
      worktreeSnap
        ? ({
            ...worktreeSnap,
            worktreeChanges: worktreeSnap.worktreeChanges ?? null,
            lastActivityTimestamp: worktreeSnap.lastActivityTimestamp ?? null,
          } as WorktreeState)
        : undefined,
    [worktreeSnap]
  );

  const handleSelect = useCallback(() => {
    onSelectWorktree(worktreeId);
    onClose();
  }, [onSelectWorktree, onClose, worktreeId]);

  const handleOpenEditor = useCallback(
    () => worktree && onOpenEditor(worktree),
    [worktree, onOpenEditor]
  );
  const handleSaveLayout = useCallback(
    () => worktree && onSaveLayout?.(worktree),
    [worktree, onSaveLayout]
  );
  const handleLaunchAgent = useCallback(
    (agentId: string) => onLaunchAgent?.(worktreeId, agentId),
    [onLaunchAgent, worktreeId]
  );
  const handleToggleSelect = useCallback(
    (event: React.MouseEvent) => onToggleSelect?.(worktreeId, event),
    [onToggleSelect, worktreeId]
  );

  if (!worktree) return null;

  return (
    <WorktreeCard
      variant={variant}
      worktree={worktree}
      isActive={worktreeId === activeWorktreeId}
      isFocused={worktreeId === focusedWorktreeId}
      isSingleWorktree={totalWorktreeCount === 1}
      onSelect={handleSelect}
      onOpenEditor={handleOpenEditor}
      onSaveLayout={onSaveLayout ? handleSaveLayout : undefined}
      onLaunchAgent={onLaunchAgent ? handleLaunchAgent : undefined}
      agentAvailability={agentAvailability}
      agentSettings={agentSettings}
      homeDir={homeDir}
      onAfterTerminalSelect={onClose}
      isSelected={isSelected}
      onToggleSelect={onToggleSelect ? handleToggleSelect : undefined}
    />
  );
}

/**
 * One cell of the overview grid. Wraps {@link OverviewWorktreeCard} in the
 * ARIA `role="gridcell"` container that the keyboard hook tracks via
 * `aria-activedescendant`. Selection treatment lives on this wrapper, not
 * the card itself, so the shared {@link WorktreeCard} stays accent-policy
 * neutral and its sidebar variant is untouched.
 *
 * The wrapper is the actual rendered box (the card's chrome). Selection
 * styling uses `bg-overlay-subtle` + a neutral inset ring per CLAUDE.md's
 * accent-color restraint — accent is reserved for one load-bearing signal
 * per active focus region and is never used as a multi-select indicator.
 */
function OverviewGridCell(props: OverviewWorktreeCardProps) {
  const cellId = getWorktreeOverviewCellId(props.worktreeId);
  const isSelected = props.isSelected ?? false;
  return (
    <div
      id={cellId}
      role="gridcell"
      aria-selected={isSelected}
      data-worktree-overview-cell={props.worktreeId}
      style={{
        contentVisibility: "auto",
        containIntrinsicSize: "auto 240px",
      }}
      className={cn(
        "rounded-lg overflow-hidden",
        "border border-divider",
        "bg-daintree-sidebar/50",
        "transition duration-150",
        "hover:bg-overlay-subtle hover:shadow-[var(--theme-shadow-ambient)]",
        isSelected && "bg-overlay-subtle ring-1 ring-inset ring-border-default"
      )}
    >
      <OverviewWorktreeCard {...props} variant="grid" />
    </div>
  );
}

export interface WorktreeOverviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  worktrees: WorktreeState[];
  isLoading?: boolean;
  activeWorktreeId: string | null;
  focusedWorktreeId: string | null;
  onSelectWorktree: (worktreeId: string) => void;
  onOpenEditor: (worktree: WorktreeSnapshot) => void;
  onSaveLayout?: (worktree: WorktreeSnapshot) => void;
  onLaunchAgent?: (worktreeId: string, agentId: string) => void;
  agentAvailability?: UseAgentLauncherReturn["availability"];
  agentSettings?: UseAgentLauncherReturn["agentSettings"];
  homeDir?: string;
}

export function WorktreeOverviewModal({
  isOpen,
  onClose,
  worktrees,
  isLoading = false,
  activeWorktreeId,
  focusedWorktreeId,
  onSelectWorktree,
  onOpenEditor,
  onSaveLayout,
  onLaunchAgent,
  agentAvailability,
  agentSettings,
  homeDir,
}: WorktreeOverviewModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Filter store state
  const {
    query,
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
      query: state.query,
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
  const hasActiveFilters = useWorktreeFilterStore((state) => state.hasActiveFilters);
  const hasFacetFilters = useWorktreeFilterStore((state) => state.hasFacetFilters);
  const hasFacetFiltersActive = hasFacetFilters();
  const setQuickStateFilter = useWorktreeFilterStore((state) => state.setQuickStateFilter);

  // Terminal store for derived metadata
  const panelsById = usePanelStore((state) => state.panelsById);
  const panelIdsByWorktreeId = usePanelStore((state) => state.panelIdsByWorktreeId);
  const isInTrash = usePanelStore((state) => state.isInTrash);
  const worktreeIds = useWorktreeIds();

  // Error store for derived metadata
  // Filter store: hide main worktree preference
  const hideMainWorktree = useWorktreeFilterStore((state) => state.hideMainWorktree);
  const setHideMainWorktree = useWorktreeFilterStore((state) => state.setHideMainWorktree);

  // Compute derived metadata for each worktree
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

  const chipCounts = useMemo(() => {
    const candidates = hideMainWorktree ? worktrees.filter((w) => !w.isMainWorktree) : worktrees;
    return computeChipCounts(
      candidates,
      derivedMetaMap,
      activeWorktreeId,
      {
        query,
        statusFilters,
        typeFilters,
        prIssueFilters,
        sessionFilters,
        activityFilters,
        devServerFilters,
      },
      devServerSessions
    );
  }, [
    worktrees,
    derivedMetaMap,
    activeWorktreeId,
    hideMainWorktree,
    query,
    statusFilters,
    typeFilters,
    prIssueFilters,
    sessionFilters,
    activityFilters,
    devServerFilters,
    devServerSessions,
  ]);

  // Compute aggregate statistics from derivedMetaMap
  const aggregateStats = useMemo(() => {
    let workingCount = 0;
    let waitingCount = 0;
    let finishedCount = 0;

    // Count worktrees (not terminals) with specific agent states
    // Use same visibility logic as filtered list to keep stats in sync
    for (const worktree of worktrees) {
      const derived = derivedMetaMap.get(worktree.id);
      if (!derived) continue;

      // hideMainWorktree always takes precedence for the main worktree (user's explicit intent)
      if (hideMainWorktree && worktree.isMainWorktree) {
        continue;
      }

      if (derived.hasWorkingAgent) workingCount++;
      if (derived.hasWaitingAgent) waitingCount++;
      // Mirror matchesQuickStateFilter("finished") so the chip count and filter stay in sync
      if (derived.chipState === "complete" || derived.chipState === "cleanup") finishedCount++;
    }

    return { workingCount, waitingCount, finishedCount };
  }, [worktrees, derivedMetaMap, hideMainWorktree]);

  // Check if only main worktree exists (to hide the filter toggle)
  const hasOnlyMainWorktree = useMemo(() => {
    return worktrees.length === 1 && worktrees[0]?.isMainWorktree === true;
  }, [worktrees]);

  // Check if there are any non-main worktrees
  const hasNonMainWorktrees = useMemo(() => {
    return worktrees.some((w) => !w.isMainWorktree);
  }, [worktrees]);

  // Apply filters and sorting
  const { filteredWorktrees, groupedSections } = useMemo(() => {
    const filters: FilterState = {
      query,
      statusFilters,
      typeFilters,
      prIssueFilters,
      sessionFilters,
      activityFilters,
      devServerFilters,
    };

    // Filter worktrees
    const filtered = worktrees.filter((worktree) => {
      const derived = derivedMetaMap.get(worktree.id) ?? {
        terminalCount: 0,
        hasWorkingAgent: false,
        hasWaitingAgent: false,
        hasCompletedAgent: false,
        hasExitedAgent: false,
        hasMergeConflict: false,
        chipState: null,
      };
      const isActive = worktree.id === activeWorktreeId;
      const hasActiveQuery = query.trim().length > 0;

      // hideMainWorktree always takes precedence for the main worktree (user's explicit intent)
      if (hideMainWorktree && worktree.isMainWorktree) {
        return false;
      }

      if (
        alwaysShowActive &&
        isActive &&
        !hasActiveQuery &&
        quickStateFilter === "all" &&
        !hasFacetFiltersActive
      ) {
        return true;
      }

      if (
        alwaysShowWaiting &&
        derived.hasWaitingAgent &&
        !hasActiveQuery &&
        quickStateFilter === "all" &&
        !hasFacetFiltersActive
      ) {
        return true;
      }

      if (quickStateFilter !== "all" && !matchesQuickStateFilter(quickStateFilter, derived)) {
        return false;
      }

      return matchesFilters(worktree, filters, derived, isActive, devServerSessions);
    });

    // Filter out pinned worktrees that no longer exist
    const existingWorktreeIds = new Set(worktrees.map((w) => w.id));
    const validPinnedWorktrees = pinnedWorktrees.filter((id) => existingWorktreeIds.has(id));

    // Sort worktrees
    const sorted = sortWorktrees(filtered, orderBy, validPinnedWorktrees, manualOrder);

    // Group if enabled
    if (isGroupedByType) {
      return {
        filteredWorktrees: sorted,
        groupedSections: groupByType(sorted, orderBy, validPinnedWorktrees),
      };
    }

    return { filteredWorktrees: sorted, groupedSections: null };
  }, [
    worktrees,
    query,
    orderBy,
    isGroupedByType,
    statusFilters,
    typeFilters,
    prIssueFilters,
    sessionFilters,
    activityFilters,
    devServerFilters,
    devServerSessions,
    alwaysShowActive,
    alwaysShowWaiting,
    pinnedWorktrees,
    manualOrder,
    derivedMetaMap,
    activeWorktreeId,
    hideMainWorktree,
    quickStateFilter,
    hasFacetFiltersActive,
  ]);

  // ── Multi-select state ────────────────────────────────────────────────
  // Selection lives on the modal so it resets naturally when the modal
  // unmounts (isOpen=false returns null below). Persistent stores would
  // outlive the modal session and re-surface stale selection on reopen.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Anchor for contiguous range selection. Survives filter changes by design
  // (lesson #4729) — only deliberate actions reset it.
  const selectionAnchorRef = useRef<string | null>(null);

  // Must mirror DOM render order so keyboard navigation indexes into the right
  // cell. When grouped, the DOM flattens groupedSections in section order; the
  // flat sorted order in filteredWorktrees does not match.
  const visibleIds = useMemo(
    () =>
      groupedSections
        ? groupedSections.flatMap((s) => s.worktrees.map((w) => w.id))
        : filteredWorktrees.map((w) => w.id),
    [groupedSections, filteredWorktrees]
  );
  const visibleIdSet = useMemo(() => new Set(visibleIds), [visibleIds]);

  // Drop selections that are no longer visible (filter narrowed). Anchor is
  // deliberately not reset — a user re-widening the filter can resume range
  // selection from where they left off.
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

  const handleCardToggleSelect = useCallback(
    (worktreeId: string, event: React.MouseEvent) => {
      // Shift+Click on a card extends from the anchor; Ctrl/Cmd+Click toggles
      // the individual cell. A plain click without modifiers never reaches
      // this handler (WorktreeCard routes those to onSelect).
      if (event.shiftKey && selectionAnchorRef.current !== null) {
        selectRangeBetween(selectionAnchorRef.current, worktreeId);
        return;
      }
      selectionAnchorRef.current = worktreeId;
      toggleSelection(worktreeId);
    },
    [selectRangeBetween, toggleSelection]
  );

  const hasSelection = selectedIds.size > 0;

  // Build a lookup map so the bulk-remove hook can snapshot per-target
  // metadata (dirty / unpushed / main-worktree) at confirm-click time
  // without re-deriving from the filtered list (lesson #4729 — reactive
  // derivations silently shrink as deletes land).
  const worktreeMap = useMemo(() => {
    const map = new Map<string, WorktreeState>();
    for (const w of worktrees) map.set(w.id, w);
    return map;
  }, [worktrees]);

  // Bulk-remove orchestrator. Owns the confirm-dialog state, the typed-
  // name target, the p-queue (concurrency:4 to stay under the
  // worktree:delete 10/10s rate-limit window on large selections), and
  // the summary toast.
  const bulkRemove = useWorktreeBulkRemove({
    selectedIds,
    worktreeMap,
    clearSelection,
  });

  // D1 close-sessions confirm — single-step, no typed-name gate. The
  // fan-out is local-store-only (no IPC, no rate limit), so we just
  // need a yes/no surface that names the blast radius.
  //
  // The id set is snapshotted at click time (lesson #4729) so a
  // selection change between the click and the user pressing the
  // confirm button doesn't silently retarget the close fan-out. The
  // dialog title also reads from this snapshot so the surface stays
  // consistent with the actual blast radius.
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

  const gridRef = useRef<HTMLDivElement | null>(null);
  const closeModal = useCallback(() => onClose(), [onClose]);

  // Section sizes drive section-aware Arrow navigation across the col-[1/-1]
  // header breaks. Undefined when ungrouped — the hook degrades to flat-list
  // stride math.
  const sectionSizes = useMemo<readonly number[] | undefined>(
    () =>
      groupedSections
        ? groupedSections.map((s: GroupedSection<WorktreeState>) => s.worktrees.length)
        : undefined,
    [groupedSections]
  );

  const { activeDescendantId, handleGridKeyDown, handleGridFocus } = useWorktreeOverviewKeyboard({
    worktreeIds: visibleIds,
    sectionSizes,
    gridRef,
    selectionAnchorRef,
    onActivate: activateWorktree,
    onToggleSelection: toggleSelection,
    onSelectRange: selectRangeBetween,
    onSelectAll: selectAllVisible,
    onClearSelection: clearSelection,
    onEscapeWithoutSelection: closeModal,
    hasSelection,
  });

  // Reset modifier-driven anchor state when the window loses focus (lesson
  // #4591) — prevents a stuck Shift after Cmd+Tab from producing phantom
  // range selections on the next click.
  useEffect(() => {
    if (!isOpen) return;
    const handleWindowBlur = () => {
      // Modifier keys are tracked by the browser; only the anchor state
      // needs explicit reset on blur, so a subsequent un-modifier click
      // doesn't pick up an unintended range origin.
      selectionAnchorRef.current = null;
    };
    window.addEventListener("blur", handleWindowBlur);
    return () => window.removeEventListener("blur", handleWindowBlur);
  }, [isOpen]);

  // Document-level keydown — fallback for keys fired outside the grid (e.g.
  // when focus is on the close button or filter popover trigger). The grid
  // hook handles Escape / Cmd+A when the grid is focused.
  const handleKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (hasSelection) {
        e.preventDefault();
        e.stopPropagation();
        clearSelection();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
      // Only intercept when focus is inside the modal but not in a text
      // input — otherwise Cmd+A in a filter input must select the text.
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
    const timeoutId = setTimeout(() => closeButtonRef.current?.focus(), 50);
    return () => clearTimeout(timeoutId);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => document.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [isOpen]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  if (!isOpen) return null;

  return (
    <div
      ref={modalRef}
      className={cn(
        "fixed inset-0 z-[var(--z-modal)] flex items-center justify-center",
        "bg-scrim-medium backdrop-blur-sm",
        "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
      )}
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="worktree-overview-title"
    >
      <div
        className={cn(
          "relative flex flex-col",
          "w-[calc(100vw-80px)] h-[calc(100vh-80px)]",
          "max-w-[1800px] max-h-[1200px]",
          "bg-daintree-bg rounded-xl",
          "border border-divider",
          "shadow-[var(--theme-shadow-dialog)]",
          "motion-safe:animate-in motion-safe:zoom-in-95 motion-safe:duration-200"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — swaps to a contextual action bar while a selection
            is active. The Clear control and Close button always remain
            so the user can escape selection mode without keyboard. */}
        {hasSelection ? (
          <div className="flex items-center justify-between px-6 py-4 border-b border-divider shrink-0">
            <div className="flex items-center gap-3">
              <span
                className="text-daintree-text font-semibold text-base tracking-wide tabular-nums"
                aria-live="polite"
              >
                {selectedIds.size} selected
              </span>
              <button
                type="button"
                onClick={clearSelection}
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1 rounded text-xs",
                  "text-daintree-text/60 hover:text-daintree-text",
                  "hover:bg-tint/[0.06]",
                  "transition-colors",
                  "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
                )}
                aria-label="Clear selection"
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
                Remove worktrees
              </Button>
              <button
                ref={closeButtonRef}
                onClick={onClose}
                className={cn(
                  "p-2 rounded-lg transition-colors",
                  "text-daintree-text/60 hover:text-daintree-text",
                  "hover:bg-tint/[0.06]",
                  "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
                )}
                aria-label="Close overview"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between px-6 py-4 border-b border-divider shrink-0">
            <div className="flex items-center gap-3">
              <Layers className="w-5 h-5 text-daintree-text/60" />
              <h2
                id="worktree-overview-title"
                className="text-daintree-text font-semibold text-base tracking-wide"
              >
                Worktrees Overview
              </h2>
              <span className="text-daintree-text/50 text-sm tabular-nums">
                ({filteredWorktrees.length}
                {filteredWorktrees.length !== worktrees.length && ` of ${worktrees.length}`})
              </span>
              {/* Aggregate activity statistics — clickable chips that set quickStateFilter */}
              {(aggregateStats.workingCount > 0 ||
                aggregateStats.waitingCount > 0 ||
                aggregateStats.finishedCount > 0) && (
                <div
                  className="flex items-center gap-1 ml-2 pl-3 border-l border-divider"
                  role="group"
                  aria-label="Filter by agent state"
                >
                  {aggregateStats.workingCount > 0 && (
                    <button
                      type="button"
                      aria-pressed={quickStateFilter === "working"}
                      onClick={() =>
                        setQuickStateFilter(quickStateFilter === "working" ? "all" : "working")
                      }
                      className={cn(
                        "flex items-center gap-1 text-xs tabular-nums rounded-full px-2 py-0.5 transition-colors",
                        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent",
                        quickStateFilter === "working"
                          ? "bg-overlay-subtle shadow-[inset_0_-2px_0_0_var(--color-text-secondary)]"
                          : "hover:bg-tint/[0.04]"
                      )}
                    >
                      <span className="status-mark w-1.5 h-1.5 rounded-full bg-[var(--color-state-working)] motion-safe:animate-pulse" />
                      <span
                        className={
                          quickStateFilter === "working"
                            ? "text-daintree-text"
                            : "text-daintree-text/60"
                        }
                      >
                        {aggregateStats.workingCount} working
                      </span>
                    </button>
                  )}
                  {aggregateStats.waitingCount > 0 && (
                    <button
                      type="button"
                      aria-pressed={quickStateFilter === "waiting"}
                      onClick={() =>
                        setQuickStateFilter(quickStateFilter === "waiting" ? "all" : "waiting")
                      }
                      className={cn(
                        "flex items-center gap-1 text-xs tabular-nums rounded-full px-2 py-0.5 transition-colors",
                        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent",
                        quickStateFilter === "waiting"
                          ? "bg-overlay-subtle shadow-[inset_0_-2px_0_0_var(--color-text-secondary)]"
                          : "hover:bg-tint/[0.04]"
                      )}
                    >
                      <span className="status-mark w-1.5 h-1.5 rounded-full bg-status-warning" />
                      <span
                        className={
                          quickStateFilter === "waiting"
                            ? "text-daintree-text"
                            : "text-daintree-text/60"
                        }
                      >
                        {aggregateStats.waitingCount} waiting
                      </span>
                    </button>
                  )}
                  {aggregateStats.finishedCount > 0 && (
                    <button
                      type="button"
                      aria-pressed={quickStateFilter === "finished"}
                      onClick={() =>
                        setQuickStateFilter(quickStateFilter === "finished" ? "all" : "finished")
                      }
                      className={cn(
                        "flex items-center gap-1 text-xs tabular-nums rounded-full px-2 py-0.5 transition-colors",
                        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent",
                        quickStateFilter === "finished"
                          ? "bg-overlay-subtle shadow-[inset_0_-2px_0_0_var(--color-text-secondary)]"
                          : "hover:bg-tint/[0.04]"
                      )}
                    >
                      <span className="status-mark w-1.5 h-1.5 rounded-full bg-category-blue" />
                      <span
                        className={
                          quickStateFilter === "finished"
                            ? "text-daintree-text"
                            : "text-daintree-text/60"
                        }
                      >
                        {aggregateStats.finishedCount} finished
                      </span>
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              {/* Hide main worktree toggle - show if there are non-main worktrees OR if filter is active (to allow recovery) */}
              {(hasNonMainWorktrees || hideMainWorktree) && !hasOnlyMainWorktree && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!hideMainWorktree}
                      aria-label={hideMainWorktree ? "Show main worktree" : "Hide main worktree"}
                      onClick={() => setHideMainWorktree(!hideMainWorktree)}
                      className={cn(
                        "flex items-center gap-1.5 px-2 py-1 rounded-full text-xs transition-colors",
                        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent",
                        hideMainWorktree
                          ? "bg-tint/[0.06] text-daintree-text/40 hover:text-daintree-text/60"
                          : "bg-tint/[0.10] text-daintree-text/70 hover:text-daintree-text/90"
                      )}
                    >
                      <Plug
                        className={cn(
                          "w-3 h-3 transition-colors",
                          hideMainWorktree ? "text-daintree-text/30" : "text-daintree-text/50"
                        )}
                      />
                      <span
                        className={cn(
                          "transition-colors",
                          hideMainWorktree && "line-through decoration-daintree-text/30"
                        )}
                      >
                        main
                      </span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {hideMainWorktree ? "Show main worktree" : "Hide main worktree"}
                  </TooltipContent>
                </Tooltip>
              )}
              {/* Filter Popover — only shown in header when the search bar (with its own popover) is absent */}
              {!hasNonMainWorktrees && (
                <WorktreeFilterPopover hideSearchInput chipCounts={chipCounts} />
              )}
              {/* Clear Filters Button - only shown when filters are active */}
              {hasActiveFilters() && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={clearAllFilters}
                      className={cn(
                        "flex items-center gap-1.5 px-2 py-1.5 rounded text-xs",
                        "text-daintree-text/60 hover:text-daintree-text",
                        "hover:bg-tint/[0.06]",
                        "transition-colors",
                        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
                      )}
                      aria-label="Clear all filters"
                    >
                      <FilterX className="w-3.5 h-3.5" />
                      <span>Clear</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Clear all filters</TooltipContent>
                </Tooltip>
              )}
              {/* Close Button */}
              <button
                ref={closeButtonRef}
                onClick={onClose}
                className={cn(
                  "p-2 rounded-lg transition-colors",
                  "text-daintree-text/60 hover:text-daintree-text",
                  "hover:bg-tint/[0.06]",
                  "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
                )}
                aria-label="Close overview"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>
        )}

        {/* Search bar — always visible when there are non-main worktrees.
            Stays mounted during selection mode so the user can refine the
            target set without losing the selection (visible-id sync drops
            hidden selections naturally — see selectedIds reconciliation). */}
        {hasNonMainWorktrees && (
          <WorktreeSidebarSearchBar variant="modal" chipCounts={chipCounts} />
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {isLoading && worktrees.length === 0 ? (
            <Skeleton label="Loading worktrees">
              <div
                className={cn(
                  "grid gap-3",
                  "grid-cols-[repeat(auto-fit,minmax(min(320px,100%),480px))]",
                  "justify-center"
                )}
              >
                {Array.from({ length: 6 }).map((_, i) => (
                  <SkeletonBone
                    key={i}
                    heightPx={220}
                    className="rounded-lg border border-divider"
                  />
                ))}
              </div>
            </Skeleton>
          ) : worktrees.length === 0 ? (
            <EmptyState
              variant="zero-data"
              scale="canvas"
              icon={<Layers />}
              title="No worktrees yet"
              description="Create a worktree to get started."
              action={
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={() => {
                    void actionService.dispatch("worktree.createDialog.open", undefined, {
                      source: "user",
                    });
                  }}
                >
                  Create worktree
                </Button>
              }
            />
          ) : filteredWorktrees.length === 0 ? (
            <EmptyState
              variant="filtered-empty"
              scale="canvas"
              instant
              title={
                query.trim()
                  ? `No matches for "${query.trim().length > 40 ? query.trim().slice(0, 40) + "…" : query.trim()}"`
                  : "No matching worktrees"
              }
              description={
                worktrees.length > 0
                  ? `${worktrees.length} worktree${worktrees.length !== 1 ? "s" : ""} hidden by active filters`
                  : undefined
              }
              action={
                <Button variant="subtle" size="sm" onClick={clearAllFilters}>
                  Clear all filters
                </Button>
              }
            />
          ) : (
            <div
              ref={gridRef}
              role="grid"
              tabIndex={0}
              aria-multiselectable="true"
              aria-activedescendant={activeDescendantId}
              onKeyDown={handleGridKeyDown}
              onFocus={handleGridFocus}
              className={cn(
                "grid gap-3",
                "grid-cols-[repeat(auto-fit,minmax(min(320px,100%),480px))]",
                "justify-center",
                "auto-rows-min items-start",
                "focus:outline-hidden"
              )}
            >
              {groupedSections
                ? groupedSections.flatMap((section: GroupedSection<WorktreeState>) => [
                    <div
                      key={`section-header-${section.type}`}
                      role="presentation"
                      className="col-[1/-1] flex items-center gap-2 mt-2 first:mt-0"
                    >
                      <h3 className="text-xs font-medium text-daintree-text/60 uppercase tracking-wider">
                        {section.displayName}
                      </h3>
                      <span className="text-xs text-daintree-text/40">
                        ({section.worktrees.length})
                      </span>
                    </div>,
                    ...section.worktrees.map((worktree: WorktreeState) => (
                      <OverviewGridCell
                        key={worktree.id}
                        worktreeId={worktree.id}
                        activeWorktreeId={activeWorktreeId}
                        focusedWorktreeId={focusedWorktreeId}
                        totalWorktreeCount={worktrees.length}
                        onSelectWorktree={onSelectWorktree}
                        onOpenEditor={onOpenEditor}
                        onSaveLayout={onSaveLayout}
                        onLaunchAgent={onLaunchAgent}
                        agentAvailability={agentAvailability}
                        agentSettings={agentSettings}
                        homeDir={homeDir}
                        onClose={onClose}
                        isSelected={selectedIds.has(worktree.id)}
                        onToggleSelect={handleCardToggleSelect}
                      />
                    )),
                  ])
                : filteredWorktrees.map((worktree) => (
                    <OverviewGridCell
                      key={worktree.id}
                      worktreeId={worktree.id}
                      activeWorktreeId={activeWorktreeId}
                      focusedWorktreeId={focusedWorktreeId}
                      totalWorktreeCount={worktrees.length}
                      onSelectWorktree={onSelectWorktree}
                      onOpenEditor={onOpenEditor}
                      onSaveLayout={onSaveLayout}
                      onLaunchAgent={onLaunchAgent}
                      agentAvailability={agentAvailability}
                      agentSettings={agentSettings}
                      homeDir={homeDir}
                      onClose={onClose}
                      isSelected={selectedIds.has(worktree.id)}
                      onToggleSelect={handleCardToggleSelect}
                    />
                  ))}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="px-6 py-3 border-t border-divider shrink-0">
          <div className="flex items-center justify-center gap-x-4 gap-y-1 flex-wrap text-xs text-daintree-text/40">
            <span>
              <kbd className="px-1.5 py-0.5 bg-tint/[0.06] rounded text-[10px]">↑↓←→</kbd> navigate
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 bg-tint/[0.06] rounded text-[10px]">Enter</kbd> switch
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 bg-tint/[0.06] rounded text-[10px]">Space</kbd> select
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 bg-tint/[0.06] rounded text-[10px]">Esc</kbd>
              {hasSelection ? " clear selection" : " close"}
            </span>
            {hasSelection && (
              <span className="text-daintree-text/60 tabular-nums">
                {selectedIds.size} selected
              </span>
            )}
          </div>
        </div>
      </div>

      {/* D1 — close sessions confirm. No typed-name gate (action is local,
          reversible by re-launching the agent), but the explicit yes/no
          step prevents stray Enter/keybinding dispatch from ending
          scrollback for every selected worktree at once. */}
      <ConfirmDialog
        isOpen={isCloseSessionsConfirmOpen}
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
        onConfirm={handleCloseSessionsConfirm}
      />

      {/* D3 — bulk remove. Typed-name gate ("N worktrees"), full target
          list in the body so the user sees the actual blast radius, and
          per-target warning rows for dirty trees and unpushed commits.
          Main worktrees were filtered out at confirm-derive time (see
          useWorktreeBulkRemove); the excluded count surfaces here so the
          user isn't silently surprised. */}
      <ConfirmDialog
        isOpen={bulkRemove.isConfirmOpen}
        onClose={bulkRemove.handleCancel}
        title={
          bulkRemove.targets.length === 1
            ? `Remove '${bulkRemove.targets[0]?.branch ?? bulkRemove.targets[0]?.name ?? "worktree"}'?`
            : `Remove ${bulkRemove.targets.length} worktrees?`
        }
        description={
          bulkRemove.excludedMainCount > 0
            ? `${bulkRemove.excludedMainCount} main worktree${bulkRemove.excludedMainCount === 1 ? "" : "s"} excluded — only non-main worktrees can be removed here.`
            : "Each worktree directory is deleted from disk and the branch worktree association is removed. Uncommitted changes are discarded."
        }
        confirmLabel={
          bulkRemove.targets.length === 1
            ? "Remove worktree"
            : `Remove ${bulkRemove.targets.length} worktrees`
        }
        cancelLabel="Cancel"
        variant="destructive"
        typedNameTarget={bulkRemove.typedNameTarget}
        onConfirm={bulkRemove.handleConfirm}
        isConfirmLoading={bulkRemove.isExecuting}
      >
        {bulkRemove.targets.length > 0 && (
          <div className="border border-divider rounded max-h-64 overflow-y-auto divide-y divide-divider">
            {bulkRemove.targets.map((target) => {
              const hasTrackedChanges = target.trackedChangeCount > 0;
              const hasUnpushed = target.aheadCount > 0;
              return (
                <div key={target.id} className="flex flex-col gap-1 px-3 py-2 bg-daintree-bg/40">
                  <div className="flex items-center gap-2 text-sm text-daintree-text">
                    <GitBranch className="w-3.5 h-3.5 shrink-0 text-daintree-text/50" />
                    <span className="font-mono truncate" title={target.path}>
                      {target.branch ?? target.name}
                    </span>
                  </div>
                  {(hasTrackedChanges || hasUnpushed) && (
                    <div className="flex items-start gap-1.5 text-xs text-status-warning">
                      <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                      <span>
                        {hasTrackedChanges &&
                          `${target.trackedChangeCount} uncommitted file${target.trackedChangeCount === 1 ? "" : "s"}`}
                        {hasTrackedChanges && hasUnpushed && " · "}
                        {hasUnpushed &&
                          `${target.aheadCount} unpushed commit${target.aheadCount === 1 ? "" : "s"}`}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="flex items-start gap-2 p-3 bg-status-error/10 border border-status-error/20 rounded text-status-error text-xs">
          <Trash2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>This is irreversible. Type the count to confirm.</span>
        </div>
      </ConfirmDialog>
      {/* Co-located live region: VoiceOver suppresses announcements made
          from `aria-live` regions outside the focused `aria-modal` subtree
          when `document.ariaNotify` is unavailable (Chromium 354736464). */}
      <AccessibilityAnnouncer />
    </div>
  );
}
