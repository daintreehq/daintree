import React, {
  Profiler,
  Suspense,
  lazy,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import "@xterm/xterm/css/xterm.css";
import { FolderOpen, FilterX, LayoutGrid, Plus, RefreshCw, Radio } from "lucide-react";
import { ScrollIndicator } from "./components/Worktree/ScrollIndicator";
import {
  isElectronAvailable,
  useAgentLauncher,
  useWorktrees,
  useNewTerminalPalette,
  usePanelPalette,
  useProjectSwitcherPalette,
  useTerminalConfig,
  useAppThemeConfig,
  useGlobalKeybindings,
  useGlobalEscapeDispatcher,
  useContextInjection,
  useProjectSettings,
  useGridNavigation,
  useWindowNotifications,
  useWatchedPanelNotifications,
  useWorktreeActions,
  useMenuActions,
  useErrors,
  useReEntrySummary,
} from "./hooks";
import { useHibernationNotifications } from "./hooks/useHibernationNotifications";
import { useDiskSpaceWarnings } from "./hooks/useDiskSpaceWarnings";
import { useActionRegistry } from "./hooks/useActionRegistry";
import { useUpdateListener } from "./hooks/useUpdateListener";
import { useMainProcessToastListener } from "./hooks/useMainProcessToastListener";

import { useActionPalette } from "./hooks/useActionPalette";
import { useQuickSwitcher } from "./hooks/useQuickSwitcher";
import { useWorktreePalette } from "./hooks/useWorktreePalette";
import { useQuickCreatePalette } from "./hooks/useQuickCreatePalette";
import { useDoubleShift } from "./hooks/useDoubleShift";
import { useMcpBridge } from "./hooks/useMcpBridge";
import { useFileDropGuard } from "./hooks/useFileDropGuard";
import { useSoundPlaybackListener } from "./hooks/useSoundPlaybackListener";
import { removeStartupSkeleton } from "./utils/removeStartupSkeleton";
import { createTooltipWithShortcut } from "./lib/platform";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";
import { useCrashRecoveryGate } from "./hooks/app/useCrashRecoveryGate";
import { CrashRecoveryDialog } from "./components/Recovery/CrashRecoveryDialog";
import { SafeModeBanner } from "./components/Recovery/SafeModeBanner";
import {
  useAppHydration,
  useProjectSwitchRehydration,
  useShortcutHints,
  useTerminalStoreBootstrap,
  useSemanticWorkerLifecycle,
  useSystemWakeHandler,
  useCloudSyncWarning,
  useAccessibilityAnnouncements,
  useGettingStartedChecklist,
  useOrchestrationMilestones,
  useAgentWaitingNudge,
  useUnloadCleanup,
  useHomeDir,
  usePerformanceMonitors,
  useSettingsDialog,
  useWorktreeOverview,
  useAppEventListeners,
  useErrorRetry,
  useActiveWorktreeSync,
} from "./hooks/app";
import { useResourceProfile } from "./hooks/useResourceProfile";
import { AppLayout } from "./components/Layout";
import { ContentGrid } from "./components/Terminal";
import { PanelTransitionOverlay } from "./components/Panel";
import {
  WorktreeCard,
  type WorktreeCardProps,
  WorktreePalette,
  WorktreeSidebarSearchBar,
  WorktreeOverviewModal,
  QuickCreatePalette,
  QuickStateFilterBar,
} from "./components/Worktree";
import { CrossWorktreeDiff } from "./components/Worktree/CrossWorktreeDiff";

import { BulkCreateWorktreeDialog } from "./components/GitHub/BulkCreateWorktreeDialog";
import { TerminalInfoDialogHost } from "./components/Terminal/TerminalInfoDialogHost";
import { FileViewerModalHost } from "./components/FileViewer/FileViewerModalHost";
import { NewTerminalPalette } from "./components/TerminalPalette";
import { PanelPalette } from "./components/PanelPalette/PanelPalette";
import { MORE_AGENTS_PANEL_ID } from "./hooks/usePanelPalette";
import { buildResumeCommand } from "@shared/types/agentSettings";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import {
  GitInitDialog,
  CloneRepoDialog,
  ProjectOnboardingWizard,
  WelcomeScreen,
} from "./components/Project";
import { VoiceRecordingAnnouncer } from "./components/Terminal/VoiceRecordingAnnouncer";
import { AccessibilityAnnouncer } from "./components/Accessibility/AccessibilityAnnouncer";
import { CreateProjectFolderDialog } from "./components/Project/CreateProjectFolderDialog";
import { ProjectSwitcherPalette } from "./components/Project/ProjectSwitcherPalette";
import { ActionPalette } from "./components/ActionPalette";
import { QuickSwitcher } from "./components/QuickSwitcher";
import { SendToAgentPalette } from "./components/Terminal/SendToAgentPalette";
import { useSendToAgentPalette } from "./hooks/useSendToAgentPalette";
import { BulkCommandPalette } from "./components/BulkCommandCenter";
import { ConfirmDialog } from "./components/ui/ConfirmDialog";
import { PanelLimitConfirmDialog } from "./components/Terminal/PanelLimitConfirmDialog";
import { RecipeEditor } from "./components/TerminalRecipe/RecipeEditor";
import { RecipeManager } from "./components/TerminalRecipe/RecipeManager";
import { NotesPalette } from "./components/Notes";

function preloadSettingsDialog() {
  return import("./components/Settings/SettingsDialog");
}
const LazySettingsDialog = lazy(() =>
  preloadSettingsDialog().then((m) => ({ default: m.SettingsDialog }))
);

function preloadNewWorktreeDialog() {
  return import("./components/Worktree/NewWorktreeDialog");
}
const LazyNewWorktreeDialog = lazy(() =>
  preloadNewWorktreeDialog().then((m) => ({ default: m.NewWorktreeDialog }))
);
import { ShortcutReferenceDialog } from "./components/KeyboardShortcuts";
import { Toaster } from "./components/ui/toaster";
import { ShortcutHint } from "./components/ui/ShortcutHint";
import { ReEntrySummary } from "./components/ui/ReEntrySummary";
import { OnboardingFlow } from "./components/Onboarding/OnboardingFlow";
import { GettingStartedChecklist } from "./components/Onboarding/GettingStartedChecklist";
import { CelebrationConfetti } from "./components/Onboarding/CelebrationConfetti";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { WorktreeCardErrorFallback } from "./components/Worktree/WorktreeCardErrorFallback";
import { DndProvider } from "./components/DragDrop";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  SortableWorktreeCard,
  getWorktreeSortDragId,
} from "./components/DragDrop/SortableWorktreeCard";
import {
  useTerminalStore,
  useWorktreeSelectionStore,
  useProjectStore,
  useErrorStore,
  useAgentPreferencesStore,
  usePaletteStore,
  useNotificationSettingsStore,
} from "./store";
import { useShallow } from "zustand/react/shallow";
import { useMacroFocusStore } from "./store/macroFocusStore";
import { useSafeModeStore } from "./store/safeModeStore";
import type { RecipeTerminal } from "./types";
import { systemClient } from "@/clients";
import { registerBuiltInPanelComponents } from "./registry";

// Register built-in panel components before any renders
registerBuiltInPanelComponents();
import { useWorktreeFilterStore } from "./store/worktreeFilterStore";
import {
  matchesFilters,
  matchesQuickStateFilter,
  sortWorktrees,
  sortWorktreesByRelevance,
  groupByType,
  findIntegrationWorktree,
  scoreWorktree,
  type DerivedWorktreeMeta,
  type FilterState,
  type QuickStateFilter,
} from "./lib/worktreeFilters";
import { computeChipState } from "./components/Worktree/utils/computeChipState";
import { parseExactNumber } from "./lib/parseExactNumber";
import type { WorktreeState, PanelKind } from "./types";
import type { TerminalType } from "@shared/types";
import { actionService } from "./services/ActionService";
import { voiceRecordingService } from "./services/VoiceRecordingService";
import { terminalInstanceService } from "./services/terminal/TerminalInstanceService";
import { SIDEBAR_TOGGLE_LOCK_MS } from "./lib/terminalLayout";
import { useRenderProfiler } from "./utils/renderProfiler";
import { useWorktreeStore } from "./hooks/useWorktreeStore";
import { useRecipeStore } from "./store/recipeStore";
import type { WorktreeActions } from "./hooks/useWorktreeActions";
import type { UseAgentLauncherReturn } from "./hooks/useAgentLauncher";

