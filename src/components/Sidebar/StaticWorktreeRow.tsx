import { useCallback, useMemo } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { WorktreeCard, type WorktreeCardProps } from "@/components/Worktree";
import { WorktreeCardErrorFallback } from "@/components/Worktree/WorktreeCardErrorFallback";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { getWorktreeSidebarRowId } from "./useWorktreeSidebarKeyboard";
import type { WorktreeState } from "@/types";
import type { WorktreeActions } from "@/hooks/useWorktreeActions";
import type { UseAgentLauncherReturn } from "@/hooks/useAgentLauncher";

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
  isDragHandleDisabled?: boolean;
  ariaRowIndex: number;
}

function StaticWorktreeRow({
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
  isDragHandleDisabled,
  ariaRowIndex,
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

  const isActive = worktreeId === activeWorktreeId;

  return (
    <div
      role="row"
      id={getWorktreeSidebarRowId(worktreeId)}
      data-worktree-row={worktreeId}
      tabIndex={-1}
      aria-rowindex={ariaRowIndex}
      aria-current={isActive ? "true" : undefined}
    >
      <div role="gridcell">
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
            isDragHandleDisabled={isDragHandleDisabled}
          />
        </ErrorBoundary>
      </div>
    </div>
  );
}

export { StaticWorktreeRow };
export type { StaticWorktreeRowProps };
