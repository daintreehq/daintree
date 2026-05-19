import {
  Suspense,
  lazy,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { AlertTriangle, FolderOpen, LayoutGrid, Plus, RefreshCw, Zap } from "lucide-react";
import { HollowCircle } from "@/components/icons";
import { EmptyState } from "@/components/ui/EmptyState";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { Skeleton } from "@/components/ui/Skeleton";
import { ScrollIndicator } from "@/components/Worktree/ScrollIndicator";
import {
  useAgentLauncher,
  useWorktrees,
  useProjectSettings,
  useWorktreeActions,
  useAriaKeyshortcuts,
  useKeybindingDisplay,
  useDeferredLoading,
} from "@/hooks";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { WorktreeSidebarSearchBar, QuickStateFilterBar } from "@/components/Worktree";
import { getBuiltinView } from "@/registry/builtinRendererRegistry";
import type { BulkCreateWorktreeDialogProps } from "@github-renderer/components/BulkCreateWorktreeDialog";
import { FleetPickerPalette } from "@/components/Fleet/FleetPickerPalette";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useDndMonitor } from "@dnd-kit/core";
import {
  getWorktreeSortDragId,
  isWorktreeSortDragData,
} from "@/components/DragDrop/SortableWorktreeCard";
import { applyManualWorktreeReorder } from "@/lib/worktreeReorder";
import { usePanelStore, useWorktreeSelectionStore, useProjectStore } from "@/store";
import type { PendingCreation } from "@/store/worktreeStore";
import { useFleetArmingStore, collectFilterArmEligibleIds } from "@/store/fleetArmingStore";
import { useShallow } from "zustand/react/shallow";
import { systemClient } from "@/clients";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import {
  matchesFilters,
  matchesQuickStateFilter,
  sortWorktrees,
  sortWorktreesByRelevance,
  groupByType,
  findIntegrationWorktree,
  scoreWorktree,
  computeChipCounts,
  type DerivedWorktreeMeta,
  type FilterState,
} from "@/lib/worktreeFilters";
import { computeChipState } from "@/components/Worktree/utils/computeChipState";
import { parseExactNumber } from "@/lib/parseExactNumber";
import type { WorktreeState } from "@/types";
import { actionService } from "@/services/ActionService";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SidebarWorktreeRow } from "./SidebarWorktreeRow";
import { WorktreeLoadErrorBanner } from "./WorktreeLoadErrorBanner";
import { StaticWorktreeRow } from "./StaticWorktreeRow";
import { WorktreeCardPlaceholder } from "./WorktreeCardPlaceholder";
import { useScrollIndicator } from "./useScrollIndicator";
import { useRecipeDialogState } from "./useRecipeDialogState";
import { RecipeEditor } from "@/components/TerminalRecipe/RecipeEditor";
import { RecipeManager } from "@/components/TerminalRecipe/RecipeManager";
import { isAgentTerminal } from "@/utils/terminalType";
import { isTerminalVisible } from "@/lib/terminalVisibility";
import { useWorktreeIds } from "@/hooks/useTerminalSelectors";
import { logError } from "@/utils/logger";
import { useWorktreeSidebarKeyboard, type SidebarKeyboardItem } from "./useWorktreeSidebarKeyboard";
import type { UseAgentLauncherReturn } from "@/hooks/useAgentLauncher";
import type { WorktreeActions } from "@/hooks/useWorktreeActions";

export function preloadNewWorktreeDialog() {
  return import("@/components/Worktree/NewWorktreeDialog");
}
const LazyNewWorktreeDialog = lazy(() =>
  preloadNewWorktreeDialog().then((m) => ({ default: m.NewWorktreeDialog }))
);

function formatButtonTitle(label: string, shortcut?: string | null): string {
  return shortcut ? `${label} (${shortcut})` : label;
}

const NO_MATCH_QUERY_MAX = 40;

const QUICK_STATE_LABELS: Record<"working" | "waiting" | "finished", string> = {
  working: "Working",
  waiting: "Waiting",
  finished: "Finished",
};

const KEYBOARD_REORDER_ANNOUNCEMENT_DEBOUNCE_MS = 150;

// Virtuoso overscan in pixels — covers ~2–5 rows at the 120–260px height range,
// keeping useSortable hooks alive in a small window beyond the viewport so a
// dnd-kit drop target stays mounted as the user drags past it.
const SIDEBAR_VIRTUOSO_OVERSCAN_PX = 600;

// Threshold for escalating the "Reconnecting…" badge to include the time
// since data last arrived. 10s sits above the Doherty 400ms gate so the
// indicator never flickers on transient reconnects, and below the worst-case
// ~14s workspace-host restart budget so it fires before `setFatalError`.
const RECONNECT_ESCALATE_MS = 10_000;

function truncateSearchQuery(trimmedQuery: string) {
  const codepoints = Array.from(trimmedQuery);
  return codepoints.length > NO_MATCH_QUERY_MAX
    ? `${codepoints.slice(0, NO_MATCH_QUERY_MAX).join("")}…`
    : trimmedQuery;
}

interface SidebarHeaderFlatItem {
  kind: "header";
  id: string;
  type: string;
  displayName: string;
  count: number;
  ariaRowIndex: number;
}

interface SidebarRowFlatItem {
  kind: "row";
  id: string;
  worktreeId: string;
  ariaRowIndex: number;
  rowIndex: number;
  isPinned: boolean;
  mode: "sortable" | "static";
}

type SidebarFlatItem = SidebarHeaderFlatItem | SidebarRowFlatItem;

