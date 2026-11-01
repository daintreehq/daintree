import { memo, useCallback, useMemo } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { WorktreeCard } from "@/components/Worktree";
import { WorktreeCardErrorFallback } from "@/components/Worktree/WorktreeCardErrorFallback";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import type { WorktreeState } from "@/types";
import type { WorktreeActions } from "@/hooks/useWorktreeActions";
import type { UseAgentLauncherReturn } from "@/hooks/useAgentLauncher";

interface StaticWorktreeRowProps {
  worktreeId: string;
  activeWorktreeId: string | null;
  focusedWorktreeId: string | null;
  keyboardCursorId: string | null;
  totalWorktreeCount: number;
  selectWorktree: (id: string) => void;
  worktreeActions: WorktreeActions;
  availability: UseAgentLauncherReturn["availability"];
  agentSettings: UseAgentLauncherReturn["agentSettings"];
  homeDir: string | undefined;
  isDragHandleDisabled?: boolean;
  ariaRowIndex: number;
}

function StaticWorktreeRow({
  worktreeId,
  activeWorktreeId,
  focusedWorktreeId,
  keyboardCursorId,
  totalWorktreeCount,
  selectWorktree,
  worktreeActions,
  availability,
  agentSettings,
  homeDir,
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
  const isKeyboardCursor = worktreeId === keyboardCursorId;

  return (
    <div
      role="row"
      data-worktree-row={worktreeId}
      data-keyboard-cursor={isKeyboardCursor ? "true" : undefined}
      tabIndex={-1}
      aria-rowindex={ariaRowIndex}
      aria-current={isActive ? "true" : undefined}
    >
      <div role="gridcell">
        <ErrorBoundary
          variant="component"
          componentName="WorktreeCard"
          displayName={worktree.branch || worktree.name}
          fallback={WorktreeCardErrorFallback}
          resetKeys={[worktreeId]}
          context={{ worktreeId }}
        >
          <WorktreeCard
            worktree={worktree}
            isActive={isActive}
            isFocused={worktreeId === focusedWorktreeId}
            isKeyboardCursor={isKeyboardCursor}
            isSingleWorktree={totalWorktreeCount === 1}
            onSelect={onSelect}
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

// Rendered from Virtuoso's item renderer, which re-invokes on every sidebar
// render; memo lets rows whose props are unchanged skip the whole card subtree.
const MemoizedStaticWorktreeRow = memo(StaticWorktreeRow);

export { MemoizedStaticWorktreeRow as StaticWorktreeRow };
export type { StaticWorktreeRowProps };