interface SidebarWorktreeRowProps {
  worktreeId: string;
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
  isPinned: boolean;
}

const SidebarWorktreeRow = React.memo(function SidebarWorktreeRow({
  worktreeId,
  activeWorktreeId,
  focusedWorktreeId,
  totalWorktreeCount,
  selectWorktree,
  worktreeActions,
  availability,
  agentSettings,
  homeDir,
  dragStartOrder,
  isSortDisabled,
  isPinned,
}: SidebarWorktreeRowProps) {
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

  const onSelect = useCallback(() => selectWorktree(worktreeId), [selectWorktree, worktreeId]);
  const onCopyTree = useCallback(
    () => worktree && worktreeActions.handleCopyTree(worktree),
    [worktree, worktreeActions]
  );
  const onOpenEditor = useCallback(
    () => worktree && worktreeActions.handleOpenEditor(worktree),
    [worktree, worktreeActions]
  );
  const onSaveLayout = useCallback(
    () => worktree && worktreeActions.handleSaveLayout(worktree),
    [worktree, worktreeActions]
  );
  const onLaunchAgent = useCallback(
    (agentId: string) => worktreeActions.handleLaunchAgent(worktreeId, agentId),
    [worktreeActions, worktreeId]
  );

  if (!worktree) return null;

  const showDragHandle = !isSortDisabled && !isPinned;
  const isActive = worktreeId === activeWorktreeId;
  const isFocused = worktreeId === focusedWorktreeId;
  const isSingleWorktree = totalWorktreeCount === 1;

  if (showDragHandle) {
    return (
      <SortableWorktreeCard
        worktreeId={worktreeId}
        dragStartOrder={dragStartOrder}
        disabled={isSortDisabled || isPinned}
      >
        {({ isDraggingSort, dragHandleListeners, dragHandleActivatorRef }) => (
          <ErrorBoundary
            variant="component"
            componentName="WorktreeCard"
            fallback={WorktreeCardErrorFallback}
            resetKeys={[worktreeId]}
            context={{ worktreeId }}
          >
            <WorktreeCard
              worktree={worktree}
              isActive={isActive}
              isFocused={isFocused}
              isSingleWorktree={isSingleWorktree}
              onSelect={onSelect}
              onCopyTree={onCopyTree}
              onOpenEditor={onOpenEditor}
              onSaveLayout={onSaveLayout}
              onLaunchAgent={onLaunchAgent}
              agentAvailability={availability}
              agentSettings={agentSettings}
              homeDir={homeDir}
              dragHandleListeners={dragHandleListeners}
              dragHandleActivatorRef={dragHandleActivatorRef}
              isDraggingSort={isDraggingSort}
            />
          </ErrorBoundary>
        )}
      </SortableWorktreeCard>
    );
  }

  return (
    <SortableWorktreeCard worktreeId={worktreeId} dragStartOrder={dragStartOrder} disabled={true}>
      {({ isDraggingSort }) => (
        <ErrorBoundary
          variant="component"
          componentName="WorktreeCard"
          fallback={WorktreeCardErrorFallback}
          resetKeys={[worktreeId]}
          context={{ worktreeId }}
        >
          <WorktreeCard
            worktree={worktree}
            isActive={isActive}
            isFocused={isFocused}
            isSingleWorktree={isSingleWorktree}
            onSelect={onSelect}
            onCopyTree={onCopyTree}
            onOpenEditor={onOpenEditor}
            onSaveLayout={onSaveLayout}
            onLaunchAgent={onLaunchAgent}
            agentAvailability={availability}
            agentSettings={agentSettings}
            homeDir={homeDir}
            isDraggingSort={isDraggingSort}
          />
        </ErrorBoundary>
      )}
    </SortableWorktreeCard>
  );
});

interface StaticWorktreeRowProps {
  worktreeId: string;
  activeWorktreeId: string | null;
  focusedWorktreeId: string | null;
  totalWorktreeCount: number;
  selectWorktree: (id: string) => void;
  worktreeActions: WorktreeActions;
  availability: UseAgentLauncherReturn["availability"];
  agentSettings: UseAgentLauncherReturn["agentSettings"];
  homeDir: string | undefined;
  aggregateCounts?: WorktreeCardProps["aggregateCounts"];
}

const StaticWorktreeRow = React.memo(function StaticWorktreeRow({
  worktreeId,
  activeWorktreeId,
  focusedWorktreeId,
  totalWorktreeCount,
  selectWorktree,
  worktreeActions,
  availability,
  agentSettings,
  homeDir,
  aggregateCounts,
}: StaticWorktreeRowProps) {
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

  const onSelect = useCallback(() => selectWorktree(worktreeId), [selectWorktree, worktreeId]);
  const onCopyTree = useCallback(
    () => worktree && worktreeActions.handleCopyTree(worktree),
    [worktree, worktreeActions]
  );
  const onOpenEditor = useCallback(
    () => worktree && worktreeActions.handleOpenEditor(worktree),
    [worktree, worktreeActions]
  );
  const onSaveLayout = useCallback(
    () => worktree && worktreeActions.handleSaveLayout(worktree),
    [worktree, worktreeActions]
  );
  const onLaunchAgent = useCallback(
    (agentId: string) => worktreeActions.handleLaunchAgent(worktreeId, agentId),
    [worktreeActions, worktreeId]
  );

  if (!worktree) return null;

  return (
    <ErrorBoundary
      variant="component"
      componentName="WorktreeCard"
      fallback={WorktreeCardErrorFallback}
      resetKeys={[worktreeId]}
      context={{ worktreeId }}
    >
      <WorktreeCard
        worktree={worktree}
        isActive={worktreeId === activeWorktreeId}
        isFocused={worktreeId === focusedWorktreeId}
        isSingleWorktree={totalWorktreeCount === 1}
        aggregateCounts={aggregateCounts}
        onSelect={onSelect}
        onCopyTree={onCopyTree}
        onOpenEditor={onOpenEditor}
        onSaveLayout={onSaveLayout}
        onLaunchAgent={onLaunchAgent}
        agentAvailability={availability}
        agentSettings={agentSettings}
        homeDir={homeDir}
      />
    </ErrorBoundary>
  );
});

interface SidebarContentProps {
  onOpenOverview: () => void;
}

