import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  forwardRef,
} from "react";
import {
  Virtuoso,
  type Components,
  type ItemProps,
  type ListProps,
  type ScrollerProps,
  type VirtuosoHandle,
} from "react-virtuoso";
import { FolderOpen, LayoutGrid, Plus, RefreshCw, Zap } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { boundedErrorText } from "@/utils/errorText";
import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import {
  ScrollIndicator,
  SCROLL_INDICATOR_BAND_HEIGHT_PX,
} from "@/components/Worktree/ScrollIndicator";
import {
  useAgentLauncher,
  useWorktrees,
  useProjectSettings,
  useWorktreeActions,
  useAriaKeyshortcuts,
  useEffectiveCombo,
  useDohertyGate,
} from "@/hooks";
import {
  WorktreeSidebarSearchBar,
  QuickStateFilterBar,
  QuickStateArmButton,
} from "@/components/Worktree";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { WorktreesReconnectingBadge, WorktreesReconnectingRow } from "./WorktreesReconnectingBadge";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { Rows3, Server } from "@/components/icons";
import { getViewHostId } from "@/hooks/useHostConnection";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { ProjectHostsGroup } from "./ProjectHostsGroup";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import { splitHostName } from "@/components/Hosts/hostModel";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WorktreeDensityItems } from "@/components/Worktree/WorktreeDensitySubmenu";
import { SIDEBAR_HEADER_ACTION, SIDEBAR_HEADER_ROW } from "./sidebarHeader";
import { useDispatchedSidebarRefresh } from "./useDispatchedSidebarRefresh";
import { useSettledSidebarFailure, type SidebarFailure } from "./useSettledSidebarFailure";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { cn } from "@/lib/utils";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { useWorktreeSelectionStore, useProjectStore } from "@/store";
import type { PendingCreation } from "@/store/worktreeStore";
import { DeletedWorktreeCard } from "@/components/Sidebar/DeletedWorktreeCard";
import { DeletedWorktreeGroup } from "@/components/Sidebar/DeletedWorktreeGroup";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetPickerPaletteStore } from "@/store/fleetPickerPaletteStore";
import { preloadNewWorktreeDialog } from "@/components/Layout/ProjectDialogHost";
import { useShallow } from "zustand/react/shallow";
import { systemClient } from "@/clients";
import { describeActiveFacets } from "@/lib/worktreeFilterOptions";
import { actionService } from "@/services/ActionService";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SidebarWorktreeRow } from "./SidebarWorktreeRow";
import { WorktreeLoadErrorBanner } from "./WorktreeLoadErrorBanner";
import { StaticWorktreeRow } from "./StaticWorktreeRow";
import { WorkspaceRootSidebar } from "./WorkspaceRootSidebar";
import { SidebarViewHeading } from "./SidebarViewSwitcher";
import { useBuiltInSidebarViewHidden } from "./sidebarViewContext";
import { WorktreeCardPlaceholder } from "./WorktreeCardPlaceholder";
import { useWorkspaceRoot } from "@/hooks/useWorkspaceRoot";
import { useShouldSkipMotion } from "@/hooks/useShouldSkipMotion";
import { useVisibilityAwareInterval } from "@/hooks/useVisibilityAwareInterval";
import { useScrollIndicator } from "./useScrollIndicator";
import { useSidebarVirtuosoReset } from "./useSidebarVirtuosoReset";
import { logError } from "@/utils/logger";
import { useWorktreeSidebarKeyboard } from "./useWorktreeSidebarKeyboard";
import type { UseAgentLauncherReturn } from "@/hooks/useAgentLauncher";
import type { WorktreeActions } from "@/hooks/useWorktreeActions";
import { LIST_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { CountBadge } from "@/components/ui/badge";
import { needsReconnectRetry } from "@/lib/worktreeReconnect";
import type { SidebarFlatItem } from "./sidebarWorktreeModel";
import { useSidebarWorktreeModel } from "./useSidebarWorktreeModel";
import {
  SidebarListEmptyState,
  resolveSidebarListEmpty,
  sidebarListEmptyTitle,
} from "./SidebarListEmptyState";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { useSidebarReorderSession } from "./useSidebarReorderSession";
import { useRenderTime } from "./useRenderTime";

// Virtuoso overscan in pixels — covers ~2–5 rows at the 120–260px height range,
// keeping useSortable hooks alive in a small window beyond the viewport so a
// dnd-kit drop target stays mounted as the user drags past it.
const SIDEBAR_VIRTUOSO_OVERSCAN_PX = 600;

// Threshold for escalating the "Reconnecting…" badge to include the time
// since data last arrived. 10s sits above the Doherty 400ms gate so the
// indicator never flickers on transient reconnects, and below the worst-case
// ~14s workspace-host restart budget so it fires before `setFatalError`.
const RECONNECT_ESCALATE_MS = 10_000;

const WORKTREE_DISCONNECTED_MESSAGE = "The workspace service isn't connected to this project.";
const WORKTREE_RECONNECT_STALLED_MESSAGE =
  "Lost the connection to the workspace service, and it hasn't come back. The list may be out of date.";

// Fixed-count shimmer card placeholders for the worktree sidebar loading state.
// Follows the same 3-bone structure as the `.skel-card` design in the
// index.html startup ghost — title / subtitle / detail at 13px / 11px / 32px,
// padding py-3 px-4, gap-2 between bones. Card height ≈ 100px (24 padding +
// 56 bones + 16 gap + 4 mt). Varied widths avoid a picket-fence read.
const WORKTREE_SKELETON_CARDS = [
  { id: "a", titleWidth: "58%", subtitleWidth: "44%" },
  { id: "b", titleWidth: "42%", subtitleWidth: "55%" },
  { id: "c", titleWidth: "52%", subtitleWidth: "38%" },
  { id: "d", titleWidth: "36%", subtitleWidth: "48%" },
] as const;

interface SidebarVirtuosoContext {
  activeWorktreeId: string | null;
  focusedWorktreeId: string | null;
  keyboardCursorId: string | null;
  totalWorktreeCount: number;
  selectWorktree: (id: string) => void;
  worktreeActions: WorktreeActions;
  availability: UseAgentLauncherReturn["availability"];
  agentSettings: UseAgentLauncherReturn["agentSettings"];
  homeDir: string | undefined;
  dragStartOrder: string[];
  isSortDisabled: boolean;
  dragDisabledReason: string | null;
}

const SidebarVirtuosoScroller = forwardRef<
  HTMLDivElement,
  ScrollerProps & { context?: SidebarVirtuosoContext }
>(function SidebarVirtuosoScroller({ children, style, tabIndex: _tabIndex, ...props }, ref) {
  return (
    <div {...props} ref={ref} role="rowgroup" tabIndex={-1} style={style}>
      {children}
    </div>
  );
});

const SidebarVirtuosoList = forwardRef<
  HTMLDivElement,
  ListProps & { context?: SidebarVirtuosoContext }
>(function SidebarVirtuosoList({ children, style, ...props }, ref) {
  return (
    <div {...props} ref={ref} role="presentation" style={style}>
      {children}
    </div>
  );
});

function SidebarVirtuosoItem({
  children,
  style,
  item: _item,
  context: _context,
  ...props
}: ItemProps<SidebarFlatItem> & { context?: SidebarVirtuosoContext }) {
  return (
    <div {...props} role="presentation" style={style}>
      {children}
    </div>
  );
}

const SIDEBAR_VIRTUOSO_COMPONENTS: Components<SidebarFlatItem, SidebarVirtuosoContext> = {
  Scroller: SidebarVirtuosoScroller,
  List: SidebarVirtuosoList,
  Item: SidebarVirtuosoItem,
};

// Module-level item key so Virtuoso's memoization isn't broken by a fresh
// arrow identity each render (past lesson #5010). Returning the stable id
// (not a key that encodes mutable state) is the lesson from #1992.
function computeSidebarItemKey(_index: number, item: SidebarFlatItem): string {
  return item.id;
}

function renderSidebarFlatItem(
  _index: number,
  item: SidebarFlatItem,
  context: SidebarVirtuosoContext
) {
  if (item.kind === "deletedWorktree") {
    return (
      <div role="row" aria-rowindex={item.ariaRowIndex}>
        <div role="gridcell">
          <DeletedWorktreeCard worktree={item.worktree} homeDir={context.homeDir} />
        </div>
      </div>
    );
  }
  if (item.kind === "deletedWorktreeGroup") {
    // One grid row whether collapsed or expanded: the group is a disclosure
    // inside its own cell, so expanding changes the row's height rather than
    // the grid's shape, and `aria-rowindex` stays stable for everything below.
    return (
      <div role="row" aria-rowindex={item.ariaRowIndex}>
        <div role="gridcell">
          <DeletedWorktreeGroup worktrees={item.worktrees} homeDir={context.homeDir} />
        </div>
      </div>
    );
  }
  if (item.kind === "header") {
    return (
      <div
        role="row"
        aria-rowindex={item.ariaRowIndex}
        className="bg-surface-sidebar border-b border-divider"
      >
        <div
          role="rowheader"
          aria-colspan={1}
          className={cn(LIST_LABEL_CLASS, "flex items-center gap-1.5 px-4 py-2")}
        >
          {item.displayName}
          {/* The pill is for the eye; the name keeps its "(n)" for a screen reader. */}
          <CountBadge aria-hidden="true">{item.count}</CountBadge>
          <span className="sr-only"> ({item.count})</span>
        </div>
      </div>
    );
  }
  if (item.mode === "static") {
    return (
      <StaticWorktreeRow
        worktreeId={item.worktreeId}
        activeWorktreeId={context.activeWorktreeId}
        focusedWorktreeId={context.focusedWorktreeId}
        keyboardCursorId={context.keyboardCursorId}
        totalWorktreeCount={context.totalWorktreeCount}
        selectWorktree={context.selectWorktree}
        worktreeActions={context.worktreeActions}
        availability={context.availability}
        agentSettings={context.agentSettings}
        homeDir={context.homeDir}
        ariaRowIndex={item.ariaRowIndex}
      />
    );
  }
  return (
    <SidebarWorktreeRow
      worktreeId={item.worktreeId}
      activeWorktreeId={context.activeWorktreeId}
      focusedWorktreeId={context.focusedWorktreeId}
      keyboardCursorId={context.keyboardCursorId}
      totalWorktreeCount={context.totalWorktreeCount}
      selectWorktree={context.selectWorktree}
      worktreeActions={context.worktreeActions}
      availability={context.availability}
      agentSettings={context.agentSettings}
      homeDir={context.homeDir}
      dragStartOrder={context.dragStartOrder}
      isSortDisabled={context.isSortDisabled}
      dragDisabledReason={context.dragDisabledReason}
      isPinned={item.isPinned}
      rowIndex={item.rowIndex}
      ariaRowIndex={item.ariaRowIndex}
    />
  );
}

interface SidebarContentProps {
  onOpenOverview: () => void;
}

function SidebarContent({ onOpenOverview }: SidebarContentProps) {
  const overviewShortcut = useEffectiveCombo("worktree.overview");
  const refreshShortcut = useEffectiveCombo("worktree.refresh");
  const createWorktreeShortcut = useEffectiveCombo("worktree.createDialog.open");
  const overviewAriaShortcut = useAriaKeyshortcuts("worktree.overview");
  const refreshAriaShortcut = useAriaKeyshortcuts("worktree.refresh");
  const createWorktreeAriaShortcut = useAriaKeyshortcuts("worktree.createDialog.open");
  // Static per view: a project view is bound to one host for its life.
  const viewHostId = getViewHostId();
  const storeHostName = useHostConnectionStore((s) => s.hostName);
  const remoteHostName = viewHostId === null ? null : (storeHostName ?? viewHostId);
  const remoteHostParts = remoteHostName === null ? null : splitHostName(remoteHostName);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const scrollerElementRef = useRef<HTMLElement | null>(null);
  const {
    worktrees,
    isLoading: isStoreLoading,
    isInitialized,
    isReconnecting,
    reconnectingAt,
    reconnectRecovery,
    error,
  } = useWorktrees();
  const [bannerDismissed, setBannerDismissed] = useState(false);
  useEffect(() => {
    setBannerDismissed(false);
  }, [error]);
  const onBannerDismiss = useCallback(() => setBannerDismissed(true), []);

  // 1Hz tick that drives the escalated "Reconnecting… last updated X ago"
  // copy. The store holds the start timestamp; this state forces a render so
  // `formatRelativeTime(reconnectingAt)` recomputes against the latest clock.
  // Visibility-gated so the tick pauses while the window is hidden (Chromium
  // throttles hidden-tab intervals to ~1/min) and snaps back on restore. The
  // callback reads no captured timestamp, so there's no stale-closure risk
  // despite the hook only depending on [intervalMs, enabled].
  const [, setReconnectTick] = useState(0);
  useVisibilityAwareInterval(
    () => setReconnectTick((n) => n + 1),
    1000,
    isReconnecting && reconnectingAt != null
  );
  // Handed to every check that ages. A helper that reads the clock itself is
  // cached against its other inputs once compiled, so a reconnect that only
  // gets older would never escalate or surface Retry.
  const now = useRenderTime();
  const showReconnectingEscalated =
    isReconnecting && reconnectingAt !== null && now - reconnectingAt >= RECONNECT_ESCALATE_MS;
  const [isRefreshPending, startRefreshTransition] = useTransition();
  // A refresh dispatched from anywhere but the button (palette, shortcut, the
  // sidebar's context menu) never enters the transition above.
  const isRefreshDispatched = useDispatchedSidebarRefresh();
  const isRefreshing = isRefreshPending || isRefreshDispatched;
  // Gate the "Reconnecting…" indicator behind the Doherty threshold so routine
  // sub-400ms port replacements don't flash the spinner. A real host crash
  // takes 2–4s to recover, well past the threshold.
  const showReconnecting = useDohertyGate(isReconnecting);
  // One-shot screen-reader announcements on the rising edges of the reconnecting
  // state. The visible indicator's text is rewritten every second by the 1Hz
  // tick above; routing those changes through an `aria-live` region would make
  // the AT re-announce on every tick. Instead the visible span is `aria-hidden`
  // and we fire a single announcement here when reconnecting starts and again
  // when it escalates. Recovery is intentionally silent — the spinner vanishing
  // is self-evident, and a "Connected" announcement would be noise.
  const prevReconnecting = useRef(false);
  const prevEscalated = useRef(false);
  useEffect(() => {
    if (showReconnecting && !prevReconnecting.current) {
      useAnnouncerStore.getState().announce("Reconnecting…", "polite");
    }
    // Gate escalation on `showReconnecting` (the Doherty-gated value) too:
    // `showReconnectingEscalated` reads raw `isReconnecting`, so mounting mid-
    // outage could otherwise fire "Still reconnecting…" 400ms before the base
    // "Reconnecting…" announcement and invert their order.
    if (showReconnecting && showReconnectingEscalated && !prevEscalated.current) {
      useAnnouncerStore.getState().announce("Still reconnecting…", "polite");
    }
    prevReconnecting.current = showReconnecting;
    // Gate the escalated edge-tracker on `showReconnecting` too, so a mid-outage
    // remount (escalated true while the Doherty gate still reads false) doesn't
    // consume the edge before the base announcement lands — otherwise the next
    // render, once the gate flips true, would skip "Still reconnecting…"
    // entirely. With this gate, that render fires base then escalated, in order.
    prevEscalated.current = showReconnecting && showReconnectingEscalated;
  }, [showReconnecting, showReconnectingEscalated]);
  const currentProject = useProjectStore((state) => state.currentProject);
  // The workspace this view owns, whatever kind it is. `currentProject` alone
  // can't see a scratch, which is why the sidebar had nothing to render in one.
  const workspaceRoot = useWorkspaceRoot();
  const worktreeLoadError = useProjectStore((state) => state.worktreeLoadError);
  // A load that already failed is not still loading. The store keeps
  // `isLoading` when a switch's load throws or the host dies before the first
  // snapshot, and the skeleton branch would say the list is loading while
  // hiding the only recovery — Retry for the one, Restart for the other.
  const isLoading = isStoreLoading && worktreeLoadError === null && error === null;
  useProjectSettings();
  const { availability, agentSettings } = useAgentLauncher();
  const { activeWorktreeId, focusedWorktreeId, selectWorktree } = useWorktreeSelectionStore(
    useShallow((state) => ({
      activeWorktreeId: state.activeWorktreeId,
      focusedWorktreeId: state.focusedWorktreeId,
      selectWorktree: state.selectWorktree,
    }))
  );
  // Direct subscription (no useDeferredValue) so the skeleton renders the
  // moment the dialog submits — defer would make the placeholder lag the
  // dialog close by a frame and lose the perceived-responsiveness win.
  const pendingCreations = useWorktreeSelectionStore((s) => s.pendingCreations);
  const deletedWorktrees = useWorktreeSelectionStore((s) => s.deletedWorktrees);
  const openCreateDialog = useWorktreeSelectionStore((s) => s.openCreateDialog);
  const dismissPendingCreation = useWorktreeSelectionStore((s) => s.dismissPendingCreation);

  const handleRetryPendingCreation = useCallback(
    (pendingCreation: PendingCreation) => {
      dismissPendingCreation(pendingCreation.path);
      openCreateDialog(null, {
        initialBranchInput: pendingCreation.branch,
        initialRecipeId: pendingCreation.recipeId,
        initialAgentId: pendingCreation.agentId,
        initialPrompt: pendingCreation.prompt,
      });
    },
    [dismissPendingCreation, openCreateDialog]
  );

  const pendingCreationRows = useMemo(() => {
    if (pendingCreations.size === 0) return null;
    // Rows of the grid like any other, since the grid may own only rows.
    return Array.from(pendingCreations.values()).map((pendingCreation) => (
      <div key={pendingCreation.path} role="row">
        <div role="gridcell">
          <WorktreeCardPlaceholder
            pendingCreation={pendingCreation}
            onRetry={handleRetryPendingCreation}
            onDismiss={dismissPendingCreation}
          />
        </div>
      </div>
    ));
  }, [pendingCreations, handleRetryPendingCreation, dismissPendingCreation]);

  const openFleetPicker = useFleetPickerPaletteStore((s) => s.open);
  const [isRestartConfirmOpen, setIsRestartConfirmOpen] = useState(false);

  useEffect(() => {
    if (!error) setIsRestartConfirmOpen(false);
  }, [error]);
  const armedIds = useFleetArmingStore((s) => s.armedIds);
  const armedSize = armedIds.size;

  // Only against a list the host actually delivered: before the first snapshot,
  // while a load is in flight, or after one failed, `worktrees` is empty or
  // stale, and pruning against it would wipe every pin and label in the project
  // (#13408). A reconnect is not gated: the view keeps its last full list
  // through it, and a reconnect flag that outlives its recovery would otherwise
  // switch pruning off for the rest of the session.
  const canPruneWorktreeIds =
    isInitialized && !isLoading && error === null && worktreeLoadError === null;
  const {
    deferredWorktrees,
    liveQuery,
    deferredQuery,
    isGroupedByType,
    statusFilters,
    typeFilters,
    prIssueFilters,
    sessionFilters,
    hasAgentFilter,
    activityFilters,
    devServerFilters,
    quickStateFilter,
    hasFacetFiltersActive,
    clearAllFilters,
    setQuickStateFilter,
    mainWorktree,
    mainVisible,
    mainInQuickState,
    mainHiddenByQuickState,
    nonMainWorktrees,
    quickStateCounts,
    chipCounts,
    filteredWorktrees,
    groupedSections,
    resultsWithoutQuickStateCount,
    totalCount,
    dragStartOrder,
    sortableIds,
    filterArmEligibleIds,
    mainRowIndex,
    ariaRowCount,
    sidebarItems,
    attentionWorktreeIds,
    problemWorktreeTones,
    keyboardItems,
  } = useSidebarWorktreeModel({
    worktrees,
    activeWorktreeId,
    deletedWorktrees,
    canPruneWorktreeIds,
  });
  const {
    handleKeyboardReorder,
    keyboardReorderAnnouncement,
    keyboardCancelAnnouncement,
    isSortDisabled,
    dragDisabledReason,
    isDragActive,
  } = useSidebarReorderSession({
    worktrees,
    dragStartOrder,
    isGroupedByType,
    liveQuery,
  });

  const searchInputRef = useRef<HTMLInputElement>(null);

  const [homeDir, setHomeDir] = useState<string | undefined>(undefined);

  useEffect(() => {
    systemClient
      .getHomeDir()
      .then(setHomeDir)
      .catch((err) => logError("Failed to get home dir", err));
  }, []);

  const handleRefreshAll = useCallback(() => {
    if (isRefreshing) return;
    startRefreshTransition(async () => {
      await actionService.dispatch("worktree.refresh", undefined, { source: "user" });
    });
  }, [isRefreshing, startRefreshTransition]);

  const worktreeActions = useWorktreeActions();

  const filterArmUnarmedCount = useMemo(() => {
    let unarmed = 0;
    for (const id of filterArmEligibleIds) {
      if (!armedIds.has(id)) unarmed++;
    }
    return unarmed;
  }, [filterArmEligibleIds, armedIds]);

  const hasQuery = liveQuery.trim().length > 0;

  // Filter-scope + sort-disabled state. Hoisted above the early returns below so
  // the announcement effects that depend on them keep a stable hook order.
  // `hasFilters` mirrors the store's `hasActiveFilters()` but uses the instant
  // `liveQuery` so filter-dependent UI (scope line, filtered-empty state) reacts
  // immediately rather than after the persisted-query debounce.
  const hasFilters =
    liveQuery.trim().length > 0 || hasFacetFiltersActive || quickStateFilter !== "all";
  // Main is a pinned card rather than a list row, but every filter applies to
  // it and it is on screen, so it belongs in both halves of the ratio, as it
  // does in the quick-state counts. Without it, selecting "Main (1)" read
  // "0 of 6 worktrees" directly above a visible main card.
  const filteredCount = filteredWorktrees.length + (mainVisible ? 1 : 0);
  const scopeTotal = totalCount + (mainWorktree ? 1 : 0);
  const showScope = hasFilters && filteredCount !== scopeTotal;
  // Filter scope + sort-disabled status, rendered inside the search bar strip
  // so the feedback sits with the controls that produced it. Visual-only —
  // screen readers are served by the debounced announcer effects below, not a
  // live region, so the persistent sort-disabled text isn't re-announced on
  // every keystroke (#9665).
  // On screen only for the search and the facets. A segment shows its own
  // choice and count on the bar, and a line appearing above the bar on click
  // pushed the bar out from under the pointer that had just pressed it. The
  // announcement below still speaks for every kind of narrowing.
  const scopeText =
    showScope && (hasQuery || hasFacetFiltersActive)
      ? `${filteredCount} of ${scopeTotal} worktrees`
      : null;
  // Which filters, not just how many. A count tells the user the list is cut
  // down; it does not stop a sparse sidebar reading as an empty one.
  const activeFacetText = describeActiveFacets({
    statusFilters,
    typeFilters,
    prIssueFilters,
    sessionFilters,
    hasAgentFilter,
    activityFilters,
    devServerFilters,
  });
  // Identity outranks the reorder note: that note is a standing explanation
  // rather than news, and it was eating the line and truncating the scope.
  const filterStatusText = scopeText ?? dragDisabledReason;

  const listEmpty = resolveSidebarListEmpty({
    filteredCount: filteredWorktrees.length,
    hasNonMainWorktrees: nonMainWorktrees.length > 0,
    quickStateFilter,
    hasQuery,
    hasFacets: hasFacetFiltersActive,
    resultsWithoutQuickStateCount: resultsWithoutQuickStateCount + (mainHiddenByQuickState ? 1 : 0),
    mainVisible: mainVisible === true,
    mainInQuickState,
    displayQuery: deferredQuery,
  });
  const listEmptyTitle = listEmpty === null ? null : sidebarListEmptyTitle(listEmpty);

  // Announce the filtered worktree count to screen readers, debounced so rapid
  // typing in the search box doesn't flood the AT speech queue. Routed through
  // the global announcer (document.ariaNotify + always-mounted fallback) rather
  // than a persistent aria-atomic live region — that region re-announced the
  // whole status line, including the persistent sort-disabled text, on every
  // keystroke (#9665).
  // Silent on mount, so opening a project does not announce its own worktree
  // count; from then on every transition speaks, including the one back to the
  // full set. Bailing out on `!showScope` meant clearing the last filter — the
  // moment the user most needs it confirmed — said nothing at all.
  // Compares against the last narrowed state rather than counting effect runs:
  // a "first run is mount" flag flips on the loading render, so the first real
  // snapshot after it announced the project's own worktree count on open. The
  // "All N" message fires only on the narrowed -> not-narrowed edge, and only
  // once the deferred list has actually caught up (`filteredCount ===
  // scopeTotal`) — `liveQuery` clears instantly while `deferredQuery` still
  // drives the rows, so without that check it spoke "All 7" over a list of one
  // and then again when the rows arrived.
  // A list hidden behind a plugin's sidebar view speaks for nothing on screen.
  const isHiddenInSidebar = useBuiltInSidebarViewHidden();
  const wasNarrowedRef = useRef(false);
  useEffect(() => {
    let message: string | null = null;
    if (showScope) {
      // An emptied list says why rather than "1 of 7 worktrees", which counts
      // the main card and reads as a contradiction of the tab that emptied it.
      message = listEmptyTitle ?? `${filteredCount} of ${scopeTotal} worktrees`;
      wasNarrowedRef.current = true;
    } else if (wasNarrowedRef.current && filteredCount === scopeTotal) {
      message = `All ${scopeTotal} worktrees shown`;
      wasNarrowedRef.current = false;
    }
    if (message === null || isHiddenInSidebar) return;
    const spoken = message;
    const timer = window.setTimeout(() => {
      useAnnouncerStore.getState().announce(spoken);
    }, UI_DOHERTY_THRESHOLD);
    return () => {
      window.clearTimeout(timer);
    };
    // Keyed on the filter inputs as well as the count, so swapping to a
    // different set of the same size still speaks.
  }, [
    showScope,
    filteredCount,
    scopeTotal,
    activeFacetText,
    liveQuery,
    quickStateFilter,
    isHiddenInSidebar,
    listEmptyTitle,
  ]);

  // Computed after `sidebarItems` because the indicator counts hidden worktree
  // rows directly from the flat list geometry (variable-height rows + section
  // headers, issue #9666), so it needs the full item array as its input.

  const skipMotion = useShouldSkipMotion();
  const isCompactDensity = useWorktreeFilterStore((state) => state.cardDensity === "compact");

  const {
    hiddenAbove,
    hiddenBelow,
    revealAbove,
    revealBelow,
    bandInsets,
    handleBandWheel,
    scrollerRef: scrollIndicatorScrollerRef,
    handleScroll,
    handleItemsRendered,
  } = useScrollIndicator({
    items: sidebarItems,
    attentionWorktreeIds,
    problemWorktreeTones,
    virtuosoRef,
    smoothScroll: !skipMotion,
    bandHeightPx: SCROLL_INDICATOR_BAND_HEIGHT_PX,
    // A band would hide rows a drop can still land on.
    paused: isDragActive,
  });

  // Native focus scrolling (a row's toolbar button) parks its target clear
  // of the bands too.
  const scrollerStyle = {
    scrollPaddingTop: bandInsets.top,
    scrollPaddingBottom: bandInsets.bottom,
  };

  const setScrollerElement = useCallback(
    (el: HTMLElement | Window | null) => {
      scrollerElementRef.current = el instanceof HTMLElement ? el : null;
      scrollIndicatorScrollerRef(el);
    },
    [scrollIndicatorScrollerRef]
  );

  // Virtuoso's size/offset trees are index-keyed, so any shrink leaves them
  // describing the old layout and strands a row that can never re-measure
  // itself. Remounting is the only way to discard them (#12094).
  const { resetKey: virtuosoResetKey, initialScrollTop: virtuosoInitialScrollTop } =
    useSidebarVirtuosoReset({
      itemCount: sidebarItems.length,
      searchQuery: deferredQuery,
      liveQuery,
      scrollerRef: scrollerElementRef,
    });

  const {
    gridRef,
    activeDescendantId,
    keyboardCursorId,
    handleGridKeyDown,
    handleGridFocus,
    handleGridFocusCapture,
  } = useWorktreeSidebarKeyboard({
    items: keyboardItems,
    virtuosoRef,
    scrollerRef: scrollerElementRef,
    onKeyboardReorder: handleKeyboardReorder,
    onSelectWorktree: selectWorktree,
  });

  const virtuosoContext = useMemo<SidebarVirtuosoContext>(
    () => ({
      activeWorktreeId,
      focusedWorktreeId,
      keyboardCursorId,
      totalWorktreeCount: deferredWorktrees.length,
      selectWorktree,
      worktreeActions,
      availability,
      agentSettings,
      homeDir,
      dragStartOrder,
      isSortDisabled,
      dragDisabledReason,
    }),
    [
      activeWorktreeId,
      focusedWorktreeId,
      keyboardCursorId,
      deferredWorktrees.length,
      selectWorktree,
      worktreeActions,
      availability,
      agentSettings,
      homeDir,
      dragStartOrder,
      isSortDisabled,
      dragDisabledReason,
    ]
  );

  // An open project whose worktree store never received a snapshot has no port
  // to the workspace service. That is a connection failure, not an empty
  // repository, so it must never fall through to the "Open a Git repository"
  // nudge — the state Retry used to leave behind (#12576).
  const isProjectDisconnected = currentProject !== null && !isInitialized;

  // Hoisted before the early returns so the failed-switch banner (#8400)
  // surfaces regardless of which empty/populated branch the sidebar is in —
  // when a switch's worktree load throws, the store stays empty so every
  // other branch would otherwise show no trace of the failure. An open project
  // with no snapshot once loading has settled is a connection failure (#12576)
  // and takes the same banner. It yields to any service error, shown or
  // dismissed: a crashed host needs Restart, and Retry offers a fix that
  // cannot work. A lost port that no restart brought back takes it too, under
  // the cached list (#13748), once automatic recovery has given up on it
  // (#14313).
  const loadFailure =
    worktreeLoadError ??
    (isProjectDisconnected && !isLoading && error === null
      ? WORKTREE_DISCONNECTED_MESSAGE
      : null) ??
    (needsReconnectRetry({ isReconnecting, reconnectingAt, reconnectRecovery }, now)
      ? WORKTREE_RECONNECT_STALLED_MESSAGE
      : null);

  // Both banners wait out a settle window before they show: a switch to a slow
  // remote host passes through states that read as failures on the way to
  // connecting, and a banner that flashes past unread is worse than none
  // (#14311). An empty sidebar keeps its skeleton through the window instead.
  const sidebarFailure: SidebarFailure | null =
    error !== null
      ? { kind: "service-error", message: error }
      : loadFailure !== null
        ? { kind: "load-error", message: loadFailure }
        : null;
  const isFailureSettled = useSettledSidebarFailure(sidebarFailure);
  // A settled failure ends the skeleton even while the store still reads as
  // loading: a stalled reconnect during the first hydration leaves `isLoading`
  // up for good, and the skeleton would hide the only recovery.
  const showSkeleton = (isLoading || sidebarFailure !== null) && !isFailureSettled;
  const worktreeLoadErrorBanner =
    loadFailure !== null && error === null && isFailureSettled ? (
      <WorktreeLoadErrorBanner error={loadFailure} />
    ) : null;

  // Workspace-service error banner overlays cached data so the user can keep
  // working through transient poll failures. Hoisted before the early returns
  // so a `setFatalError` that fires before the first snapshot is still
  // actionable from the zero-worktrees branch — its only recovery path is the
  // banner's "Restart Service" button. Over an empty, disconnected sidebar it
  // is also the only explanation on screen, so it can't be dismissed there.
  const canDismissErrorBanner = worktrees.length > 0 || !isProjectDisconnected;
  const errorBanner =
    error !== null && isFailureSettled && (!bannerDismissed || !canDismissErrorBanner) ? (
      <InlineStatusBanner
        title="Workspace service unavailable"
        // A wrapping description, not the one-line mono context line: the
        // reason is the part worth reading, and at sidebar width the context
        // line clipped it to "Workspace host exit…" with the rest on hover only.
        description={boundedErrorText(error)}
        // Error, not warning: this shows only once recovery has failed and
        // settled, beside the load-failure banner's error tier.
        severity="error"
        role="status"
        ariaLive="polite"
        onClose={canDismissErrorBanner ? onBannerDismiss : undefined}
        closeAriaLabel="Dismiss error"
        action={{
          id: "restart-workspace-service",
          // The ellipsis says a confirmation comes first.
          label: "Restart service…",
          variant: "primary",
          onClick: () => setIsRestartConfirmOpen(true),
        }}
      />
    ) : null;

  // Mounted in both the zero-worktree early return and the main return path so
  // the errorBanner's "Restart Service" action stays reachable when
  // `setFatalError` fires before the first snapshot hydrates.
  const restartConfirmDialog = (
    <ConfirmDialog
      isOpen={isRestartConfirmOpen}
      onClose={() => setIsRestartConfirmOpen(false)}
      title="Restart workspace service?"
      description="Restarts the workspace monitoring process. Git status and worktree data will be temporarily unavailable."
      confirmLabel="Restart service"
      variant="destructive"
      onConfirm={() => {
        void actionService.dispatch("worktree.restartService", undefined, { source: "user" });
        setIsRestartConfirmOpen(false);
      }}
    />
  );

  // A workspace with no git worktrees — a scratch, or a folder opened without
  // git (#11405) — still has exactly one place agents run: its own root. It
  // renders that as the single row instead of a Worktrees header over an empty
  // state, so the sidebar means one thing across all three workspace kinds and
  // the toggle that opens it stops lying in a scratch (#11499).
  //
  // It takes neither the skeleton (no worktree poll will ever resolve) nor the
  // "Open a Git repository" nudge, so it has to answer before both. Paired with
  // the empty list rather than read alone: a folder that has since been
  // initialized externally loads worktrees normally, and those must win over a
  // flag that is only reconciled the next time the folder is opened (#11405).
  if (workspaceRoot !== null && !workspaceRoot.isGitBacked && worktrees.length === 0) {
    return (
      <>
        <WorkspaceRootSidebar workspace={workspaceRoot} homeDir={homeDir} />
        {restartConfirmDialog}
      </>
    );
  }

  if (showSkeleton && worktrees.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className={SIDEBAR_HEADER_ROW}>
          <SidebarViewHeading className="truncate text-text-primary font-semibold text-sm tracking-wide">
            Worktrees
          </SidebarViewHeading>
        </div>
        {/* The control zone's shape, at its real heights (the 28px search rail,
            the quick-state bar), so the zone's bottom edge does not drop 70px
            the moment the list arrives. */}
        <div
          aria-hidden="true"
          className="worktree-filter-bar flex shrink-0 gap-1.5 border-b border-divider px-3 pb-3"
        >
          <SkeletonBone className="flex-1 rounded-[var(--radius-md)]" heightPx={28} />
          <SkeletonBone className="w-7 rounded-[var(--radius-md)]" heightPx={28} />
        </div>
        <div
          aria-hidden="true"
          className="worktree-filter-bar flex h-[29px] shrink-0 items-center gap-3 border-b border-border-default px-3"
        >
          {/* The bar's four segments, so its shape is there before its counts. */}
          {[0, 1, 2, 3].map((segment) => (
            <SkeletonBone key={segment} className="flex-1 rounded-sm" heightPx={10} />
          ))}
        </div>
        <div className="flex-1 min-h-0 relative overflow-hidden pb-8">
          <Skeleton label="Loading worktrees">
            {WORKTREE_SKELETON_CARDS.map((card) => (
              // The current density's card, line for line: Comfortable's
              // title, branch, PR and activity rows; Compact's three.
              <div
                key={card.id}
                aria-hidden="true"
                className={cn(
                  "flex flex-col px-4",
                  isCompactDensity ? "gap-2 py-3" : "gap-2.5 py-3.5"
                )}
              >
                <SkeletonBone
                  shimmer
                  className="rounded-sm"
                  heightPx={13}
                  style={{ width: card.titleWidth }}
                />
                <SkeletonBone
                  shimmer
                  className="rounded-sm"
                  heightPx={11}
                  style={{ width: card.subtitleWidth }}
                />
                {!isCompactDensity && (
                  <SkeletonBone shimmer className="w-1/4 rounded-sm" heightPx={11} />
                )}
                <SkeletonBone shimmer className="mt-1 w-[85%] rounded-sm" heightPx={12} />
              </div>
            ))}
          </Skeleton>
          <SkeletonHint className="absolute bottom-4 inset-x-4 flex justify-center pointer-events-auto" />
        </div>
      </div>
    );
  }

  if (worktrees.length === 0) {
    return (
      <>
        <div className="flex flex-col h-full">
          <div className={cn(SIDEBAR_HEADER_ROW, "border-b border-divider")}>
            <SidebarViewHeading className="truncate text-text-primary font-semibold text-sm tracking-wide">
              Worktrees
            </SidebarViewHeading>
          </div>
          {errorBanner}
          {worktreeLoadErrorBanner}

          {/* A failed load or a missing connection already has an open
              project — the "Open a Git repository" nudge would contradict the
              banner, so the banner stands alone as the actionable state. */}
          {loadFailure === null && !isProjectDisconnected && (
            <EmptyState
              variant="zero-data"
              scale="sidebar"
              icon={<FolderOpen />}
              title="Open a Git repository"
              action={
                <span className="text-xs text-text-secondary">
                  {/* A menu path, not a key — set as words, never as a key chip. */}
                  Use <span className="text-text-primary">File → Open Project</span>
                </span>
              }
              className="flex-1"
            />
          )}
        </div>
        {restartConfirmDialog}
      </>
    );
  }

  const hasNonMainWorktrees = nonMainWorktrees.length > 0;
  // The control zone stays up while any filter is on, even once the last
  // feature worktree is gone: the filters persist, and the zone that set them
  // is the only way to clear them. Without this a filter that hid main left a
  // blank sidebar with nothing to undo it.
  const showControlZone = hasNonMainWorktrees || hasFilters;

  // Each recovery action unmounts the button it lives on, so focus goes to the
  // search field first — it survives every branch, and it holds the criteria
  // the user kept. Without it a keyboard user lands on the document body.
  const handleShowAllMatches = () => {
    searchInputRef.current?.focus();
    setQuickStateFilter("all");
  };
  const handleClearSearch = () => {
    searchInputRef.current?.focus();
    const { setLiveQuery, setQuery } = useWorktreeFilterStore.getState();
    setLiveQuery("");
    setQuery("");
  };
  const handleClearAllFilters = () => {
    searchInputRef.current?.focus();
    clearAllFilters();
  };

  // Compact arm affordance pinned to the QuickStateFilterBar's trailing edge —
  // replaces the former full-width banner button. Enabled whenever the visible
  // worktrees still hold unarmed agent terminals; with "All" selected and no
  // filters that means "arm every agent". Otherwise it rests dimmed and
  // disabled so the layout stays stable and the affordance stays discoverable.
  // Plain shells are excluded here (#11637) — they stay armable individually
  // and via the header fleet picker's broad "arm all".
  const filterArmEligibleCount = filterArmEligibleIds.length;
  const canArmMatching = filterArmUnarmedCount > 0;
  // Agent-scoped nouns: this affordance no longer addresses plain shells, so
  // "terminals" would overstate what a click arms and the exhausted states
  // would read as false whenever an unarmed shell is in scope (#11637).
  const armNoun = filterArmUnarmedCount === 1 ? "agent" : "agents";
  const armMatchingLabel = canArmMatching
    ? hasFilters
      ? armedSize > 0
        ? `Arm ${filterArmUnarmedCount} more matching ${armNoun}`
        : `Arm ${filterArmUnarmedCount} matching ${armNoun}`
      : armedSize > 0
        ? `Arm ${filterArmUnarmedCount} more ${armNoun}`
        : `Arm all ${filterArmUnarmedCount} ${armNoun}`
    : filterArmEligibleCount === 0
      ? hasFilters
        ? "No agents match the filter"
        : "No agents to arm"
      : hasFilters
        ? "All matching agents are armed"
        : "All agents are armed";
  const armMatchingButton = (
    <QuickStateArmButton
      label={armMatchingLabel}
      disabled={!canArmMatching}
      onArm={() =>
        actionService.dispatch(
          "fleet.armMatchingFilter",
          {
            worktreeIds: [
              ...(mainVisible && mainWorktree ? [mainWorktree.id] : []),
              ...filteredWorktrees.map((w) => w.id),
            ],
          },
          { source: "user" }
        )
      }
    />
  );
  return (
    <div className="@container/sidebar flex flex-col h-full">
      {/* Header Section */}
      {/* The control zone carries ONE horizontal rule, at its bottom edge. When
          the search rail renders it owns that rule, so the header goes without;
          with no rail the header IS the bottom of the zone and keeps it.
          Stacking a header rule on a rail rule put two hairlines in the first
          90px of the sidebar and neither was carrying hierarchy (#11991). */}
      {/* SIDEBAR_HEADER_ROW, not a bare h-8. The zone read as cramped against
          the window chrome above it, and an even 12px rhythm — above the title,
          title to field, field to list — is what a control zone needs before
          the eye will treat it as one band rather than two stacked strips. The
          loading and error branches above, and the non-git workspace sidebar,
          carry the same row, or the sidebar jumps as a project resolves or the
          workspace kind changes. */}
      <div
        className={cn(
          SIDEBAR_HEADER_ROW,
          "group/header @container/header justify-between gap-1 bg-transparent",
          !showControlZone && "border-b border-divider"
        )}
      >
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          {/* Heading navigation lands here, not on the tag, so the host rides in
              the heading's name, and stays there when the tag hides. */}
          <SidebarViewHeading
            className="min-w-0 truncate text-text-primary font-semibold text-sm tracking-wide"
            aria-label={
              remoteHostName === null ? undefined : `Worktrees, on host ${remoteHostName}`
            }
          >
            Worktrees
          </SidebarViewHeading>
          {remoteHostParts && !showReconnecting && (
            // These checkouts live on the host, not here: the list says where,
            // in the remote hue the toolbar above it wears. It repeats the host
            // chip, so it is the first thing to go — when the header is too
            // narrow for the name's distinguishing end, or "Reconnecting…"
            // needs the room. Centred in the free run between the title and the
            // actions, so it sits in its own light rather than trailing the title.
            <span className="hidden min-w-0 flex-1 justify-center self-center @[18rem]/header:flex">
              <span
                data-testid="sidebar-remote-host"
                aria-hidden="true"
                className="sidebar-remote-host flex h-5 min-w-0 cursor-default items-center gap-1 rounded-[var(--radius-sm)] px-1.5 text-xs text-text-secondary"
              >
                <Server className="sidebar-remote-host-source h-3 w-3 shrink-0" />
                {/* One gapless run, so the name's parts never read as separate words. */}
                <span className="flex min-w-0">
                  {/* A few characters of a long head always show: "g…" names nothing. */}
                  <span
                    className={cn(
                      "truncate",
                      remoteHostParts.nameHead.length > 7
                        ? "min-w-[4ch]"
                        : remoteHostParts.nameHead.length > 4
                          ? "min-w-0"
                          : "shrink-0"
                    )}
                  >
                    {remoteHostParts.nameHead}
                  </span>
                  <span className="shrink-0">{remoteHostParts.nameTail}</span>
                  {remoteHostParts.nameDomain && (
                    <span className="min-w-0 shrink-[100] truncate">
                      {remoteHostParts.nameDomain}
                    </span>
                  )}
                </span>
              </span>
            </span>
          )}
          {showReconnecting && (
            <WorktreesReconnectingBadge
              escalatedSince={showReconnectingEscalated ? reconnectingAt : null}
            />
          )}
        </div>
        {/* gap-0.5, not gap-1: the four 24px buttons already carry their own
            inset, so a 4px gap on top spent width the 200px minimum does not
            have — the cluster crowded the "Worktrees" landmark it sits beside. */}
        {/* The cluster also stays up while the refresh icon is turning, so a
            refresh the pointer has left, or one started from the palette, still
            shows — and it fades back only once SpinningIcon finishes its turn. */}
        <div className="flex shrink-0 items-center gap-0.5">
          {/* Faded, not `invisible`: `visibility: hidden` took these out of the
              tab order, so focus-within could never reveal them and a keyboard
              user tabbing in never met them. Gone below 13rem, where their
              reserved width would have run the title into them; all three
              stay in the command palette and the background menu. */}
          <div
            className={cn(
              "opacity-0 pointer-events-none transition-opacity duration-150 delay-75 group-hover/header:opacity-100 group-hover/header:pointer-events-auto group-hover/header:delay-75 group-focus-within/header:opacity-100 group-focus-within/header:pointer-events-auto group-focus-within/header:delay-75 has-[[data-spinning]]:opacity-100 has-[[data-spinning]]:pointer-events-auto hidden items-center gap-0.5",
              // "Reconnecting…" beside the title needs the room these reserve.
              !showReconnecting && "@[13rem]/header:flex"
            )}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={onOpenOverview}
                  className={SIDEBAR_HEADER_ACTION}
                  aria-label="Open worktrees overview"
                  aria-keyshortcuts={overviewAriaShortcut}
                >
                  <LayoutGrid aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {createTooltipContent("Open worktrees overview", overviewShortcut)}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={openFleetPicker}
                  className={SIDEBAR_HEADER_ACTION}
                  aria-label="Select terminals to arm"
                >
                  <Zap aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Select terminals to arm</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                {/* aria-disabled, not disabled: a disabled button drops keyboard
                    focus mid-refresh. The handler already ignores a press while
                    a refresh is in flight. Busy, not unavailable, so no dim:
                    the spinner is the whole signal and must not be faded. */}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={handleRefreshAll}
                  aria-disabled={isRefreshing || undefined}
                  className={cn(
                    SIDEBAR_HEADER_ACTION,
                    "aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent aria-disabled:hover:text-text-secondary"
                  )}
                  aria-label="Refresh sidebar"
                  aria-keyshortcuts={refreshAriaShortcut}
                >
                  <SpinningIcon icon={RefreshCw} active={isRefreshing} aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {createTooltipContent("Refresh sidebar", refreshShortcut)}
              </TooltipContent>
            </Tooltip>
          </div>
          {/* Always shown, unlike the cluster beside it: with a full list the
              cards cover the sidebar, so its background menu (where density
              and the list-wide fold live) has nowhere to be right-clicked. */}
          {worktrees.length > 0 && (
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className={SIDEBAR_HEADER_ACTION}
                      aria-label="View options"
                    >
                      <Rows3 aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">View options</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="w-48">
                <WorktreeDensityItems kind="dropdown" />
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() =>
                  actionService.dispatch("worktree.createDialog.open", undefined, {
                    source: "user",
                  })
                }
                onPointerEnter={() => void preloadNewWorktreeDialog()}
                className={SIDEBAR_HEADER_ACTION}
                aria-label="Create new worktree"
                aria-keyshortcuts={createWorktreeAriaShortcut}
              >
                <Plus aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {createTooltipContent("Create new worktree", createWorktreeShortcut)}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Too narrow for "Reconnecting…" beside the title: it says it on its
          own line under the header instead of shrinking to a bare spinner. */}
      {showReconnecting && (
        <WorktreesReconnectingRow
          escalatedSince={showReconnectingEscalated ? reconnectingAt : null}
        />
      )}
      {/* Inline search bar — only when there are non-main worktrees */}
      {showControlZone && (
        <WorktreeSidebarSearchBar
          inputRef={searchInputRef}
          // ArrowDown from the field walks into the results, as it does in the
          // overview: the grid takes focus and its cursor lands on the first row.
          onArrowIntoResults={() => gridRef.current?.focus()}
          chipCounts={chipCounts}
          statusText={filterStatusText}
          filterSummaryText={activeFacetText || null}
        />
      )}
      {/* The quick-state bar belongs to the control zone, under the search it
          narrows alongside and above every card it filters, main included.
          Sitting below the main card it read as a filter on the list alone,
          and split the zone's controls around a card. */}
      {showControlZone && (
        <QuickStateFilterBar
          // The search rail's plane, so the zone is one surface on the
          // themes that tint it rather than a tinted rail over a bare bar.
          className="worktree-filter-bar shrink-0"
          value={quickStateFilter}
          onChange={setQuickStateFilter}
          counts={quickStateCounts}
          finishedUnseen={quickStateCounts.finishedUnseen}
          trailing={armMatchingButton}
        />
      )}

      {/* Both failure banners take the slot below the control zone, so a
          failure about the list reads as belonging to the list. */}
      {errorBanner}
      {worktreeLoadErrorBanner}

      {/* SR-only live region for keyboard reorder announcements. dnd-kit's
          built-in announcer can't see external mutations like Alt+Arrow, so
          announce here. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {keyboardReorderAnnouncement}
      </div>
      {/* Sibling assertive region for explicit Escape-cancel of a worktree-sort
          drag. Always mounted so the AT has registered it before the drag begins.
          Assertive priority interrupts any polite "Moved to position N" backlog
          queued from rapid Alt+Arrow reorders. */}
      <div className="sr-only" role="status" aria-live="assertive" aria-atomic="true">
        {keyboardCancelAnnouncement}
      </div>
      <span id="worktree-sidebar-grid-help" className="sr-only">
        Arrow keys move between worktrees and Enter opens one. Right arrow or F2 reaches a
        worktree's controls, Escape comes back.
      </span>
      {/* Worktree list — single role="grid" with aria-activedescendant tracking
          the active row. Single tab stop on the grid container; rows never
          take focus directly, so they can be unmounted by Virtuoso without
          stranding keyboard navigation. */}
      <div
        ref={gridRef}
        role="grid"
        aria-label="Worktrees"
        aria-describedby="worktree-sidebar-grid-help"
        aria-rowcount={ariaRowCount}
        aria-activedescendant={activeDescendantId}
        // No rows, no stop: an empty grid took focus with nothing to show it.
        tabIndex={keyboardItems.length > 0 ? 0 : -1}
        onKeyDown={handleGridKeyDown}
        onFocus={handleGridFocus}
        onFocusCapture={handleGridFocusCapture}
        className="flex flex-col flex-1 min-h-0 focus:outline-hidden"
      >
        {/* Main worktree — visible unless excluded by text search or facet filters */}
        {mainVisible && mainWorktree && (
          <div
            role="rowgroup"
            className="shrink-0"
            style={{ contentVisibility: "auto", containIntrinsicSize: "auto 180px" }}
          >
            <StaticWorktreeRow
              key={mainWorktree.id}
              worktreeId={mainWorktree.id}
              activeWorktreeId={activeWorktreeId}
              focusedWorktreeId={focusedWorktreeId}
              keyboardCursorId={keyboardCursorId}
              totalWorktreeCount={deferredWorktrees.length}
              selectWorktree={selectWorktree}
              worktreeActions={worktreeActions}
              availability={availability}
              agentSettings={agentSettings}
              homeDir={homeDir}
              ariaRowIndex={mainRowIndex}
            />
          </div>
        )}

        {/* Strong divider between pinned worktrees and scrollable list */}
        {(hasNonMainWorktrees || pendingCreationRows) && mainVisible && (
          <div role="presentation" className="shrink-0 border-b border-border-default" />
        )}

        {/* A worktree being created sits at the head of the list it will join,
            not beside the pinned main card, so the row the user is watching
            does not jump zones the moment it lands. */}
        {pendingCreationRows && (
          <div role="rowgroup" className="shrink-0">
            {pendingCreationRows}
          </div>
        )}

        {/* Virtualized non-main worktree list */}
        <div role="presentation" className="relative flex-1 min-h-0">
          {listEmpty !== null ? (
            // A row of its own, since the grid may own only rows.
            <div role="row" className="h-full">
              <div role="gridcell" className="h-full">
                <SidebarListEmptyState
                  empty={listEmpty}
                  onShowAllMatches={handleShowAllMatches}
                  onClearSearch={handleClearSearch}
                  onClearAllFilters={handleClearAllFilters}
                />
              </div>
            </div>
          ) : groupedSections ? (
            <Virtuoso<SidebarFlatItem, SidebarVirtuosoContext>
              key={virtuosoResetKey}
              initialScrollTop={virtuosoInitialScrollTop}
              ref={virtuosoRef}
              data={sidebarItems}
              context={virtuosoContext}
              overscan={SIDEBAR_VIRTUOSO_OVERSCAN_PX}
              increaseViewportBy={SIDEBAR_VIRTUOSO_OVERSCAN_PX}
              skipAnimationFrameInResizeObserver
              components={SIDEBAR_VIRTUOSO_COMPONENTS}
              computeItemKey={computeSidebarItemKey}
              itemContent={renderSidebarFlatItem}
              scrollerRef={setScrollerElement}
              onScroll={handleScroll}
              itemsRendered={handleItemsRendered}
              style={scrollerStyle}
              // `z-0` makes the scroller a stacking context, so nothing raised
              // inside a row can paint over the bands.
              className="absolute inset-0 z-0 overflow-y-auto scrollbar-none"
            />
          ) : (
            <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
              <Virtuoso<SidebarFlatItem, SidebarVirtuosoContext>
                key={virtuosoResetKey}
                initialScrollTop={virtuosoInitialScrollTop}
                ref={virtuosoRef}
                data={sidebarItems}
                context={virtuosoContext}
                overscan={SIDEBAR_VIRTUOSO_OVERSCAN_PX}
                increaseViewportBy={SIDEBAR_VIRTUOSO_OVERSCAN_PX}
                skipAnimationFrameInResizeObserver
                components={SIDEBAR_VIRTUOSO_COMPONENTS}
                computeItemKey={computeSidebarItemKey}
                itemContent={renderSidebarFlatItem}
                scrollerRef={setScrollerElement}
                onScroll={handleScroll}
                itemsRendered={handleItemsRendered}
                style={scrollerStyle}
                className="absolute inset-0 z-0 overflow-y-auto scrollbar-none"
              />
            </SortableContext>
          )}
          {/* Out of the accessibility tree on purpose: these sit inside the
              grid, where only rows may be owned, and the grid's own rows
              already carry each worktree's state. Keyboard users have the
              same reach through arrow navigation, the "Attention" segment,
              and "Focus next waiting agent". */}
          <ScrollIndicator
            direction="above"
            count={hiddenAbove.count}
            attentionCount={hiddenAbove.attention}
            problemCount={hiddenAbove.problem}
            problemTone={hiddenAbove.problemTone}
            onClick={revealAbove}
            onWheel={handleBandWheel}
            ariaHidden
            tabIndex={-1}
          />
          <ScrollIndicator
            direction="below"
            count={hiddenBelow.count}
            attentionCount={hiddenBelow.attention}
            problemCount={hiddenBelow.problem}
            problemTone={hiddenBelow.problemTone}
            onClick={revealBelow}
            onWheel={handleBandWheel}
            ariaHidden
            tabIndex={-1}
          />
        </div>
      </div>

      <ProjectHostsGroup projectId={getViewWorkspaceId()} />

      {restartConfirmDialog}
    </div>
  );
}

export { SidebarContent };
