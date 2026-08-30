import React, { useCallback, useEffect, useEffectEvent, useRef, useMemo, useState } from "react";
import { FilterX, AlertTriangle, Trash2, GitBranch } from "lucide-react";
import { Layers, Plug } from "@/components/icons";
import { AppDialog } from "@/components/ui/AppDialog";
import { KBD_CLASS, KbdChord } from "@/components/ui/Kbd";
import { cn } from "@/lib/utils";
import { getVisibleTabbableElements } from "@/lib/accessibility";
import { useShallow } from "zustand/react/shallow";
import { WorktreeCard } from "./WorktreeCard";
import { WorktreeFilterPopover } from "./WorktreeFilterPopover";
import { WorktreeSidebarSearchBar } from "./WorktreeSidebarSearchBar";
import { useWorktreeBulkRemove, describeBulkRemoveRisks } from "./useWorktreeBulkRemove";
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

/**
 * One frame past the dialog's mount so the search input exists and AppDialog's
 * own focus pass (disabled here via `initialFocus="none"`) cannot race it.
 */
const SEARCH_FOCUS_DELAY_MS = 50;

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
 *
 * Two independent states live on this box and they are deliberately drawn with
 * different marks, the same way `.palette-row` and `.forge-row` separate theirs
 * in `index.css`: MEMBERSHIP is the neutral tint plus inset ring, and the
 * KEYBOARD CURSOR is the accent outline. The grid is its own arrow-key domain,
 * so the cursor is that region's single load-bearing accent — which is what the
 * accent-restraint rule reserves it for. Drawing both as an outline would let
 * the later one overwrite the earlier, and a selected cell under the cursor
 * would lose the cursor.
 */
