import { useCallback, useEffect } from "react";
import type { ProjectLink } from "@shared/types";
import { useProjectStore } from "@/store/projectStore";
import { useGlobalLinksStore, type GlobalLink } from "@/store/globalLinksStore";
import { refreshCachedProjectLinks, useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useLinksLauncherStore } from "@/store/linksLauncherStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { selectViewProject } from "@/store/viewWorkspace";
import { useProjectViewRevealed } from "@/hooks/useProjectViewRevealed";
import { logError } from "@/utils/logger";

export interface LinksLauncherLinks {
  /** This view's project's links, never another project's (#17091). */
  projectLinks: readonly ProjectLink[];
  /** The person's global links that are switched on, in their order. */
  globalLinks: readonly GlobalLink[];
}

const NO_PROJECT_LINKS: readonly ProjectLink[] = [];

function useViewProjectId(): string | null {
  return useProjectStore((s) => selectViewProject(getViewWorkspaceId(), s)?.id ?? null);
}

/** What the links launcher lists right now. */
export function useLinksLauncherLinks(): LinksLauncherLinks {
  const viewProjectId = useViewProjectId();
  const projectLinks = useProjectSettingsStore((s) =>
    viewProjectId !== null && s.projectId === viewProjectId ? s.settings?.links : undefined
  );
  const links = useGlobalLinksStore((s) => s.links);
  const globalLinks = links.filter((link) => link.enabled);
  return { projectLinks: projectLinks ?? NO_PROJECT_LINKS, globalLinks };
}

export function hasLauncherLinks({ projectLinks, globalLinks }: LinksLauncherLinks): boolean {
  return projectLinks.length > 0 || globalLinks.length > 0;
}

/**
 * Keeps this view's cached project links current for the launcher. Mounted
 * once, whether or not the button shows: an empty list must still be able to
 * find its first link, which is what brings the button back. Reads main's
 * list when the project's settings land, on every opening, and when the view
 * comes back. Global links need nothing here: their store follows sibling
 * views' writes through the `storage` event itself.
 */
export function useLinksLauncherRefresh(): void {
  const viewProjectId = useViewProjectId();
  const settingsCached = useProjectSettingsStore(
    (s) => viewProjectId !== null && s.projectId === viewProjectId && s.settings !== null
  );
  const refreshSeq = useLinksLauncherStore((s) => s.refreshSeq);
  const refresh = useCallback(() => {
    if (viewProjectId === null) return;
    refreshCachedProjectLinks(viewProjectId).catch((error: unknown) =>
      logError("Failed to refresh the project's links", error)
    );
  }, [viewProjectId]);
  useEffect(() => {
    if (settingsCached) refresh();
  }, [settingsCached, refreshSeq, refresh]);
  useProjectViewRevealed(refresh, { enabled: settingsCached });
}
