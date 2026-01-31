import type { ActionContext } from "@shared/types/actions";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import { useTerminalStore } from "@/store/terminalStore";

/**
 * Derives enriched ActionContext from stores for assistant context injection.
 * Provides project, worktree, and terminal metadata beyond just IDs.
 */
export function getAssistantContext(): ActionContext {
  const project = useProjectStore.getState().currentProject;
  const worktreeSelection = useWorktreeSelectionStore.getState();
  const activeWorktreeId = worktreeSelection.activeWorktreeId ?? undefined;
  const focusedWorktreeId = worktreeSelection.focusedWorktreeId ?? undefined;
  const focusedTerminalId = useTerminalStore.getState().focusedId ?? undefined;

  const context: ActionContext = {
    projectId: project?.id,
    projectName: project?.name,
    projectPath: project?.path,
    activeWorktreeId,
    focusedWorktreeId,
    focusedTerminalId,
  };

  // Enrich with active worktree metadata
  if (activeWorktreeId) {
    const activeWorktree = useWorktreeDataStore.getState().worktrees.get(activeWorktreeId);
    if (activeWorktree) {
      context.activeWorktreeName = activeWorktree.name;
      context.activeWorktreePath = activeWorktree.path;
      context.activeWorktreeBranch = activeWorktree.branch;
      context.activeWorktreeIsMain = activeWorktree.isMainWorktree;
    }
  }

  // Enrich with focused terminal metadata
  if (focusedTerminalId) {
    const terminal = useTerminalStore
      .getState()
      .terminals.find((t) => t.id === focusedTerminalId);
    if (terminal) {
      context.focusedTerminalKind = terminal.kind;
      context.focusedTerminalType = terminal.type;
      context.focusedTerminalTitle = terminal.title;
    }
  }

  return context;
}
