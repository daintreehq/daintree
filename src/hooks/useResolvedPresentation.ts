import { useEffect, useMemo } from "react";
import { isGitBackedProject, type Project } from "@shared/types/project";
import {
  resolvePresentation,
  type PresentationLevels,
  type ResolvedPresentation,
} from "@shared/config/presentationProfile";
import { useProjectStore } from "@/store/projectStore";
import { useProjectPresentationStore } from "@/store/projectPresentationStore";

const NO_LEVELS: PresentationLevels = {};

/**
 * The profile's levels for `project`, defaults filled in. Levels count only
 * once main has answered for this same project; until then — and for a view
 * with no project row, such as a scratch workspace — every feature draws its
 * default, which is exactly what it drew before profiles existed.
 */
export function resolvePresentationFor(
  project: Pick<Project, "id" | "gitBacked"> | null | undefined,
  profile: { levels: PresentationLevels; loaded: boolean; projectId: string | null }
): ResolvedPresentation {
  // Not `isGitBackedProject(null)`: that answers true, and a view with no
  // project row has no repository to report on.
  const gitBacked = project != null && isGitBackedProject(project);
  const applies = project != null && profile.loaded && profile.projectId === project.id;
  return resolvePresentation(applies ? profile.levels : NO_LEVELS, { gitBacked });
}

/** Non-reactive read, for paths that resolve once per event (keybinding `when` clauses). */
export function getResolvedPresentation(): ResolvedPresentation {
  return resolvePresentationFor(
    useProjectStore.getState().currentProject,
    useProjectPresentationStore.getState()
  );
}

/** This view's resolved presentation profile; starts following main on first use. */
export function useResolvedPresentation(): ResolvedPresentation {
  // Primitives, not the row: worktree cards call this through their context
  // menus, and a project row update that moves neither field shouldn't
  // re-render every card.
  const projectId = useProjectStore((s) => s.currentProject?.id);
  const gitBacked = useProjectStore((s) => s.currentProject?.gitBacked);
  const levels = useProjectPresentationStore((s) => s.levels);
  const loaded = useProjectPresentationStore((s) => s.loaded);
  const profileProjectId = useProjectPresentationStore((s) => s.projectId);
  const init = useProjectPresentationStore((s) => s.init);

  useEffect(() => {
    init();
  }, [init]);

  return useMemo(
    () =>
      resolvePresentationFor(projectId === undefined ? null : { id: projectId, gitBacked }, {
        levels,
        loaded,
        projectId: profileProjectId,
      }),
    [projectId, gitBacked, levels, loaded, profileProjectId]
  );
}
