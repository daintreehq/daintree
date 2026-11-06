import { useHomeDir } from "@/hooks/app/useHomeDir";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { selectViewProject, selectViewScratch } from "@/store/viewWorkspace";

export type GuidedTerminalPlacement =
  | { ready: true; cwd: string; worktreeId: string | undefined }
  | { ready: false; reason?: "remote" | "no-project" };

/**
 * Where a guided decisions CLI pane (a relay deploy or removal) would go, or
 * why it can't go anywhere this window shows. It runs from the home folder in
 * the grid being looked at.
 */
export function useGuidedTerminalPlacement(): GuidedTerminalPlacement {
  const { homeDir } = useHomeDir();
  const hasProject = useProjectStore(
    (state) => selectViewProject(getViewWorkspaceId(), state) !== undefined
  );
  const hasScratch = useScratchStore(
    (state) => selectViewScratch(getViewWorkspaceId(), state) !== undefined
  );
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);

  // Its terminals run on the Host, which reaches neither this browser's Cloudflare sign-in nor main.
  if (isRemoteWindow()) return { ready: false, reason: "remote" };
  if (!hasProject && !hasScratch) return { ready: false, reason: "no-project" };
  // A project's grid shows one worktree's panes, so the pane waits until that's known.
  if (homeDir === undefined || (hasProject && activeWorktreeId === null)) return { ready: false };
  return { ready: true, cwd: homeDir, worktreeId: activeWorktreeId ?? undefined };
}
