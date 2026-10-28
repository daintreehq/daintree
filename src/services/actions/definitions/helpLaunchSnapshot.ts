import type { ActionContext } from "@shared/types/actions";
import { actionService } from "@/services/ActionService";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";

export interface HelpLaunchSnapshot {
  context: ActionContext;
  workspace: { id: string; path: string } | null;
  isProjectStateSettled: boolean;
}

/**
 * What `help.launchAgent` binds its session to, read synchronously when the
 * action is dispatched — before its run body's chunk loads (#14271).
 *
 * The context is bound to the MCP session at provision and replayed as the
 * contextOverride on every assistant tool call, so a focus shift during the
 * model's turn can't retarget actions onto the wrong worktree/terminal
 * (#8317). Capturing after an await would reintroduce the exact stale-read
 * race this fixes (lesson #5087). The workspace is read in the same block so
 * the session's workspace identity and context snapshot are guaranteed
 * consistent.
 *
 * The active workspace is a project OR a scratch (#11068): switching to a
 * scratch clears `currentProject` by design, and main keys the assistant's
 * session on an opaque workspace id (`ctx.projectId` resolves through
 * ProjectViewManager, which maps scratch ids the same as project ids), so a
 * scratch's `{ id, path }` provisions unchanged. The two pointers are mutually
 * exclusive; project-first only guards a transient inconsistency.
 */
export function captureHelpLaunchSnapshot(): HelpLaunchSnapshot {
  const context = actionService.getContext();
  const projectState = useProjectStore.getState();
  return {
    context,
    workspace: projectState.currentProject ?? useScratchStore.getState().currentScratch ?? null,
    isProjectStateSettled: projectState.isBootstrapped,
  };
}