interface SidebarVirtuosoContext {
  activeWorktreeId: string | null;
  focusedWorktreeId: string | null;
  totalWorktreeCount: number;
  selectWorktree: (id: string) => void;
  worktreeActions: WorktreeActions;
  availability: UseAgentLauncherReturn["availability"];
  agentSettings: UseAgentLauncherReturn["agentSettings"];
  homeDir: string | undefined;
  dragStartOrder: string[];
  isSortDisabled: boolean;
}

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
  if (item.kind === "header") {
    return (
      <div
        role="row"
        aria-rowindex={item.ariaRowIndex}
        className="bg-daintree-sidebar border-b border-divider"
      >
        <div
          role="rowheader"
          aria-colspan={1}
          className="px-4 py-2 text-[10px] font-medium text-daintree-text/50 uppercase tracking-wide"
        >
          {item.displayName} ({item.count})
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
      totalWorktreeCount={context.totalWorktreeCount}
      selectWorktree={context.selectWorktree}
      worktreeActions={context.worktreeActions}
      availability={context.availability}
      agentSettings={context.agentSettings}
      homeDir={context.homeDir}
      dragStartOrder={context.dragStartOrder}
      isSortDisabled={context.isSortDisabled}
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
  const overviewShortcut = useKeybindingDisplay("worktree.overview");
  const refreshShortcut = useKeybindingDisplay("worktree.refresh");
  const createWorktreeShortcut = useKeybindingDisplay("worktree.createDialog.open");
  const overviewAriaShortcut = useAriaKeyshortcuts("worktree.overview");
  const refreshAriaShortcut = useAriaKeyshortcuts("worktree.refresh");
  const createWorktreeAriaShortcut = useAriaKeyshortcuts("worktree.createDialog.open");
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const scrollerElementRef = useRef<HTMLElement | null>(null);
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
    const name = worktreesRef.current.find((w) => w.id === worktreeId)?.name ?? worktreeId;
    const message = `Moved '${name}' to position ${targetIdx + 1} of ${visible.length}`;
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
      // Drop any pending 50ms cancel-announcement timer from a previous drag
      // so a rapid Escape → pickup sequence can't speak stale cancel copy on
      // top of the new drag's pickup announcement.
      if (cancelAnnouncementTimerRef.current !== null) {
        clearTimeout(cancelAnnouncementTimerRef.current);
        cancelAnnouncementTimerRef.current = null;
      }
    },
    onDragCancel({ active }) {
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
      const label = wt?.issueTitle ?? wt?.branch ?? wt?.name ?? worktreeId ?? "worktree";
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
  const { worktrees, isLoading, isReconnecting, reconnectingAt, error, refresh } = useWorktrees();
  const [bannerDismissed, setBannerDismissed] = useState(false);
  useEffect(() => {
    setBannerDismissed(false);
  }, [error]);
  const onBannerDismiss = useCallback(() => setBannerDismissed(true), []);
  worktreesRef.current = worktrees;

  // 1Hz tick that drives the escalated "Reconnecting… last updated X ago"
  // copy. The store holds the start timestamp; this state forces a render so
  // `formatRelativeTime(reconnectingAt)` recomputes against the latest clock.
  // Effect re-runs on every new disconnect via `reconnectingAt` dep, so the
  // baseline is always fresh — no stale-closure risk.
  const [, setReconnectTick] = useState(0);
  useEffect(() => {
    if (!isReconnecting || reconnectingAt == null) return;
    const id = setInterval(() => setReconnectTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [isReconnecting, reconnectingAt]);
  const showReconnectingEscalated =
    isReconnecting &&
    reconnectingAt !== null &&
    Date.now() - reconnectingAt >= RECONNECT_ESCALATE_MS;
  const deferredWorktrees = useDeferredValue(worktrees);
  const [isRefreshing, startRefreshTransition] = useTransition();
  const showRefreshSpinner = useDeferredLoading(isRefreshing, UI_DOHERTY_THRESHOLD);
  // Gate the "Reconnecting…" indicator behind the Doherty threshold so routine
  // sub-400ms port replacements don't flash the spinner. A real host crash
  // takes 2–4s to recover, well past the threshold.
  const showReconnecting = useDeferredLoading(isReconnecting, UI_DOHERTY_THRESHOLD);
  const currentProject = useProjectStore((state) => state.currentProject);
  const worktreeLoadError = useProjectStore((state) => state.worktreeLoadError);
  useProjectSettings();
  const { availability, agentSettings } = useAgentLauncher();
  const {
    activeWorktreeId,
    focusedWorktreeId,
    selectWorktree,
    createDialog,
    closeCreateDialog,
    bulkCreateDialog,
    closeBulkCreateDialog,
  } = useWorktreeSelectionStore(
    useShallow((state) => ({
      activeWorktreeId: state.activeWorktreeId,
      focusedWorktreeId: state.focusedWorktreeId,
      selectWorktree: state.selectWorktree,
      createDialog: state.createDialog,
      closeCreateDialog: state.closeCreateDialog,
      bulkCreateDialog: state.bulkCreateDialog,
      closeBulkCreateDialog: state.closeBulkCreateDialog,
    }))
  );
  // Direct subscription (no useDeferredValue) so the skeleton renders the
  // moment the dialog submits — defer would make the placeholder lag the
  // dialog close by a frame and lose the perceived-responsiveness win.
  const pendingCreations = useWorktreeSelectionStore((s) => s.pendingCreations);
  const openCreateDialog = useWorktreeSelectionStore((s) => s.openCreateDialog);
  const dismissPendingCreation = useWorktreeSelectionStore((s) => s.dismissPendingCreation);

  const handleRetryPendingCreation = useCallback(
    (pendingCreation: PendingCreation) => {
      dismissPendingCreation(pendingCreation.path);
      openCreateDialog(null, { initialBranchInput: pendingCreation.branch });
    },
    [dismissPendingCreation, openCreateDialog]
  );

  const pendingCreationRows = useMemo(() => {
    if (pendingCreations.size === 0) return null;
    return Array.from(pendingCreations.values()).map((pendingCreation) => (
      <WorktreeCardPlaceholder
        key={pendingCreation.path}
        pendingCreation={pendingCreation}
        onRetry={handleRetryPendingCreation}
        onDismiss={dismissPendingCreation}
      />
    ));
  }, [pendingCreations, handleRetryPendingCreation, dismissPendingCreation]);

  const [hasOpenedNewWorktree, setHasOpenedNewWorktree] = useState(false);
  useEffect(() => {
    if (createDialog.isOpen) setHasOpenedNewWorktree(true);
  }, [createDialog.isOpen]);

  const [isFleetPickerOpen, setIsFleetPickerOpen] = useState(false);
  const [isRestartConfirmOpen, setIsRestartConfirmOpen] = useState(false);
  const openFleetPicker = useCallback(() => setIsFleetPickerOpen(true), []);
  const closeFleetPicker = useCallback(() => setIsFleetPickerOpen(false), []);
  useEffect(() => {
    if (!error) setIsRestartConfirmOpen(false);
  }, [error]);
  const armedIds = useFleetArmingStore((s) => s.armedIds);
  const armedSize = armedIds.size;

  // Filter/sort state - destructured for stable memoization
  const {
    query,
    orderBy,
    groupByType: isGroupedByType,
    statusFilters,
    typeFilters,
    prIssueFilters,
    sessionFilters,
    activityFilters,
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
      alwaysShowActive: state.alwaysShowActive,
      alwaysShowWaiting: state.alwaysShowWaiting,
      pinnedWorktrees: state.pinnedWorktrees,
      manualOrder: state.manualOrder,
      quickStateFilter: state.quickStateFilter,
    }))
  );

  const isSortDisabledPrevRef = useRef(isGroupedByType || query.trim().length > 0);
  useEffect(() => {
    const current = isGroupedByType || query.trim().length > 0;
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
  }, [isGroupedByType, query]);

  const clearAllFilters = useWorktreeFilterStore((state) => state.clearAll);
  const hasActiveFilters = useWorktreeFilterStore((state) => state.hasActiveFilters);
  const hasFacetFilters = useWorktreeFilterStore((state) => state.hasFacetFilters);
  const hasFacetFiltersActive = hasFacetFilters();
  const activeFacetFilterCount =
    statusFilters.size +
    typeFilters.size +
    prIssueFilters.size +
    sessionFilters.size +
    activityFilters.size;
  const collapsedWorktrees = useWorktreeFilterStore((state) => state.collapsedWorktrees);
  const pruneStaleWorktreeIds = useWorktreeFilterStore((state) => state.pruneStaleWorktreeIds);
  const setQuickStateFilter = useWorktreeFilterStore((state) => state.setQuickStateFilter);

  // Terminal store: subscribe to stable primitives, then derive per-worktree
  // counts locally. Returning nested objects directly from the store selector
  // trips React's external-store snapshot guard.
  const worktreeIds = useWorktreeIds();
  const worktreeIdList = useMemo(() => deferredWorktrees.map((w) => w.id), [deferredWorktrees]);
  const panelIds = usePanelStore((state) => state.panelIds);
  const panelIdsByWorktreeId = usePanelStore((state) => state.panelIdsByWorktreeId);
  const panelsById = usePanelStore((state) => state.panelsById);
  const isInTrash = usePanelStore((state) => state.isInTrash);
  const panelStateByWorktree = useMemo(() => {
    const result: Record<
      string,
      {
        terminalCount: number;
        waitingTerminalCount: number;
        hasWorkingAgent: boolean;
        hasWaitingAgent: boolean;
        hasCompletedAgent: boolean;
        hasExitedAgent: boolean;
      }
    > = {};
    for (const worktreeId of worktreeIdList) {
      const ids = panelIdsByWorktreeId[worktreeId];
      if (!ids || ids.length === 0) {
        result[worktreeId] = {
          terminalCount: 0,
          waitingTerminalCount: 0,
          hasWorkingAgent: false,
          hasWaitingAgent: false,
          hasCompletedAgent: false,
          hasExitedAgent: false,
        };
        continue;
      }
      let terminalCount = 0;
      let waitingTerminalCount = 0;
      let hasWorkingAgent = false;
      let hasWaitingAgent = false;
      let hasCompletedAgent = false;
      let hasExitedAgent = false;
      for (const id of ids) {
        const t = panelsById[id];
        if (!t) continue;
        if (!isTerminalVisible(t, isInTrash, worktreeIds)) continue;
        terminalCount++;
        if (!isAgentTerminal(t)) continue;
        if (t.agentState === "working") hasWorkingAgent = true;
        if (t.agentState === "waiting") {
          hasWaitingAgent = true;
          waitingTerminalCount++;
        }
        if (t.agentState === "completed") hasCompletedAgent = true;
        if (t.agentState === "exited") hasExitedAgent = true;
      }
      result[worktreeId] = {
        terminalCount,
        waitingTerminalCount,
        hasWorkingAgent,
        hasWaitingAgent,
        hasCompletedAgent,
        hasExitedAgent,
      };
    }
    return result;
  }, [worktreeIdList, panelIdsByWorktreeId, panelsById, isInTrash, worktreeIds]);

  const searchInputRef = useRef<HTMLInputElement>(null);

  const {
    isRecipeEditorOpen,
    recipeEditorWorktreeId,
    recipeEditorInitialTerminals,
    recipeEditorDefaultScope,
    recipeManagerEdit,
    isRecipeManagerOpen,
    handleOpenRecipeEditor,
    handleCloseRecipeEditor,
    handleCloseRecipeManager,
    handleRecipeManagerEdit,
    handleRecipeManagerCreate,
  } = useRecipeDialogState();

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

  const setManualOrder = useWorktreeFilterStore((state) => state.setManualOrder);

  // Clean up stale pinned and collapsed worktrees in a single store write so
  // pin/collapse pruning costs one persist flush, not N.
  useEffect(() => {
    if (pinnedWorktrees.length === 0 && collapsedWorktrees.length === 0) return;
    const existingIds = new Set(worktrees.map((w) => w.id));
    const hasStalePin = pinnedWorktrees.some((id) => !existingIds.has(id));
    const hasStaleCollapsed = collapsedWorktrees.some((id) => !existingIds.has(id));
    if (!hasStalePin && !hasStaleCollapsed) return;
    pruneStaleWorktreeIds(existingIds);
  }, [worktrees, pinnedWorktrees, collapsedWorktrees, pruneStaleWorktreeIds]);

  // Clean up stale manual order entries
  useEffect(() => {
    if (manualOrder.length === 0) return;
    const existingIds = new Set(worktrees.map((w) => w.id));
    const cleaned = manualOrder.filter((id) => existingIds.has(id));
    if (cleaned.length !== manualOrder.length) {
      setManualOrder(cleaned);
    }
  }, [worktrees, manualOrder, setManualOrder]);

  // Compute derived metadata for each worktree. Panel scan is delegated to the
  // single-pass `panelStateByWorktree` selector above, so this useMemo only
  // joins per-worktree state with worktree-level fields and chip computation.
  const derivedMetaMap = useMemo(() => {
    const map = new Map<string, DerivedWorktreeMeta>();
    for (const worktree of deferredWorktrees) {
      const panelState = panelStateByWorktree[worktree.id] ?? {
        terminalCount: 0,
        waitingTerminalCount: 0,
        hasWorkingAgent: false,
        hasWaitingAgent: false,
        hasCompletedAgent: false,
        hasExitedAgent: false,
      };

      // chipState logic mirrors useWorktreeStatus.ts — keep in sync
      const hasChanges = (worktree.worktreeChanges?.changedFileCount ?? 0) > 0;
      const isComplete =
        !!worktree.issueNumber &&
        !!worktree.linked?.pr &&
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
        waitingTerminalCount: panelState.waitingTerminalCount,
        lifecycleStage,
        isComplete,
        hasActiveAgent: panelState.hasWorkingAgent,
      });

      map.set(worktree.id, {
        terminalCount: panelState.terminalCount,
        hasWorkingAgent: panelState.hasWorkingAgent,
        hasWaitingAgent: panelState.hasWaitingAgent,
        hasCompletedAgent: panelState.hasCompletedAgent,
        hasExitedAgent: panelState.hasExitedAgent,
        hasMergeConflict:
          worktree.worktreeChanges?.changes.some((c) => c.status === "conflicted") ?? false,
        chipState,
      });
    }
    return map;
  }, [deferredWorktrees, panelStateByWorktree]);

  // Apply filters and sorting
  const mainWorktree = useMemo(
    () => deferredWorktrees.find((w) => w.isMainWorktree) ?? deferredWorktrees[0] ?? null,
    [deferredWorktrees]
  );

  const integrationWorktree = useMemo(
    () => findIntegrationWorktree(deferredWorktrees, mainWorktree?.id),
    [deferredWorktrees, mainWorktree]
  );

  const quickStateCounts = useMemo(() => {
    const counts = { all: 0, working: 0, waiting: 0, finished: 0 };
    for (const w of deferredWorktrees) {
      if (w.id === mainWorktree?.id || w.id === integrationWorktree?.id) continue;
      counts.all++;
      const meta = derivedMetaMap.get(w.id);
      if (!meta) continue;
      if (matchesQuickStateFilter("working", meta)) counts.working++;
      if (matchesQuickStateFilter("waiting", meta)) counts.waiting++;
      if (matchesQuickStateFilter("finished", meta)) counts.finished++;
    }
    return counts;
  }, [deferredWorktrees, derivedMetaMap, mainWorktree, integrationWorktree]);

  const chipCounts = useMemo(() => {
    const nonMain = deferredWorktrees.filter(
      (w) => w.id !== mainWorktree?.id && w.id !== integrationWorktree?.id
    );
    return computeChipCounts(nonMain, derivedMetaMap, activeWorktreeId, {
      query,
      statusFilters,
      typeFilters,
      prIssueFilters,
      sessionFilters,
      activityFilters,
    });
  }, [
    deferredWorktrees,
    derivedMetaMap,
    mainWorktree,
    integrationWorktree,
    activeWorktreeId,
    query,
    statusFilters,
    typeFilters,
    prIssueFilters,
    sessionFilters,
    activityFilters,
  ]);

  const mainWorktreeAggregateCounts = useMemo(() => {
    const nonMainCount = deferredWorktrees.length - 1 - (integrationWorktree ? 1 : 0);
    if (
      nonMainCount === 0 &&
      quickStateCounts.working === 0 &&
      quickStateCounts.waiting === 0 &&
      quickStateCounts.finished === 0
    ) {
      return undefined;
    }
    return {
      worktrees: nonMainCount,
      working: quickStateCounts.working,
      waiting: quickStateCounts.waiting,
      finished: quickStateCounts.finished,
    };
  }, [deferredWorktrees.length, integrationWorktree, quickStateCounts]);

  const { filteredWorktrees, groupedSections, hasResultsWithoutQuickState, totalCount } =
    useMemo(() => {
      const filters: FilterState = {
        query,
        statusFilters,
        typeFilters,
        prIssueFilters,
        sessionFilters,
        activityFilters,
      };

      // Filter non-main worktrees only (exclude main and integration by ID)
      const nonMain = deferredWorktrees.filter(
        (w) => w.id !== mainWorktree?.id && w.id !== integrationWorktree?.id
      );
      let withoutQuickStateMatch = false;
      const filtered = nonMain.filter((worktree) => {
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

        // Counterfactual: would this worktree be visible if the quick state
        // filter were "all"? Mirrors the same precedence below (active /
        // waiting bypasses → matchesFilters), with quickStateFilter forced
        // to "all". Short-circuit once we find any match — only the boolean
        // matters for the empty-state branch.
        if (!withoutQuickStateMatch && quickStateFilter !== "all") {
          if (alwaysShowActive && isActive && !hasActiveQuery && !hasFacetFiltersActive) {
            withoutQuickStateMatch = true;
          } else if (
            alwaysShowWaiting &&
            derived.hasWaitingAgent &&
            !hasActiveQuery &&
            !hasFacetFiltersActive
          ) {
            withoutQuickStateMatch = true;
          } else if (matchesFilters(worktree, filters, derived, isActive)) {
            withoutQuickStateMatch = true;
          }
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

        return matchesFilters(worktree, filters, derived, isActive);
      });

      const existingWorktreeIds = new Set(deferredWorktrees.map((w) => w.id));
      const validPinnedWorktrees = pinnedWorktrees.filter((id) => existingWorktreeIds.has(id));

      const hasQuery = query.trim().length > 0;
      const sorted = hasQuery
        ? sortWorktreesByRelevance(filtered, query, orderBy, validPinnedWorktrees, manualOrder)
        : sortWorktrees(filtered, orderBy, validPinnedWorktrees, manualOrder);

      if (isGroupedByType && !hasQuery) {
        return {
          filteredWorktrees: sorted,
          groupedSections: groupByType(sorted, orderBy, validPinnedWorktrees),
          hasResultsWithoutQuickState: withoutQuickStateMatch,
          totalCount: nonMain.length,
        };
      }

      return {
        filteredWorktrees: sorted,
        groupedSections: null,
        hasResultsWithoutQuickState: withoutQuickStateMatch,
        totalCount: nonMain.length,
      };
    }, [
      deferredWorktrees,
      query,
      orderBy,
      isGroupedByType,
      statusFilters,
      typeFilters,
      prIssueFilters,
      sessionFilters,
      activityFilters,
      alwaysShowActive,
      alwaysShowWaiting,
      pinnedWorktrees,
      manualOrder,
      mainWorktree,
      integrationWorktree,
      derivedMetaMap,
      activeWorktreeId,
      quickStateFilter,
      hasFacetFiltersActive,
    ]);

  const {
    hiddenAbove,
    hiddenBelow,
    scrollToTop,
    scrollToBottom,
    scrollerRef: scrollIndicatorScrollerRef,
    handleScroll,
  } = useScrollIndicator({
    itemCount: filteredWorktrees.length,
  });

  const setScrollerElement = useCallback(
    (el: HTMLElement | Window | null) => {
      scrollerElementRef.current = el instanceof HTMLElement ? el : null;
      scrollIndicatorScrollerRef(el);
    },
    [scrollIndicatorScrollerRef]
  );

  const worktreeActions = useWorktreeActions({
    onOpenRecipeEditor: handleOpenRecipeEditor,
  });

  const sortableIds = useMemo(
    () => filteredWorktrees.map((w) => getWorktreeSortDragId(w.id)),
    [filteredWorktrees]
  );

  const dragStartOrder = useMemo(() => filteredWorktrees.map((w) => w.id), [filteredWorktrees]);
  dragStartOrderRef.current = dragStartOrder;

  // Drop a pending reorder announcement if the sidebar unmounts mid-key-repeat.
  useEffect(() => {
    return () => {
      if (reorderAnnouncementTimerRef.current !== null) {
        clearTimeout(reorderAnnouncementTimerRef.current);
      }
    };
  }, []);

  // Fleet-eligible terminals inside the currently visible worktrees, split so an
  // arm/disarm elsewhere only re-walks the unarmed tally rather than re-scanning
  // every panel. Drives the QuickStateFilterBar arm affordance.
  const filterArmEligibleIds = useMemo(
    () =>
      collectFilterArmEligibleIds(
        filteredWorktrees.map((w) => w.id),
        panelIds,
        panelsById
      ),
    [filteredWorktrees, panelIds, panelsById]
  );
  const filterArmUnarmedCount = useMemo(() => {
    let unarmed = 0;
    for (const id of filterArmEligibleIds) {
      if (!armedIds.has(id)) unarmed++;
    }
    return unarmed;
  }, [filterArmEligibleIds, armedIds]);

  // -------------------------------------------------------------------------
  // Pre-render index + visibility computations — these are pure derivations,
  // but they're hoisted above the early returns below so the hook calls that
  // depend on them (sidebarItems memo, useWorktreeSidebarKeyboard) can stay
  // in a single, render-order-stable position. Without this hoist the hooks
  // would sit after `if (isLoading) return …`, breaking rules-of-hooks.
  const worktreeMatchesQueryPre = (w: WorktreeState) => {
    if (!query) return true;
    const exactNum = parseExactNumber(query);
    if (exactNum !== null) {
      return w.issueNumber === exactNum || w.linked?.pr?.ref.number === exactNum;
    }
    return scoreWorktree(w, query) > 0;
  };

  const pinnedFiltersPre: FilterState = {
    query,
    statusFilters,
    typeFilters,
    prIssueFilters,
    sessionFilters,
    activityFilters,
  };

  const mainMatchesQueryPre = mainWorktree && worktreeMatchesQueryPre(mainWorktree);
  const mainMatchesFacetsPre =
    !hasFacetFiltersActive ||
    (mainWorktree &&
      matchesFilters(
        mainWorktree,
        pinnedFiltersPre,
        derivedMetaMap.get(mainWorktree.id) ?? {
          terminalCount: 0,
          hasWorkingAgent: false,
          hasWaitingAgent: false,
          hasCompletedAgent: false,
          hasExitedAgent: false,
          hasMergeConflict: false,
          chipState: null,
        },
        mainWorktree.id === activeWorktreeId
      ));
  const mainVisible = mainMatchesQueryPre && mainMatchesFacetsPre;

  const integrationMatchesQueryPre =
    integrationWorktree && worktreeMatchesQueryPre(integrationWorktree);
  const integrationMatchesFacetsPre =
    !hasFacetFiltersActive ||
    (integrationWorktree &&
      matchesFilters(
        integrationWorktree,
        pinnedFiltersPre,
        derivedMetaMap.get(integrationWorktree.id) ?? {
          terminalCount: 0,
          hasWorkingAgent: false,
          hasWaitingAgent: false,
          hasCompletedAgent: false,
          hasExitedAgent: false,
          hasMergeConflict: false,
          chipState: null,
        },
        integrationWorktree.id === activeWorktreeId
      ));
  const integrationVisible = integrationMatchesQueryPre && integrationMatchesFacetsPre;

  const hasQuery = query.trim().length > 0;
  const isSortDisabled = isGroupedByType || hasQuery;
  isSortDisabledRef.current = isSortDisabled;

  const mainRowIndex = mainVisible ? 1 : 0;
  const integrationRowIndex = integrationVisible ? mainRowIndex + 1 : mainRowIndex;
  const firstScrollableRowIndex = integrationRowIndex + 1;

  // Total rows in the grid — pinned rows + group header rows + data rows.
  // Group header rows count toward aria-rowcount because they carry role="row".
  const ariaRowCount =
    integrationRowIndex +
    (groupedSections
      ? groupedSections.reduce((n, s) => n + 1 + s.worktrees.length, 0)
      : filteredWorktrees.length);

  // Build the flat item array that drives the virtualized scroll region. The
  // grouped path interleaves sticky header sentinels with static rows; the
  // ungrouped path emits sortable rows so dnd-kit's SortableContext can
  // wrap the whole Virtuoso surface.
  const sidebarItems = useMemo<SidebarFlatItem[]>(() => {
    const items: SidebarFlatItem[] = [];
    let nextRowIndex = firstScrollableRowIndex;
    if (groupedSections) {
      for (const section of groupedSections) {
        items.push({
          kind: "header",
          id: `header-${section.type}`,
          type: section.type,
          displayName: section.displayName,
          count: section.worktrees.length,
          ariaRowIndex: nextRowIndex++,
        });
        for (const w of section.worktrees) {
          items.push({
            kind: "row",
            id: `row-${w.id}`,
            worktreeId: w.id,
            ariaRowIndex: nextRowIndex++,
            rowIndex: dragStartOrder.indexOf(w.id),
            isPinned: pinnedWorktrees.includes(w.id),
            mode: "static",
          });
        }
      }
    } else {
      for (let i = 0; i < filteredWorktrees.length; i++) {
        const w = filteredWorktrees[i]!;
        items.push({
          kind: "row",
          id: `row-${w.id}`,
          worktreeId: w.id,
          ariaRowIndex: nextRowIndex++,
          rowIndex: i,
          isPinned: pinnedWorktrees.includes(w.id),
          mode: "sortable",
        });
      }
    }
    return items;
  }, [
    groupedSections,
    filteredWorktrees,
    firstScrollableRowIndex,
    pinnedWorktrees,
    dragStartOrder,
  ]);

  // The pinned main + integration rows live OUTSIDE the Virtuoso surface but
  // INSIDE the role="grid" container, so keyboard navigation must visit them
  // before descending into the virtualized list. They carry isPinned so the
  // hook skips scrollToIndex (they're always rendered, never windowed).
  const keyboardItems = useMemo<SidebarKeyboardItem[]>(() => {
    const items: SidebarKeyboardItem[] = [];
    if (mainVisible && mainWorktree) {
      items.push({ kind: "row", worktreeId: mainWorktree.id, isPinned: true });
    }
    if (integrationVisible && integrationWorktree) {
      items.push({ kind: "row", worktreeId: integrationWorktree.id, isPinned: true });
    }
    for (const item of sidebarItems) {
      items.push(
        item.kind === "row" ? { kind: "row", worktreeId: item.worktreeId } : { kind: "header" }
      );
    }
    return items;
  }, [sidebarItems, mainVisible, mainWorktree, integrationVisible, integrationWorktree]);

  const {
    gridRef,
    activeDescendantId,
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
      totalWorktreeCount: deferredWorktrees.length,
      selectWorktree,
      worktreeActions,
      availability,
      agentSettings,
      homeDir,
      dragStartOrder,
      isSortDisabled,
    }),
    [
      activeWorktreeId,
      focusedWorktreeId,
      deferredWorktrees.length,
      selectWorktree,
      worktreeActions,
      availability,
      agentSettings,
      homeDir,
      dragStartOrder,
      isSortDisabled,
    ]
  );

  // Hoisted before early returns so the dialog still mounts when the zero-
  // worktrees branch fires — its empty-state nudge dispatches
  // worktree.createDialog.open and the dialog has nowhere else to live.
  const dialogRootPath = currentProject?.path ?? "";
  const newWorktreeDialogElement = dialogRootPath &&
    (createDialog.isOpen || hasOpenedNewWorktree) && (
      <ErrorBoundary
        variant="component"
        componentName="NewWorktreeDialog"
        resetKeys={[Number(createDialog.isOpen)]}
      >
        <Suspense fallback={null}>
          <LazyNewWorktreeDialog
            isOpen={createDialog.isOpen}
            onClose={closeCreateDialog}
            rootPath={dialogRootPath}
            onWorktreeCreated={(worktreeId) => {
              refresh();
              createDialog.onCreated?.(worktreeId);
            }}
            initialIssue={createDialog.initialIssue}
            initialPR={createDialog.initialPR}
            initialRecipeId={createDialog.initialRecipeId}
            initialBranchInput={createDialog.initialBranchInput}
          />
        </Suspense>
      </ErrorBoundary>
    );

  // Hoisted before the early returns so the failed-switch banner (#8400)
  // surfaces regardless of which loading/empty/error branch the sidebar is in
  // — when a switch's worktree load throws, the store stays empty so every
  // other branch would otherwise show no trace of the failure.
  const worktreeLoadErrorBanner = worktreeLoadError ? (
    <WorktreeLoadErrorBanner error={worktreeLoadError} />
  ) : null;

  // Workspace-service error banner overlays cached data so the user can keep
  // working through transient poll failures. Hoisted before the early returns
  // so a `setFatalError` that fires before the first snapshot is still
  // actionable from the zero-worktrees branch — its only recovery path is the
  // banner's "Restart Service" button.
  const errorBanner =
    error !== null && !bannerDismissed ? (
      <InlineStatusBanner
        icon={AlertTriangle}
        title="Workspace service unavailable"
        contextLine={error}
        severity="warning"
        role="status"
        ariaLive="polite"
        onClose={onBannerDismiss}
        closeAriaLabel="Dismiss error"
        actions={[
          {
            id: "restart-workspace-service",
            label: "Restart Service",
            variant: "primary",
            onClick: () => setIsRestartConfirmOpen(true),
          },
        ]}
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

  if (isLoading && worktrees.length === 0) {
    return (
      <div className="flex flex-col h-full">
        {worktreeLoadErrorBanner}
        <div className="flex items-center px-4 py-4 border-b border-divider shrink-0">
          <h2 className="text-daintree-text font-semibold text-sm tracking-wide">Worktrees</h2>
        </div>
        <Skeleton label="Loading worktrees">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              aria-hidden="true"
              className="border-b border-border-default px-4 py-3 flex flex-col gap-1.5"
            >
              <div className="h-3.5 w-2/3 bg-muted rounded animate-pulse-delayed" />
              <div className="h-3 w-1/3 bg-muted rounded animate-pulse-delayed" />
            </div>
          ))}
        </Skeleton>
      </div>
    );
  }

  if (worktrees.length === 0) {
    return (
      <>
        <div className="flex flex-col h-full">
          {worktreeLoadErrorBanner}
          <div className="flex items-center px-4 py-4 border-b border-divider shrink-0">
            <h2 className="text-daintree-text font-semibold text-sm tracking-wide">Worktrees</h2>
          </div>
          {errorBanner}

          {/* A failed load already has an open project — the "Open a Git
              repository" nudge would contradict the banner, so the banner
              stands alone as the actionable state. */}
          {!worktreeLoadError && (
            <EmptyState
              variant="zero-data"
              scale="sidebar"
              icon={<FolderOpen />}
              title="Open a Git repository to get started"
              action={
                <span className="text-xs text-daintree-text/50">
                  Use{" "}
                  <kbd className="px-1.5 py-0.5 bg-tint/[0.06] rounded text-xs">
                    File → Open Directory
                  </kbd>
                </span>
              }
              className="flex-1"
            />
          )}
        </div>
        {newWorktreeDialogElement}
        {restartConfirmDialog}
      </>
    );
  }

  const hasNonMainWorktrees = deferredWorktrees.length > 1;
  const hasFilters = hasActiveFilters();
  const showQuickStateEmptyState =
    filteredWorktrees.length === 0 &&
    quickStateFilter !== "all" &&
    hasResultsWithoutQuickState &&
    hasNonMainWorktrees;

  // Compact arm affordance pinned to the QuickStateFilterBar's trailing edge —
  // replaces the former full-width banner button. Enabled whenever the visible
  // worktrees still hold unarmed fleet-eligible terminals; with "All" selected
  // and no filters that means "arm everything". Otherwise it rests dimmed and
  // disabled so the layout stays stable and the affordance stays discoverable.
  const filterArmEligibleCount = filterArmEligibleIds.length;
  const canArmMatching = filterArmUnarmedCount > 0;
  const armNoun = filterArmUnarmedCount === 1 ? "terminal" : "terminals";
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
        ? "No arm-eligible terminals match the filter"
        : "No arm-eligible terminals"
      : hasFilters
        ? "All matching terminals are armed"
        : "All terminals are armed";
  const armMatchingButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-disabled={!canArmMatching || undefined}
          onClick={() => {
            if (!canArmMatching) return;
            actionService.dispatch(
              "fleet.armMatchingFilter",
              { worktreeIds: filteredWorktrees.map((w) => w.id) },
              { source: "user" }
            );
          }}
          className={`inline-flex items-center justify-center self-stretch px-1.5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-daintree-accent ${
            canArmMatching
              ? "text-category-blue hover:text-category-blue/80 hover:bg-tint/[0.06]"
              : "text-daintree-text/25 cursor-not-allowed"
          }`}
          aria-label={armMatchingLabel}
        >
          <Zap className="w-3 h-3" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{armMatchingLabel}</TooltipContent>
    </Tooltip>
  );
  const filteredCount = filteredWorktrees.length;
  const showScope = hasActiveFilters() && filteredCount !== totalCount;
  const dragDisabledReason = hasQuery
    ? "Sorting disabled while searching"
    : isGroupedByType
      ? "Sorting disabled while grouped by type"
      : null;

  return (
    <div className="flex flex-col h-full">
      {worktreeLoadErrorBanner}
      {/* Header Section */}
      <div className="group/header flex items-center justify-between px-4 py-2 border-b border-divider bg-transparent shrink-0">
        <div className="flex items-baseline gap-1.5">
          <h2 className="text-daintree-text font-semibold text-sm tracking-wide">Worktrees</h2>
          {showReconnecting && (
            <span
              role="status"
              aria-live="polite"
              className="flex items-center gap-1 text-daintree-text/60 text-xs"
              data-reconnect-escalated={showReconnectingEscalated ? "true" : undefined}
            >
              <RefreshCw className="w-3 h-3 animate-spin" aria-hidden="true" />
              {showReconnectingEscalated && reconnectingAt !== null
                ? `Reconnecting… last updated ${formatRelativeTime(reconnectingAt)}`
                : "Reconnecting…"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <div className="invisible opacity-0 pointer-events-none transition-[opacity,visibility] duration-150 delay-75 group-hover/header:visible group-hover/header:opacity-100 group-hover/header:pointer-events-auto group-hover/header:delay-75 group-focus-within/header:visible group-focus-within/header:opacity-100 group-focus-within/header:pointer-events-auto group-focus-within/header:delay-75 motion-reduce:transition-none flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setQuickStateFilter("working");
                onOpenOverview();
              }}
              className="p-1 text-daintree-text/40 hover:text-[var(--color-state-working)] hover:bg-tint/[0.06] rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
              aria-label="View working worktrees"
              title="View working worktrees"
            >
              <HollowCircle className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                setQuickStateFilter("waiting");
                onOpenOverview();
              }}
              className="p-1 text-daintree-text/40 hover:text-status-warning hover:bg-tint/[0.06] rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
              aria-label="View waiting worktrees"
              title="View waiting worktrees"
            >
              <HollowCircle className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={onOpenOverview}
              className="p-1 text-daintree-text/40 hover:text-daintree-text hover:bg-tint/[0.06] rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
              aria-label="Open worktrees overview"
              aria-keyshortcuts={overviewAriaShortcut}
              title={formatButtonTitle("Open worktrees overview", overviewShortcut)}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={openFleetPicker}
              className="p-1 text-daintree-text/40 hover:text-daintree-text hover:bg-tint/[0.06] rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
              aria-label="Select terminals to arm"
              title="Select terminals to arm"
            >
              <Zap className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleRefreshAll}
              disabled={isRefreshing}
              className="p-1 text-daintree-text/40 hover:text-daintree-text hover:bg-tint/[0.06] rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-daintree-text/40"
              aria-label="Refresh sidebar"
              aria-keyshortcuts={refreshAriaShortcut}
              title={formatButtonTitle("Refresh sidebar", refreshShortcut)}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${showRefreshSpinner ? "animate-spin" : ""}`} />
            </button>
          </div>
          <button
            type="button"
            onClick={() =>
              actionService.dispatch("worktree.createDialog.open", undefined, {
                source: "user",
              })
            }
            onPointerEnter={() => void preloadNewWorktreeDialog()}
            className="p-1 text-daintree-text/60 hover:text-daintree-text hover:bg-tint/[0.06] rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
            aria-label="Create new worktree"
            aria-keyshortcuts={createWorktreeAriaShortcut}
            title={formatButtonTitle("Create new worktree", createWorktreeShortcut)}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Filter scope and sort-disabled status */}
      <div className="px-4 min-h-5 shrink-0">
        {(showScope || dragDisabledReason) && (
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="text-xs text-daintree-text/50 leading-5"
          >
            {showScope && (
              <span>
                {filteredCount} of {totalCount} worktrees
              </span>
            )}
            {showScope && dragDisabledReason && <span> · </span>}
            {dragDisabledReason && <span>{dragDisabledReason}</span>}
          </div>
        )}
      </div>

      {/* Inline search bar — only when there are non-main worktrees */}
      {hasNonMainWorktrees && (
        <WorktreeSidebarSearchBar inputRef={searchInputRef} chipCounts={chipCounts} />
      )}

      {errorBanner}

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
      {/* Worktree list — single role="grid" with aria-activedescendant tracking
          the active row. Single tab stop on the grid container; rows never
          take focus directly, so they can be unmounted by Virtuoso without
          stranding keyboard navigation. */}
      <div
        ref={gridRef}
        role="grid"
        aria-label="Worktrees"
        aria-rowcount={ariaRowCount}
        aria-activedescendant={activeDescendantId}
        tabIndex={0}
        onKeyDown={handleGridKeyDown}
        onFocus={handleGridFocus}
        onFocusCapture={handleGridFocusCapture}
        className="flex flex-col flex-1 min-h-0 focus:outline-hidden"
      >
        {/* Main worktree — visible unless excluded by text search or facet filters */}
        {mainVisible && (
          <div
            className="shrink-0"
            style={{ contentVisibility: "auto", containIntrinsicSize: "auto 180px" }}
          >
            <StaticWorktreeRow
              key={mainWorktree.id}
              worktreeId={mainWorktree.id}
              activeWorktreeId={activeWorktreeId}
              focusedWorktreeId={focusedWorktreeId}
              totalWorktreeCount={deferredWorktrees.length}
              selectWorktree={selectWorktree}
              worktreeActions={worktreeActions}
              availability={availability}
              agentSettings={agentSettings}
              homeDir={homeDir}
              aggregateCounts={mainWorktreeAggregateCounts}
              ariaRowIndex={mainRowIndex}
            />
          </div>
        )}

        {/* Integration branch (develop/trunk/next) — pinned below main, subject to text search and facet filters */}
        {integrationVisible && (
          <div
            className="shrink-0"
            style={{ contentVisibility: "auto", containIntrinsicSize: "auto 180px" }}
          >
            <StaticWorktreeRow
              key={integrationWorktree.id}
              worktreeId={integrationWorktree.id}
              activeWorktreeId={activeWorktreeId}
              focusedWorktreeId={focusedWorktreeId}
              totalWorktreeCount={deferredWorktrees.length}
              selectWorktree={selectWorktree}
              worktreeActions={worktreeActions}
              availability={availability}
              agentSettings={agentSettings}
              homeDir={homeDir}
              ariaRowIndex={integrationRowIndex}
            />
          </div>
        )}

        {pendingCreationRows && <div className="shrink-0">{pendingCreationRows}</div>}

        {/* Strong divider between pinned worktrees and scrollable list */}
        {hasNonMainWorktrees && <div className="shrink-0 border-b border-border-default" />}

        {hasNonMainWorktrees && (
          <QuickStateFilterBar
            value={quickStateFilter}
            onChange={setQuickStateFilter}
            counts={quickStateCounts}
            trailing={armMatchingButton}
          />
        )}

        {/* Virtualized non-main worktree list */}
        <div className="relative flex-1 min-h-0">
          {showQuickStateEmptyState && !hasFacetFiltersActive && !hasQuery ? (
            <EmptyState variant="user-cleared" scale="sidebar" title="All caught up" />
          ) : showQuickStateEmptyState && hasFacetFiltersActive ? (
            <EmptyState
              variant="filtered-empty"
              scale="sidebar"
              instant
              title={`No worktrees match ${QUICK_STATE_LABELS[quickStateFilter]} with ${activeFacetFilterCount} ${
                activeFacetFilterCount === 1 ? "filter" : "filters"
              }`}
              action={
                <>
                  <button
                    type="button"
                    onClick={clearAllFilters}
                    className="text-xs px-3 py-1.5 text-daintree-text/60 hover:text-daintree-text hover:bg-overlay-soft rounded transition-colors"
                  >
                    Show all worktrees
                  </button>
                  <button
                    type="button"
                    onClick={onOpenOverview}
                    className="text-xs px-3 py-1.5 text-daintree-text/60 hover:text-daintree-text hover:bg-overlay-soft rounded transition-colors ml-1"
                    title={formatButtonTitle("Open overview", overviewShortcut)}
                    aria-keyshortcuts={overviewAriaShortcut}
                  >
                    Open overview
                  </button>
                </>
              }
            />
          ) : filteredWorktrees.length === 0 &&
            hasFilters &&
            hasNonMainWorktrees &&
            !(mainVisible || integrationVisible) ? (
            <EmptyState
              variant="filtered-empty"
              scale="sidebar"
              instant
              title={
                hasQuery
                  ? `No matches for "${truncateSearchQuery(query.trim())}"`
                  : "No matching worktrees"
              }
              action={
                <>
                  <button
                    type="button"
                    onClick={clearAllFilters}
                    className="text-xs px-3 py-1.5 text-daintree-text/60 hover:text-daintree-text hover:bg-overlay-soft rounded transition-colors"
                  >
                    Show all worktrees
                  </button>
                  <button
                    type="button"
                    onClick={onOpenOverview}
                    className="text-xs px-3 py-1.5 text-daintree-text/60 hover:text-daintree-text hover:bg-overlay-soft rounded transition-colors ml-1"
                    title={formatButtonTitle("Open overview", overviewShortcut)}
                    aria-keyshortcuts={overviewAriaShortcut}
                  >
                    Open overview
                  </button>
                </>
              }
            />
          ) : groupedSections ? (
            <Virtuoso<SidebarFlatItem, SidebarVirtuosoContext>
              ref={virtuosoRef}
              data={sidebarItems}
              context={virtuosoContext}
              overscan={SIDEBAR_VIRTUOSO_OVERSCAN_PX}
              increaseViewportBy={SIDEBAR_VIRTUOSO_OVERSCAN_PX}
              skipAnimationFrameInResizeObserver
              computeItemKey={computeSidebarItemKey}
              itemContent={renderSidebarFlatItem}
              scrollerRef={setScrollerElement}
              onScroll={handleScroll}
              className="absolute inset-0 overflow-y-auto scrollbar-none"
            />
          ) : (
            <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
              <Virtuoso<SidebarFlatItem, SidebarVirtuosoContext>
                ref={virtuosoRef}
                data={sidebarItems}
                context={virtuosoContext}
                overscan={SIDEBAR_VIRTUOSO_OVERSCAN_PX}
                increaseViewportBy={SIDEBAR_VIRTUOSO_OVERSCAN_PX}
                skipAnimationFrameInResizeObserver
                computeItemKey={computeSidebarItemKey}
                itemContent={renderSidebarFlatItem}
                scrollerRef={setScrollerElement}
                onScroll={handleScroll}
                className="absolute inset-0 overflow-y-auto scrollbar-none"
              />
            </SortableContext>
          )}
          <ScrollIndicator
            direction="above"
            count={hiddenAbove}
            onClick={scrollToTop}
            ariaHidden
            tabIndex={-1}
          />
          <ScrollIndicator
            direction="below"
            count={hiddenBelow}
            onClick={scrollToBottom}
            ariaHidden
            tabIndex={-1}
          />
        </div>
      </div>

      <ErrorBoundary
        variant="component"
        componentName="RecipeEditor"
        resetKeys={[Number(isRecipeEditorOpen)]}
      >
        <RecipeEditor
          recipe={recipeManagerEdit}
          worktreeId={recipeEditorWorktreeId}
          initialTerminals={recipeEditorInitialTerminals}
          defaultScope={recipeEditorDefaultScope}
          isOpen={isRecipeEditorOpen}
          onClose={handleCloseRecipeEditor}
        />
      </ErrorBoundary>

      <ErrorBoundary
        variant="component"
        componentName="RecipeManager"
        resetKeys={[Number(isRecipeManagerOpen)]}
      >
        <RecipeManager
          isOpen={isRecipeManagerOpen}
          onClose={handleCloseRecipeManager}
          onEditRecipe={handleRecipeManagerEdit}
          onCreateRecipe={handleRecipeManagerCreate}
        />
      </ErrorBoundary>

      {newWorktreeDialogElement}

      <ErrorBoundary
        variant="component"
        componentName="BulkCreateWorktreeDialog"
        resetKeys={[Number(bulkCreateDialog.isOpen)]}
      >
        {(() => {
          const BulkCreateWorktreeDialog = getBuiltinView<BulkCreateWorktreeDialogProps>(
            "github.bulkCreateWorktreeDialog"
          );
          if (!BulkCreateWorktreeDialog) return null;
          return (
            <BulkCreateWorktreeDialog
              isOpen={bulkCreateDialog.isOpen}
              onClose={closeBulkCreateDialog}
              mode={bulkCreateDialog.mode}
              selectedIssues={bulkCreateDialog.selectedIssues}
              selectedPRs={bulkCreateDialog.selectedPRs}
              onComplete={closeBulkCreateDialog}
            />
          );
        })()}
      </ErrorBoundary>

      <ErrorBoundary
        variant="component"
        componentName="FleetPickerPalette"
        resetKeys={[Number(isFleetPickerOpen)]}
      >
        <FleetPickerPalette isOpen={isFleetPickerOpen} onClose={closeFleetPicker} />
      </ErrorBoundary>

      {restartConfirmDialog}
    </div>
  );
}

export { SidebarContent };
