import { useEffect, useMemo } from "react";
import { isGitBackedProject, type Project } from "@shared/types/project";
import {
  defaultPresentationLevel,
  hasProjectToolbarOverrides,
  isProjectToolbarActive,
  resolvePresentation,
  type PresentationLevels,
  type ResolvedPresentation,
} from "@shared/config/presentationProfile";
import {
  STOCK_LAUNCHER_ARRANGEMENT,
  type LauncherArrangement,
} from "@shared/config/launcherArrangement";
import { useProjectStore } from "@/store/projectStore";
import { useProjectPresentationStore } from "@/store/projectPresentationStore";
import { useDevPreviewOfferStore } from "@/store/devPreviewOfferStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { selectViewProject } from "@/store/viewWorkspace";

const NO_LEVELS: PresentationLevels = {};
const NO_PROMOTED: readonly string[] = [];
const NO_ORDER: readonly string[] = [];

interface ProfileForView {
  levels: PresentationLevels;
  loaded: boolean;
  projectId: string | null;
  /** Absent reads as never set, so the toolbar follows whether the profile places anything. */
  useProjectToolbar?: boolean | null;
  promotedPluginButtons?: readonly string[];
  launcherGroupOrder?: readonly string[];
  featuredLaunchEntry?: string | null;
}

/**
 * The profile's levels for `project`, defaults filled in. Levels count only
 * once main has answered for this same project; until then — and for a view
 * with no project row, such as a scratch workspace — every feature draws its
 * default, which is exactly what it drew before profiles existed.
 *
 * `devPreviewOffered` is this view's answer from `devPreviewOfferStore`
 * (#14069); absent, the dev preview keeps today's default.
 */
export function resolvePresentationFor(
  project: Pick<Project, "id" | "gitBacked"> | null | undefined,
  profile: ProfileForView,
  devPreviewOffered?: boolean
): ResolvedPresentation {
  // Not `isGitBackedProject(null)`: that answers true, and a view with no
  // project row has no repository to report on.
  const gitBacked = project != null && isGitBackedProject(project);
  const applies = profileAppliesTo(project, profile);
  return resolvePresentation(
    applies ? profile.levels : NO_LEVELS,
    { gitBacked, devPreviewOffered },
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
    useProjectPresentationStore.getState(),
    useDevPreviewOfferStore.getState().reason !== null
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
  const devPreviewOffered = useDevPreviewOfferStore((s) => s.reason !== null);
  useFollowPresentationProfile(projectId);

  return useMemo(
    () =>
      resolvePresentationFor(
        projectId === undefined ? null : { id: projectId, gitBacked },
        {
          levels,
          loaded,
          projectId: profileProjectId,
          useProjectToolbar,
          promotedPluginButtons,
        },
        devPreviewOffered
      ),
    [
      projectId,
      gitBacked,
      levels,
      loaded,
      profileProjectId,
      useProjectToolbar,
      promotedPluginButtons,
      devPreviewOffered,
    ]
  );
}

/**
 * Whether this view's project hides the dev preview (#14069). The one answer
 * surfaces that stay mounted for the life of the view need, read through
 * primitives so a profile change that leaves it alone re-renders nothing.
 */
export function useDevPreviewHidden(): boolean {
  const viewWorkspaceId = getViewWorkspaceId();
  const projectId = useProjectStore((s) => selectViewProject(viewWorkspaceId, s)?.id);
  const gitBacked = useProjectStore((s) => selectViewProject(viewWorkspaceId, s)?.gitBacked);
  const level = useProjectPresentationStore((s) =>
    projectId !== undefined && s.loaded && s.projectId === projectId
      ? s.levels.devServer
      : undefined
  );
  const devPreviewOffered = useDevPreviewOfferStore((s) => s.reason !== null);
  useFollowPresentationProfile(projectId);
  if (projectId === undefined) return false;
  const fallback = defaultPresentationLevel("devServer", {
    gitBacked: isGitBackedProject({ gitBacked }),
    devPreviewOffered,
  });
  return (level ?? fallback) === "hidden";
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

/**
 * How `project` arranges its launcher (#13791), resolved like its levels:
 * stock until main has answered for this same project.
 */
export function launcherArrangementFor(
  project: Pick<Project, "id" | "gitBacked"> | null | undefined,
  profile: ProfileForView
): LauncherArrangement {
  if (project == null || !profileAppliesTo(project, profile)) return STOCK_LAUNCHER_ARRANGEMENT;
  const resolved = resolvePresentationFor(project, profile);
  return {
    projectId: project.id,
    demoted: {
      agents: resolved.launcherAgents === "demoted",
      panels: resolved.launcherPanels === "demoted",
    },
    groupOrder: profile.launcherGroupOrder ?? NO_ORDER,
    featuredEntry: profile.featuredLaunchEntry ?? null,
  };
}

/** This view's launcher arrangement (#13791); starts following main on first use. */
export function useLauncherArrangement(): LauncherArrangement {
  const viewWorkspaceId = getViewWorkspaceId();
  const projectId = useProjectStore((s) => selectViewProject(viewWorkspaceId, s)?.id);
  const gitBacked = useProjectStore((s) => selectViewProject(viewWorkspaceId, s)?.gitBacked);
  const levels = useProjectPresentationStore((s) => s.levels);
  const loaded = useProjectPresentationStore((s) => s.loaded);
  const profileProjectId = useProjectPresentationStore((s) => s.projectId);
  const launcherGroupOrder = useProjectPresentationStore((s) => s.launcherGroupOrder);
  const featuredLaunchEntry = useProjectPresentationStore((s) => s.featuredLaunchEntry);
  useFollowPresentationProfile(projectId);

  return useMemo(
    () =>
      launcherArrangementFor(projectId === undefined ? null : { id: projectId, gitBacked }, {
        levels,
        loaded,
        projectId: profileProjectId,
        launcherGroupOrder,
        featuredLaunchEntry,
      }),
    [
      projectId,
      gitBacked,
      levels,
      loaded,
      profileProjectId,
      launcherGroupOrder,
      featuredLaunchEntry,
    ]
  );
}