function OverviewGridCell(props: OverviewWorktreeCardProps & { isCursor?: boolean }) {
  const cellId = getWorktreeOverviewCellId(props.worktreeId);
  const isSelected = props.isSelected ?? false;
  const isCursor = props.isCursor ?? false;
  return (
    <div
      id={cellId}
      role="gridcell"
      aria-selected={isSelected}
      data-worktree-overview-cell={props.worktreeId}
      data-overview-cursor={isCursor ? "true" : undefined}
      style={{
        contentVisibility: "auto",
        containIntrinsicSize: "auto 240px",
      }}
      className={cn(
        // The per-cell width cap lives on the cell, not as a `[&>*]` rule on
        // the grid: the grouped-section headers are `col-[1/-1]` direct
        // children too, and a 480px cap on a row spanning every track is not
        // what that rule means.
        "max-w-[480px]",
        // `h-full` against a stretched grid row: every card in a row ends on
        // the same y. Cards carry a variable number of status rows, so left to
        // themselves their bottoms landed on three different lines per row and
        // the gutter between rows read as broken — 57px under a short card,
        // 13px under a tall one.
        //
        // What is equalised is the card's BOX, not its content: the content
        // stays top-aligned and the slack falls below it. Pushing the status
        // rows down to the bottom edge instead was tried and is worse — one
        // card expanded to 460px opened a 250px hole in the middle of each of
        // its three row-mates, which reads far more broken than a short card
        // with space under it.
        "h-full",
        "rounded-lg overflow-hidden",
        "border border-divider",
        // This element is the card. The `WorktreeCard` inside it paints no
        // plane of its own in the grid variant, so the border, fill, hover
        // lift and shadow are declared once, here.
        "bg-overlay-subtle",
        // Narrowest property set the states here actually animate — a bare
        // `transition` would also cover transform, filter and backdrop-filter.
        "transition-[background-color,box-shadow,outline-color] duration-150 ease-out",
        // The drag guard rides with the shadow. While a sort drag is active
        // the pointer sweeps across every card it passes, and lighting each
        // one in turn reads as the drag doing something to them.
        "hover:bg-overlay-soft hover:shadow-[var(--theme-shadow-ambient)]",
        "[html[data-dragging='true']_&]:hover:shadow-none",
        // Membership: a raised fill plus a LEADING RAIL, which is what every
        // other selectable surface in this app draws — nine of them, and the
        // rail geometry is written down once in `.palette-row::before`.
        //
        // This was a four-sided `ring-1 ring-inset ring-selection-outline` for
        // one round, which turned out to be the only four-sided ring on this
        // token anywhere in the codebase. #11686 had already made that exact
        // swap for the palette rows and `theme-tokens.md` names the ink
        // "selected-row leading-rail" — so the ring was re-deciding a settled
        // question and losing.
        //
        // `selection-outline` rather than a border token, either way: it is
        // the one ink derived from `text-primary` instead of the border ramp,
        // and `getThemeContrastWarnings` gates it at 3:1 on every theme. The
        // fill cannot be the SC 1.4.11 indicator — `overlay-medium` over
        // `overlay-subtle` is a 2% step, around 1.1:1 — so the mark has to
        // carry the ratio on its own.
        //
        // The top inset is a function of the card's own status mark, which
        // shares this edge. Both resolve against this cell's padding box: the
        // tick is `top-1 start-1` w-1 h-4 at x 4-8, y 4-20 — it is flush at 0,0
        // on the square sidebar card and inset only here, where this cell's
        // `rounded-lg overflow-hidden` arc would otherwise clip it — and this
        // rail is `start-0` w-[3px] at x 0-3. One pixel apart. Two thin verticals that
        // close together would read as one broken rail if they also shared a
        // row, so the rail starts below the tick instead — 24px, four clear
        // pixels under it — rather than the 12px it would otherwise take. The
        // bottom keeps that 12px: nothing is down there to clear, and the
        // asymmetry is imperceptible on a card this tall. Leading edge,
        // because the trailing edge already carries the current-worktree
        // stripe.
        //
        // The two marks are also told apart by radius, not just position: this
        // rail is a pill and the status tick is square-ended. Rounding the tick
        // would collapse that distinction.
        "relative",
        isSelected && "bg-overlay-medium",
        isSelected &&
          "before:absolute before:top-6 before:bottom-3 before:start-0 before:z-10 before:w-[3px] before:rounded-full before:bg-selection-outline before:content-['']",
        // The cursor is painted only while the grid itself holds DOM focus.
        // It is `aria-activedescendant`, so its id survives blur by design —
        // but the accent mark should not: an overview whose search field is
        // focused was showing an accent ring on the field AND an accent
        // outline on a card, two load-bearing signals in one region with
        // nothing saying which one the keys would move.
        //
        // Gating it here is also what gives the grid container a focus
        // indicator at all. It carries `tabIndex={0}` and `focus:outline-hidden`
        // (the container must not paint its own 1500px-wide ring), so before
        // this the surface had a keyboard-focusable element with nothing
        // marking it — the #8940 debt recorded in focusRingFallback's
        // allowlist. The cursor cell IS the indicator, and it appears exactly
        // when the container takes focus.
        isCursor &&
          "group-focus/overview-grid:outline group-focus/overview-grid:outline-2 group-focus/overview-grid:-outline-offset-2 group-focus/overview-grid:outline-accent-primary"
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
  const searchInputRef = useRef<HTMLInputElement>(null);
  // First child of the dialog surface, so its parent is the surface itself —
  // the anchor the initial-focus fallback below scopes its tabbable lookup to.
  const liveRegionRef = useRef<HTMLDivElement>(null);

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

  /**
   * ArrowDown out of the search field hands keyboard control to the grid.
   * The cursor is seeded by `handleGridFocus` when there is none, so this
   * does not have to name a cell.
   */
  const handleArrowIntoResults = useCallback(() => {
    gridRef.current?.focus({ preventScroll: true });
  }, []);

  /**
   * The way back: ArrowUp off the top row, `/`, or any printable character
   * typed while the grid holds focus. The character is appended rather than
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
  const closeModal = useCallback(() => onClose(), [onClose]);

  const hasActivitySummary =
    aggregateStats.waitingCount > 0 ||
    aggregateStats.workingCount > 0 ||
    aggregateStats.finishedCount > 0;
  const showMainToggle = (hasNonMainWorktrees || hideMainWorktree) && !hasOnlyMainWorktree;

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
      onEscapeWithoutSelection: closeModal,
      onReturnToSearch: handleReturnToSearch,
      hasSelection,
    });

  const handleCardToggleSelect = useCallback(
    (worktreeId: string, event: React.MouseEvent) => {
      // The pointer-to-keyboard hand-off the APG's keyboard-interface practice
      // requires of any composite driven by `aria-activedescendant`: a click
      // inside the widget must move the cursor to what was clicked AND pull
      // DOM focus onto the container. Neither happened, and the consequence is
      // the one the practice names — the container's keydown listener never
      // fires, so after Cmd-clicking a card every arrow key, Space and Enter
      // did nothing until the user found their way back with Tab. From the
      // outside that reads as "this grid has no keyboard navigation".
      //
      // Focus first, then the cursor: `handleGridFocus` seeds the cursor at
      // the first cell when there is none, and it must not beat the cell the
      // pointer actually named.
      gridRef.current?.focus({ preventScroll: true });
      setActiveWorktreeId(worktreeId);

      // Shift+Click extends from the anchor; Ctrl/Cmd+Click toggles the
      // individual cell. A plain click never reaches this handler
      // (WorktreeCard routes those to onSelect).
      if (event.shiftKey && selectionAnchorRef.current !== null) {
        selectRangeBetween(selectionAnchorRef.current, worktreeId);
        return;
      }
      selectionAnchorRef.current = worktreeId;
      toggleSelection(worktreeId);
    },
    [selectRangeBetween, toggleSelection, setActiveWorktreeId]
  );

  // Keep the keyboard cursor on screen. `aria-activedescendant` moves a cursor
  // that is not DOM focus, so the browser does no scrolling of its own — without
  // this, arrowing past the visible rows walked the cursor off the bottom of the
  // scroll box and the user was selecting cards they could not see.
  useEffect(() => {
    if (!isOpen || !activeDescendantId) return;
    const cell = gridRef.current?.querySelector<HTMLElement>(
      `[id="${CSS.escape(activeDescendantId)}"]`
    );
    cell?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [isOpen, activeDescendantId]);

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

  // Document-level keydown — fallback for Cmd/Ctrl+A fired outside the grid
  // (e.g. when focus is on the search field or the filter popover trigger).
  // The grid hook handles Cmd+A when the grid itself is focused.
  const handleKeyDown = useEffectEvent((e: KeyboardEvent) => {
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

  // Initial focus goes to search, not to Close. This is a browse-and-search
  // surface, so the APG dialog guidance puts first focus on the primary input;
  // landing on the dismiss control spent the one accent focus ring in the
  // region on "leave". AppDialog is told `initialFocus="none"` so it does not
  // race this.
  useEffect(() => {
    if (!isOpen) return;
    const timeoutId = setTimeout(() => {
      const searchInput = searchInputRef.current;
      if (searchInput) {
        searchInput.focus();
        return;
      }
      // No search field to take it: the toolbar only mounts when there are
      // non-main worktrees, and it has not rendered yet while the loading
      // skeleton is up. AppDialog's own focus pass is off, so without this
      // focus would stay on whatever the app shell had behind the scrim. Fall
      // back to the dialog's first tabbable — the close button, where focus
      // landed before this surface had a search field at all.
      const surface = liveRegionRef.current?.parentElement;
      if (!surface) return;
      const fallback = getVisibleTabbableElements(surface)[0];
      if (fallback) fallback.focus();
      else surface.focus();
    }, SEARCH_FOCUS_DELAY_MS);
    return () => clearTimeout(timeoutId);
  }, [isOpen]);

  // Cmd/Ctrl+A only. Escape is deliberately NOT handled here any more: this
  // listener used to run on `document` in the CAPTURE phase and swallow the key
  // before the facet popover or a confirmation could act on it, so dismissing a
  // nested layer tore down the whole overview. AppDialog's layer-aware escape
  // stack owns dismissal now, and `onBeforeClose` keeps the two-stage
  // clear-selection-then-close behaviour.
  useEffect(() => {
    if (!isOpen) return;
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  // AppDialog routes every dismissal through `onBeforeClose` — Escape, the
  // close button and a scrim click alike — but the two-stage contract below
  // belongs to Escape alone. The X and the scrim have to leave in one click
  // (the CAB already carries its own Clear control, so guarding them is
  // redundant as well as surprising), so record whether the close being
  // resolved originated from an Escape keypress. Capture phase, because both
  // the escape stack and AppDialog's backstop dispatch on bubble; cleared on a
  // microtask, so a later pointer dismissal can never inherit the flag.
  const escapeDismissRef = useRef(false);
  useEffect(() => {
    if (!isOpen) return;
    const markEscapeDismissal = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      escapeDismissRef.current = true;
      queueMicrotask(() => {
        escapeDismissRef.current = false;
      });
    };
    document.addEventListener("keydown", markEscapeDismissal, true);
    return () => document.removeEventListener("keydown", markEscapeDismissal, true);
  }, [isOpen]);

  /**
   * Escape's first press clears a selection; the second closes. Returning
   * `false` cancels AppDialog's close, which is the same two-stage contract the
   * grid hook implements for when focus is inside the grid.
   */
  const handleBeforeClose = useCallback(() => {
    if (escapeDismissRef.current && hasSelection) {
      clearSelection();
      return false;
    }
    return true;
  }, [hasSelection, clearSelection]);

  return (
    <>
      <AppDialog
        isOpen={isOpen}
        onClose={onClose}
        onBeforeClose={handleBeforeClose}
        // The app-scale tier the shared primitive already declares. It was
        // added for a workspace-sized surface and had no consumer; this is the
        // surface it was sized for, and its width lands within ~2% of the
        // hand-rolled box it replaces.
        size="workspace"
        maxHeight="h-[calc(100vh-80px)] max-h-[1200px]"
        // Focus is placed on the search field by this component; AppDialog must
        // not race it onto the first tabbable (the close button).
        initialFocus="none"
        data-testid="worktree-overview-modal"
      >
        {/* Selection is a mode change, and a screen reader has to hear it.
            The region is rendered unconditionally so it exists in the
            accessibility tree BEFORE its text changes — a live region mounted
            at the same moment as its content is frequently missed — and it is
            atomic so "3 of 13 selected" is read as one phrase rather than a
            stray digit. */}
        <div
          ref={liveRegionRef}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {hasSelection ? `${selectedIds.size} of ${filteredWorktrees.length} selected` : ""}
        </div>

        {/* Tier 1 — identity. Title, result context and close, and nothing
            else. This row does not change when filters narrow the list or when
            a selection starts: it is what tells the user which surface they are
            on and how much of it they are seeing. */}
        <AppDialog.Header>
          <AppDialog.Title icon={<Layers className="w-5 h-5 text-text-secondary" />}>
            <span>Worktrees overview</span>
            <span className="text-text-secondary text-sm font-normal tabular-nums">
              ({filteredWorktrees.length}
              {filteredWorktrees.length !== worktrees.length && ` of ${worktrees.length}`})
            </span>
          </AppDialog.Title>
          <AppDialog.CloseButton aria-label="Close overview" />
        </AppDialog.Header>

        {/* Tier 2 — the working toolbar: search and facets. Stays mounted
            during selection so the user can refine the target set without
            losing what they picked (visible-id sync drops hidden selections
            naturally — see the selectedIds reconciliation). */}
        {hasNonMainWorktrees && (
          <WorktreeSidebarSearchBar
            variant="modal"
            inputRef={searchInputRef}
            onArrowIntoResults={handleArrowIntoResults}
            chipCounts={chipCounts}
            trailing={
              // Main-worktree visibility rides with the facets rather than in a
              // band of its own: it is a filter, and next to the funnel is
              // where the rest of them live. The accessible name is fixed —
              // `aria-checked` carries the state — because a toggle whose label
              // flips is announced as a different control each time it is used.
              showMainToggle ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!hideMainWorktree}
                      aria-label="Show main worktree"
                      onClick={() => setHideMainWorktree(!hideMainWorktree)}
                      className={cn(
                        "flex shrink-0 items-center gap-1.5 px-2 rounded-full text-xs transition-colors",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px]",
                        // Both states stay on `text-text-secondary`: the
                        // strike-through and the surface step already say
                        // which one this is, and `text-text-muted` has no dark
                        // contrast floor — a filter chip whose label is the
                        // only thing naming what it filters has to stay
                        // readable in the state where it is switched off.
                        hideMainWorktree
                          ? "bg-overlay-soft text-text-secondary hover:text-text-primary"
                          : "bg-overlay-medium text-text-secondary hover:text-text-primary"
                      )}
                    >
                      <Plug className={cn("w-3 h-3 transition-colors", "text-text-secondary")} />
                      <span
                        className={cn(
                          "transition-colors",
                          hideMainWorktree && "line-through decoration-text-muted"
                        )}
                      >
                        main
                      </span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {hideMainWorktree ? "Main worktree hidden" : "Main worktree shown"}
                  </TooltipContent>
                </Tooltip>
              ) : null
            }
          />
        )}

        {/* Tier 3 — quick controls, and the contextual action bar that replaces
            them while a selection is active. The CAB displaces this tier and
            not the identity row above it: that is the data-dense desktop
            convention (Carbon batch-action toolbar, Primer, Atlassian), and it
            is what keeps the title and the `N of M` count on screen while a
            destructive bulk action is one click away. */}
        {hasSelection ? (
          <div className="flex items-center justify-between gap-3 px-[calc(1.5rem+11px)] py-2 border-b border-divider shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              {/* Visual only — the announcement is owned by the status region
                  above, so this must not be a second live region. */}
              <span className="text-text-primary font-medium text-sm tabular-nums">
                {selectedIds.size} of {filteredWorktrees.length} selected
              </span>
              <button
                type="button"
                onClick={clearSelection}
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1 rounded-[var(--radius-md)] text-xs",
                  "text-text-secondary hover:text-text-primary",
                  "hover:bg-overlay-soft",
                  "transition-colors",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px]"
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
                <Trash2 className="w-3.5 h-3.5" />
                Remove worktrees
              </Button>
            </div>
          </div>
        ) : (
          // `!hasNonMainWorktrees` is part of the gate, not just of the row's
          // contents: on a main-worktree-only project with no agent activity
          // the fallback facet popover below is the ONLY control that can open
          // the filters, so gating the row on activity or an active filter
          // would make filtering permanently unreachable — no filter could be
          // set, so `hasActiveFilters()` could never become true.
          (hasActivitySummary || hasActiveFilters() || !hasNonMainWorktrees) && (
            <div className="flex items-center gap-2 px-[calc(1.5rem+11px)] py-2 border-b border-divider shrink-0 flex-wrap">
              {/* Aggregate activity statistics — clickable chips that set quickStateFilter.
                  Ordered waiting → working → finished: "something is asking me
                  for input" is the highest-value signal on this surface, so it
                  reads first. */}
              {hasActivitySummary && (
                <div
                  className="flex items-center gap-1"
                  role="group"
                  aria-label="Filter by agent state"
                >
                  {aggregateStats.waitingCount > 0 && (
                    <button
                      type="button"
                      aria-pressed={quickStateFilter === "waiting"}
                      onClick={() =>
                        setQuickStateFilter(quickStateFilter === "waiting" ? "all" : "waiting")
                      }
                      className={cn(
                        "flex items-center gap-1 text-xs tabular-nums rounded-full px-2 py-1 transition-colors",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px]",
                        quickStateFilter === "waiting"
                          ? "bg-overlay-subtle shadow-[inset_0_-2px_0_0_var(--color-text-secondary)]"
                          : "hover:bg-overlay-subtle"
                      )}
                    >
                      <span className="status-mark w-1.5 h-1.5 rounded-full bg-status-warning" />
                      <span
                        className={
                          quickStateFilter === "waiting"
                            ? "text-text-primary"
                            : "text-text-secondary"
                        }
                      >
                        {aggregateStats.waitingCount} waiting
                      </span>
                    </button>
                  )}
                  {aggregateStats.workingCount > 0 && (
                    <button
                      type="button"
                      aria-pressed={quickStateFilter === "working"}
                      onClick={() =>
                        setQuickStateFilter(quickStateFilter === "working" ? "all" : "working")
                      }
                      className={cn(
                        "flex items-center gap-1 text-xs tabular-nums rounded-full px-2 py-1 transition-colors",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px]",
                        quickStateFilter === "working"
                          ? "bg-overlay-subtle shadow-[inset_0_-2px_0_0_var(--color-text-secondary)]"
                          : "hover:bg-overlay-subtle"
                      )}
                    >
                      <span className="status-mark w-1.5 h-1.5 rounded-full bg-[var(--color-state-working)] motion-safe:animate-pulse" />
                      <span
                        className={
                          quickStateFilter === "working"
                            ? "text-text-primary"
                            : "text-text-secondary"
                        }
                      >
                        {aggregateStats.workingCount} working
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
                        "flex items-center gap-1 text-xs tabular-nums rounded-full px-2 py-1 transition-colors",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px]",
                        quickStateFilter === "finished"
                          ? "bg-overlay-subtle shadow-[inset_0_-2px_0_0_var(--color-text-secondary)]"
                          : "hover:bg-overlay-subtle"
                      )}
                    >
                      <span className="status-mark w-1.5 h-1.5 rounded-full bg-category-blue" />
                      <span
                        className={
                          quickStateFilter === "finished"
                            ? "text-text-primary"
                            : "text-text-secondary"
                        }
                      >
                        {aggregateStats.finishedCount} finished
                      </span>
                    </button>
                  )}
                </div>
              )}

              <div className="ml-auto flex items-center gap-2">
                {/* Clear Filters Button - only shown when filters are active */}
                {hasActiveFilters() && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={clearAllFilters}
                        className={cn(
                          "flex items-center gap-1.5 px-2 py-1 rounded-[var(--radius-md)] text-xs",
                          "text-text-secondary hover:text-text-primary",
                          "hover:bg-overlay-soft",
                          "transition-colors",
                          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px]"
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
                {/* Filter Popover — only shown here when the search bar (with its own popover) is absent */}
                {!hasNonMainWorktrees && (
                  <WorktreeFilterPopover hideSearchInput chipCounts={chipCounts} />
                )}
              </div>
            </div>
          )
        )}

        {/* Content. `AppDialog.Body` brings the shared scroll box: a
            ScrollShadow at both edges, so content no longer just stops
            mid-glyph against the footer, and a reserved scrollbar gutter so
            the grid does not shift by 11px the moment it starts to overflow. */}
        <AppDialog.Body className="p-6">
          {isLoading && worktrees.length === 0 ? (
            <Skeleton label="Loading worktrees">
              <div
                className={cn(
                  "grid gap-3",
                  "grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))]"
                )}
              >
                {Array.from({ length: 6 }).map((_, i) => (
                  <SkeletonBone
                    key={i}
                    heightPx={220}
                    className="max-w-[480px] rounded-lg border border-divider"
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
                  ? `${worktrees.length} worktree${worktrees.length !== 1 ? "s" : ""} hidden by ${
                      query.trim() && !hasFacetFiltersActive
                        ? "your search"
                        : hasFacetFiltersActive && !query.trim()
                          ? "active filters"
                          : "your search and filters"
                    }`
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
                "group/overview-grid grid gap-3",
                // `auto-fill`, not `auto-fit`: auto-fit collapses the empty
                // tracks, so the track count followed the RESULT count and the
                // whole grid slid sideways as the user typed. `1fr` with a
                // per-cell max keeps cards from stretching on a wide display.
                "grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))]",
                // `items-stretch`, not `items-start`: cards in one row share a
                // bottom edge. `auto-rows-min` still sizes each row to its own
                // tallest card, so a row of short cards does not inherit a tall
                // row's height.
                "auto-rows-min items-stretch",
                // The container must not paint its own ring — it spans the
                // whole grid. The cursor cell paints the indicator instead,
                // gated on this element's `focus-visible` (see
                // `OverviewGridCell`).
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
                      <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wider">
                        {section.displayName}
                      </h3>
                      <span className="text-xs text-text-secondary">
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
                        isCursor={activeDescendantId === getWorktreeOverviewCellId(worktree.id)}
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
                      isCursor={activeDescendantId === getWorktreeOverviewCellId(worktree.id)}
                      onToggleSelect={handleCardToggleSelect}
                    />
                  ))}
            </div>
          )}
        </AppDialog.Body>

        {/* Footer — the keyboard contract, in the shared chip style, plus the
            two operations that make a 5-to-30 item cleanup quick. The selected
            count is NOT repeated here: it now lives in the contextual bar
            above, next to the actions it applies to. */}
        <AppDialog.Footer
          // Container-scoped so the two lower-priority hints drop out on a
          // narrow window instead of wrapping the row onto a second line.
          className="justify-center @container/overview-footer"
          hint={
            <div className="flex items-center justify-center gap-x-4 gap-y-1 flex-wrap text-text-secondary">
              <span>
                <kbd className={KBD_CLASS}>↑↓←→</kbd> navigate
              </span>
              <span>
                <kbd className={KBD_CLASS}>Enter</kbd> switch
              </span>
              <span>
                <kbd className={KBD_CLASS}>Space</kbd> select
              </span>
              <span className="hidden @2xl/overview-footer:inline">
                <KbdChord shortcut="Cmd+A" /> select all
              </span>
              <span className="hidden @3xl/overview-footer:inline">
                <kbd className={KBD_CLASS}>Shift</kbd>+<kbd className={KBD_CLASS}>↑↓←→</kbd> extend
              </span>
              {/* The way back to the field. It is the least guessable binding
                  on the surface and the one a user reaches for most often —
                  arrow into the results, not find it, want to retype — so it
                  earns a slot even though it drops out first on a narrow
                  window. Typing any character does the same thing; `/` is
                  what gets advertised because it is the convention the
                  neighbours (GitHub, Gmail, Linear) already teach. */}
              <span className="hidden @4xl/overview-footer:inline">
                <kbd className={KBD_CLASS}>/</kbd> search
              </span>
              <span>
                <kbd className={KBD_CLASS}>Esc</kbd>
                {hasSelection ? " clear selection" : " close"}
              </span>
            </div>
          }
        />
      </AppDialog>

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
        zIndex="nested"
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
          // The consequence sentence is never traded away for the exclusion
          // note. It used to be an either/or, so selecting a main worktree
          // alongside real targets silently removed the only line telling the
          // user that directories are deleted and uncommitted work discarded.
          bulkRemove.excludedMainCount > 0
            ? `Each worktree directory is deleted from disk and the branch worktree association is removed. Uncommitted and untracked changes are discarded. ${bulkRemove.excludedMainCount} main worktree${bulkRemove.excludedMainCount === 1 ? " is" : "s are"} excluded — only non-main worktrees can be removed here.`
            : "Each worktree directory is deleted from disk and the branch worktree association is removed. Uncommitted and untracked changes are discarded."
        }
        confirmLabel={
          bulkRemove.targets.length === 1
            ? "Remove worktree"
            : `Remove ${bulkRemove.targets.length} worktrees`
        }
        cancelLabel="Cancel"
        variant="destructive"
        // Scrollable per-worktree table of what is about to be deleted — a
        // dialog, not an alertdialog.
        hasPreview={bulkRemove.targets.length > 0}
        zIndex="nested"
        typedNameTarget={bulkRemove.typedNameTarget}
        onConfirm={bulkRemove.handleConfirm}
        isConfirmLoading={bulkRemove.isExecuting}
      >
        {bulkRemove.targets.length > 0 && (
          <div className="border border-divider rounded-[var(--radius-md)] max-h-64 overflow-y-auto divide-y divide-divider">
            {bulkRemove.targets.map((target) => {
              const risks = describeBulkRemoveRisks(target);
              return (
                <div key={target.id} className="flex flex-col gap-1 px-3 py-2 bg-surface-canvas/40">
                  <div className="flex items-center gap-2 text-sm text-text-primary">
                    <GitBranch className="w-3.5 h-3.5 shrink-0 text-text-secondary" />
                    {/* The branch is what truncates, so the branch is what the
                        tooltip has to reveal — it used to show the path, which
                        is not the string being clipped. */}
                    <span
                      className="font-mono truncate"
                      title={`${target.branch ?? target.name}\n${target.path}`}
                    >
                      {target.branch ?? target.name}
                    </span>
                  </div>
                  {risks.length > 0 && (
                    <div className="flex items-start gap-1.5 text-xs text-status-warning">
                      <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                      <span>{risks.join(" · ")}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="flex items-start gap-2 p-3 bg-status-error/10 border border-status-error/20 rounded-[var(--radius-md)] text-status-error text-xs">
          <Trash2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>This is irreversible. Type the count to confirm.</span>
        </div>
      </ConfirmDialog>
    </>
  );
}
