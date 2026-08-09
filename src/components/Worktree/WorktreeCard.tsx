import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { WorktreeState } from "../../types";
import type { Issue } from "@shared/types/forge";
import { logError } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { useWorktreeTerminals } from "../../hooks/useWorktreeTerminals";

import { useDroppable } from "@dnd-kit/core";
import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";
import {
  useDndPlaceholder,
  useIsWorktreeSortDragging,
  type WorktreeDragData,
} from "../DragDrop/DndProvider";
import { getWorktreeSortDragId } from "../DragDrop/SortableWorktreeCard";
import { GripVertical } from "lucide-react";
import { useErrorStore, usePanelStore, type RetryAction } from "../../store";
import type { PtyPanelData } from "@shared/types/panel";
import { useRecipeStore } from "../../store/recipeStore";
import { useWorktreeSelectionStore } from "../../store/worktreeStore";
import {
  useProjectSettingsStore,
  areProjectNotificationsMuted,
} from "../../store/projectSettingsStore";
import { useWorktreeFilterStore } from "../../store/worktreeFilterStore";
import { errorsClient, worktreeClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { cn } from "../../lib/utils";
import { isExternalWorktree } from "@/lib/worktreeFilters";
import { getAgentConfig, getAgentIds } from "@/config/agents";
import { isAssistantOnlyAgentId } from "@shared/config/agentIds";
import { getAgentSettingsEntry } from "@/types";
import type { UseAgentLauncherReturn } from "@/hooks/useAgentLauncher";
import { isAgentLaunchable } from "../../../shared/utils/agentAvailability";
import { isAgentPinned } from "../../../shared/utils/agentPinned";
import { FocusedSubLine } from "./WorktreeCard/FocusedSubLine";
import {
  WorktreeDetailsSection,
  WorktreeDeleteErrorBanner,
  WorktreeIssueErrorBanner,
} from "./WorktreeCard/WorktreeDetailsSection";
import { WorktreeDialogs } from "./WorktreeCard/WorktreeDialogs";
import { WorktreeHeader } from "./WorktreeCard/WorktreeHeader";
import { WorktreeTerminalSection } from "./WorktreeCard/WorktreeTerminalSection";
import { WslGitBanner } from "./WorktreeCard/WslGitBanner";
import {
  MainWorktreeSummaryRows,
  type AggregateCounts,
} from "./WorktreeCard/MainWorktreeSummaryRows";
import { useInputReceiptKey } from "./WorktreeCard/hooks/useInputReceiptKey";
import { useWorktreeActions } from "./WorktreeCard/hooks/useWorktreeActions";
import { copyContextWithFeedback } from "@/hooks/useWorktreeActions";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  CONTEXT_COMPONENTS,
  WorktreeMenuItems,
  type WorktreeMenuActions,
} from "./WorktreeMenuItems";
import { usePluginContextMenuItems } from "@/hooks/usePluginContextMenuItems";
import type { WhenClauseContext } from "@shared/utils/whenClause";
import { isAgentFleetActionEligible, isFleetArmEligible } from "@/store/fleetArmingStore";
import { useWorktreeStatus } from "./WorktreeCard/hooks/useWorktreeStatus";
import { useWorktreeDevServerSession } from "@/hooks/app/useWorktreeDevServerSession";
import { computeChipState } from "./utils/computeChipState";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

const HOVER_REVALIDATE_DELAY = 150;
const REVALIDATE_FRESHNESS_GATE = 10_000;
const MAX_CONCURRENT_REVALIDATES = 3;
const inFlightRevalidates = new Set<string>();

function isRevalidationAllowed(worktreeId: string): boolean {
  return (
    inFlightRevalidates.size < MAX_CONCURRENT_REVALIDATES || inFlightRevalidates.has(worktreeId)
  );
}

export interface WorktreeCardProps {
  worktree: WorktreeState;
  isActive: boolean;
  isFocused: boolean;
  isSingleWorktree?: boolean;
  aggregateCounts?: AggregateCounts;
  onSelect: () => void;
  onOpenEditor: () => void;
  onSaveLayout?: () => void;
  onLaunchAgent?: (agentId: string) => void;
  agentAvailability?: UseAgentLauncherReturn["availability"];
  agentSettings?: UseAgentLauncherReturn["agentSettings"];
  homeDir?: string;
  variant?: "sidebar" | "grid";
  onAfterTerminalSelect?: () => void;
  dragHandleListeners?: SyntheticListenerMap;
  dragHandleActivatorRef?: (node: HTMLElement | null) => void;
  isDraggingSort?: boolean;
  isDragHandleDisabled?: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  projectHealth?: import("@shared/types/ipc/forge").ForgeProjectHealthPayload | null;
  /**
   * Multi-select state (grid variant only). When provided, modifier-clicks
   * (Ctrl/Cmd/Shift) route through `onToggleSelect` instead of `onSelect`
   * and a checkbox affordance becomes visible on hover or when selected.
   */
  isSelected?: boolean;
  onToggleSelect?: (event: React.MouseEvent) => void;
}

