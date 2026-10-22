import { useEffect, useMemo } from "react";
import { isGitBackedProject, type Project } from "@shared/types/project";
import {
  hasProjectToolbarOverrides,
  isProjectToolbarActive,
  resolvePresentation,
  type PresentationLevels,
  type ResolvedPresentation,
} from "@shared/config/presentationProfile";
import { useProjectStore } from "@/store/projectStore";
import { useProjectPresentationStore } from "@/store/projectPresentationStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { selectViewProject } from "@/store/viewWorkspace";

const NO_LEVELS: PresentationLevels = {};
const NO_PROMOTED: readonly string[] = [];

interface ProfileForView {
  levels: PresentationLevels;
  loaded: boolean;
  projectId: string | null;
  /** Absent reads as never set, so the toolbar follows whether the profile places anything. */
  useProjectToolbar?: boolean | null;
  promotedPluginButtons?: readonly string[];
}

/**
 * The profile's levels for `project`, defaults filled in. Levels count only
 * once main has answered for this same project; until then — and for a view
 * with no project row, such as a scratch workspace — every feature draws its
 * default, which is exactly what it drew before profiles existed.
 */
export function resolvePresentationFor(
  project: Pick<Project, "id" | "gitBacked"> | null | undefined,
  profile: ProfileForView
): ResolvedPresentation {
  // Not `isGitBackedProject(null)`: that answers true, and a view with no
  // project row has no repository to report on.
  const gitBacked = project != null && isGitBackedProject(project);
  const applies = profileAppliesTo(project, profile);
  return resolvePresentation(
    applies ? profile.levels : NO_LEVELS,
    { gitBacked },
    { toolbar: applies && isProjectToolbarActive(withToolbarDefaults(profile)) }
  );
}

function profileAppliesTo(
  project: Pick<Project, "id"> | null | undefined,
  profile: Pick<ProfileForView, "loaded" | "projectId">
): boolean {
  return project != null && profile.loaded && profile.projectId === project.id;
}

function withToolbarDefaults(profile: ProfileForView) {
  return {
    levels: profile.levels,
    useProjectToolbar: profile.useProjectToolbar ?? null,
    promotedPluginButtons: profile.promotedPluginButtons ?? NO_PROMOTED,
  };
}

export interface ProjectToolbarOverlay {
  /** The view's own project once its profile has loaded, else `null`. */
  projectId: string | null;
  /** Main has answered for this view's own project, so the toolbar toggle can be offered and written. */
  available: boolean;
  /** "Use this project's toolbar" is in effect. */
  active: boolean;
  /** The profile sets anything the toolbar draws differently, in effect or not. */
  hasOverrides: boolean;
  /** Promoted plugin buttons while the overlay is in effect; empty otherwise. */
  promotedPluginButtons: readonly string[];
}

/** The project toolbar overlay (#13783) for `project`, resolved like its levels. */
export function projectToolbarOverlayFor(
  project: Pick<Project, "id"> | null | undefined,
  profile: ProfileForView
): ProjectToolbarOverlay {
  if (project == null || !profileAppliesTo(project, profile)) {
    return {
      projectId: null,
      available: false,
      active: false,
      hasOverrides: false,
      promotedPluginButtons: NO_PROMOTED,
    };
  }
  const toolbar = withToolbarDefaults(profile);
  const active = isProjectToolbarActive(toolbar);
  return {
    projectId: project.id,
    available: true,
    active,
    hasOverrides: hasProjectToolbarOverrides(toolbar),
    promotedPluginButtons: active ? toolbar.promotedPluginButtons : NO_PROMOTED,
  };
}

/** Non-reactive read, for paths that resolve once per event (keybinding `when` clauses). */
export function getResolvedPresentation(): ResolvedPresentation {
  return resolvePresentationFor(
    selectViewProject(getViewWorkspaceId(), useProjectStore.getState()),
    useProjectPresentationStore.getState()
  );
}

/**
 * This view's resolved presentation profile; starts following main on first use.
 * Resolved against the project this view owns, not the globally broadcast
 * `currentProject`: main loads the profile for the view's own project, and a
 * sibling window switching projects repoints `currentProject` here too.
 */
export function useResolvedPresentation(): ResolvedPresentation {
  const viewWorkspaceId = getViewWorkspaceId();
  // Primitives, not the row: worktree cards call this through their context
  // menus, and a project row update that moves neither field shouldn't
  // re-render every card.
  const projectId = useProjectStore((s) => selectViewProject(viewWorkspaceId, s)?.id);
  const gitBacked = useProjectStore((s) => selectViewProject(viewWorkspaceId, s)?.gitBacked);
  const levels = useProjectPresentationStore((s) => s.levels);
  const loaded = useProjectPresentationStore((s) => s.loaded);
  const profileProjectId = useProjectPresentationStore((s) => s.projectId);
  const useProjectToolbar = useProjectPresentationStore((s) => s.useProjectToolbar);
  const promotedPluginButtons = useProjectPresentationStore((s) => s.promotedPluginButtons);
  useFollowPresentationProfile(projectId);

  return useMemo(
    () =>
      resolvePresentationFor(projectId === undefined ? null : { id: projectId, gitBacked }, {
        levels,
        loaded,
        projectId: profileProjectId,
        useProjectToolbar,
        promotedPluginButtons,
      }),
    [
      projectId,
      gitBacked,
      levels,
      loaded,
      profileProjectId,
      useProjectToolbar,
      promotedPluginButtons,
    ]
  );
}

function useFollowPresentationProfile(projectId: string | undefined): void {
  const init = useProjectPresentationStore((s) => s.init);
  const ensureLoaded = useProjectPresentationStore((s) => s.ensureLoaded);

  useEffect(() => {
    init();
  }, [init]);

  // The view learning its project is the renderer's sign that main has bound
  // it, so a profile that could not be read before gets another read now.
  useEffect(() => {
    if (projectId !== undefined) ensureLoaded();
  }, [projectId, ensureLoaded]);
}

/** This view's project toolbar overlay (#13783); starts following main on first use. */
export function useProjectToolbarOverlay(): ProjectToolbarOverlay {
  const viewWorkspaceId = getViewWorkspaceId();
  const projectId = useProjectStore((s) => selectViewProject(viewWorkspaceId, s)?.id);
  const levels = useProjectPresentationStore((s) => s.levels);
  const loaded = useProjectPresentationStore((s) => s.loaded);
  const profileProjectId = useProjectPresentationStore((s) => s.projectId);
  const useProjectToolbar = useProjectPresentationStore((s) => s.useProjectToolbar);
  const promotedPluginButtons = useProjectPresentationStore((s) => s.promotedPluginButtons);
  useFollowPresentationProfile(projectId);

  return useMemo(
    () =>
      projectToolbarOverlayFor(projectId === undefined ? null : { id: projectId }, {
        levels,
        loaded,
        projectId: profileProjectId,
        useProjectToolbar,
        promotedPluginButtons,
      }),
    [projectId, levels, loaded, profileProjectId, useProjectToolbar, promotedPluginButtons]
  );
}