function SidebarContent({ onOpenOverview }: SidebarContentProps) {
  const { worktrees, isLoading, error, refresh } = useWorktrees();
  const deferredWorktrees = useDeferredValue(worktrees);
  const [isRefreshing, startRefreshTransition] = useTransition();
  const currentProject = useProjectStore((state) => state.currentProject);
  useProjectSettings();
  const { launchAgent, availability, agentSettings } = useAgentLauncher();
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

  const [hasOpenedNewWorktree, setHasOpenedNewWorktree] = useState(false);
  useEffect(() => {
    if (createDialog.isOpen) setHasOpenedNewWorktree(true);
  }, [createDialog.isOpen]);

  // Filter/sort state - destructured for stable memoization
  const {
    query,
    orderBy,
    groupByType: isGroupedByType,
    statusFilters,
    typeFilters,
    githubFilters,
    sessionFilters,
    activityFilters,
    alwaysShowActive,
    alwaysShowWaiting,
    pinnedWorktrees,
    manualOrder,
  } = useWorktreeFilterStore(
    useShallow((state) => ({
      query: state.query,
      orderBy: state.orderBy,
      groupByType: state.groupByType,
      statusFilters: state.statusFilters,
      typeFilters: state.typeFilters,
      githubFilters: state.githubFilters,
      sessionFilters: state.sessionFilters,
      activityFilters: state.activityFilters,
      alwaysShowActive: state.alwaysShowActive,
      alwaysShowWaiting: state.alwaysShowWaiting,
      pinnedWorktrees: state.pinnedWorktrees,
      manualOrder: state.manualOrder,
    }))
  );
  const clearAllFilters = useWorktreeFilterStore((state) => state.clearAll);
  const hasActiveFilters = useWorktreeFilterStore((state) => state.hasActiveFilters);
  const unpinWorktree = useWorktreeFilterStore((state) => state.unpinWorktree);
  const collapsedWorktrees = useWorktreeFilterStore((state) => state.collapsedWorktrees);
  const expandWorktree = useWorktreeFilterStore((state) => state.expandWorktree);

  // Terminal store for derived metadata
  const terminals = useTerminalStore(useShallow((state) => state.terminals));

  // Error store for derived metadata
  const getWorktreeErrors = useErrorStore((state) => state.getWorktreeErrors);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const recipeManagerEditRef = useRef<import("@/types").TerminalRecipe | undefined>(undefined);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [hiddenAbove, setHiddenAbove] = useState(0);
  const [hiddenBelow, setHiddenBelow] = useState(0);

  const [quickStateFilter, setQuickStateFilter] = useState<QuickStateFilter>("all");

  const [isRecipeEditorOpen, setIsRecipeEditorOpen] = useState(false);
  const [recipeEditorWorktreeId, setRecipeEditorWorktreeId] = useState<string | undefined>(
    undefined
  );
  const [recipeEditorInitialTerminals, setRecipeEditorInitialTerminals] = useState<
    RecipeTerminal[] | undefined
  >(undefined);
  const [recipeEditorDefaultScope, setRecipeEditorDefaultScope] = useState<
    "global" | "project" | undefined
  >(undefined);

  const [isRecipeManagerOpen, setIsRecipeManagerOpen] = useState(false);

  const [homeDir, setHomeDir] = useState<string | undefined>(undefined);

  useEffect(() => {
    systemClient.getHomeDir().then(setHomeDir).catch(console.error);
  }, []);

  const handleRefreshAll = useCallback(() => {
    if (isRefreshing) return;
    startRefreshTransition(async () => {
      await actionService.dispatch("worktree.refresh", undefined, { source: "user" });
    });
  }, [isRefreshing, startRefreshTransition]);

  const setManualOrder = useWorktreeFilterStore((state) => state.setManualOrder);

  // Clean up stale pinned and collapsed worktrees
  useEffect(() => {
    const existingIds = new Set(worktrees.map((w) => w.id));
    const stalePins = pinnedWorktrees.filter((id) => !existingIds.has(id));
    stalePins.forEach((id) => unpinWorktree(id));
    const staleCollapsed = collapsedWorktrees.filter((id) => !existingIds.has(id));
    staleCollapsed.forEach((id) => expandWorktree(id));
  }, [worktrees, pinnedWorktrees, unpinWorktree, collapsedWorktrees, expandWorktree]);

  // Clean up stale manual order entries
  useEffect(() => {
    if (manualOrder.length === 0) return;
    const existingIds = new Set(worktrees.map((w) => w.id));
    const cleaned = manualOrder.filter((id) => existingIds.has(id));
    if (cleaned.length !== manualOrder.length) {
      setManualOrder(cleaned);
    }
  }, [worktrees, manualOrder, setManualOrder]);

  // Compute derived metadata for each worktree
  const derivedMetaMap = useMemo(() => {
    const map = new Map<string, DerivedWorktreeMeta>();
    for (const worktree of deferredWorktrees) {
      const worktreeTerminals = terminals.filter(
        (t) => t.worktreeId === worktree.id && t.location !== "trash"
      );
      const waitingTerminalCount = worktreeTerminals.filter(
        (t) => t.agentState === "waiting"
      ).length;

      // chipState logic mirrors useWorktreeStatus.ts — keep in sync
      const hasChanges = (worktree.worktreeChanges?.changedFileCount ?? 0) > 0;
      const isComplete =
        !!worktree.issueNumber &&
        !!worktree.prNumber &&
        !hasChanges &&
        worktree.worktreeChanges !== null;

      let lifecycleStage: "in-review" | "merged" | "ready-for-cleanup" | null = null;
      if (!worktree.isMainWorktree && worktree.worktreeChanges !== null) {
        if (worktree.prState === "merged") {
          lifecycleStage = worktree.issueNumber ? "ready-for-cleanup" : "merged";
        } else if (worktree.prState === "open") {
          lifecycleStage = "in-review";
        }
      }

      const hasWorkingAgent = worktreeTerminals.some((t) => t.agentState === "working");
      const hasRunningAgent = worktreeTerminals.some((t) => t.agentState === "running");

      const chipState = computeChipState({
        waitingTerminalCount,
        lifecycleStage,
        isComplete,
        hasActiveAgent: hasWorkingAgent || hasRunningAgent,
      });

      map.set(worktree.id, {
        terminalCount: worktreeTerminals.length,
        hasWorkingAgent,
        hasRunningAgent,
        hasWaitingAgent: worktreeTerminals.some((t) => t.agentState === "waiting"),
        hasCompletedAgent: worktreeTerminals.some((t) => t.agentState === "completed"),
        hasMergeConflict:
          worktree.worktreeChanges?.changes.some((c) => c.status === "conflicted") ?? false,
        chipState,
      });
    }
    return map;
  }, [deferredWorktrees, terminals, getWorktreeErrors]);

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
    const counts = { working: 0, waiting: 0, finished: 0 };
    for (const w of deferredWorktrees) {
      if (w.id === mainWorktree?.id || w.id === integrationWorktree?.id) continue;
      const meta = derivedMetaMap.get(w.id);
      if (!meta) continue;
      if (matchesQuickStateFilter("working", meta)) counts.working++;
      if (matchesQuickStateFilter("waiting", meta)) counts.waiting++;
      if (matchesQuickStateFilter("finished", meta)) counts.finished++;
    }
    return counts;
  }, [deferredWorktrees, derivedMetaMap, mainWorktree, integrationWorktree]);

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

  const { filteredWorktrees, groupedSections } = useMemo(() => {
    const filters: FilterState = {
      query,
      statusFilters,
      typeFilters,
      githubFilters,
      sessionFilters,
      activityFilters,
    };

    // Filter non-main worktrees only (exclude main and integration by ID)
    const nonMain = deferredWorktrees.filter(
      (w) => w.id !== mainWorktree?.id && w.id !== integrationWorktree?.id
    );
    const filtered = nonMain.filter((worktree) => {
      const derived = derivedMetaMap.get(worktree.id) ?? {
        terminalCount: 0,
        hasWorkingAgent: false,
        hasRunningAgent: false,
        hasWaitingAgent: false,
        hasCompletedAgent: false,
        hasMergeConflict: false,
        chipState: null,
      };
      const isActive = worktree.id === activeWorktreeId;
      const hasActiveQuery = query.trim().length > 0;

      if (alwaysShowActive && isActive && !hasActiveQuery && quickStateFilter === "all") {
        return true;
      }

      if (
        alwaysShowWaiting &&
        derived.hasWaitingAgent &&
        !hasActiveQuery &&
        quickStateFilter === "all"
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
      };
    }

    return { filteredWorktrees: sorted, groupedSections: null };
  }, [
    deferredWorktrees,
    query,
    orderBy,
    isGroupedByType,
    statusFilters,
    typeFilters,
    githubFilters,
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
  ]);

  const updateScrollIndicators = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const totalItems = filteredWorktrees.length;

    if (scrollHeight <= clientHeight + 1) {
      setHiddenAbove(0);
      setHiddenBelow(0);
      return;
    }

    const scrollableHeight = scrollHeight - clientHeight;
    if (scrollableHeight <= 0) {
      setHiddenAbove(0);
      setHiddenBelow(0);
      return;
    }

    const scrollFraction = Math.min(1, Math.max(0, scrollTop / scrollableHeight));
    const visibleFraction = clientHeight / scrollHeight;
    const approxVisible = Math.max(1, Math.round(totalItems * visibleFraction));
    const totalHidden = Math.max(0, totalItems - approxVisible);

    const above = Math.round(totalHidden * scrollFraction);
    const below = totalHidden - above;

    setHiddenAbove(above);
    setHiddenBelow(below);
  }, [filteredWorktrees.length]);

  useLayoutEffect(() => {
    updateScrollIndicators();
  }, [updateScrollIndicators, filteredWorktrees, groupedSections]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    const content = scrollContentRef.current;
    if (!container) return;

    let rafId: number | null = null;
    const handleScroll = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        updateScrollIndicators();
        rafId = null;
      });
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    const resizeObserver = new ResizeObserver(() => updateScrollIndicators());
    resizeObserver.observe(container);
    if (content) resizeObserver.observe(content);

    return () => {
      container.removeEventListener("scroll", handleScroll);
      if (rafId !== null) cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
    };
  }, [updateScrollIndicators]);

  const scrollToTop = useCallback(() => {
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    }
  }, []);

  const handleOpenRecipeEditor = useCallback(
    (worktreeId: string, initialTerminals?: RecipeTerminal[]) => {
      setRecipeEditorWorktreeId(worktreeId);
      setRecipeEditorInitialTerminals(initialTerminals);
      setIsRecipeEditorOpen(true);
    },
    []
  );

  useEffect(() => {
    const handleOpenRecipeEditorEvent = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as unknown;
      if (!detail) return;
      const d = detail as { worktreeId?: unknown; recipeId?: unknown; initialTerminals?: unknown };

      // If recipeId is provided, open the editor for that recipe
      if (typeof d.recipeId === "string") {
        const recipe = useRecipeStore.getState().getRecipeById(d.recipeId);
        if (recipe) {
          setIsRecipeManagerOpen(false);
          setRecipeEditorWorktreeId(recipe.worktreeId);
          setRecipeEditorDefaultScope(recipe.projectId === undefined ? "global" : "project");
          setRecipeEditorInitialTerminals(undefined);
          recipeManagerEditRef.current = recipe;
          setIsRecipeEditorOpen(true);
          return;
        }
      }

      if (typeof d.worktreeId !== "string") return;
      const worktreeId = d.worktreeId;
      const initialTerminals = Array.isArray(d.initialTerminals)
        ? (d.initialTerminals as RecipeTerminal[])
        : undefined;
      handleOpenRecipeEditor(worktreeId, initialTerminals);
    };

    const controller = new AbortController();
    window.addEventListener("canopy:open-recipe-editor", handleOpenRecipeEditorEvent, {
      signal: controller.signal,
    });
    return () => controller.abort();
  }, [handleOpenRecipeEditor]);

  useEffect(() => {
    const handleOpenRecipeManagerEvent = () => {
      setIsRecipeManagerOpen(true);
    };
    const controller = new AbortController();
    window.addEventListener("canopy:open-recipe-manager", handleOpenRecipeManagerEvent, {
      signal: controller.signal,
    });
    return () => controller.abort();
  }, []);

  const handleCloseRecipeManager = useCallback(() => {
    setIsRecipeManagerOpen(false);
  }, []);

  const handleRecipeManagerEdit = useCallback((recipe: import("@/types").TerminalRecipe) => {
    setIsRecipeManagerOpen(false);
    setRecipeEditorWorktreeId(recipe.worktreeId);
    setRecipeEditorDefaultScope(recipe.projectId === undefined ? "global" : "project");
    setRecipeEditorInitialTerminals(undefined);
    // Small delay to let the manager dialog close first
    setTimeout(() => {
      setIsRecipeEditorOpen(true);
    }, 100);
    // Store the recipe to edit via a ref-like approach by setting it directly
    recipeManagerEditRef.current = recipe;
  }, []);

  const handleRecipeManagerCreate = useCallback((scope: "global" | "project") => {
    setIsRecipeManagerOpen(false);
    setRecipeEditorDefaultScope(scope);
    setRecipeEditorWorktreeId(undefined);
    setRecipeEditorInitialTerminals(undefined);
    recipeManagerEditRef.current = undefined;
    setTimeout(() => {
      setIsRecipeEditorOpen(true);
    }, 100);
  }, []);

  const worktreeActions = useWorktreeActions({
    onOpenRecipeEditor: handleOpenRecipeEditor,
    launchAgent,
  });

  const handleCloseRecipeEditor = useCallback(() => {
    setIsRecipeEditorOpen(false);
    setRecipeEditorWorktreeId(undefined);
    setRecipeEditorInitialTerminals(undefined);
    setRecipeEditorDefaultScope(undefined);
    recipeManagerEditRef.current = undefined;
  }, []);

  const sortableIds = useMemo(
    () => filteredWorktrees.map((w) => getWorktreeSortDragId(w.id)),
    [filteredWorktrees]
  );

  const dragStartOrder = useMemo(() => filteredWorktrees.map((w) => w.id), [filteredWorktrees]);

  if (isLoading && worktrees.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center px-4 py-4 border-b border-divider shrink-0">
          <h2 className="text-canopy-text font-semibold text-sm tracking-wide">Worktrees</h2>
        </div>
        <div className="px-4 py-4 text-canopy-text/60 text-sm">Loading worktrees...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center px-4 py-4 border-b border-divider shrink-0">
          <h2 className="text-canopy-text font-semibold text-sm tracking-wide">Worktrees</h2>
        </div>
        <div className="px-4 py-4">
          <div className="text-[var(--color-status-error)] text-sm mb-2">{error}</div>
          <button
            onClick={refresh}
            className="text-xs px-2 py-1 border border-divider rounded hover:bg-tint/[0.06] text-canopy-text"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (worktrees.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center px-4 py-4 border-b border-divider shrink-0">
          <h2 className="text-canopy-text font-semibold text-sm tracking-wide">Worktrees</h2>
        </div>

        <div className="flex flex-col items-center justify-center py-12 px-4 text-center flex-1">
          <FolderOpen className="w-12 h-12 text-canopy-text/60 mb-3" aria-hidden="true" />

          <h3 className="text-canopy-text font-medium mb-2">No worktrees yet</h3>

          <p className="text-sm text-canopy-text/60 mb-4 max-w-xs">
            Open a Git repository with worktrees to get started. Use{" "}
            <kbd className="px-1.5 py-0.5 bg-tint/[0.06] rounded text-xs">
              File → Open Directory
            </kbd>
          </p>

          <div className="text-xs text-canopy-text/60 text-left w-full max-w-xs">
            <div className="font-medium mb-1">Quick Start:</div>
            <ol className="space-y-1 list-decimal list-inside">
              <li>Open a repository</li>
              <li>Launch an agent</li>
              <li>Inject context to AI agent</li>
            </ol>
          </div>
        </div>
      </div>
    );
  }

  const rootPath = currentProject?.path ?? "";
  const hasNonMainWorktrees = deferredWorktrees.length > 1;
  const hasQuickFilter = quickStateFilter !== "all";
  const hasFilters = hasActiveFilters() || hasQuickFilter;
  const worktreeMatchesQuery = (w: WorktreeState) => {
    if (!query) return true;
    const exactNum = parseExactNumber(query);
    if (exactNum !== null) {
      return w.issueNumber === exactNum || w.prNumber === exactNum;
    }
    return scoreWorktree(w, query) > 0;
  };
  const mainMatchesQuery = mainWorktree && worktreeMatchesQuery(mainWorktree);
  const integrationMatchesQuery = integrationWorktree && worktreeMatchesQuery(integrationWorktree);
  const visibleCount = hasFilters
    ? filteredWorktrees.length + (mainMatchesQuery ? 1 : 0) + (integrationMatchesQuery ? 1 : 0)
    : deferredWorktrees.length;

  const hasQuery = query.trim().length > 0;
  const isSortDisabled = isGroupedByType || hasQuery;

  const renderWorktreeCard = (worktree: WorktreeState) => (
    <StaticWorktreeRow
      key={worktree.id}
      worktreeId={worktree.id}
      activeWorktreeId={activeWorktreeId}
      focusedWorktreeId={focusedWorktreeId}
      totalWorktreeCount={deferredWorktrees.length}
      selectWorktree={selectWorktree}
      worktreeActions={worktreeActions}
      availability={availability}
      agentSettings={agentSettings}
      homeDir={homeDir}
    />
  );

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={300}>
      <div className="flex flex-col h-full">
        {/* Header Section */}
        <div className="group/header flex items-center justify-between px-4 py-2 border-b border-divider bg-transparent shrink-0">
          <div className="flex items-baseline gap-1.5">
            <h2 className="text-canopy-text font-semibold text-sm tracking-wide">Worktrees</h2>
            <span className="text-canopy-text/50 text-xs">
              {hasFilters && visibleCount !== deferredWorktrees.length
                ? `(${visibleCount} of ${deferredWorktrees.length})`
                : `(${deferredWorktrees.length})`}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <div className="invisible group-hover/header:visible group-focus-within/header:visible flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={onOpenOverview}
                    className="p-1 text-canopy-text/40 hover:text-canopy-text hover:bg-tint/[0.06] rounded transition-colors"
                    aria-label="Open worktrees overview"
                  >
                    <LayoutGrid className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {createTooltipWithShortcut("Open worktrees overview", "Cmd+Shift+O")}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() =>
                      actionService.dispatch("terminal.bulkCommand", undefined, {
                        source: "user",
                      })
                    }
                    className="p-1 text-canopy-text/40 hover:text-canopy-text hover:bg-tint/[0.06] rounded transition-colors"
                    aria-label="Bulk Operations"
                  >
                    <Radio className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {createTooltipWithShortcut("Bulk Operations", "Cmd+Shift+B")}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleRefreshAll}
                    disabled={isRefreshing}
                    className="p-1 text-canopy-text/40 hover:text-canopy-text hover:bg-tint/[0.06] rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    aria-label="Refresh sidebar"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Refresh sidebar</TooltipContent>
              </Tooltip>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() =>
                    actionService.dispatch("worktree.createDialog.open", undefined, {
                      source: "user",
                    })
                  }
                  className="p-1 text-canopy-text/40 hover:text-canopy-text hover:bg-tint/[0.06] rounded transition-colors"
                  aria-label="Create new worktree"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Create new worktree</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Inline search bar — only when there are non-main worktrees */}
        {hasNonMainWorktrees && <WorktreeSidebarSearchBar inputRef={searchInputRef} />}

        {/* Main worktree — visible unless excluded by text search */}
        {mainMatchesQuery && (
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
            />
          </div>
        )}

        {/* Integration branch (develop/trunk/next) — pinned below main, subject to text search */}
        {integrationMatchesQuery && (
          <div
            className="shrink-0"
            style={{ contentVisibility: "auto", containIntrinsicSize: "auto 180px" }}
          >
            {renderWorktreeCard(integrationWorktree)}
          </div>
        )}

        {/* Strong divider between pinned worktrees and scrollable list */}
        {hasNonMainWorktrees && <div className="shrink-0 border-b border-border-default" />}

        {/* Non-main worktree list */}
        <div className="relative flex-1 min-h-0">
          <div ref={scrollContainerRef} className="h-full overflow-y-auto scrollbar-none">
            <div ref={scrollContentRef}>
              {hasNonMainWorktrees && (
                <QuickStateFilterBar
                  value={quickStateFilter}
                  onChange={setQuickStateFilter}
                  counts={quickStateCounts}
                />
              )}
              {filteredWorktrees.length === 0 && hasFilters && hasNonMainWorktrees ? (
                <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                  <FilterX className="w-10 h-10 text-canopy-text/40 mb-3" />
                  <p className="text-sm text-canopy-text/60 mb-3">
                    No worktrees match your filters
                  </p>
                  <button
                    onClick={() => {
                      clearAllFilters();
                      setQuickStateFilter("all");
                    }}
                    className="text-xs px-3 py-1.5 text-canopy-accent hover:bg-canopy-accent/10 rounded transition-colors"
                  >
                    Clear filters
                  </button>
                </div>
              ) : groupedSections ? (
                <div className="flex flex-col">
                  {groupedSections.map((section) => (
                    <div key={section.type}>
                      <div className="sticky top-0 z-10 px-4 py-2 text-[10px] font-medium text-canopy-text/50 uppercase tracking-wide bg-canopy-sidebar border-b border-divider">
                        {section.displayName} ({section.worktrees.length})
                      </div>
                      {section.worktrees.map(renderWorktreeCard)}
                    </div>
                  ))}
                </div>
              ) : (
                <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
                  <div className="flex flex-col">
                    {filteredWorktrees.map((worktree) => {
                      const isPinned = pinnedWorktrees.includes(worktree.id);
                      return (
                        <SidebarWorktreeRow
                          key={worktree.id}
                          worktreeId={worktree.id}
                          activeWorktreeId={activeWorktreeId}
                          focusedWorktreeId={focusedWorktreeId}
                          totalWorktreeCount={deferredWorktrees.length}
                          selectWorktree={selectWorktree}
                          worktreeActions={worktreeActions}
                          availability={availability}
                          agentSettings={agentSettings}
                          homeDir={homeDir}
                          dragStartOrder={dragStartOrder}
                          isSortDisabled={isSortDisabled}
                          isPinned={isPinned}
                        />
                      );
                    })}
                  </div>
                </SortableContext>
              )}
            </div>
          </div>
          <ScrollIndicator direction="above" count={hiddenAbove} onClick={scrollToTop} />
          <ScrollIndicator direction="below" count={hiddenBelow} onClick={scrollToBottom} />
        </div>

        <RecipeEditor
          recipe={recipeManagerEditRef.current}
          worktreeId={recipeEditorWorktreeId}
          initialTerminals={recipeEditorInitialTerminals}
          defaultScope={recipeEditorDefaultScope}
          isOpen={isRecipeEditorOpen}
          onClose={handleCloseRecipeEditor}
        />

        <RecipeManager
          isOpen={isRecipeManagerOpen}
          onClose={handleCloseRecipeManager}
          onEditRecipe={handleRecipeManagerEdit}
          onCreateRecipe={handleRecipeManagerCreate}
        />

        {rootPath && (createDialog.isOpen || hasOpenedNewWorktree) && (
          <Suspense fallback={null}>
            <LazyNewWorktreeDialog
              isOpen={createDialog.isOpen}
              onClose={closeCreateDialog}
              rootPath={rootPath}
              onWorktreeCreated={(worktreeId) => {
                refresh();
                createDialog.onCreated?.(worktreeId);
              }}
              initialIssue={createDialog.initialIssue}
              initialPR={createDialog.initialPR}
              initialRecipeId={createDialog.initialRecipeId}
            />
          </Suspense>
        )}

        <BulkCreateWorktreeDialog
          isOpen={bulkCreateDialog.isOpen}
          onClose={closeBulkCreateDialog}
          mode={bulkCreateDialog.mode}
          selectedIssues={bulkCreateDialog.selectedIssues}
          selectedPRs={bulkCreateDialog.selectedPRs}
          onComplete={closeBulkCreateDialog}
        />
      </div>
    </TooltipProvider>
  );
}