export function WorktreeCard({
  worktree,
  isActive,
  isFocused,
  isSingleWorktree: _isSingleWorktree,
  aggregateCounts: _aggregateCounts,
  onSelect,
  onOpenEditor,
  onSaveLayout,
  onLaunchAgent,
  agentAvailability,
  agentSettings,
  homeDir,
  variant = "sidebar",
  onAfterTerminalSelect,
  dragHandleListeners,
  dragHandleActivatorRef,
  isDraggingSort,
  isDragHandleDisabled = false,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  projectHealth,
  isSelected = false,
  onToggleSelect,
}: WorktreeCardProps) {
  "use memo";
  const isMultiSelectEnabled = variant === "grid" && onToggleSelect !== undefined;

  const handleCardClick = (e: React.MouseEvent) => {
    if (isMultiSelectEnabled && (e.metaKey || e.ctrlKey || e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      onToggleSelect?.(e);
      return;
    }
    onSelect();
  };

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onToggleSelect?.(e);
  };
  const isExpanded = useWorktreeSelectionStore((state) => state.expandedWorktrees.has(worktree.id));
  const toggleWorktreeExpanded = useWorktreeSelectionStore((state) => state.toggleWorktreeExpanded);

  const isTerminalsExpanded = useWorktreeSelectionStore((state) =>
    state.expandedTerminals.has(worktree.id)
  );
  const toggleTerminalsExpanded = useWorktreeSelectionStore(
    (state) => state.toggleTerminalsExpanded
  );
  const trackTerminalFocus = useWorktreeSelectionStore((state) => state.trackTerminalFocus);

  const getRecipesForWorktree = useRecipeStore((state) => state.getRecipesForWorktree);
  const recipes = getRecipesForWorktree(worktree.id);

  const resourceEnvironments = useProjectSettingsStore(
    (state) => state.settings?.resourceEnvironments
  );

  const notificationOverrides = useProjectSettingsStore(
    (state) => state.settings?.notificationOverrides
  );
  const isProjectNotificationsMuted = areProjectNotificationsMuted(notificationOverrides);

  const environmentIcon =
    worktree.worktreeMode && worktree.worktreeMode !== "local"
      ? resourceEnvironments?.[worktree.worktreeMode]?.icon
      : undefined;

  const isPinnedStored = useWorktreeFilterStore((state) =>
    state.pinnedWorktrees.includes(worktree.id)
  );
  const pinWorktree = useWorktreeFilterStore((state) => state.pinWorktree);
  const unpinWorktree = useWorktreeFilterStore((state) => state.unpinWorktree);
  const isExternal = isExternalWorktree(worktree);
  // Pinning can't lift an external worktree out of the bottom partition, so a
  // leftover pin entry must not render as pinned either (#11434).
  const isPinned = isPinnedStored && !isExternal;

  const isCollapsed = useWorktreeFilterStore((state) =>
    state.collapsedWorktrees.includes(worktree.id)
  );
  const toggleWorktreeCollapsed = useWorktreeFilterStore((state) => state.toggleWorktreeCollapsed);

  const canCollapse = variant !== "grid";
  const effectiveIsCollapsed = canCollapse && isCollapsed;

  const handleToggleCollapse = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleWorktreeCollapsed(worktree.id);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    if (!canCollapse) return;
    // Interactive children stop `click` propagation but `click` and `dblclick`
    // are separate events, so a double-click on a control (More actions,
    // Delete, the git-status Refresh button, the drag handle, issue/PR badges,
    // the lifecycle "Show details" <summary>) still bubbles here and would
    // toggle collapse. Only collapse when the double-click originates on the
    // inert card body — the full-card select overlay or non-interactive
    // content — not on a nested control (#10319).
    const target = e.target;
    if (!(target instanceof Element)) return;
    const interactive = target.closest(
      'button, a, summary, [role="button"], [role="menuitem"], input, select, textarea, [data-worktree-row-drag-handle]'
    );
    if (interactive && !interactive.hasAttribute("data-card-select-overlay")) return;
    e.stopPropagation();
    toggleWorktreeCollapsed(worktree.id);
  };

  const handleTogglePin = () => {
    if (isPinned) {
      unpinWorktree(worktree.id);
    } else {
      pinWorktree(worktree.id);
    }
  };

  const {
    counts: terminalCounts,
    terminals: worktreeTerminals,
    dominantAgentState,
  } = useWorktreeTerminals(worktree.id);

  const devServerSession = useWorktreeDevServerSession(worktree.id);

  const pluginMenuContext = useMemo<WhenClauseContext>(
    () => ({ worktreeId: worktree.id }),
    [worktree.id]
  );
  const pluginItems = usePluginContextMenuItems("worktree", pluginMenuContext);

  // Border accent flash — fires once when the dominant *execution* state for
  // this card meaningfully changes. `directing` is excluded because it's
  // driven by the user's local typing cycle (start typing → directing,
  // submit/clear → null), which would flash the card on every keystroke
  // rather than on real agent activity. The flashKey counter remounts the
  // overlay on each transition so back-to-back changes restart the
  // animation rather than dropping silently.
  const prevAgentStateRef = useRef(dominantAgentState);
  const [flashKey, setFlashKey] = useState(0);

  useEffect(() => {
    const prev = prevAgentStateRef.current;
    if (prev !== dominantAgentState) {
      prevAgentStateRef.current = dominantAgentState;
      if (
        dominantAgentState !== null &&
        dominantAgentState !== "directing" &&
        prev !== "directing"
      ) {
        setFlashKey((k) => k + 1);
      }
    }
  }, [dominantAgentState]);

  // Input-time receipt — fires the moment a row terminal is pinged (well
  // before the polled `dominantAgentState` border-flash). Acknowledges the
  // input itself, not its outcome, so any agent-state staleness is irrelevant.
  // `pingSeq` is the authoritative trigger so back-to-back taps of the same
  // terminal both produce a receipt (Zustand `Object.is` would suppress the
  // re-render if we keyed off `pingedId` alone).
  const pingedId = usePanelStore((state) => state.pingedId);
  const pingSeq = usePanelStore((state) => state.pingSeq);
  const worktreeTerminalIds = useMemo(
    () => worktreeTerminals.map((t) => t.id),
    [worktreeTerminals]
  );
  const receiptKey = useInputReceiptKey(pingedId, pingSeq, worktreeTerminalIds);

  const setFocused = usePanelStore((state) => state.setFocused);
  const pingTerminal = usePanelStore((state) => state.pingTerminal);
  const openDockTerminal = usePanelStore((state) => state.openDockTerminal);
  const completedCount = terminalCounts.byState.completed + terminalCounts.byState.exited;
  const totalTerminalCount = terminalCounts.total;
  const gridCount = worktreeTerminals.filter(
    (t) => t.location === "grid" || t.location === undefined
  ).length;
  const dockCount = worktreeTerminals.filter((t) => t.location === "dock").length;
  // Counts for the Sessions submenu's Select * items. "All" follows Fleet
  // broadcast membership (any live PTY); state-specific items are meaningful
  // only for terminals with agent state.
  const eligibleTerminals = worktreeTerminals.filter(isFleetArmEligible);
  const eligibleTerminalCount = eligibleTerminals.length;
  const waitingAgentCount = eligibleTerminals.filter(
    (t) => isAgentFleetActionEligible(t) && t.agentState === "waiting"
  ).length;
  const workingAgentCount = eligibleTerminals.filter(
    (t) => isAgentFleetActionEligible(t) && t.agentState === "working"
  ).length;

  const worktreeErrors = useErrorStore(
    useShallow((state) =>
      state.errors.filter((e) => e.context?.worktreeId === worktree.id && !e.dismissed)
    )
  );
  const dismissError = useErrorStore((state) => state.dismissError);
  const removeError = useErrorStore((state) => state.removeError);

  const isBeingDeleted = useWorktreeStore((state) => state.deletingIds.has(worktree.id));
  const deleteError = useWorktreeStore((state) => state.deleteErrors.get(worktree.id) ?? null);
  const issueError = useWorktreeStore((state) => state.issueErrors.get(worktree.id) ?? null);

  const handleRetryDelete = () => {
    getCurrentViewStore().getState().retryDelete(worktree.id);
  };

  const handleDismissDeleteError = () => {
    getCurrentViewStore().getState().clearDeleteError(worktree.id);
  };

  const handleRetryIssue = () => {
    if (!issueError) return;
    getCurrentViewStore().getState().retryOutboxEntry(issueError.mutationId);
  };

  const handleDismissIssueError = () => {
    if (!issueError) return;
    getCurrentViewStore().getState().dismissOutboxEntry(issueError.mutationId);
  };

  const handleErrorRetry = async (
    errorId: string,
    action: RetryAction,
    args?: Record<string, unknown>
  ) => {
    try {
      await errorsClient.retry(errorId, action, args);
      removeError(errorId);
    } catch (error) {
      logError("Error retry failed", error);
    }
  };

  const isMainWorktree = Boolean(worktree.isMainWorktree);
  const {
    branchLabel,
    isMainOnStandardBranch,
    hasChanges,
    isComplete,
    lifecycleStage,
    effectiveNote,
    effectiveSummary,
    computedSubtitle,
    reviewState,
    spineState,
    isLifecycleRunning,
    lifecycleLabel,
    resourceStatusLabel,
    resourceStatusColor,
    hasResourceConfig,
    gitStateIndicator,
  } = useWorktreeStatus({ worktree });

  const hasPauseCommand = !!worktree.hasPauseCommand;
  const hasResumeCommand = !!worktree.hasResumeCommand;
  const hasTeardownCommand = !!worktree.hasTeardownCommand;
  const teardownCommands =
    worktree.worktreeMode && worktree.worktreeMode !== "local"
      ? (resourceEnvironments?.[worktree.worktreeMode]?.teardown ?? [])
      : [];
  const hasStatusCommand = !!worktree.hasStatusCommand;
  const hasProvisionCommand = !!worktree.hasProvisionCommand;

  const {
    runningRecipeId,
    confirmDialog,
    showDeleteDialog,
    setShowDeleteDialog,
    closeConfirmDialog,
    handlePathClick,
    handleRunRecipe,
    handleDockAll,
    handleMaximizeAll,
    handleSelectAllAgents,
    handleSelectWaitingAgents,
    handleSelectWorkingAgents,
    handleCloseAll,
    handleTerminateAll,
    handleClearHistory,
    handleResourceTeardown,
  } = useWorktreeActions({
    worktree,
    teardownCommands,
  });

  const handleOpenIssueExternal = () => {
    void actionService.dispatch(
      "worktree.openIssue",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  };

  const handleOpenPRExternal = () => {
    void actionService.dispatch("worktree.openPR", { worktreeId: worktree.id }, { source: "user" });
  };

  const handleResetRenderers = () => {
    void actionService.dispatch(
      "worktree.sessions.resetRenderers",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  };

  const handleStopDevServer = useCallback((worktreeId: string) => {
    safeFireAndForget(window.electron.devPreview.stopDevServerByWorktree({ worktreeId }), {
      context: "Stop dev server for worktree",
    });
  }, []);

  const handleRestartDevServer = useCallback((worktreeId: string) => {
    safeFireAndForget(window.electron.devPreview.restartByWorktree({ worktreeId }), {
      context: "Restart dev server for worktree",
    });
  }, []);

  const handleResourceResume = () => {
    void actionService.dispatch(
      "worktree.resource.resume",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  };

  const handleResourcePause = () => {
    void actionService.dispatch(
      "worktree.resource.pause",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  };

  const handleResourceConnect = () => {
    void actionService.dispatch(
      "worktree.resource.connect",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  };

  const resourceEnvironmentKeys = Object.keys(resourceEnvironments ?? {});

  const handleSwitchEnvironment = (envKey: string) => {
    void worktreeClient.switchEnvironment(worktree.id, envKey);
  };

  const handleResourceProvision = () => {
    void actionService.dispatch(
      "worktree.resource.provision",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  };

  const handleResourceStatus = () => {
    void actionService.dispatch(
      "worktree.resource.status",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  };

  const handleCopyContextFull = () => {
    void copyContextWithFeedback(worktree.id, "context-menu", undefined, "worktree-card");
  };

  const handleCopyContextModified = () => {
    void copyContextWithFeedback(worktree.id, "context-menu", { modified: true }, "worktree-card");
  };

  const { copy: copyWorktreePath } = useCopyWithFeedback();
  const handleCopyPath = () => {
    void copyWorktreePath(worktree.path);
  };

  const [showIssuePicker, setShowIssuePicker] = useState(false);
  const [showPlanViewer, setShowPlanViewer] = useState(false);

  const onClosePlanViewer = () => setShowPlanViewer(false);

  // Every Review Hub entry point (banner button, menu, header, terminal
  // section) dispatches the action, which presents the review panel as a
  // dialog through the global host. The action owns the commit-message seed,
  // so no card-local state or window event bridges it any more.
  const openReviewHubForThisWorktree = () => {
    void actionService.dispatch("worktree.openReviewHub", { worktreeId: worktree.id });
  };

  const hasOpenableChanges = (worktree.worktreeChanges?.changes.length ?? 0) > 0;

  // Names the card outright, like the Review Hub entry point. No focus nudge is
  // needed: the action gates only its palette row on context, so an explicit
  // worktreeId is always honoured whatever else holds focus.
  const openChangesForThisWorktree = () => {
    void actionService.dispatch("worktree.openChanges", { worktreeId: worktree.id });
  };

  // Unlike the Review Hub and Changes entry points above, this one opens a real
  // grid panel rather than a dialog — and the grid renders only the active
  // worktree's bucket, so a panel created for an inactive card would be
  // backgrounded on arrival: counted, persisted, and invisible (#11666). Select
  // first, exactly as `handleTerminalSelect` below does before focusing a
  // terminal on an inactive card.
  // `"user"`, not the menu source: the handler is defined in the card body,
  // outside any menu Root, so `useMenuActionSource()` would fall back to
  // exactly this and warn on the way. Naming a foreground source at all is what
  // matters — it is what lets the panel take focus instead of deferring to the
  // store's ambient spawn guards.
  const openFileBrowserForThisWorktree = () => {
    if (!isActive) onSelect();
    void actionService.dispatch(
      "worktree.openFileBrowserPanel",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  };

  // Route attach/detach through the resilient mutation outbox (#9163) instead
  // of a fire-and-forget IPC. The store applies the local association only once
  // the Electron-store write lands, replays a mutation that was in flight when
  // the host crashed, and surfaces failures via `WorktreeIssueErrorBanner`.
  const handleAttachIssue = (issue: Issue) => {
    getCurrentViewStore().getState().startAttachIssue({
      worktreeId: worktree.id,
      issueNumber: issue.number,
      issueTitle: issue.title,
    });
  };

  const handleDetachIssue = () => {
    getCurrentViewStore().getState().startDetachIssue(worktree.id);
  };

  const handleTerminalSelect = (terminal: PtyPanelData) => {
    // Switch to this worktree if it isn't already active
    if (!isActive) {
      if (terminal.worktreeId) {
        trackTerminalFocus(terminal.worktreeId, terminal.id);
      }
      onSelect();
    }

    // Focus the terminal (Dock or Grid)
    if (terminal.location === "dock") {
      openDockTerminal(terminal.id);
    } else {
      setFocused(terminal.id);
    }

    // Trigger the ping animation
    pingTerminal(terminal.id);

    // Invoke callback (e.g. close modal) after focusing terminal
    onAfterTerminalSelect?.();
  };

  const handleToggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleWorktreeExpanded(worktree.id);
  };

  const handleToggleTerminals = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleTerminalsExpanded(worktree.id);
  };

  const agentIds = (() => {
    const baseIds = getAgentIds();
    const settingsIds = agentSettings?.agents ? Object.keys(agentSettings.agents) : [];
    const extraIds = settingsIds.filter((id) => !baseIds.includes(id)).sort();
    // Assistant-only agents are never launchable from the worktree card.
    return [...baseIds, ...extraIds].filter((id) => !isAssistantOnlyAgentId(id));
  })();

  const launchAgents = (() => {
    return agentIds
      .filter((agentId) => isAgentPinned(getAgentSettingsEntry(agentSettings, agentId)))
      .map((agentId) => {
        const config = getAgentConfig(agentId);
        const available = isAgentLaunchable(agentAvailability?.[agentId]);

        return {
          id: agentId,
          name: config?.name ?? agentId,
          icon: config?.icon,
          isEnabled: available,
        };
      });
  })();

  const isWorktreeSortDragging = useIsWorktreeSortDragging();

  const isIdleCard = spineState === "idle";
  const isStaleCard = spineState === "stale";
  const isWaitingCard = terminalCounts.byState.waiting > 0;

  const chipState = computeChipState({
    waitingTerminalCount: terminalCounts.byState.waiting,
    lifecycleStage,
    isComplete,
    hasActiveAgent: terminalCounts.byState.working > 0,
  });

  // The active card used to opt out of being a drop target entirely — every
  // panel drag originated from the active worktree, so it could only ever be a
  // no-op self-drop. Accordion drags broke that assumption: dragging a
  // terminal out of an inactive (or deleted) worktree's sidebar row onto the
  // ACTIVE card is the most common rescue flow, so the droppable stays
  // registered and only disables when the dragged panel already lives here.
  const { activeTerminal: draggedPanel } = useDndPlaceholder();
  const isCrossWorktreePanelDrag =
    draggedPanel !== null && (draggedPanel.worktreeId ?? null) !== worktree.id;

  const { setNodeRef, isOver, over, active } = useDroppable({
    id: `worktree-drop-${worktree.id}`,
    data: {
      type: "worktree",
      worktreeId: worktree.id,
    },
    disabled: (isActive && !isCrossWorktreePanelDrag) || isWorktreeSortDragging,
  });

  const droppableRef = (node: HTMLElement | null) => {
    setNodeRef(node);
  };

  const activeDragData = active?.data.current as Partial<WorktreeDragData> | undefined;
  // Only drops handleDragEnd will actually accept: a single-panel drag —
  // group drags are rejected by cancelDrop, and worktree-sort drags carry no
  // terminal. Accordion drags count only when they come from a *different*
  // worktree (a cross-worktree move); within their own worktree they are
  // reorders and the card must not light up as a drop target.
  const isMovablePanelDrag =
    activeDragData?.terminal !== undefined &&
    (activeDragData.origin !== "accordion" || activeDragData.worktreeId !== worktree.id) &&
    !(activeDragData.groupId && (activeDragData.groupPanelIds?.length ?? 0) > 1);
  // The sidebar row stacks two same-size droppables (this drop target inside
  // the SortableWorktreeCard sortable), and pointerWithin resolves their tie
  // by registration order — `over` can be either id, so match both. Mirrors
  // the dual-id handling in DndProvider's handleDragEnd.
  const isPanelDropTarget =
    (!isActive || isCrossWorktreePanelDrag) &&
    isMovablePanelDrag &&
    (isOver || over?.id === getWorktreeSortDragId(worktree.id));

  const isMuted =
    (isIdleCard || isStaleCard) && !isWaitingCard && !isActive && !isFocused && !isPanelDropTarget;

  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverWorktreeIdRef = useRef(worktree.id);
  useEffect(() => {
    hoverWorktreeIdRef.current = worktree.id;
  }, [worktree.id]);

  // Freshness lives in the store's statusCheckedAt side map, not on the
  // snapshot — the snapshot field only reflects the last content change (see
  // createWorktreeStore). Per-id primitive selector: this card re-renders only
  // when ITS worktree's stamp advances.
  const lastGitStatusCheckedAt = useWorktreeStore((s) => s.statusCheckedAt.get(worktree.id));

  const handleRevalidate = useCallback(() => {
    const id = hoverWorktreeIdRef.current;
    if (
      isActive ||
      !isRevalidationAllowed(id) ||
      (lastGitStatusCheckedAt && Date.now() - lastGitStatusCheckedAt < REVALIDATE_FRESHNESS_GATE)
    ) {
      return;
    }
    inFlightRevalidates.add(id);
    void worktreeClient
      .refresh(id)
      .finally(() => {
        inFlightRevalidates.delete(id);
      })
      .catch(() => {});
  }, [isActive, lastGitStatusCheckedAt]);

  const handlePointerEnter = useCallback(() => {
    if (isActive || !lastGitStatusCheckedAt) return;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      handleRevalidate();
    }, HOVER_REVALIDATE_DELAY);
  }, [isActive, lastGitStatusCheckedAt, handleRevalidate]);

  const handlePointerLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
      }
    };
  }, []);

  const handleOpenPanelPalette = () => {
    useWorktreeSelectionStore.getState().setActiveWorktree(worktree.id);
    void actionService.dispatch("panel.palette", undefined, {
      // eslint-disable-next-line no-restricted-syntax -- context-menu-source: hardcoded because callback lives outside the ContextMenu Root (see #8322)
      source: "context-menu",
    });
  };

  // One action set drives both menu surfaces — the card's right-click menu and
  // the ⋯ toolbar dropdown — so they can't drift apart (they did: Browse Files
  // was wired into the dropdown only).
  const menuActions: WorktreeMenuActions = {
    launchAgents,
    recipes: recipes.map((r) => ({ id: r.id, name: r.name })),
    runningRecipeId,
    counts: {
      grid: gridCount,
      dock: dockCount,
      active: totalTerminalCount,
      completed: completedCount,
      all: eligibleTerminalCount,
      waiting: waitingAgentCount,
      working: workingAgentCount,
    },
    onCopyContextFull: handleCopyContextFull,
    onCopyContextModified: handleCopyContextModified,
    onCopyPath: handleCopyPath,
    onOpenEditor,
    onRevealInFinder: handlePathClick,
    onOpenIssueExternal: worktree.issueNumber ? handleOpenIssueExternal : undefined,
    onOpenPRExternal: worktree.linked?.pr?.url ? handleOpenPRExternal : undefined,
    onAttachIssue: () => setShowIssuePicker(true),
    onViewPlan: () => setShowPlanViewer(true),
    // Gated on the change list, not `hasChanges` (a `changedFileCount` read):
    // an external git provider may report a count with no per-file entries, and
    // the action has nothing to open then. Same guard the Changed Files header
    // button uses.
    onOpenChanges: hasOpenableChanges ? openChangesForThisWorktree : undefined,
    onOpenReviewHub: openReviewHubForThisWorktree,
    onOpenFileBrowser: openFileBrowserForThisWorktree,
    onCompareDiff: () => useWorktreeSelectionStore.getState().openCrossWorktreeDiff(worktree.id),
    onRunRecipe: (recipeId) => void handleRunRecipe(recipeId),
    onSaveLayout,
    onTogglePin: isExternal ? undefined : handleTogglePin,
    onToggleCollapse: canCollapse ? () => toggleWorktreeCollapsed(worktree.id) : undefined,
    isCollapsed: effectiveIsCollapsed,
    onLaunchAgent,
    onMoveUp,
    onMoveDown,
    canMoveUp,
    canMoveDown,
    onOpenPanelPalette: handleOpenPanelPalette,
    onDockAll: handleDockAll,
    onMaximizeAll: handleMaximizeAll,
    onCloseAll: handleCloseAll,
    onTerminateAll: handleTerminateAll,
    onClearHistory: handleClearHistory,
    onResetRenderers: handleResetRenderers,
    onSelectAllAgents: handleSelectAllAgents,
    onSelectWaitingAgents: handleSelectWaitingAgents,
    onSelectWorkingAgents: handleSelectWorkingAgents,
    onDeleteWorktree: !isMainWorktree ? () => setShowDeleteDialog(true) : undefined,
    hasResourceConfig,
    worktreeMode: worktree.worktreeMode,
    resourceEnvironmentKeys,
    onSwitchEnvironment: handleSwitchEnvironment,
    resourceStatus: worktree.resourceStatus?.lastStatus,
    onResourceProvision: hasProvisionCommand ? handleResourceProvision : undefined,
    onResourceResume: hasResumeCommand ? handleResourceResume : undefined,
    onResourcePause: hasPauseCommand ? handleResourcePause : undefined,
    onResourceConnect: worktree.resourceConnectCommand ? handleResourceConnect : undefined,
    onResourceStatus: hasStatusCommand ? handleResourceStatus : undefined,
    onResourceTeardown: hasTeardownCommand ? handleResourceTeardown : undefined,
    onStopDevServer: handleStopDevServer,
    onRestartDevServer: handleRestartDevServer,
    pluginItems,
  };

  const ariaStatusParts: string[] = [spineState];
  if (gitStateIndicator) {
    ariaStatusParts.push(gitStateIndicator.label);
  }
  if (hasChanges) {
    ariaStatusParts.push("has uncommitted changes");
  }
  const ariaStatusLabel = ariaStatusParts.join(", ");
  const cardContent = (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={droppableRef}
          className={cn(
            "sidebar-worktree-card group/card relative isolate transition-colors duration-150",
            variant === "sidebar" && "border-b border-border-default",
            variant === "grid" && "rounded-lg border border-divider bg-overlay-subtle",
            isActive && variant !== "sidebar" && "bg-surface-panel-elevated",
            !isActive &&
              variant === "grid" &&
              "hover:bg-overlay-subtle hover:shadow-[var(--theme-shadow-ambient)] [html[data-dragging='true']_&]:hover:shadow-none",
            variant === "sidebar" && !isActive && "bg-transparent",
            isFocused && !isActive && variant === "grid" && "bg-overlay-soft",
            // Sidebar selection carries the full-height right accent border in
            // sidebar.css, so the cwd stripe is grid-only — stacking both on
            // one right edge read as a broken double marker (#9711 round-3
            // owner decision). Right edge: the side facing the panel grid the
            // worktree controls, clear of the window edge where it vanished on
            // light themes.
            worktree.isCurrent &&
              variant !== "sidebar" &&
              "before:absolute before:right-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-l before:bg-daintree-accent before:content-['']",
            isBeingDeleted && !deleteError && "opacity-50 pointer-events-none"
          )}
          data-active={isActive && variant === "sidebar" ? "true" : undefined}
          data-hoverable={!isActive && variant === "sidebar" ? "true" : undefined}
          data-hovered={isFocused && !isActive && variant === "sidebar" ? "true" : undefined}
          data-drop-target={isPanelDropTarget ? "true" : undefined}
          data-worktree-branch={branchLabel}
          data-worktree-is-main={isMainWorktree ? "true" : undefined}
          data-resource-status={resourceStatusLabel ?? undefined}
          data-deleting={isBeingDeleted && !deleteError ? "true" : undefined}
          aria-busy={isBeingDeleted && !deleteError ? "true" : undefined}
          role={variant === "grid" ? "group" : undefined}
          aria-current={variant === "grid" && isActive ? "true" : undefined}
          aria-label={`Worktree: ${worktree.issueTitle ?? worktree.branchDerivedTitle ?? branchLabel}${(worktree.issueTitle ?? worktree.branchDerivedTitle) ? ` (${branchLabel})` : ""}${worktree.isCurrent ? " (current)" : ""}, Status: ${ariaStatusLabel}`}
          onClick={handleCardClick}
          onDoubleClick={handleDoubleClick}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
        >
          <button
            type="button"
            data-card-select-overlay=""
            tabIndex={variant === "grid" ? -1 : undefined}
            // Grid variant: suppress focus shift on click so the role="grid"
            // container retains the keyboard tab stop after a modifier-click.
            onMouseDown={
              variant === "grid" ? (e: React.MouseEvent) => e.preventDefault() : undefined
            }
            className={cn(
              "absolute inset-0 z-0 outline-hidden",
              variant === "grid" && "rounded-lg",
              (isDraggingSort || isWorktreeSortDragging) && "pointer-events-none"
            )}
            aria-label={`Select worktree: ${worktree.issueTitle ?? worktree.branchDerivedTitle ?? branchLabel}${(worktree.issueTitle ?? worktree.branchDerivedTitle) ? ` (${branchLabel})` : ""}`}
          />
          {flashKey > 0 && (
            <div
              key={flashKey}
              className={cn(
                "absolute inset-0 z-20 pointer-events-none border border-overlay animate-border-flash",
                variant === "grid" && "rounded-lg",
                // The active row carries a brighten blend so the flash reads over
                // its own elevated fill. On dark that fill is a dark surface, so
                // screen/plus-lighter lightens it (visible). On light the active
                // row is now an opaque near-white surface (Issue 1 elevate-to-
                // select), and screen-blending the dark `border-strong` flash over
                // near-white is ~invisible — so the blend is dark-only and light
                // paints the border with normal compositing.
                isActive && "dark:mix-blend-plus-lighter"
              )}
              aria-hidden="true"
            />
          )}
          {receiptKey > 0 && (
            <div
              key={receiptKey}
              className={cn(
                "absolute inset-0 z-20 pointer-events-none animate-input-receipt-flash",
                variant === "grid" && "rounded-lg"
              )}
              style={{ background: "color-mix(in srgb, currentColor 10%, transparent)" }}
              aria-hidden="true"
              data-testid="worktree-card-input-receipt"
            />
          )}
          {chipState !== null && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className={cn(
                    "absolute w-3 h-3 z-10 cursor-default",
                    chipState === "waiting" && "bg-activity-waiting",
                    chipState === "cleanup" && "bg-pr-merged",
                    chipState === "complete" && "bg-category-blue",
                    variant === "sidebar" ? "top-0 left-[1px]" : "top-0 left-0 rounded-tl-lg"
                  )}
                  style={{ clipPath: "polygon(0 0, 100% 0, 0 100%)" }}
                  role="img"
                  aria-label={
                    {
                      waiting: "Agent waiting for input",
                      cleanup: "Ready for cleanup",
                      complete: "Complete: in review",
                    }[chipState]
                  }
                />
              </TooltipTrigger>
              <TooltipContent side="right" align="start" className="text-xs">
                {
                  {
                    waiting: "Agent waiting for input",
                    cleanup: "Ready for cleanup",
                    complete: "Complete: in review",
                  }[chipState]
                }
              </TooltipContent>
            </Tooltip>
          )}
          {isMultiSelectEnabled && (
            <div
              className={cn(
                "absolute top-2 right-2 z-30 transition-opacity duration-150",
                isSelected
                  ? "opacity-100"
                  : "opacity-0 group-hover/card:opacity-100 focus-within:opacity-100"
              )}
            >
              <button
                type="button"
                role="checkbox"
                aria-checked={isSelected}
                aria-label={isSelected ? "Deselect worktree" : "Select worktree"}
                tabIndex={-1}
                onClick={handleCheckboxClick}
                className={cn(
                  "flex items-center justify-center w-5 h-5 rounded",
                  "border border-divider transition-colors",
                  isSelected
                    ? "bg-overlay-emphasis text-text-primary"
                    : "bg-daintree-bg/80 text-transparent hover:bg-overlay-subtle"
                )}
              >
                <svg
                  className="w-3 h-3"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M2.5 6.5l2.5 2.5 4.5-5" />
                </svg>
              </button>
            </div>
          )}
          <div className="relative z-10 flex">
            {(dragHandleListeners || isDragHandleDisabled) &&
              (isDragHandleDisabled ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div
                      ref={dragHandleActivatorRef}
                      data-worktree-row-drag-handle=""
                      className="shrink-0 w-4 flex items-center justify-center cursor-not-allowed opacity-30 touch-none select-none transition-colors motion-reduce:transition-none"
                      aria-hidden="true"
                    >
                      <GripVertical className="w-3 h-3" />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="text-xs">
                    Manual reorder paused while filter is active
                  </TooltipContent>
                </Tooltip>
              ) : (
                <div
                  ref={dragHandleActivatorRef}
                  data-worktree-row-drag-handle=""
                  className={cn(
                    "shrink-0 w-4 flex items-center justify-center cursor-grab active:cursor-grabbing touch-none select-none transition-colors group-hover/card:delay-[50ms] motion-reduce:transition-none",
                    isDraggingSort
                      ? "bg-overlay-emphasis text-text-primary"
                      : "text-text-primary/25 group-hover/card:text-text-primary/40 group-hover/card:bg-overlay-soft"
                  )}
                  // Pointer-only affordance: the grip is non-focusable (the row
                  // strips dnd-kit's role/tabIndex), so an aria-label here is
                  // dead ARIA claiming a phantom control. Keyboard reorder is
                  // the row's Alt+Arrow path (aria-keyshortcuts on the row).
                  aria-hidden="true"
                  {...dragHandleListeners}
                >
                  <GripVertical className="w-3 h-3" />
                </div>
              ))}
            <div
              className={cn(
                "flex-1 min-w-0 py-3",
                dragHandleListeners || isDragHandleDisabled ? "pl-1 pr-4" : "px-4"
              )}
            >
              <WorktreeHeader
                worktree={worktree}
                isActive={isActive}
                variant={variant}
                isMuted={isMuted}
                isProjectNotificationsMuted={isProjectNotificationsMuted}
                isMainWorktree={isMainWorktree}
                isMainOnStandardBranch={isMainOnStandardBranch}
                isPinned={isPinned}
                isCollapsed={effectiveIsCollapsed}
                canCollapse={canCollapse}
                onToggleCollapse={handleToggleCollapse}
                contentId={`worktree-body-${worktree.id}`}
                branchLabel={branchLabel}
                sessionStates={terminalCounts.byState}
                sessionTotal={terminalCounts.total}
                environmentIcon={environmentIcon}
                isLifecycleRunning={isLifecycleRunning}
                resourceStatusLabel={resourceStatusLabel}
                resourceStatusColor={resourceStatusColor}
                resourceLastOutput={worktree.resourceStatus?.lastOutput}
                resourceEndpoint={worktree.resourceStatus?.endpoint}
                resourceLastCheckedAt={worktree.resourceStatus?.lastCheckedAt}
                devServerSession={devServerSession}
                lastGitStatusCheckedAt={lastGitStatusCheckedAt}
                onRevalidateGitStatus={handleRevalidate}
                onCheckResourceStatus={hasStatusCommand ? handleResourceStatus : undefined}
                onCleanupWorktree={
                  chipState === "cleanup" && !isMainWorktree
                    ? () => setShowDeleteDialog(true)
                    : undefined
                }
                badges={{
                  onOpenIssue: worktree.issueNumber ? handleOpenIssueExternal : undefined,
                  onOpenPR: worktree.linked?.pr ? handleOpenPRExternal : undefined,
                  onOpenPlan: worktree.hasPlanFile ? () => setShowPlanViewer(true) : undefined,
                }}
                gitStateIndicator={gitStateIndicator}
                menu={menuActions}
              />

              <FocusedSubLine
                open={!isMainWorktree && effectiveIsCollapsed && (isActive || isFocused)}
                changedFileCount={worktree.worktreeChanges?.changedFileCount}
                lastActivityTimestamp={worktree.lastActivityTimestamp}
                statusLabel={lifecycleLabel ?? resourceStatusLabel ?? null}
              />

              {!effectiveIsCollapsed && (
                <div id={`worktree-body-${worktree.id}`}>
                  {worktree.isWslPath && !worktree.wslGitOptIn && !worktree.wslGitDismissed && (
                    <WslGitBanner
                      worktreeId={worktree.id}
                      wslDistro={worktree.wslDistro}
                      wslGitEligible={worktree.wslGitEligible}
                    />
                  )}
                  {isMainWorktree && <MainWorktreeSummaryRows health={projectHealth ?? null} />}

                  <WorktreeDetailsSection
                    worktree={worktree}
                    homeDir={homeDir}
                    isExpanded={isExpanded}
                    hasChanges={hasChanges}
                    computedSubtitle={computedSubtitle}
                    reviewState={reviewState}
                    effectiveNote={effectiveNote}
                    effectiveSummary={effectiveSummary}
                    worktreeErrors={worktreeErrors}
                    isFocused={isFocused}
                    isStale={isStaleCard}
                    onToggleExpand={handleToggleExpand}
                    onPathClick={handlePathClick}
                    onDismissError={dismissError}
                    onRetryError={handleErrorRetry}
                    onOpenReviewHub={openReviewHubForThisWorktree}
                    isLifecycleRunning={isLifecycleRunning}
                    lifecycleLabel={lifecycleLabel}
                    isBeingDeleted={isBeingDeleted}
                    deleteError={deleteError}
                    hasResourceConfig={hasResourceConfig}
                    resourceStatus={worktree.resourceStatus?.lastStatus}
                    onResourceResume={hasResumeCommand ? handleResourceResume : undefined}
                    onResourcePause={hasPauseCommand ? handleResourcePause : undefined}
                    onResourceConnect={
                      worktree.resourceConnectCommand ? handleResourceConnect : undefined
                    }
                    onResourceProvision={hasProvisionCommand ? handleResourceProvision : undefined}
                    onResourceTeardown={hasTeardownCommand ? handleResourceTeardown : undefined}
                    onResourceStatus={hasStatusCommand ? handleResourceStatus : undefined}
                  />

                  <WorktreeTerminalSection
                    worktreeId={worktree.id}
                    isExpanded={isTerminalsExpanded}
                    counts={terminalCounts}
                    terminals={worktreeTerminals}
                    onToggle={handleToggleTerminals}
                    onTerminalSelect={handleTerminalSelect}
                  />
                </div>
              )}

              {deleteError && (
                <WorktreeDeleteErrorBanner
                  message={deleteError}
                  onRetry={handleRetryDelete}
                  onDismiss={handleDismissDeleteError}
                />
              )}

              {issueError && (
                <WorktreeIssueErrorBanner
                  message={issueError.message}
                  mutationType={issueError.type}
                  onRetry={handleRetryIssue}
                  onDismiss={handleDismissIssueError}
                />
              )}

              <WorktreeDialogs
                worktree={worktree}
                confirmDialog={confirmDialog}
                onCloseConfirm={closeConfirmDialog}
                showDeleteDialog={showDeleteDialog}
                onCloseDeleteDialog={() => setShowDeleteDialog(false)}
                showIssuePicker={showIssuePicker}
                onCloseIssuePicker={() => setShowIssuePicker(false)}
                onAttachIssue={handleAttachIssue}
                onDetachIssue={handleDetachIssue}
                showPlanViewer={showPlanViewer}
                onClosePlanViewer={onClosePlanViewer}
              />
            </div>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-64">
        <WorktreeMenuItems
          worktree={worktree}
          components={CONTEXT_COMPONENTS}
          isPinned={isPinned}
          {...menuActions}
        />
      </ContextMenuContent>
    </ContextMenu>
  );

  return cardContent;
}
