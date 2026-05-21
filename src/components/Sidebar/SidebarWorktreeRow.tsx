import { useCallback, useMemo } from "react";
import { SortableWorktreeCard } from "@/components/DragDrop/SortableWorktreeCard";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { WorktreeCard } from "@/components/Worktree";
import { WorktreeCardErrorFallback } from "@/components/Worktree/WorktreeCardErrorFallback";
import { applyManualWorktreeReorder } from "@/lib/worktreeReorder";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import type { WorktreeState } from "@/types";
import type { WorktreeActions } from "@/hooks/useWorktreeActions";
import type { UseAgentLauncherReturn } from "@/hooks/useAgentLauncher";

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
  rowIndex: number;
  ariaRowIndex: number;
}

function SidebarWorktreeRow({
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
  rowIndex,
  ariaRowIndex,
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

  const showDragHandle = !isPinned;
  const dragEnabled = !isSortDisabled && !isPinned;

  const handleMoveBy = useCallback(
    (delta: -1 | 1) => {
      const targetIndex = rowIndex + delta;
      if (targetIndex < 0 || targetIndex >= dragStartOrder.length) return;
      const filterStore = useWorktreeFilterStore.getState();
      const merged = applyManualWorktreeReorder(
        filterStore.manualOrder,
        dragStartOrder,
        rowIndex,
        targetIndex
      );
      filterStore.setManualOrder(merged);
      filterStore.setOrderBy("manual");
    },
    [dragStartOrder, rowIndex]
  );
  const onMoveUp = useCallback(() => handleMoveBy(-1), [handleMoveBy]);
  const onMoveDown = useCallback(() => handleMoveBy(1), [handleMoveBy]);

  if (!worktree) return null;

  const isActive = worktreeId === activeWorktreeId;
  const isFocused = worktreeId === focusedWorktreeId;
  const isSingleWorktree = totalWorktreeCount === 1;
  const moveUpHandler = dragEnabled ? onMoveUp : undefined;
  const moveDownHandler = dragEnabled ? onMoveDown : undefined;
  const canMoveUp = dragEnabled && rowIndex > 0;
  const canMoveDown = dragEnabled && rowIndex < dragStartOrder.length - 1;

  return (
    <SortableWorktreeCard
      worktreeId={worktreeId}
      dragStartOrder={dragStartOrder}
      disabled={isSortDisabled || isPinned}
      ariaRowIndex={ariaRowIndex}
      isActive={isActive}
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
            dragHandleListeners={showDragHandle ? dragHandleListeners : undefined}
            dragHandleActivatorRef={showDragHandle ? dragHandleActivatorRef : undefined}
            isDraggingSort={isDraggingSort}
            isDragHandleDisabled={showDragHandle && isSortDisabled}
            onMoveUp={moveUpHandler}
            onMoveDown={moveDownHandler}
            canMoveUp={canMoveUp}
            canMoveDown={canMoveDown}
          />
        </ErrorBoundary>
      )}
    </SortableWorktreeCard>
  );
}

export { SidebarWorktreeRow };
export type { SidebarWorktreeRowProps };
