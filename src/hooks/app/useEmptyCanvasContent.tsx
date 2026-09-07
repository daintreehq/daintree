import { Suspense } from "react";
import type { GettingStartedChecklistState } from "@/hooks/app/useGettingStartedChecklist";
import { isGitBackedProject } from "@shared/types";
import { useProjectStore } from "@/store";
import { useScratchStore } from "@/store/scratchStore";
import { ContentGridEmptyState } from "@/components/Terminal/ContentGridEmptyState";
import { resolveEmptyCanvas } from "@/components/Terminal/emptyCanvas";
import { LazyWelcomeScreen } from "@/lazyPanels";
import { ProjectSurfaceView, useProjectSurface } from "@/components/Plugin/ProjectSurfaceView";

/**
 * What the content grid shows when it has no panels, and the id of the
 * workspace that content belongs to (#11076).
 *
 * A scratch is a workspace, so its empty canvas gets the agent launcher — not
 * WelcomeScreen, whose CTAs all acquire a workspace the user already has. It
 * has no worktree, branch, recipes or project settings, so those affordances
 * stay off. A project returns `undefined`, deferring to the grid's own
 * context-driven empty state.
 *
 * A project opened without git (#11405) is the third case: the grid derives its
 * launch target from the active worktree, and this one has none, so deferring
 * would leave the user no way to start an agent in the folder they just opened.
 * It supplies the target explicitly like a scratch does, but keeps the project
 * affordances a scratch lacks — it has real settings and recipes.
 *
 * A project-local plugin can claim this surface (`contributes.surfaces.
 * emptyCanvas`, §7.8) and draw the project's own canvas here instead. It is a
 * slot replacement, not a removal: the surrounding chrome is untouched, and
 * `ProjectSurfaceFrame` keeps the stock launcher one click away. The claim is
 * only consulted for the `"project"` canvas — a scratch has no project to own
 * it, and the welcome screen is app-level, not project-level.
 */
export function useEmptyCanvasContent(gettingStarted: GettingStartedChecklistState): {
  emptyContent: React.ReactNode | undefined;
  workspaceId: string | null;
} {
  const currentProject = useProjectStore((state) => state.currentProject);
  const currentScratch = useScratchStore((state) => state.currentScratch);
  // Unconditional: hooks cannot be called behind the canvas-kind branches
  // below, and the resolver already returns null for every case that should
  // not use a surface (no claim, an unresolvable one, or the stock canvas
  // pinned).
  const surface = useProjectSurface("emptyCanvas");

  const canvas = resolveEmptyCanvas(currentProject, currentScratch);

  if (canvas.kind === "project") {
    if (surface !== null) {
      return {
        emptyContent: <ProjectSurfaceView config={surface.config} />,
        workspaceId: currentProject?.id ?? null,
      };
    }
    if (currentProject && !isGitBackedProject(currentProject)) {
      return {
        emptyContent: (
          <ContentGridEmptyState
            hasLaunchTarget
            hasProjectContext
            hasWorktrees={false}
            isWorktreeInitialized={false}
            workspaceName={currentProject.name}
            projectEmoji={currentProject.emoji}
            activeWorktreePath={currentProject.path}
            showProjectPulse={false}
            defaultCwd={currentProject.path}
          />
        ),
        workspaceId: currentProject.id,
      };
    }
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
