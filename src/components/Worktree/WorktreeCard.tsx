import { useCallback, useMemo } from "react";
import type React from "react";
import { useShallow } from "zustand/react/shallow";
import type { WorktreeState } from "../../types";
import { useWorktreeTerminals } from "../../hooks/useWorktreeTerminals";
import { useDroppable } from "@dnd-kit/core";
import {
  useErrorStore,
  useTerminalStore,
  type RetryAction,
  type TerminalInstance,
} from "../../store";
import { useRecipeStore } from "../../store/recipeStore";
import { useWorktreeSelectionStore } from "../../store/worktreeStore";
import { errorsClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { cn } from "../../lib/utils";
import { getAgentConfig, getAgentIds } from "@/config/agents";
import { getAgentSettingsEntry } from "@/types";
import type { UseAgentLauncherReturn } from "@/hooks/useAgentLauncher";
import { WorktreeDetailsSection } from "./WorktreeCard/WorktreeDetailsSection";
import { WorktreeDialogs } from "./WorktreeCard/WorktreeDialogs";
import { WorktreeHeader } from "./WorktreeCard/WorktreeHeader";
import { WorktreeStatusSpine } from "./WorktreeCard/WorktreeStatusSpine";
import { WorktreeTerminalSection } from "./WorktreeCard/WorktreeTerminalSection";
import { useWorktreeActions } from "./WorktreeCard/hooks/useWorktreeActions";
import { useWorktreeMenu } from "./WorktreeCard/hooks/useWorktreeMenu";
import { useWorktreeStatus } from "./WorktreeCard/hooks/useWorktreeStatus";

export interface WorktreeCardProps {
  worktree: WorktreeState;
  isActive: boolean;
  isFocused: boolean;
  onSelect: () => void;
  onCopyTree: () => Promise<string | undefined> | void;
  onOpenEditor: () => void;
  onOpenIssue?: () => void;
  onOpenPR?: () => void;
  onCreateRecipe?: () => void;
  onSaveLayout?: () => void;
  onLaunchAgent?: (agentId: string) => void;
  agentAvailability?: UseAgentLauncherReturn["availability"];
  agentSettings?: UseAgentLauncherReturn["agentSettings"];
  homeDir?: string;
}

export function WorktreeCard({
  worktree,
  isActive,
  isFocused,
  onSelect,
  onCopyTree,
  onOpenEditor,
  onOpenIssue,
  onOpenPR,
  onCreateRecipe,
  onSaveLayout,
  onLaunchAgent,
  agentAvailability,
  agentSettings,
  homeDir,
}: WorktreeCardProps) {
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

  const { counts: terminalCounts, terminals: worktreeTerminals } = useWorktreeTerminals(
    worktree.id
  );
  const setFocused = useTerminalStore((state) => state.setFocused);
  const pingTerminal = useTerminalStore((state) => state.pingTerminal);
  const openDockTerminal = useTerminalStore((state) => state.openDockTerminal);
  const getCountByWorktree = useTerminalStore((state) => state.getCountByWorktree);
  const completedCount = terminalCounts.byState.completed;
  const failedCount = terminalCounts.byState.failed;
  const totalTerminalCount = terminalCounts.total;
  const allTerminalCount = getCountByWorktree(worktree.id);
  const gridCount = useMemo(
    () => worktreeTerminals.filter((t) => t.location === "grid" || t.location === undefined).length,
    [worktreeTerminals]
  );
  const dockCount = useMemo(
    () => worktreeTerminals.filter((t) => t.location === "dock").length,
    [worktreeTerminals]
  );

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
  const { branchLabel, hasChanges, effectiveNote, effectiveSummary, computedSubtitle, spineState } =
    useWorktreeStatus({ worktree, worktreeErrorCount: worktreeErrors.length });

  const {
    runningRecipeId,
    isRestartValidating,
    treeCopied,
    isCopyingTree,
    copyFeedback,
    confirmDialog,
    showDeleteDialog,
    setShowDeleteDialog,
    closeConfirmDialog,
    handlePathClick,
    handleCopyTree,
    handleCopyTreeClick,
    handleRunRecipe,
    handleCloseCompleted,
    handleCloseFailed,
    handleMinimizeAll,
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

  const handleOpenIssue = useCallback(() => {
    void actionService.dispatch(
      "worktree.openIssue",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  }, [worktree.id]);

  const handleOpenPR = useCallback(() => {
    void actionService.dispatch("worktree.openPR", { worktreeId: worktree.id }, { source: "user" });
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
    },
    [isActive, onSelect, setFocused, pingTerminal, openDockTerminal, trackTerminalFocus]
  );

  const handleToggleExpand = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      toggleWorktreeExpanded(worktree.id);
    },
    [toggleWorktreeExpanded, worktree.id]
  );

  const hasExpandableContent =
    hasChanges ||
    Boolean(effectiveNote) ||
    !!effectiveSummary ||
    worktreeErrors.length > 0 ||
    terminalCounts.total > 0;

  const showTimeInHeader = !hasExpandableContent;

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
    return agentIds.map((agentId) => {
      const config = getAgentConfig(agentId);
      const entry = getAgentSettingsEntry(agentSettings, agentId);
      const settingsEnabled = entry.enabled ?? true;
      const available = agentAvailability?.[agentId] ?? false;

      return {
        id: agentId,
        name: config?.name ?? agentId,
        icon: config?.icon,
        shortcut: config?.shortcut ?? null,
        isEnabled: settingsEnabled && available,
      };
    });
  }, [agentAvailability, agentIds, agentSettings]);

  const launchAgentsForContextMenu = useMemo(
    () => launchAgents.map((a) => ({ id: a.id, label: a.name, isEnabled: a.isEnabled })),
    [launchAgents]
  );

  const isIdleCard = spineState === "idle";
  const isStaleCard = spineState === "stale";

  const { setNodeRef, isOver } = useDroppable({
    id: `worktree-drop-${worktree.id}`,
    data: {
      type: "worktree",
      worktreeId: worktree.id,
    },
    disabled: isActive,
  });

  const { handleContextMenu } = useWorktreeMenu({
    worktree,
    recipes,
    runningRecipeId,
    isRestartValidating,
    counts: {
      grid: gridCount,
      dock: dockCount,
      active: totalTerminalCount,
      completed: completedCount,
      failed: failedCount,
      all: allTerminalCount,
    },
    launchAgents: launchAgentsForContextMenu,
    onLaunchAgent,
    onOpenIssue,
    onOpenPR,
    onCreateRecipe,
    onSaveLayout,
    onRestartAll: () => void handleRestartAll(),
    onCloseAll: handleCloseAll,
    onEndAll: handleEndAll,
    onShowDeleteDialog: () => setShowDeleteDialog(true),
  });

  const cardContent = (
    <div
      ref={isActive ? undefined : setNodeRef}
      className={cn(
        "group relative border-b border-divider transition-all duration-200",
        isActive
          ? "bg-white/[0.03] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]"
          : "hover:bg-white/[0.02] bg-transparent",
        isFocused && !isActive && "bg-white/[0.02]",
        (isIdleCard || isStaleCard) && !isActive && !isFocused && "opacity-70 hover:opacity-100",
        isOver &&
          !isActive &&
          "ring-2 ring-canopy-accent bg-canopy-accent/10 border-canopy-accent/50 transition-all duration-200",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
      )}
      onClick={onSelect}
      onContextMenu={handleContextMenu}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          onSelect();
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`Worktree: ${branchLabel}${isActive ? " (selected)" : ""}${worktree.isCurrent ? " (current)" : ""}, Status: ${spineState}${worktreeErrors.length > 0 ? `, ${worktreeErrors.length} error${worktreeErrors.length !== 1 ? "s" : ""}` : ""}${hasChanges ? ", has uncommitted changes" : ""}`}
    >
      {isOver && !isActive && (
        <div className="absolute inset-0 z-50 bg-canopy-accent/20 border-2 border-canopy-accent pointer-events-none animate-in fade-in duration-150" />
      )}
      <WorktreeStatusSpine spineState={spineState} />
      <div className="px-4 py-5">
        <WorktreeHeader
          worktree={worktree}
          isActive={isActive}
          isMainWorktree={isMainWorktree}
          branchLabel={branchLabel}
          showTimeInHeader={showTimeInHeader}
          worktreeErrorCount={worktreeErrors.length}
          copy={{
            treeCopied,
            isCopyingTree,
            copyFeedback,
            onCopyTreeClick: handleCopyTreeClick,
          }}
          badges={{
            onOpenIssue: onOpenIssue,
            onOpenPR: onOpenPR,
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
              failed: failedCount,
              all: allTerminalCount,
            },
            onCopyContext: () => void handleCopyTree(),
            onOpenEditor,
            onRevealInFinder: handlePathClick,
            onOpenIssue: worktree.issueNumber && onOpenIssue ? handleOpenIssue : undefined,
            onOpenPR:
              worktree.issueNumber && worktree.prNumber && onOpenPR ? handleOpenPR : undefined,
            onRunRecipe: (recipeId) => void handleRunRecipe(recipeId),
            onCreateRecipe,
            onSaveLayout,
            onLaunchAgent,
            onMinimizeAll: handleMinimizeAll,
            onMaximizeAll: handleMaximizeAll,
            onRestartAll: () => void handleRestartAll(),
            onCloseCompleted: handleCloseCompleted,
            onCloseFailed: handleCloseFailed,
            onCloseAll: handleCloseAll,
            onEndAll: handleEndAll,
            onDeleteWorktree: !isMainWorktree ? () => setShowDeleteDialog(true) : undefined,
          }}
        />

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
          showTimeInHeader={showTimeInHeader}
          onToggleExpand={handleToggleExpand}
          onPathClick={handlePathClick}
          onDismissError={dismissError}
          onRetryError={handleErrorRetry}
        />

        <WorktreeTerminalSection
          worktreeId={worktree.id}
          isExpanded={isTerminalsExpanded}
          counts={terminalCounts}
          terminals={worktreeTerminals}
          onToggle={handleToggleTerminals}
          onTerminalSelect={handleTerminalSelect}
        />

        <WorktreeDialogs
          worktree={worktree}
          confirmDialog={confirmDialog}
          onCloseConfirm={closeConfirmDialog}
          showDeleteDialog={showDeleteDialog}
          onCloseDeleteDialog={() => setShowDeleteDialog(false)}
        />
      </div>
    </div>
  );

  return cardContent;
}
