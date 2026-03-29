import React, { useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { WorktreeState } from "../../types";
import type { GitHubIssue } from "@shared/types/github";
import { useWorktreeTerminals } from "../../hooks/useWorktreeTerminals";
import { useWorktreeColorMap } from "../../hooks/useWorktreeColorMap";
import { useDroppable } from "@dnd-kit/core";
import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";
import { useIsWorktreeSortDragging } from "../DragDrop/DndProvider";
import { GripVertical } from "lucide-react";
import {
  useErrorStore,
  useTerminalStore,
  type RetryAction,
  type TerminalInstance,
} from "../../store";
import { useRecipeStore } from "../../store/recipeStore";
import { useWorktreeSelectionStore } from "../../store/worktreeStore";
import { useWorktreeFilterStore } from "../../store/worktreeFilterStore";
import { errorsClient, worktreeClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import { cn } from "../../lib/utils";
import { getAgentConfig, getAgentIds } from "@/config/agents";
import { getAgentSettingsEntry } from "@/types";
import type { UseAgentLauncherReturn } from "@/hooks/useAgentLauncher";
import { WorktreeDetailsSection } from "./WorktreeCard/WorktreeDetailsSection";
import { WorktreeDialogs } from "./WorktreeCard/WorktreeDialogs";
import { WorktreeHeader } from "./WorktreeCard/WorktreeHeader";
import { WorktreeTerminalSection } from "./WorktreeCard/WorktreeTerminalSection";
import {
  MainWorktreeSummaryRows,
  type AggregateCounts,
} from "./WorktreeCard/MainWorktreeSummaryRows";
import { useWorktreeActions } from "./WorktreeCard/hooks/useWorktreeActions";
import { copyContextWithFeedback } from "@/hooks/useWorktreeActions";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { CONTEXT_COMPONENTS, WorktreeMenuItems } from "./WorktreeMenuItems";
import { useWorktreeStatus } from "./WorktreeCard/hooks/useWorktreeStatus";
import { computeChipState, type ChipState } from "./utils/computeChipState";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

export function worktreeCardPropsAreEqual(
  prev: WorktreeCardProps,
  next: WorktreeCardProps
): boolean {
  if (prev.worktree !== next.worktree) {
    const a = prev.worktree;
    const b = next.worktree;
    if (
      a.id !== b.id ||
      a.branch !== b.branch ||
      a.path !== b.path ||
      a.name !== b.name ||
      a.isCurrent !== b.isCurrent ||
      a.isMainWorktree !== b.isMainWorktree ||
      a.modifiedCount !== b.modifiedCount ||
      a.summary !== b.summary ||
      a.mood !== b.mood ||
      a.aiNote !== b.aiNote ||
      a.aiNoteTimestamp !== b.aiNoteTimestamp ||
      a.lastActivityTimestamp !== b.lastActivityTimestamp ||
      a.prNumber !== b.prNumber ||
      a.prUrl !== b.prUrl ||
      a.prState !== b.prState ||
      a.prTitle !== b.prTitle ||
      a.issueNumber !== b.issueNumber ||
      a.issueTitle !== b.issueTitle ||
      a.isDetached !== b.isDetached ||
      a.lifecycleStatus !== b.lifecycleStatus ||
      a.taskId !== b.taskId ||
      a.hasPlanFile !== b.hasPlanFile ||
      a.planFilePath !== b.planFilePath ||
      a.worktreeChanges !== b.worktreeChanges
    ) {
      return false;
    }
  }

  if (prev.agentAvailability !== next.agentAvailability) {
    const a = prev.agentAvailability;
    const b = next.agentAvailability;
    if (a == null || b == null) return a === b;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      if (a[k as keyof typeof a] !== b[k as keyof typeof b]) return false;
    }
  }

  if (prev.aggregateCounts !== next.aggregateCounts) {
    const a = prev.aggregateCounts;
    const b = next.aggregateCounts;
    if (a == null || b == null) {
      if (a !== b) return false;
    } else if (
      a.worktrees !== b.worktrees ||
      a.working !== b.working ||
      a.waiting !== b.waiting ||
      a.finished !== b.finished
    ) {
      return false;
    }
  }

  return (
    prev.isActive === next.isActive &&
    prev.isFocused === next.isFocused &&
    prev.isSingleWorktree === next.isSingleWorktree &&
    prev.homeDir === next.homeDir &&
    prev.variant === next.variant &&
    prev.isDraggingSort === next.isDraggingSort &&
    prev.dragHandleListeners === next.dragHandleListeners &&
    prev.dragHandleActivatorRef === next.dragHandleActivatorRef &&
    prev.agentSettings === next.agentSettings &&
    prev.onSelect === next.onSelect &&
    prev.onCopyTree === next.onCopyTree &&
    prev.onOpenEditor === next.onOpenEditor &&
    prev.onSaveLayout === next.onSaveLayout &&
    prev.onLaunchAgent === next.onLaunchAgent &&
    prev.onAfterTerminalSelect === next.onAfterTerminalSelect &&
    prev.projectHealth === next.projectHealth
  );
}

export interface WorktreeCardProps {
  worktree: WorktreeState;
  isActive: boolean;
  isFocused: boolean;
  isSingleWorktree?: boolean;
  aggregateCounts?: AggregateCounts;
  onSelect: () => void;
  onCopyTree: () => Promise<string | undefined> | void;
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
  projectHealth?: import("@shared/types").ProjectHealthData | null;
}

export const WorktreeCard = React.memo(function WorktreeCard({
  worktree,
  isActive,
  isFocused,
  isSingleWorktree,
  aggregateCounts,
  onSelect,
  onCopyTree,
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
  projectHealth,
}: WorktreeCardProps) {
  "use memo";
  const worktreeColorMap = useWorktreeColorMap();
  const worktreeAccentColor = worktreeColorMap?.[worktree.id];

  const isExpanded = useWorktreeSelectionStore(
    useCallback((state) => state.expandedWorktrees.has(worktree.id), [worktree.id])
  );
  const toggleWorktreeExpanded = useWorktreeSelectionStore((state) => state.toggleWorktreeExpanded);

  const isTerminalsExpanded = useWorktreeSelectionStore(
    useCallback((state) => state.expandedTerminals.has(worktree.id), [worktree.id])
  );
  const toggleTerminalsExpanded = useWorktreeSelectionStore(
    (state) => state.toggleTerminalsExpanded
  );
  const trackTerminalFocus = useWorktreeSelectionStore((state) => state.trackTerminalFocus);

  const getRecipesForWorktree = useRecipeStore((state) => state.getRecipesForWorktree);
  const recipes = getRecipesForWorktree(worktree.id);

  const isPinned = useWorktreeFilterStore(
    useCallback((state) => state.pinnedWorktrees.includes(worktree.id), [worktree.id])
  );
  const pinWorktree = useWorktreeFilterStore((state) => state.pinWorktree);
  const unpinWorktree = useWorktreeFilterStore((state) => state.unpinWorktree);

  const isCollapsed = useWorktreeFilterStore(
    useCallback((state) => state.collapsedWorktrees.includes(worktree.id), [worktree.id])
  );
  const toggleWorktreeCollapsed = useWorktreeFilterStore((state) => state.toggleWorktreeCollapsed);

  const canCollapse = variant !== "grid";
  const effectiveIsCollapsed = canCollapse && isCollapsed;

  const handleToggleCollapse = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      toggleWorktreeCollapsed(worktree.id);
    },
    [toggleWorktreeCollapsed, worktree.id]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!canCollapse) return;
      // Don't toggle when double-clicking interactive elements
      const target = e.target as HTMLElement;
      if (target.closest("button, a, [role='menuitem'], input, textarea, select")) return;
      e.stopPropagation();
      toggleWorktreeCollapsed(worktree.id);
    },
    [canCollapse, toggleWorktreeCollapsed, worktree.id]
  );

  const handleTogglePin = useCallback(() => {
    if (isPinned) {
      unpinWorktree(worktree.id);
    } else {
      pinWorktree(worktree.id);
    }
  }, [isPinned, pinWorktree, unpinWorktree, worktree.id]);

  const [hasSnapshot, setHasSnapshot] = useState(false);

  // Check for snapshot availability — re-runs when agent activity changes
  React.useEffect(() => {
    let cancelled = false;
    window.electron.git
      .snapshotGet(worktree.id)
      .then((info) => {
        if (!cancelled) setHasSnapshot(info !== null && info.hasChanges);
      })
      .catch(() => {
        // Ignore errors — snapshot check is best-effort
      });
    return () => {
      cancelled = true;
    };
  }, [worktree.id, worktree.lastActivityTimestamp]);

  const handleRevertAgentChanges = useCallback(async () => {
    try {
      const result = await window.electron.git.snapshotRevert(worktree.id);
      setHasSnapshot(false);
      if (result.hasConflicts) {
        // Notify about conflicts
        void actionService.dispatch(
          "app.showNotification",
          {
            type: "warning",
            message: result.message,
          },
          { source: "user" }
        );
      }
    } catch {
      // Error handled by IPC layer
    }
  }, [worktree.id]);

  const { counts: terminalCounts, terminals: worktreeTerminals } = useWorktreeTerminals(
    worktree.id
  );
  const setFocused = useTerminalStore((state) => state.setFocused);
  const pingTerminal = useTerminalStore((state) => state.pingTerminal);
  const openDockTerminal = useTerminalStore((state) => state.openDockTerminal);
  const getCountByWorktree = useTerminalStore((state) => state.getCountByWorktree);
  const completedCount = terminalCounts.byState.completed;
  const totalTerminalCount = terminalCounts.total;
  const allTerminalCount = getCountByWorktree(worktree.id);
  const gridCount = worktreeTerminals.filter(
    (t) => t.location === "grid" || t.location === undefined
  ).length;
  const dockCount = worktreeTerminals.filter((t) => t.location === "dock").length;

  const worktreeErrors = useErrorStore(
    useShallow((state) =>
      state.errors.filter((e) => e.context?.worktreeId === worktree.id && !e.dismissed)
    )
  );
  const dismissError = useErrorStore((state) => state.dismissError);
  const removeError = useErrorStore((state) => state.removeError);

  const handleErrorRetry = useCallback(
    async (errorId: string, action: RetryAction, args?: Record<string, unknown>) => {
      try {
        await errorsClient.retry(errorId, action, args);
        removeError(errorId);
      } catch (error) {
        console.error("Error retry failed:", error);
      }
    },
    [removeError]
  );

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
    spineState,
    isLifecycleRunning,
    lifecycleLabel,
  } = useWorktreeStatus({ worktree });

  const {
    runningRecipeId,
    isRestartValidating,
    confirmDialog,
    showDeleteDialog,
    setShowDeleteDialog,
    closeConfirmDialog,
    handlePathClick,
    handleRunRecipe,
    handleCloseCompleted,
    handleDockAll,
    handleMaximizeAll,
    handleCloseAll,
    handleEndAll,
    handleRestartAll,
  } = useWorktreeActions({
    worktree,
    onCopyTree,
    totalTerminalCount,
    allTerminalCount,
  });

  const handleOpenIssuePortal = useCallback(() => {
    void actionService.dispatch(
      "worktree.openIssueInPortal",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  }, [worktree.id]);

  const handleOpenIssueExternal = useCallback(() => {
    void actionService.dispatch(
      "worktree.openIssue",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  }, [worktree.id]);

  const handleOpenPRPortal = useCallback(() => {
    void actionService.dispatch(
      "worktree.openPRInPortal",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  }, [worktree.id]);

  const handleOpenPRExternal = useCallback(() => {
    void actionService.dispatch("worktree.openPR", { worktreeId: worktree.id }, { source: "user" });
  }, [worktree.id]);

  const handleResetRenderers = useCallback(() => {
    void actionService.dispatch(
      "worktree.sessions.resetRenderers",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  }, [worktree.id]);

  const handleCopyContextFull = useCallback(() => {
    void copyContextWithFeedback(worktree.id);
  }, [worktree.id]);

  const handleCopyContextModified = useCallback(() => {
    void copyContextWithFeedback(worktree.id, { modified: true });
  }, [worktree.id]);

  const [showIssuePicker, setShowIssuePicker] = useState(false);
  const [showReviewHub, setShowReviewHub] = useState(false);
  const [showPlanViewer, setShowPlanViewer] = useState(false);

  const onCloseReviewHub = useCallback(() => setShowReviewHub(false), []);
  const onClosePlanViewer = useCallback(() => setShowPlanViewer(false), []);

  const handleAttachIssue = useCallback(
    async (issue: GitHubIssue) => {
      await worktreeClient.attachIssue({
        worktreeId: worktree.id,
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueState: issue.state,
        issueUrl: issue.url,
      });
      useWorktreeDataStore.setState((prev) => {
        const existing = prev.worktrees.get(worktree.id);
        if (!existing) return prev;
        const next = new Map(prev.worktrees);
        next.set(worktree.id, {
          ...existing,
          issueNumber: issue.number,
          issueTitle: issue.title,
        });
        return { worktrees: next };
      });
    },
    [worktree.id]
  );

  const handleDetachIssue = useCallback(async () => {
    await worktreeClient.detachIssue(worktree.id);
    useWorktreeDataStore.setState((prev) => {
      const existing = prev.worktrees.get(worktree.id);
      if (!existing) return prev;
      const next = new Map(prev.worktrees);
      next.set(worktree.id, {
        ...existing,
        issueNumber: undefined,
        issueTitle: undefined,
      });
      return { worktrees: next };
    });
  }, [worktree.id]);

  const handleTerminalSelect = useCallback(
    (terminal: TerminalInstance) => {
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
    },
    [
      isActive,
      onSelect,
      setFocused,
      pingTerminal,
      openDockTerminal,
      trackTerminalFocus,
      onAfterTerminalSelect,
    ]
  );

  const handleToggleExpand = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      toggleWorktreeExpanded(worktree.id);
    },
    [toggleWorktreeExpanded, worktree.id]
  );

  const handleToggleTerminals = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      toggleTerminalsExpanded(worktree.id);
    },
    [toggleTerminalsExpanded, worktree.id]
  );

  const agentIds = useMemo(() => {
    const baseIds = getAgentIds();
    const settingsIds = agentSettings?.agents ? Object.keys(agentSettings.agents) : [];
    const extraIds = settingsIds.filter((id) => !baseIds.includes(id)).sort();
    return [...baseIds, ...extraIds];
  }, [agentSettings]);

  const launchAgents = useMemo(() => {
    return agentIds
      .filter((agentId) => {
        const entry = getAgentSettingsEntry(agentSettings, agentId);
        // selected === false = explicitly deselected; undefined = pre-migration, treat as visible
        return entry.selected !== false;
      })
      .map((agentId) => {
        const config = getAgentConfig(agentId);
        const available = agentAvailability?.[agentId] ?? false;

        return {
          id: agentId,
          name: config?.name ?? agentId,
          icon: config?.icon,
          shortcut: config?.shortcut ?? null,
          isEnabled: available,
        };
      });
  }, [agentAvailability, agentIds, agentSettings]);

  const isWorktreeSortDragging = useIsWorktreeSortDragging();

  const isIdleCard = spineState === "idle";
  const isStaleCard = spineState === "stale";
  const isWaitingCard = terminalCounts.byState.waiting > 0;

  const chipState = useMemo(
    (): ChipState =>
      computeChipState({
        waitingTerminalCount: terminalCounts.byState.waiting,
        lifecycleStage,
        isComplete,
        hasActiveAgent: terminalCounts.byState.working > 0 || terminalCounts.byState.running > 0,
      }),
    [
      terminalCounts.byState.waiting,
      terminalCounts.byState.working,
      terminalCounts.byState.running,
      lifecycleStage,
      isComplete,
    ]
  );

  const { setNodeRef, isOver } = useDroppable({
    id: `worktree-drop-${worktree.id}`,
    data: {
      type: "worktree",
      worktreeId: worktree.id,
    },
    disabled: isActive || isWorktreeSortDragging,
  });

  const droppableRef = useCallback(
    (node: HTMLElement | null) => {
      if (!isActive) setNodeRef(node);
    },
    [isActive, setNodeRef]
  );

  const isMuted =
    (isIdleCard || isStaleCard) && !isWaitingCard && !isActive && !isFocused && !isOver;

  const handleOpenPanelPalette = useCallback(() => {
    useWorktreeSelectionStore.getState().setActiveWorktree(worktree.id);
    void actionService.dispatch("panel.palette", undefined, { source: "context-menu" });
  }, [worktree.id]);

  const cardContent = (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={droppableRef}
          style={
            worktreeAccentColor
              ? ({ "--worktree-color": worktreeAccentColor } as React.CSSProperties)
              : undefined
          }
          className={cn(
            "sidebar-worktree-card group/card relative transition-all duration-200",
            variant === "sidebar" && "border-b border-border-default",
            variant === "grid" && "rounded-lg border border-divider bg-overlay-subtle",
            isActive &&
              variant !== "sidebar" &&
              "bg-surface-panel-elevated shadow-[var(--theme-shadow-ambient)]",
            !isActive &&
              variant === "grid" &&
              "hover:bg-[var(--sidebar-hover-bg,var(--theme-overlay-hover))]",
            variant === "sidebar" && !isActive && "bg-transparent",
            isActive &&
              !isSingleWorktree &&
              variant === "sidebar" &&
              "before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[3px] before:rounded-r before:content-[''] before:z-10 motion-safe:before:animate-in motion-safe:before:fade-in motion-safe:before:duration-200",
            isActive &&
              !isSingleWorktree &&
              variant === "sidebar" &&
              (worktreeAccentColor ? "before:bg-[var(--worktree-color)]" : "before:bg-accent-primary"),
            variant === "grid" &&
              isActive &&
              "border-accent-primary/70 shadow-[var(--theme-shadow-floating)]",
            variant === "grid" &&
              !isActive &&
              "hover:border-accent-primary/50 hover:shadow-[var(--theme-shadow-floating)]",
            isFocused &&
              !isActive &&
              variant === "grid" &&
              "bg-[var(--sidebar-hover-bg,var(--theme-overlay-hover))]",
            isOver &&
              !isActive &&
              "ring-2 ring-accent-primary bg-accent-primary/10 border-accent-primary/50 transition-all duration-200",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
          )}
          data-active={isActive && variant === "sidebar" ? "true" : undefined}
          data-hoverable={!isActive && variant === "sidebar" ? "true" : undefined}
          data-hovered={isFocused && !isActive && variant === "sidebar" ? "true" : undefined}
          onClick={onSelect}
          onDoubleClick={handleDoubleClick}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
              e.preventDefault();
              onSelect();
            }
          }}
          tabIndex={0}
          role="button"
          data-worktree-branch={branchLabel}
          data-worktree-is-main={isMainWorktree ? "true" : undefined}
          aria-label={`Worktree: ${worktree.issueTitle ?? branchLabel}${worktree.issueTitle ? ` (${branchLabel})` : ""}${isActive ? " (selected)" : ""}${worktree.isCurrent ? " (current)" : ""}, Status: ${spineState}${hasChanges ? ", has uncommitted changes" : ""}`}
        >
          {isOver && !isActive && (
            <div
              className={cn(
                "absolute inset-0 z-50 bg-accent-primary/10 border-2 border-accent-primary pointer-events-none animate-in fade-in duration-150",
                variant === "grid" && "rounded-lg"
              )}
            />
          )}
          {chipState !== null && (
            <Tooltip delayDuration={400}>
              <TooltipTrigger asChild>
                <div
                  className={cn(
                    "absolute w-3 h-3 z-10 cursor-default",
                    chipState === "waiting" && "bg-activity-waiting",
                    chipState === "cleanup" && "bg-github-merged",
                    chipState === "complete" && "bg-github-open",
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
                    approval: "Agent waiting for approval",
                    waiting: "Agent waiting for input",
                    cleanup: "Ready for cleanup",
                    complete: "Complete: in review",
                  }[chipState]
                }
              </TooltipContent>
            </Tooltip>
          )}
          <div className="flex">
            {dragHandleListeners && (
              <div
                ref={dragHandleActivatorRef}
                className={cn(
                  "shrink-0 w-4 flex items-center justify-center cursor-grab active:cursor-grabbing touch-none select-none transition-colors",
                  isDraggingSort
                    ? "bg-accent-primary/20 text-accent-primary"
                    : isWorktreeSortDragging
                      ? "text-text-primary/30 hover:text-text-primary/50 hover:bg-overlay-soft"
                      : "text-transparent hover:text-text-primary/30 hover:bg-overlay-soft"
                )}
                aria-label="Drag to reorder"
                {...dragHandleListeners}
              >
                <GripVertical className="w-3 h-3" />
              </div>
            )}
            <div className={cn("flex-1 min-w-0 py-3", dragHandleListeners ? "pl-1 pr-4" : "px-4")}>
              <WorktreeHeader
                worktree={worktree}
                isActive={isActive}
                isMuted={isMuted}
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
                badges={{
                  onOpenIssue: worktree.issueNumber ? handleOpenIssueExternal : undefined,
                  onOpenPR: worktree.prNumber ? handleOpenPRExternal : undefined,
                  onOpenPlan: worktree.hasPlanFile ? () => setShowPlanViewer(true) : undefined,
                }}
                menu={{
                  launchAgents,
                  recipes,
                  runningRecipeId,
                  isRestartValidating,
                  counts: {
                    grid: gridCount,
                    dock: dockCount,
                    active: totalTerminalCount,
                    completed: completedCount,
                    all: allTerminalCount,
                  },
                  onCopyContextFull: handleCopyContextFull,
                  onCopyContextModified: handleCopyContextModified,
                  onCopyPath: () => void navigator.clipboard.writeText(worktree.path),
                  onOpenEditor,
                  onRevealInFinder: handlePathClick,
                  onOpenIssuePortal: worktree.issueNumber ? handleOpenIssuePortal : undefined,
                  onOpenIssueExternal: worktree.issueNumber ? handleOpenIssueExternal : undefined,
                  onOpenPRPortal: worktree.prUrl ? handleOpenPRPortal : undefined,
                  onOpenPRExternal: worktree.prUrl ? handleOpenPRExternal : undefined,
                  onAttachIssue: () => setShowIssuePicker(true),
                  onViewPlan: () => setShowPlanViewer(true),
                  onOpenReviewHub: () => setShowReviewHub(true),
                  onCompareDiff: () =>
                    useWorktreeSelectionStore.getState().openCrossWorktreeDiff(worktree.id),
                  onRunRecipe: (recipeId) => void handleRunRecipe(recipeId),
                  onSaveLayout,
                  onTogglePin: handleTogglePin,
                  onToggleCollapse: canCollapse
                    ? () => toggleWorktreeCollapsed(worktree.id)
                    : undefined,
                  isCollapsed: effectiveIsCollapsed,
                  onLaunchAgent,
                  onOpenPanelPalette: () => {
                    useWorktreeSelectionStore.getState().setActiveWorktree(worktree.id);
                    void actionService.dispatch("panel.palette", undefined, {
                      source: "context-menu",
                    });
                  },
                  onDockAll: handleDockAll,
                  onMaximizeAll: handleMaximizeAll,
                  onRestartAll: () => void handleRestartAll(),
                  onResetRenderers: handleResetRenderers,
                  onCloseCompleted: handleCloseCompleted,
                  onCloseAll: handleCloseAll,
                  onEndAll: handleEndAll,
                  onDeleteWorktree: !isMainWorktree ? () => setShowDeleteDialog(true) : undefined,
                  onRevertAgentChanges: handleRevertAgentChanges,
                  hasSnapshot,
                }}
              />

              {!effectiveIsCollapsed && (
                <div id={`worktree-body-${worktree.id}`}>
                  {isMainWorktree && (
                    <MainWorktreeSummaryRows
                      aggregateCounts={aggregateCounts}
                      health={projectHealth ?? null}
                    />
                  )}

                  <WorktreeDetailsSection
                    worktree={worktree}
                    homeDir={homeDir}
                    isExpanded={isExpanded}
                    hasChanges={hasChanges}
                    computedSubtitle={computedSubtitle}
                    effectiveNote={effectiveNote}
                    effectiveSummary={effectiveSummary}
                    worktreeErrors={worktreeErrors}
                    isFocused={isFocused}
                    onToggleExpand={handleToggleExpand}
                    onPathClick={handlePathClick}
                    onDismissError={dismissError}
                    onRetryError={handleErrorRetry}
                    onOpenReviewHub={() => setShowReviewHub(true)}
                    isLifecycleRunning={isLifecycleRunning}
                    lifecycleLabel={lifecycleLabel}
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

              <WorktreeDialogs
                worktree={worktree}
                confirmDialog={confirmDialog}
                onCloseConfirm={closeConfirmDialog}
                showDeleteDialog={showDeleteDialog}
                onCloseDeleteDialog={() => setShowDeleteDialog(false)}
                showIssuePicker={showIssuePicker}
                onCloseIssuePicker={() => setShowIssuePicker(false)}
                onAttachIssue={(issue) => void handleAttachIssue(issue)}
                onDetachIssue={() => void handleDetachIssue()}
                showReviewHub={showReviewHub}
                onCloseReviewHub={onCloseReviewHub}
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
          launchAgents={launchAgents}
          recipes={recipes.map((r) => ({ id: r.id, name: r.name }))}
          runningRecipeId={runningRecipeId}
          isRestartValidating={isRestartValidating}
          isPinned={isPinned}
          counts={{
            grid: gridCount,
            dock: dockCount,
            active: totalTerminalCount,
            completed: completedCount,
            all: allTerminalCount,
          }}
          onLaunchAgent={onLaunchAgent}
          onCopyContextFull={handleCopyContextFull}
          onCopyContextModified={handleCopyContextModified}
          onCopyPath={() => void navigator.clipboard.writeText(worktree.path)}
          onOpenEditor={onOpenEditor}
          onRevealInFinder={handlePathClick}
          onOpenIssuePortal={worktree.issueNumber ? handleOpenIssuePortal : undefined}
          onOpenIssueExternal={worktree.issueNumber ? handleOpenIssueExternal : undefined}
          onOpenPRPortal={worktree.prUrl ? handleOpenPRPortal : undefined}
          onOpenPRExternal={worktree.prUrl ? handleOpenPRExternal : undefined}
          onAttachIssue={() => setShowIssuePicker(true)}
          onViewPlan={() => setShowPlanViewer(true)}
          onOpenReviewHub={() => setShowReviewHub(true)}
          onCompareDiff={() =>
            useWorktreeSelectionStore.getState().openCrossWorktreeDiff(worktree.id)
          }
          onRunRecipe={(recipeId) => void handleRunRecipe(recipeId)}
          onSaveLayout={onSaveLayout}
          onTogglePin={handleTogglePin}
          onToggleCollapse={canCollapse ? () => toggleWorktreeCollapsed(worktree.id) : undefined}
          isCollapsed={effectiveIsCollapsed}
          onDockAll={handleDockAll}
          onMaximizeAll={handleMaximizeAll}
          onRestartAll={() => void handleRestartAll()}
          onResetRenderers={handleResetRenderers}
          onCloseCompleted={handleCloseCompleted}
          onCloseAll={handleCloseAll}
          onEndAll={handleEndAll}
          onOpenPanelPalette={handleOpenPanelPalette}
          onDeleteWorktree={!isMainWorktree ? () => setShowDeleteDialog(true) : undefined}
        />
      </ContextMenuContent>
    </ContextMenu>
  );

  return cardContent;
}, worktreeCardPropsAreEqual);