function E2EFaultInjector() {
  const [, setTick] = useState(0);

  useEffect(() => {
    const handler = () => setTick((t) => t + 1);
    window.addEventListener("__canopy_e2e_trigger_render__", handler);
    return () => window.removeEventListener("__canopy_e2e_trigger_render__", handler);
  }, []);

  if (window.__CANOPY_E2E_FAULT__?.renderError) {
    throw new Error("E2E_FAULT_INJECTION");
  }
  return null;
}

function App() {
  useErrors();
  useHibernationNotifications();
  useDiskSpaceWarnings();
  useUnloadCleanup();
  useResourceProfile();

  useEffect(() => {
    window.__CANOPY_E2E_ERROR_STORE__ = () =>
      useErrorStore.getState().errors.map((e) => ({
        id: e.id,
        source: e.source,
        message: e.message,
        fromPreviousSession: e.fromPreviousSession,
      }));
    window.__CANOPY_E2E_ADD_ERROR__ = (message: string) => {
      useErrorStore.getState().addError({
        type: "unknown",
        message,
        isTransient: false,
        source: "e2e-test",
      });
    };
    window.__CANOPY_E2E_CLEAR_ERRORS__ = () => {
      useErrorStore.getState().clearAll();
    };
    return () => {
      delete window.__CANOPY_E2E_ERROR_STORE__;
      delete window.__CANOPY_E2E_ADD_ERROR__;
      delete window.__CANOPY_E2E_CLEAR_ERRORS__;
    };
  }, []);

  const { crossDiffDialog, closeCrossWorktreeDiff } = useWorktreeSelectionStore(
    useShallow((state) => ({
      crossDiffDialog: state.crossDiffDialog,
      closeCrossWorktreeDiff: state.closeCrossWorktreeDiff,
    }))
  );

  const { focusedId, addTerminal } = useTerminalStore(
    useShallow((state) => ({
      focusedId: state.focusedId,
      addTerminal: state.addTerminal,
    }))
  );

  const { launchAgent, availability, agentSettings, refreshSettings } = useAgentLauncher();

  useTerminalConfig();
  useAppThemeConfig();
  useWindowNotifications();
  useWatchedPanelNotifications();
  const reEntrySummary = useReEntrySummary();
  useMainProcessToastListener();

  useMcpBridge();
  useSoundPlaybackListener();
  const { homeDir } = useHomeDir();

  // Grid navigation hook for directional terminal switching
  const { findNearest, findByIndex, findDockByIndex, getCurrentLocation } = useGridNavigation();

  const { worktrees, worktreeMap } = useWorktrees();
  const newTerminalPalette = useNewTerminalPalette({ launchAgent, worktreeMap });
  const panelPalette = usePanelPalette();
  const projectSwitcherPalette = useProjectSwitcherPalette();
  const actionPalette = useActionPalette();
  const quickSwitcher = useQuickSwitcher();
  const sendToAgentPalette = useSendToAgentPalette();
  useDoubleShift(actionPalette.toggle);
  const currentProject = useProjectStore((state) => state.currentProject);
  const gitInitDialogOpen = useProjectStore((state) => state.gitInitDialogOpen);
  const gitInitDirectoryPath = useProjectStore((state) => state.gitInitDirectoryPath);
  const closeGitInitDialog = useProjectStore((state) => state.closeGitInitDialog);
  const handleGitInitSuccess = useProjectStore((state) => state.handleGitInitSuccess);
  const onboardingWizardOpen = useProjectStore((state) => state.onboardingWizardOpen);
  const onboardingProjectId = useProjectStore((state) => state.onboardingProjectId);
  const closeOnboardingWizard = useProjectStore((state) => state.closeOnboardingWizard);

  const createFolderDialogOpen = useProjectStore((state) => state.createFolderDialogOpen);
  const closeCreateFolderDialog = useProjectStore((state) => state.closeCreateFolderDialog);
  const openCreateFolderDialog = useProjectStore((state) => state.openCreateFolderDialog);

  const cloneRepoDialogOpen = useProjectStore((state) => state.cloneRepoDialogOpen);
  const closeCloneRepoDialog = useProjectStore((state) => state.closeCloneRepoDialog);
  const handleCloneSuccess = useProjectStore((state) => state.handleCloneSuccess);
  const { selectWorktree, activeWorktreeId, focusedWorktreeId } = useWorktreeSelectionStore(
    useShallow((state) => ({
      selectWorktree: state.selectWorktree,
      activeWorktreeId: state.activeWorktreeId,
      focusedWorktreeId: state.focusedWorktreeId,
    }))
  );

  const { activeWorktree, defaultTerminalCwd } = useActiveWorktreeSync();

  const worktreePalette = useWorktreePalette({ worktrees });
  const quickCreatePalette = useQuickCreatePalette();

  const {
    isSettingsOpen,
    settingsTab,
    settingsSubtab,
    settingsSectionId,
    handleSettings,
    handleOpenSettingsTab,
    setIsSettingsOpen,
  } = useSettingsDialog();
  const [hasOpenedSettings, setHasOpenedSettings] = useState(false);
  useEffect(() => {
    if (isSettingsOpen) setHasOpenedSettings(true);
  }, [isSettingsOpen]);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const isNotesPaletteOpen = usePaletteStore((state) => state.activePaletteId === "notes");
  const {
    isWorktreeOverviewOpen,
    toggleWorktreeOverview,
    openWorktreeOverview,
    closeWorktreeOverview,
  } = useWorktreeOverview();
  const onLayoutRender = useRenderProfiler("app-layout", { sampleRate: 0.15 });
  const onContentGridRender = useRenderProfiler("content-grid", { sampleRate: 0.15 });

  usePerformanceMonitors();

  // Crash recovery gate — must resolve before hydration runs
  const {
    state: crashState,
    resolve: resolveCrash,
    updateConfig: updateCrashConfig,
  } = useCrashRecoveryGate();

  const crashResolved = crashState.status !== "loading" && crashState.status !== "pending";

  // App lifecycle hooks
  const { isStateLoaded } = useAppHydration(crashResolved);
  useEffect(() => {
    if (isStateLoaded) removeStartupSkeleton();
  }, [isStateLoaded]);
  useEffect(() => {
    useNotificationSettingsStore.getState().hydrate();
  }, []);
  useProjectSwitchRehydration();
  useShortcutHints(isStateLoaded);
  const gettingStarted = useGettingStartedChecklist(isStateLoaded);
  const onboardingOverlayActive = gettingStarted.visible || gettingStarted.showCelebration;
  useUpdateListener(onboardingOverlayActive);
  useOrchestrationMilestones(isStateLoaded);
  useAgentWaitingNudge(isStateLoaded);

  useEffect(() => {
    if (!isStateLoaded) return;
    const id = requestIdleCallback(
      () => {
        preloadSettingsDialog();
        preloadNewWorktreeDialog();
      },
      { timeout: 5000 }
    );
    return () => cancelIdleCallback(id);
  }, [isStateLoaded]);

  const handlePreloadSettings = useCallback(() => {
    preloadSettingsDialog();
  }, []);

  const handleLaunchAgent = useCallback(
    async (type: string) => {
      await launchAgent(type);
    },
    [launchAgent]
  );

  const handleWizardFinish = useCallback(() => {
    const defaultAgent = useAgentPreferencesStore.getState().defaultAgent;
    const selected = agentSettings?.agents
      ? Object.entries(agentSettings.agents)
          .filter(([, entry]) => entry.selected === true)
          .map(([id]) => id)
      : [];
    const primaryAgent = defaultAgent ?? selected[0];

    if (primaryAgent && availability[primaryAgent]) {
      launchAgent(primaryAgent, {
        worktreeId: activeWorktreeId ?? undefined,
      }).catch(() => {});
    }
  }, [launchAgent, activeWorktreeId, availability, agentSettings]);

  const closeNotesPalette = useCallback(() => {
    usePaletteStore.getState().closePalette("notes");
  }, []);

  const overviewWorktreeActions = useWorktreeActions({ launchAgent });

  useAppEventListeners();

  const { handleErrorRetry, handleCancelRetry } = useErrorRetry();

  const electronAvailable = isElectronAvailable();
  const { inject } = useContextInjection();

  const handleToggleSidebar = useCallback(() => {
    const activeWtId = useWorktreeSelectionStore.getState().activeWorktreeId;
    const gridIds = useTerminalStore
      .getState()
      .terminals.filter((t) => t.location !== "dock" && t.worktreeId === activeWtId)
      .map((t) => t.id);
    terminalInstanceService.suppressResizesDuringLayoutTransition(gridIds, SIDEBAR_TOGGLE_LOCK_MS);
    window.dispatchEvent(new CustomEvent("canopy:toggle-focus-mode"));
  }, []);

  useActionRegistry({
    onOpenSettings: handleSettings,
    onOpenSettingsTab: handleOpenSettingsTab,
    onToggleSidebar: handleToggleSidebar,
    onToggleFocusMode: handleToggleSidebar,
    onFocusRegionNext: () => useMacroFocusStore.getState().cycleNext(),
    onFocusRegionPrev: () => useMacroFocusStore.getState().cyclePrev(),
    onOpenActionPalette: actionPalette.open,
    onOpenQuickSwitcher: quickSwitcher.open,
    onOpenWorktreePalette: worktreePalette.open,
    onOpenQuickCreatePalette: quickCreatePalette.open,
    onToggleWorktreeOverview: toggleWorktreeOverview,
    onOpenWorktreeOverview: openWorktreeOverview,
    onCloseWorktreeOverview: closeWorktreeOverview,
    onOpenPanelPalette: panelPalette.open,
    onOpenProjectSwitcherPalette: projectSwitcherPalette.open,
    onOpenShortcuts: () => setIsShortcutsOpen(true),
    onLaunchAgent: async (agentId, options) => {
      return launchAgent(agentId, options);
    },
    onInject: inject,
    getDefaultCwd: () => defaultTerminalCwd,
    getActiveWorktreeId: () => activeWorktree?.id,
    getWorktrees: () => worktrees,
    getFocusedId: () => focusedId,
    getIsSettingsOpen: () => isSettingsOpen,
    getGridNavigation: () => ({ findNearest, findByIndex, findDockByIndex, getCurrentLocation }),
  });

  useMenuActions({
    onOpenSettings: handleSettings,
    onOpenSettingsTab: handleOpenSettingsTab,
    onToggleSidebar: handleToggleSidebar,
    onLaunchAgent: handleLaunchAgent,
    defaultCwd: defaultTerminalCwd,
    activeWorktreeId: activeWorktree?.id,
  });

  // Global keybinding handler - provides chord support and priority resolution
  // All keybindings dispatch through ActionService via this centralized handler
  useGlobalKeybindings(electronAvailable);
  useGlobalEscapeDispatcher();

  // App lifecycle hooks
  useTerminalStoreBootstrap();
  useSemanticWorkerLifecycle();
  useSystemWakeHandler();
  useCloudSyncWarning(homeDir);
  useAccessibilityAnnouncements();

  useEffect(() => {
    voiceRecordingService.initialize();
  }, []);

  useFileDropGuard();

  const isSafeMode = useSafeModeStore((s) => s.safeMode);

  if (!isElectronAvailable()) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-canopy-bg">
        <div className="text-canopy-text/60 text-sm">
          Electron API not available - please run in Electron
        </div>
      </div>
    );
  }

  if (crashState.status === "pending") {
    return (
      <div className="h-screen w-screen bg-canopy-bg">
        <CrashRecoveryDialog
          crash={crashState.crash}
          config={crashState.config}
          onResolve={resolveCrash}
          onUpdateConfig={updateCrashConfig}
        />
      </div>
    );
  }

  if (!crashResolved || !isStateLoaded) {
    return <div className="h-screen w-screen bg-canopy-bg" />;
  }

  return (
    <ErrorBoundary variant="fullscreen" componentName="App">
      <E2EFaultInjector />
      {isSafeMode && <SafeModeBanner />}
      <DndProvider>
        <VoiceRecordingAnnouncer />
        <AccessibilityAnnouncer />
        <Profiler id="app-layout" onRender={onLayoutRender}>
          <AppLayout
            sidebarContent={<SidebarContent onOpenOverview={openWorktreeOverview} />}
            onLaunchAgent={handleLaunchAgent}
            onSettings={handleSettings}
            onPreloadSettings={handlePreloadSettings}
            onRetry={handleErrorRetry}
            onCancelRetry={handleCancelRetry}
            agentAvailability={availability}
            agentSettings={agentSettings}
            isHydrated={isStateLoaded}
            projectSwitcherPalette={projectSwitcherPalette}
          >
            <Profiler id="content-grid" onRender={onContentGridRender}>
              <ContentGrid
                className="h-full w-full"
                agentAvailability={availability}
                defaultCwd={defaultTerminalCwd}
                emptyContent={
                  currentProject === null ? (
                    <WelcomeScreen gettingStarted={gettingStarted} />
                  ) : undefined
                }
              />
            </Profiler>
          </AppLayout>
        </Profiler>
      </DndProvider>

      <QuickSwitcher
        isOpen={quickSwitcher.isOpen}
        query={quickSwitcher.query}
        results={quickSwitcher.results}
        totalResults={quickSwitcher.totalResults}
        selectedIndex={quickSwitcher.selectedIndex}
        close={quickSwitcher.close}
        setQuery={quickSwitcher.setQuery}
        selectPrevious={quickSwitcher.selectPrevious}
        selectNext={quickSwitcher.selectNext}
        selectItem={quickSwitcher.selectItem}
        confirmSelection={quickSwitcher.confirmSelection}
      />
      <SendToAgentPalette
        isOpen={sendToAgentPalette.isOpen}
        query={sendToAgentPalette.query}
        results={sendToAgentPalette.results}
        totalResults={sendToAgentPalette.totalResults}
        selectedIndex={sendToAgentPalette.selectedIndex}
        close={sendToAgentPalette.close}
        setQuery={sendToAgentPalette.setQuery}
        selectPrevious={sendToAgentPalette.selectPrevious}
        selectNext={sendToAgentPalette.selectNext}
        selectItem={sendToAgentPalette.selectItem}
        confirmSelection={sendToAgentPalette.confirmSelection}
      />
      <BulkCommandPalette />
      <NewTerminalPalette
        isOpen={newTerminalPalette.isOpen}
        query={newTerminalPalette.query}
        results={newTerminalPalette.results}
        totalResults={newTerminalPalette.totalResults}
        selectedIndex={newTerminalPalette.selectedIndex}
        onQueryChange={newTerminalPalette.setQuery}
        onSelectPrevious={newTerminalPalette.selectPrevious}
        onSelectNext={newTerminalPalette.selectNext}
        onSelect={newTerminalPalette.handleSelect}
        onConfirm={newTerminalPalette.confirmSelection}
        onClose={newTerminalPalette.close}
      />
      <WorktreePalette
        isOpen={worktreePalette.isOpen}
        query={worktreePalette.query}
        results={worktreePalette.results}
        totalResults={worktreePalette.totalResults}
        activeWorktreeId={worktreePalette.activeWorktreeId}
        selectedIndex={worktreePalette.selectedIndex}
        onQueryChange={worktreePalette.setQuery}
        onSelectPrevious={worktreePalette.selectPrevious}
        onSelectNext={worktreePalette.selectNext}
        onSelect={worktreePalette.selectWorktree}
        onConfirm={worktreePalette.confirmSelection}
        onClose={worktreePalette.close}
      />
      <QuickCreatePalette palette={quickCreatePalette} />
      <PanelPalette
        isOpen={panelPalette.isOpen}
        query={panelPalette.query}
        results={panelPalette.results}
        totalResults={panelPalette.totalResults}
        selectedIndex={panelPalette.selectedIndex}
        onQueryChange={panelPalette.setQuery}
        onSelectPrevious={panelPalette.selectPrevious}
        onSelectNext={panelPalette.selectNext}
        onSelect={(kind) => {
          const result = panelPalette.handleSelect(kind);
          if (!result) return;
          if (result.resumeSession) {
            const session = result.resumeSession;
            const agentConfig = getEffectiveAgentConfig(session.agentId);
            const command = buildResumeCommand(
              session.agentId,
              session.sessionId,
              session.agentLaunchFlags
            );
            if (command && agentConfig) {
              addTerminal({
                kind: "agent",
                type: session.agentId as TerminalType,
                agentId: session.agentId,
                title: agentConfig.name,
                cwd: defaultTerminalCwd,
                worktreeId: activeWorktreeId ?? undefined,
                command,
                location: "grid",
              });
            }
          } else if (result.id.startsWith("agent:")) {
            const agentId = result.id.slice("agent:".length);
            if (agentId) {
              launchAgent(agentId);
            }
          } else {
            addTerminal({
              kind: result.id as PanelKind,
              cwd: defaultTerminalCwd,
              worktreeId: activeWorktreeId ?? undefined,
              location: "grid",
            });
          }
        }}
        onConfirm={() => {
          const selected = panelPalette.confirmSelection();
          if (!selected) return;
          if (selected.id === MORE_AGENTS_PANEL_ID) return;
          if (selected.resumeSession) {
            const session = selected.resumeSession;
            const agentConfig = getEffectiveAgentConfig(session.agentId);
            const command = buildResumeCommand(
              session.agentId,
              session.sessionId,
              session.agentLaunchFlags
            );
            if (command && agentConfig) {
              addTerminal({
                kind: "agent",
                type: session.agentId as TerminalType,
                agentId: session.agentId,
                title: agentConfig.name,
                cwd: defaultTerminalCwd,
                worktreeId: activeWorktreeId ?? undefined,
                command,
                location: "grid",
              });
            }
          } else if (selected.id.startsWith("agent:")) {
            const agentId = selected.id.slice("agent:".length);
            if (agentId) {
              launchAgent(agentId);
            }
          } else {
            addTerminal({
              kind: selected.id as PanelKind,
              cwd: defaultTerminalCwd,
              worktreeId: activeWorktreeId ?? undefined,
              location: "grid",
            });
          }
        }}
        onClose={panelPalette.close}
      />
      <ProjectSwitcherPalette
        isOpen={projectSwitcherPalette.isOpen && projectSwitcherPalette.mode === "modal"}
        query={projectSwitcherPalette.query}
        results={projectSwitcherPalette.results}
        selectedIndex={projectSwitcherPalette.selectedIndex}
        onQueryChange={projectSwitcherPalette.setQuery}
        onSelectPrevious={projectSwitcherPalette.selectPrevious}
        onSelectNext={projectSwitcherPalette.selectNext}
        onSelect={projectSwitcherPalette.selectProject}
        onClose={projectSwitcherPalette.close}
        onAddProject={projectSwitcherPalette.addProject}
        onCreateFolder={() => {
          projectSwitcherPalette.close();
          openCreateFolderDialog();
        }}
        onStopProject={(projectId) => projectSwitcherPalette.stopProject(projectId)}
        onCloseProject={(projectId) => projectSwitcherPalette.removeProject(projectId)}
        onTogglePinProject={(projectId) => projectSwitcherPalette.togglePinProject(projectId)}
        onOpenProjectSettings={() => {
          projectSwitcherPalette.close();
          void actionService.dispatch("project.settings.open", undefined, { source: "user" });
        }}
        removeConfirmProject={projectSwitcherPalette.removeConfirmProject}
        onRemoveConfirmClose={() => projectSwitcherPalette.setRemoveConfirmProject(null)}
        onConfirmRemove={projectSwitcherPalette.confirmRemoveProject}
        isRemovingProject={projectSwitcherPalette.isRemovingProject}
        onSelectNewWindow={(project) => {
          projectSwitcherPalette.close();
          void actionService.dispatch(
            "app.newWindow",
            { projectPath: project.path },
            { source: "user" }
          );
        }}
      />
      <ConfirmDialog
        isOpen={projectSwitcherPalette.stopConfirmProjectId != null}
        onClose={() => {
          if (projectSwitcherPalette.isStoppingProject) return;
          projectSwitcherPalette.setStopConfirmProjectId(null);
        }}
        title={`Stop project?`}
        description="This will terminate all running sessions in this project. This can't be undone."
        confirmLabel="Stop project"
        cancelLabel="Cancel"
        onConfirm={projectSwitcherPalette.confirmStopProject}
        isConfirmLoading={projectSwitcherPalette.isStoppingProject}
        variant="destructive"
      />

      <NotesPalette isOpen={isNotesPaletteOpen} onClose={closeNotesPalette} />

      <ActionPalette
        isOpen={actionPalette.isOpen}
        query={actionPalette.query}
        results={actionPalette.results}
        totalResults={actionPalette.totalResults}
        selectedIndex={actionPalette.selectedIndex}
        close={actionPalette.close}
        setQuery={actionPalette.setQuery}
        selectPrevious={actionPalette.selectPrevious}
        selectNext={actionPalette.selectNext}
        executeAction={actionPalette.executeAction}
        confirmSelection={actionPalette.confirmSelection}
      />

      <WorktreeOverviewModal
        isOpen={isWorktreeOverviewOpen}
        onClose={closeWorktreeOverview}
        worktrees={worktrees}
        activeWorktreeId={activeWorktreeId}
        focusedWorktreeId={focusedWorktreeId}
        onSelectWorktree={selectWorktree}
        onCopyTree={overviewWorktreeActions.handleCopyTree}
        onOpenEditor={overviewWorktreeActions.handleOpenEditor}
        onSaveLayout={undefined}
        onLaunchAgent={overviewWorktreeActions.handleLaunchAgent}
        agentAvailability={availability}
        agentSettings={agentSettings}
        homeDir={homeDir}
      />

      <CrossWorktreeDiff
        isOpen={crossDiffDialog.isOpen}
        onClose={closeCrossWorktreeDiff}
        initialWorktreeId={crossDiffDialog.initialWorktreeId}
      />

      {(isSettingsOpen || hasOpenedSettings) && (
        <Suspense fallback={null}>
          <LazySettingsDialog
            isOpen={isSettingsOpen}
            onClose={() => setIsSettingsOpen(false)}
            defaultTab={settingsTab}
            defaultSubtab={settingsSubtab}
            defaultSectionId={settingsSectionId}
            onSettingsChange={refreshSettings}
            projectId={currentProject?.id ?? null}
          />
        </Suspense>
      )}

      <ShortcutReferenceDialog isOpen={isShortcutsOpen} onClose={() => setIsShortcutsOpen(false)} />

      <TerminalInfoDialogHost />
      <FileViewerModalHost />

      {gitInitDirectoryPath && (
        <GitInitDialog
          isOpen={gitInitDialogOpen}
          directoryPath={gitInitDirectoryPath}
          onSuccess={handleGitInitSuccess}
          onCancel={closeGitInitDialog}
        />
      )}

      {onboardingProjectId && (
        <ProjectOnboardingWizard
          isOpen={onboardingWizardOpen}
          projectId={onboardingProjectId}
          onClose={closeOnboardingWizard}
          onFinish={handleWizardFinish}
        />
      )}

      <CreateProjectFolderDialog
        isOpen={createFolderDialogOpen}
        onClose={closeCreateFolderDialog}
      />

      <CloneRepoDialog
        isOpen={cloneRepoDialogOpen}
        onSuccess={handleCloneSuccess}
        onCancel={closeCloneRepoDialog}
      />

      <PanelTransitionOverlay />
      <PanelLimitConfirmDialog />

      <Toaster />
      <ShortcutHint />
      <ReEntrySummary state={reEntrySummary} />
      <OnboardingFlow
        availability={availability}
        onRefreshSettings={refreshSettings}
        onComplete={gettingStarted.notifyOnboardingComplete}
      />
      {currentProject !== null && gettingStarted.visible && gettingStarted.checklist && (
        <GettingStartedChecklist
          checklist={gettingStarted.checklist}
          collapsed={gettingStarted.collapsed}
          onDismiss={gettingStarted.dismiss}
          onToggleCollapse={gettingStarted.toggleCollapse}
          onMarkItem={gettingStarted.markItem}
        />
      )}
      {gettingStarted.showCelebration && <CelebrationConfetti />}
    </ErrorBoundary>
  );
}

export default App;
