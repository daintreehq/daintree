import { Suspense } from "react";
import type { GettingStartedChecklistState } from "@/hooks/app/useGettingStartedChecklist";
import { useProjectStore } from "@/store";
import { useScratchStore } from "@/store/scratchStore";
import { ContentGridEmptyState } from "@/components/Terminal/ContentGridEmptyState";
import { resolveEmptyCanvas } from "@/components/Terminal/emptyCanvas";
import { LazyWelcomeScreen } from "@/lazyPanels";

/**
 * What the content grid shows when it has no panels, and the id of the
 * workspace that content belongs to (#11076).
 *
 * A scratch is a workspace, so its empty canvas gets the agent launcher — not
 * WelcomeScreen, whose CTAs all acquire a workspace the user already has. It
 * has no worktree, branch, recipes or project settings, so those affordances
 * stay off. A project returns `undefined`, deferring to the grid's own
 * context-driven empty state.
 */
export function useEmptyCanvasContent(gettingStarted: GettingStartedChecklistState): {
  emptyContent: React.ReactNode | undefined;
  workspaceId: string | null;
} {
  const currentProject = useProjectStore((state) => state.currentProject);
  const currentScratch = useScratchStore((state) => state.currentScratch);

  const canvas = resolveEmptyCanvas(currentProject, currentScratch);

  if (canvas.kind === "project") {
    return { emptyContent: undefined, workspaceId: currentProject?.id ?? null };
  }

  if (canvas.kind === "scratch") {
    return {
      emptyContent: (
        <ContentGridEmptyState
          hasLaunchTarget
          hasProjectContext={false}
          hasWorktrees={false}
          isWorktreeInitialized={false}
          workspaceName={canvas.scratch.name}
          activeWorktreePath={canvas.scratch.path}
          showProjectPulse={false}
          defaultCwd={canvas.scratch.path}
        />
      ),
      workspaceId: canvas.scratch.id,
    };
  }

  return {
    emptyContent: (
      <Suspense fallback={null}>
        <LazyWelcomeScreen gettingStarted={gettingStarted} />
      </Suspense>
    ),
    workspaceId: null,
  };
}
