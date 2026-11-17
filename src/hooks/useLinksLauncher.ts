import { useCallback, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ProjectLink } from "@shared/types";
import type { NormalizedPRState } from "@shared/types/forge";
import type { DevPreviewSessionStatus } from "@shared/types/ipc/devPreview";
import { safeDetailsUrl } from "@/components/Worktree/ReviewHub/prChecks";
import { useResolvedForgeProvider } from "@/hooks/useResolvedForgeProvider";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { getWorktreeBranchLabel } from "@/lib/worktreeHeadline";
import { acquireAllDevSessions, useAllDevSessionsStore } from "@/store/allDevSessionsStore";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
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

/** The active worktree's pull request, as the forge reported it (#17253). */
export interface LauncherPullRequest {
  worktreeId: string;
  worktreePath: string;
  /** The worktree's branch, or its name where it has none to show. */
  worktreeLabel: string;
  providerId: string;
  number: number;
  /** Validated as an ordinary http(s) address. */
  url: string;
  title: string | undefined;
  state: NormalizedPRState;
}

/**
 * The pull request of this view's active worktree, or `null` when there is
 * none to show. Only a provider-attributed record counts, and only while that
 * provider is still this project's code forge: a worktree keeps its last
 * record through a forge being removed, and a PR seeded before any provider
 * resolved carries no attribution at all. A selection naming a worktree this
 * view doesn't hold (a restored id, another project's) shows nothing.
 */
export function useLinksLauncherPullRequest(): LauncherPullRequest | null {
  const codeProviderId = useResolvedForgeProvider(useViewProjectId()).providerId;
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);
  const pullRequest = useWorktreeStore(
    useShallow((state): LauncherPullRequest | null => {
      const worktree = activeWorktreeId ? state.worktrees.get(activeWorktreeId) : undefined;
      const linked = worktree?.linked;
      const pr = linked?.pr;
      if (!worktree || !linked || !pr) return null;
      const url = safeDetailsUrl(pr.url);
      const number = pr.ref.number;
      if (!url || !Number.isSafeInteger(number) || number <= 0) return null;
      return {
        worktreeId: worktree.id,
        worktreePath: worktree.path,
        worktreeLabel: getWorktreeBranchLabel(worktree),
        providerId: linked.providerId,
        number,
        url,
        title: pr.title?.trim() || undefined,
        state: pr.state,
      };
    })
  );
  return pullRequest !== null && pullRequest.providerId === codeProviderId ? pullRequest : null;
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

/**
 * A dev server in one of these states brings the launcher's button up on its
 * own (#17251): coming up, up, going down, or failed. A stopped one, or one
 * restored stopped after a relaunch, waits in the list for the launcher to be
 * opened some other way.
 */
const LIVE_DEV_STATUSES: ReadonlySet<DevPreviewSessionStatus> = new Set([
  "starting",
  "installing",
  "running",
  "stopping",
  "error",
]);

/**
 * Whether any dev server on this machine is live. Holds the cross-worktree
 * session subscription for as long as it is mounted, which is the toolbar's
 * life, so a server started anywhere shows the button before the launcher
 * has ever been opened.
 */
export function useHasLiveDevServer(): boolean {
  useEffect(() => acquireAllDevSessions(), []);
  return useAllDevSessionsStore((s) =>
    s.sessions.some((session) => LIVE_DEV_STATUSES.has(session.status))
  );
}
