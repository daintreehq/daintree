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
import { AlertTriangle, FolderOpen, LayoutGrid, Plus, RefreshCw, Zap } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { ScrollIndicator } from "@/components/Worktree/ScrollIndicator";
import {
  useAgentLauncher,
  useWorktrees,
  useProjectSettings,
  useWorktreeActions,
  useAriaKeyshortcuts,
  useKeybindingDisplay,
  useDohertyGate,
  useKeepMounted,
} from "@/hooks";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { WorktreeSidebarSearchBar, QuickStateFilterBar } from "@/components/Worktree";
import { useBuiltinView } from "@/registry/builtinRendererRegistry";
import type { ForgeBulkCreateWorktreeDialogProps } from "@/types/forgeSlotProps";
import { useResolvedForgeProvider } from "@/hooks/useResolvedForgeProvider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useDndMonitor } from "@dnd-kit/core";
import {
  getWorktreeSortDragId,
  isWorktreeSortDragData,
} from "@/components/DragDrop/SortableWorktreeCard";
import { applyManualWorktreeReorder } from "@/lib/worktreeReorder";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { cn } from "@/lib/utils";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { usePanelStore, useWorktreeSelectionStore, useProjectStore } from "@/store";
import type { PendingCreation, DeletedWorktree } from "@/store/worktreeStore";
import {
  recordSidebarWorktreeOrder,
  DELETED_WORKTREE_GROUP_THRESHOLD,
} from "@/store/worktreeStore";
import { planDeletedWorktreePlacement } from "@/components/Sidebar/deletedWorktreePlacement";
import { DeletedWorktreeCard } from "@/components/Sidebar/DeletedWorktreeCard";
import { DeletedWorktreeGroup } from "@/components/Sidebar/DeletedWorktreeGroup";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import {
  selectSidebarVisiblePanelIds,
  selectSidebarAgentStateByPanelId,
  selectSidebarFleetEligibleWorktreeById,
  computePanelStateByWorktree,
} from "./sidebarPanelDerivation";
import { useShallow } from "zustand/react/shallow";
import { systemClient } from "@/clients";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { useWorktreeDevServerStore } from "@/store/worktreeDevServerStore";
import {
  matchesFilters,
  matchesQuickStateFilter,
  sortWorktrees,
  sortWorktreesByRelevance,
  groupByType,
  isExternalWorktree,
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
import { WorkspaceRootSidebar } from "./WorkspaceRootSidebar";
import { WorktreeCardPlaceholder } from "./WorktreeCardPlaceholder";
import { useWorkspaceRoot } from "@/hooks/useWorkspaceRoot";
import { useVisibilityAwareInterval } from "@/hooks/useVisibilityAwareInterval";
import { useScrollIndicator } from "./useScrollIndicator";
import { useRecipeDialogState } from "./useRecipeDialogState";
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
const LazyFleetPickerPalette = lazy(() =>
  import("@/components/Fleet/FleetPickerPalette").then((m) => ({
    default: m.FleetPickerPalette,
  }))
);
const LazyRecipeEditor = lazy(() =>
  import("@/components/TerminalRecipe/RecipeEditor").then((m) => ({ default: m.RecipeEditor }))
);
const LazyRecipeManager = lazy(() =>
  import("@/components/TerminalRecipe/RecipeManager").then((m) => ({ default: m.RecipeManager }))
);

function formatButtonTitle(label: string, shortcut?: string | null): string {
  return shortcut ? `${label} (${shortcut})` : label;
}

const NO_MATCH_QUERY_MAX = 40;

/** Mirrors `QuickStateFilterBar`'s own labels — see the rationale there. */
const QUICK_STATE_LABELS: Record<"working" | "waiting" | "finished", string> = {
  working: "Working",
  waiting: "Attention",
  finished: "Finished",
};

const KEYBOARD_REORDER_ANNOUNCEMENT_DEBOUNCE_MS = 150;

// Stable empty ref so `filterArmEligibleIds` can bail to a constant when no
// worktrees are in scope instead of yielding a fresh `[]`.
const EMPTY_ELIGIBLE_IDS: readonly string[] = [];

// Virtuoso overscan in pixels — covers ~2–5 rows at the 120–260px height range,
// keeping useSortable hooks alive in a small window beyond the viewport so a
// dnd-kit drop target stays mounted as the user drags past it.
const SIDEBAR_VIRTUOSO_OVERSCAN_PX = 600;

// Threshold for escalating the "Reconnecting…" badge to include the time
// since data last arrived. 10s sits above the Doherty 400ms gate so the
// indicator never flickers on transient reconnects, and below the worst-case
// ~14s workspace-host restart budget so it fires before `setFatalError`.
const RECONNECT_ESCALATE_MS = 10_000;

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

interface SidebarDeletedWorktreeFlatItem {
  kind: "deletedWorktree";
  id: string;
  worktree: DeletedWorktree;
  ariaRowIndex: number;
}

/**
 * Several deleted worktrees collapsed behind one summary row (#11260). One
 * Virtuoso item regardless of expansion — the member cards render inside it —
 * so it spans a variable number of ARIA rows while occupying a single index.
 */
interface SidebarDeletedWorktreeGroupFlatItem {
  kind: "deletedWorktreeGroup";
  id: string;
  worktrees: DeletedWorktree[];
  ariaRowIndex: number;
}

type SidebarFlatItem =
  | SidebarHeaderFlatItem
  | SidebarRowFlatItem
  | SidebarDeletedWorktreeFlatItem
  | SidebarDeletedWorktreeGroupFlatItem;

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
          <DeletedWorktreeCard worktree={item.worktree} />
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
          <DeletedWorktreeGroup worktrees={item.worktrees} />
        </div>
      </div>
    );
  }
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
    // Resolve the label through issueTitle → branch → name, matching the
    // drag-cancel announcer below and DndProvider.resolveWorktreeLabel, so a
    // keyboard reorder reads the same headline the user sees on the card rather
    // than the bare (rarely-visible) name (issue #10317).
    const wt = worktreesRef.current.find((w) => w.id === worktreeId);
    const label = wt?.issueTitle ?? wt?.branch ?? wt?.name ?? worktreeId;
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
  useEffect(() => {
    worktreesRef.current = worktrees;
  }, [worktrees]);

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
  const showReconnectingEscalated =
    isReconnecting &&
    reconnectingAt !== null &&
    Date.now() - reconnectingAt >= RECONNECT_ESCALATE_MS;
  const deferredWorktrees = useDeferredValue(worktrees);
  const [isRefreshing, startRefreshTransition] = useTransition();
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
  // Resolved reactively from the active provider's slot so the dialog drops
  // out (and back in) live with the owning plugin's enable state instead of
  // holding a stale slot reference.
  const { entry: forgeProviderEntry } = useResolvedForgeProvider(currentProject?.id ?? null);
  const BulkCreateWorktreeDialog = useBuiltinView<ForgeBulkCreateWorktreeDialogProps>(
    forgeProviderEntry?.contribution.slots?.bulkCreateWorktreeDialog ?? ""
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
  const shouldMountFleetPicker = useKeepMounted(isFleetPickerOpen);
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

  // Lag the expensive filtering work behind the input so keystrokes stay
  // responsive. `liveQuery` updates instantly (input + urgent UI state); the
  // filtering memos consume `deferredQuery`, which yields to input events.
  const deferredQuery = useDeferredValue(liveQuery);

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

  const clearAllFilters = useWorktreeFilterStore((state) => state.clearAll);
  const hasFacetFilters = useWorktreeFilterStore((state) => state.hasFacetFilters);
  const hasFacetFiltersActive = hasFacetFilters();
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
  // Subscribing to the whole `panelsById` map re-ran every rollup below on each
  // rAF status-buffer flush (up to 60×/sec while an agent streams), because the
  // buffer replaces the map reference every flush (#10908). Instead subscribe to
  // flat primitive maps of ONLY the fields these rollups read (see
  // `sidebarPanelDerivation.ts`) — none of which the buffer writes — so
  // `useShallow` bails on buffer flushes and re-renders fire only on real
  // structural, agent-state, or fleet-eligibility changes.
  const visiblePanelIds = usePanelStore(useShallow(selectSidebarVisiblePanelIds));
  const agentStateByPanelId = usePanelStore(useShallow(selectSidebarAgentStateByPanelId));
  const fleetEligibleWorktreeById = usePanelStore(
    useShallow(selectSidebarFleetEligibleWorktreeById)
  );
  const panelStateByWorktree = useMemo(
    () =>
      computePanelStateByWorktree(
        worktreeIdList,
        panelIdsByWorktreeId,
        visiblePanelIds,
        agentStateByPanelId,
        worktreeIds
      ),
    [worktreeIdList, panelIdsByWorktreeId, visiblePanelIds, agentStateByPanelId, worktreeIds]
  );

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
  const shouldMountRecipeEditor = useKeepMounted(isRecipeEditorOpen);
  const shouldMountRecipeManager = useKeepMounted(isRecipeManagerOpen);

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

  // Clean up stale pinned/collapsed worktrees (single store write so pruning
  // costs one persist flush, not N) and stale manual order entries. Merged so
  // the worktree-ID Set is built at most once per pass.
  useEffect(() => {
    if (
      pinnedWorktrees.length === 0 &&
      collapsedWorktrees.length === 0 &&
      manualOrder.length === 0
    ) {
      return;
    }
    const existingIds = new Set(worktrees.map((w) => w.id));
    const hasStalePin = pinnedWorktrees.some((id) => !existingIds.has(id));
    const hasStaleCollapsed = collapsedWorktrees.some((id) => !existingIds.has(id));
    if (hasStalePin || hasStaleCollapsed) {
      pruneStaleWorktreeIds(existingIds);
    }
    if (manualOrder.length > 0) {
      const cleaned = manualOrder.filter((id) => existingIds.has(id));
      if (cleaned.length !== manualOrder.length) {
        setManualOrder(cleaned);
      }
    }
  }, [
    worktrees,
    pinnedWorktrees,
    collapsedWorktrees,
    manualOrder,
    pruneStaleWorktreeIds,
    setManualOrder,
  ]);

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

  // Single source for every "worktrees other than the main card" set below —
  // quick-state counts, chip counts, the main card's aggregate, and the
  // filtered list all read this one array so they can never disagree about
  // which worktrees exist. #11433 was exactly that drift: a second, branch-name
  // derived exclusion removed a worktree from the counts while it stayed on
  // screen, so the filter bar read "All 0" above a visible row.
  const nonMainWorktrees = useMemo(
    () => deferredWorktrees.filter((w) => w.id !== mainWorktree?.id),
    [deferredWorktrees, mainWorktree]
  );

  const quickStateCounts = useMemo(() => {
    const counts = { all: nonMainWorktrees.length, working: 0, waiting: 0, finished: 0 };
    for (const w of nonMainWorktrees) {
      const meta = derivedMetaMap.get(w.id);
      if (!meta) continue;
      if (matchesQuickStateFilter("working", meta)) counts.working++;
      if (matchesQuickStateFilter("waiting", meta)) counts.waiting++;
      if (matchesQuickStateFilter("finished", meta)) counts.finished++;
    }
    return counts;
  }, [nonMainWorktrees, derivedMetaMap]);

  const chipCounts = useMemo(() => {
    return computeChipCounts(
      nonMainWorktrees,
      derivedMetaMap,
      activeWorktreeId,
      {
        query: deferredQuery,
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
    nonMainWorktrees,
    derivedMetaMap,
    activeWorktreeId,
    deferredQuery,
    statusFilters,
    typeFilters,
    prIssueFilters,
    sessionFilters,
    activityFilters,
    devServerFilters,
    devServerSessions,
  ]);

  const mainWorktreeAggregateCounts = useMemo(() => {
    const nonMainCount = nonMainWorktrees.length;
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
  }, [nonMainWorktrees.length, quickStateCounts]);

  const { filteredWorktrees, groupedSections, hasResultsWithoutQuickState, totalCount } =
    useMemo(() => {
      const filters: FilterState = {
        query: deferredQuery,
        statusFilters,
        typeFilters,
        prIssueFilters,
        sessionFilters,
        activityFilters,
        devServerFilters,
      };

      let withoutQuickStateMatch = false;
      const filtered = nonMainWorktrees.filter((worktree) => {
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
        const hasActiveQuery = deferredQuery.trim().length > 0;

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
          } else if (matchesFilters(worktree, filters, derived, isActive, devServerSessions)) {
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

        return matchesFilters(worktree, filters, derived, isActive, devServerSessions);
      });

      const existingWorktreeIds = new Set(deferredWorktrees.map((w) => w.id));
      const validPinnedWorktrees = pinnedWorktrees.filter((id) => existingWorktreeIds.has(id));

      const hasQuery = deferredQuery.trim().length > 0;
      const sorted = hasQuery
        ? sortWorktreesByRelevance(
            filtered,
            deferredQuery,
            orderBy,
            validPinnedWorktrees,
            manualOrder
          )
        : sortWorktrees(filtered, orderBy, validPinnedWorktrees, manualOrder);

      if (isGroupedByType && !hasQuery) {
        return {
          filteredWorktrees: sorted,
          groupedSections: groupByType(sorted, orderBy, validPinnedWorktrees),
          hasResultsWithoutQuickState: withoutQuickStateMatch,
          totalCount: nonMainWorktrees.length,
        };
      }

      return {
        filteredWorktrees: sorted,
        groupedSections: null,
        hasResultsWithoutQuickState: withoutQuickStateMatch,
        totalCount: nonMainWorktrees.length,
      };
    }, [
      deferredWorktrees,
      nonMainWorktrees,
      deferredQuery,
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
      quickStateFilter,
      hasFacetFiltersActive,
    ]);

  const worktreeActions = useWorktreeActions({
    onOpenRecipeEditor: handleOpenRecipeEditor,
  });

  const sortableIds = useMemo(
    () => filteredWorktrees.map((w) => getWorktreeSortDragId(w.id)),
    [filteredWorktrees]
  );

  const dragStartOrder = useMemo(() => filteredWorktrees.map((w) => w.id), [filteredWorktrees]);
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

  // Arm-eligible agent terminals inside the currently visible worktrees, split
  // so an arm/disarm elsewhere only re-walks the unarmed tally rather than
  // re-scanning every panel. Drives the QuickStateFilterBar arm affordance,
  // which is agent-scoped like the state-filter presets beside it (#11637).
  const filterArmEligibleIds = useMemo(() => {
    const worktreeIdSet = new Set(filteredWorktrees.map((w) => w.id));
    if (worktreeIdSet.size === 0) return EMPTY_ELIGIBLE_IDS;
    const ids: string[] = [];
    for (const id of panelIds) {
      const worktreeId = fleetEligibleWorktreeById[id];
      if (worktreeId === undefined) continue; // not eligible
      if (!worktreeId || !worktreeIdSet.has(worktreeId)) continue;
      ids.push(id);
    }
    return ids;
  }, [filteredWorktrees, panelIds, fleetEligibleWorktreeById]);
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
    if (!deferredQuery) return true;
    const exactNum = parseExactNumber(deferredQuery);
    if (exactNum !== null) {
      return w.issueNumber === exactNum || w.linked?.pr?.ref.number === exactNum;
    }
    return scoreWorktree(w, deferredQuery) > 0;
  };

  const pinnedFiltersPre: FilterState = {
    query: deferredQuery,
    statusFilters,
    typeFilters,
    prIssueFilters,
    sessionFilters,
    activityFilters,
    devServerFilters,
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
        mainWorktree.id === activeWorktreeId,
        devServerSessions
      ));
  const mainVisible = mainMatchesQueryPre && mainMatchesFacetsPre;

  const hasQuery = liveQuery.trim().length > 0;
  const isSortDisabled = isGroupedByType || hasQuery;
  useEffect(() => {
    isSortDisabledRef.current = isSortDisabled;
  }, [isSortDisabled]);

  // Filter-scope + sort-disabled state. Hoisted above the early returns below so
  // the announcement effects that depend on them keep a stable hook order.
  // `hasFilters` mirrors the store's `hasActiveFilters()` but uses the instant
  // `liveQuery` so filter-dependent UI (scope line, filtered-empty state) reacts
  // immediately rather than after the persisted-query debounce.
  const hasFilters =
    liveQuery.trim().length > 0 || hasFacetFiltersActive || quickStateFilter !== "all";
  const filteredCount = filteredWorktrees.length;
  const showScope = hasFilters && filteredCount !== totalCount;
  const dragDisabledReason = hasQuery
    ? "Sorting disabled while searching"
    : isGroupedByType
      ? "Sorting disabled while grouped by type"
      : null;
  // Filter scope + sort-disabled status, rendered inside the search bar strip
  // so the feedback sits with the controls that produced it. Visual-only —
  // screen readers are served by the debounced announcer effects below, not a
  // live region, so the persistent sort-disabled text isn't re-announced on
  // every keystroke (#9665).
  const scopeText = showScope ? `${filteredCount} of ${totalCount} worktrees` : null;
  const filterStatusText =
    scopeText && dragDisabledReason
      ? `${scopeText} · ${dragDisabledReason}`
      : (scopeText ?? dragDisabledReason);

  // Announce the filtered worktree count to screen readers, debounced so rapid
  // typing in the search box doesn't flood the AT speech queue. Routed through
  // the global announcer (document.ariaNotify + always-mounted fallback) rather
  // than a persistent aria-atomic live region — that region re-announced the
  // whole status line, including the persistent sort-disabled text, on every
  // keystroke (#9665).
  useEffect(() => {
    if (!showScope) return;
    const timer = window.setTimeout(() => {
      useAnnouncerStore.getState().announce(`${filteredCount} of ${totalCount} worktrees`);
    }, UI_DOHERTY_THRESHOLD);
    return () => {
      window.clearTimeout(timer);
    };
  }, [showScope, filteredCount, totalCount]);

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

  const mainRowIndex = mainVisible ? 1 : 0;
  const firstScrollableRowIndex = mainRowIndex + 1;

  // Total rows in the grid — the main row + group header rows + data rows.
  // Group header rows count toward aria-rowcount because they carry role="row".
  // Deleted rows carry `role="row"` too, so they count — a collapsed group is
  // one row no matter how many worktrees it holds.
  const deletedRowCount =
    deletedWorktrees.size >= DELETED_WORKTREE_GROUP_THRESHOLD ? 1 : deletedWorktrees.size;
  const ariaRowCount =
    mainRowIndex +
    (groupedSections
      ? groupedSections.reduce((n, s) => n + 1 + s.worktrees.length, 0)
      : filteredWorktrees.length) +
    deletedRowCount;

  // Build the flat item array that drives the virtualized scroll region. The
  // grouped path interleaves sticky header sentinels with static rows; the
  // ungrouped path emits sortable rows so dnd-kit's SortableContext can
  // wrap the whole Virtuoso surface.
  // Publish the visible order so a worktree deleted later can anchor its row to
  // the live successor it currently precedes (#11232). Recorded from an effect
  // rather than during render because it is a write to module state — reading it
  // happens once, at deletion, well after this has settled.
  useEffect(() => {
    recordSidebarWorktreeOrder(filteredWorktrees.map((w) => w.id));
  }, [filteredWorktrees]);

  const sidebarItems = useMemo<SidebarFlatItem[]>(() => {
    const items: SidebarFlatItem[] = [];
    const pinnedSet = new Set(pinnedWorktrees);
    // External worktrees sort below the pinned area regardless of a leftover pin
    // entry, so their rows must not claim pinned affordances either (#11434).
    const isRowPinned = (w: WorktreeState) => pinnedSet.has(w.id) && !isExternalWorktree(w);
    let nextRowIndex = firstScrollableRowIndex;

    // Deleted worktrees anchor their row to the live neighbour it sat above
    // when it was deleted, so the terminals the user is looking for stay where
    // they left them instead of jumping to an edge of the list (#11232). Ties
    // and gone anchors fall back to deletion order / trailing for a stable
    // render. `dragStartOrder` is the live filtered id order (see line ~1060).
    const deletedList = Array.from(deletedWorktrees.values()).sort(
      (a, b) => a.deletedAt - b.deletedAt
    );
    const {
      isGrouped,
      groupSlot,
      byIndex: deletedByIndex,
      trailing: trailingDeleted,
    } = planDeletedWorktreePlacement(deletedList, dragStartOrder);
    const hasGroupSlot = groupSlot >= 0;
    const pushDeleted = (deleted: DeletedWorktree) => {
      items.push({
        kind: "deletedWorktree",
        id: `deleted-${deleted.id}`,
        worktree: deleted,
        ariaRowIndex: nextRowIndex++,
      });
    };
    const pushDeletedGroup = () => {
      items.push({
        kind: "deletedWorktreeGroup",
        id: "deleted-worktree-group",
        worktrees: deletedList,
        ariaRowIndex: nextRowIndex++,
      });
    };

    if (groupedSections) {
      const orderIndex = new Map(dragStartOrder.map((id, i) => [id, i]));
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
            rowIndex: orderIndex.get(w.id) ?? -1,
            isPinned: isRowPinned(w),
            mode: "static",
          });
        }
      }
      // Type grouping has no slot for a worktree that no longer has a type to
      // group by, so deleted rows collect at the end rather than inventing a
      // section for them. Piling up there is exactly what made a burst
      // unreadable, so the group summary matters most in this path.
      if (isGrouped) pushDeletedGroup();
      else for (const deleted of deletedList) pushDeleted(deleted);
      return items;
    }

    for (let i = 0; i < filteredWorktrees.length; i++) {
      if (hasGroupSlot && i === groupSlot) pushDeletedGroup();
      if (!isGrouped) for (const deleted of deletedByIndex.get(i) ?? []) pushDeleted(deleted);
      const w = filteredWorktrees[i]!;
      items.push({
        kind: "row",
        id: `row-${w.id}`,
        worktreeId: w.id,
        ariaRowIndex: nextRowIndex++,
        rowIndex: i,
        isPinned: isRowPinned(w),
        mode: "sortable",
      });
    }
    if (isGrouped) {
      if (!hasGroupSlot) pushDeletedGroup();
    } else {
      for (const deleted of trailingDeleted) pushDeleted(deleted);
    }
    return items;
  }, [
    groupedSections,
    filteredWorktrees,
    firstScrollableRowIndex,
    pinnedWorktrees,
    dragStartOrder,
    deletedWorktrees,
  ]);

  // Computed after `sidebarItems` because the indicator counts hidden worktree
  // rows directly from the flat list geometry (variable-height rows + section
  // headers, issue #9666), so it needs the full item array as its input.
  const {
    hiddenAbove,
    hiddenBelow,
    scrollToTop,
    scrollToBottom,
    scrollerRef: scrollIndicatorScrollerRef,
    handleScroll,
    handleItemsRendered,
  } = useScrollIndicator({
    items: sidebarItems,
  });

  const setScrollerElement = useCallback(
    (el: HTMLElement | Window | null) => {
      scrollerElementRef.current = el instanceof HTMLElement ? el : null;
      scrollIndicatorScrollerRef(el);
    },
    [scrollIndicatorScrollerRef]
  );

  // The pinned main row lives OUTSIDE the Virtuoso surface but INSIDE the
  // role="grid" container, so keyboard navigation must visit it before
  // descending into the virtualized list. It carries isPinned so the hook
  // skips scrollToIndex (it's always rendered, never windowed).
  const keyboardItems = useMemo<SidebarKeyboardItem[]>(() => {
    const items: SidebarKeyboardItem[] = [];
    if (mainVisible && mainWorktree) {
      items.push({ kind: "row", worktreeId: mainWorktree.id, isPinned: true });
    }
    for (const item of sidebarItems) {
      items.push(
        item.kind === "row" ? { kind: "row", worktreeId: item.worktreeId } : { kind: "header" }
      );
    }
    return items;
  }, [sidebarItems, mainVisible, mainWorktree]);

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
            label: "Restart service",
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

  if (isLoading && worktrees.length === 0) {
    return (
      <div className="flex flex-col h-full">
        {worktreeLoadErrorBanner}
        <div className="flex h-8 items-center px-3 border-b border-divider shrink-0">
          <h2 className="truncate text-daintree-text font-semibold text-sm tracking-wide">
            Worktrees
          </h2>
        </div>
        <div className="flex-1 min-h-0 relative overflow-hidden pb-8">
          <Skeleton label="Loading worktrees">
            {WORKTREE_SKELETON_CARDS.map((card) => (
              <div key={card.id} aria-hidden="true" className="flex flex-col gap-2 px-4 py-3">
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
                <SkeletonBone shimmer className="mt-1 w-[90%] rounded-md" heightPx={32} />
              </div>
            ))}
          </Skeleton>
          <SkeletonHint className="absolute bottom-4 left-1/2 -translate-x-1/2 pointer-events-auto" />
        </div>
      </div>
    );
  }

  if (worktrees.length === 0) {
    return (
      <>
        <div className="flex flex-col h-full">
          {worktreeLoadErrorBanner}
          <div className="flex h-8 items-center px-3 border-b border-divider shrink-0">
            <h2 className="truncate text-daintree-text font-semibold text-sm tracking-wide">
              Worktrees
            </h2>
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
              title="Open a Git repository"
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

  const hasNonMainWorktrees = nonMainWorktrees.length > 0;
  const showQuickStateEmptyState =
    filteredWorktrees.length === 0 &&
    quickStateFilter !== "all" &&
    hasResultsWithoutQuickState &&
    hasNonMainWorktrees;

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
          className="inline-flex items-center justify-center self-stretch px-1.5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-daintree-accent text-daintree-text/60 hover:text-daintree-text hover:bg-tint/[0.06] aria-disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent aria-disabled:hover:text-daintree-text/60"
          aria-label={armMatchingLabel}
        >
          <Zap className="w-3 h-3" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{armMatchingLabel}</TooltipContent>
    </Tooltip>
  );
  return (
    <div className="flex flex-col h-full">
      {worktreeLoadErrorBanner}
      {/* Header Section */}
      {/* The control zone carries ONE horizontal rule, at its bottom edge. When
          the search rail renders it owns that rule, so the header goes without;
          with no rail the header IS the bottom of the zone and keeps it.
          Stacking a header rule on a rail rule put two hairlines in the first
          90px of the sidebar and neither was carrying hierarchy (#11991). */}
      <div
        className={cn(
          "group/header @container/header flex h-8 items-center justify-between gap-1 px-3 bg-transparent shrink-0",
          !hasNonMainWorktrees && "border-b border-divider"
        )}
      >
        <div className="flex min-w-0 items-baseline gap-1.5">
          <h2 className="truncate text-daintree-text font-semibold text-sm tracking-wide">
            Worktrees
          </h2>
          {showReconnecting && (
            <span
              aria-hidden="true"
              className="shrink-0"
              data-reconnect-escalated={showReconnectingEscalated ? "true" : undefined}
            >
              {showReconnectingEscalated && reconnectingAt !== null ? (
                <Tooltip autoDismiss={false}>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1 whitespace-nowrap shrink-0 text-status-warning text-xs">
                      <RefreshCw
                        className="w-3 h-3 animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                      <span className="hidden @[16rem]/header:inline">Reconnecting…</span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    Last updated {formatRelativeTime(reconnectingAt)}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <span className="inline-flex items-center gap-1 whitespace-nowrap shrink-0 text-text-secondary text-xs">
                  <RefreshCw
                    className="w-3 h-3 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  <span className="hidden @[16rem]/header:inline">Reconnecting…</span>
                </span>
              )}
            </span>
          )}
        </div>
        {/* gap-0.5, not gap-1: the four buttons already carry p-1, so a 4px gap
            on top of that spent ~12px the 200px minimum width does not have —
            the cluster crowded the "Worktrees" landmark it sits beside. */}
        <div className="flex shrink-0 items-center gap-0.5">
          <div className="invisible opacity-0 pointer-events-none transition-[opacity,visibility] duration-150 delay-75 group-hover/header:visible group-hover/header:opacity-100 group-hover/header:pointer-events-auto group-hover/header:delay-75 group-focus-within/header:visible group-focus-within/header:opacity-100 group-focus-within/header:pointer-events-auto group-focus-within/header:delay-75 motion-reduce:transition-none flex items-center gap-0.5">
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
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleRefreshAll}
                  aria-disabled={isRefreshing || undefined}
                  className="p-1 text-daintree-text/40 hover:text-daintree-text hover:bg-tint/[0.06] rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent aria-disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent aria-disabled:hover:text-daintree-text/40"
                  aria-label="Refresh sidebar"
                  aria-keyshortcuts={refreshAriaShortcut}
                >
                  <SpinningIcon icon={RefreshCw} active={isRefreshing} className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {createTooltipContent("Refresh sidebar", refreshShortcut)}
              </TooltipContent>
            </Tooltip>
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

      {/* Inline search bar — only when there are non-main worktrees */}
      {hasNonMainWorktrees && (
        <WorktreeSidebarSearchBar
          inputRef={searchInputRef}
          chipCounts={chipCounts}
          statusText={filterStatusText}
        />
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
              aggregateCounts={mainWorktreeAggregateCounts}
              ariaRowIndex={mainRowIndex}
            />
          </div>
        )}

        {pendingCreationRows && (
          <div role="rowgroup" className="shrink-0">
            {pendingCreationRows}
          </div>
        )}

        {/* Strong divider between pinned worktrees and scrollable list */}
        {hasNonMainWorktrees && (
          <div role="presentation" className="shrink-0 border-b border-border-default" />
        )}

        {hasNonMainWorktrees && (
          <div role="row">
            <div role="gridcell">
              <QuickStateFilterBar
                value={quickStateFilter}
                onChange={setQuickStateFilter}
                counts={quickStateCounts}
                trailing={armMatchingButton}
              />
            </div>
          </div>
        )}

        {/* Virtualized non-main worktree list */}
        <div role="presentation" className="relative flex-1 min-h-0">
          {showQuickStateEmptyState && !hasFacetFiltersActive && !hasQuery ? (
            quickStateFilter === "waiting" ? (
              <EmptyState variant="user-cleared" scale="sidebar" title="All caught up" />
            ) : (
              <EmptyState
                variant="filtered-empty"
                scale="sidebar"
                instant
                title={`No ${QUICK_STATE_LABELS[quickStateFilter].toLowerCase()} worktrees`}
                action={
                  <>
                    <button
                      type="button"
                      onClick={() => setQuickStateFilter("all")}
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
            )
          ) : showQuickStateEmptyState && hasFacetFiltersActive ? (
            <EmptyState
              variant="filtered-empty"
              scale="sidebar"
              instant
              title={
                deferredQuery.trim()
                  ? `No matches for "${truncateSearchQuery(deferredQuery.trim())}"`
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
          ) : filteredWorktrees.length === 0 &&
            hasFilters &&
            hasNonMainWorktrees &&
            !mainVisible ? (
            <EmptyState
              variant="filtered-empty"
              scale="sidebar"
              instant
              title={
                deferredQuery.trim()
                  ? `No matches for "${truncateSearchQuery(deferredQuery.trim())}"`
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
              components={SIDEBAR_VIRTUOSO_COMPONENTS}
              computeItemKey={computeSidebarItemKey}
              itemContent={renderSidebarFlatItem}
              scrollerRef={setScrollerElement}
              onScroll={handleScroll}
              itemsRendered={handleItemsRendered}
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
                components={SIDEBAR_VIRTUOSO_COMPONENTS}
                computeItemKey={computeSidebarItemKey}
                itemContent={renderSidebarFlatItem}
                scrollerRef={setScrollerElement}
                onScroll={handleScroll}
                itemsRendered={handleItemsRendered}
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
        {shouldMountRecipeEditor && (
          <Suspense fallback={null}>
            <LazyRecipeEditor
              recipe={recipeManagerEdit}
              worktreeId={recipeEditorWorktreeId}
              initialTerminals={recipeEditorInitialTerminals}
              defaultScope={recipeEditorDefaultScope}
              isOpen={isRecipeEditorOpen}
              onClose={handleCloseRecipeEditor}
            />
          </Suspense>
        )}
      </ErrorBoundary>

      <ErrorBoundary
        variant="component"
        componentName="RecipeManager"
        resetKeys={[Number(isRecipeManagerOpen)]}
      >
        {shouldMountRecipeManager && (
          <Suspense fallback={null}>
            <LazyRecipeManager
              isOpen={isRecipeManagerOpen}
              onClose={handleCloseRecipeManager}
              onEditRecipe={handleRecipeManagerEdit}
              onCreateRecipe={handleRecipeManagerCreate}
            />
          </Suspense>
        )}
      </ErrorBoundary>

      {newWorktreeDialogElement}

      <ErrorBoundary
        variant="component"
        componentName="BulkCreateWorktreeDialog"
        resetKeys={[Number(bulkCreateDialog.isOpen)]}
      >
        {bulkCreateDialog.isOpen && BulkCreateWorktreeDialog && (
          <Suspense fallback={null}>
            <BulkCreateWorktreeDialog
              isOpen
              onClose={closeBulkCreateDialog}
              mode={bulkCreateDialog.mode}
              selectedIssues={bulkCreateDialog.selectedIssues}
              selectedPRs={bulkCreateDialog.selectedPRs}
              onComplete={closeBulkCreateDialog}
            />
          </Suspense>
        )}
      </ErrorBoundary>

      <ErrorBoundary
        variant="component"
        componentName="FleetPickerPalette"
        resetKeys={[Number(isFleetPickerOpen)]}
      >
        {shouldMountFleetPicker && (
          <Suspense fallback={null}>
            <LazyFleetPickerPalette isOpen={isFleetPickerOpen} onClose={closeFleetPicker} />
          </Suspense>
        )}
      </ErrorBoundary>

      {restartConfirmDialog}
    </div>
  );
}

export { SidebarContent };
