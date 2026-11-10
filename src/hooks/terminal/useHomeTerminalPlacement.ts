import { useHomeDir } from "@/hooks/app/useHomeDir";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { selectViewProject, selectViewScratch } from "@/store/viewWorkspace";

export type HomeTerminalPlacement =
  | { ready: true; cwd: string; worktreeId: string | undefined }
  | { ready: false; reason?: "no-project" };

/**
 * Where a pane that runs from the home folder goes in the grid being looked at,
 * or why this window has no grid for it. The home folder is the host's, so in a
 * remote window the pane runs there, and a project's own tool config (an
 * `.npmrc`, a `.tool-versions`) has no say in what it runs.
 */
export function useHomeTerminalPlacement(): HomeTerminalPlacement {
  const { homeDir } = useHomeDir();
  const hasProject = useProjectStore(
    (state) => selectViewProject(getViewWorkspaceId(), state) !== undefined
  );
  const hasScratch = useScratchStore(
    (state) => selectViewScratch(getViewWorkspaceId(), state) !== undefined
  );
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);

  if (!hasProject && !hasScratch) return { ready: false, reason: "no-project" };
  // A project's grid shows one worktree's panes, so the pane waits until that's known.
  if (homeDir === undefined || (hasProject && activeWorktreeId === null)) return { ready: false };
  return { ready: true, cwd: homeDir, worktreeId: activeWorktreeId ?? undefined };
}
