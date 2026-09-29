import { useProjectStore } from "@/store/projectStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { useWorktreeStoreOptional } from "@/hooks/useWorktreeStore";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";
import {
  APP_SOURCE_LABEL,
  UNKNOWN_PROJECT_LABEL,
  formatNotificationSource,
  worktreeNameFromId,
} from "@/lib/notificationSourceLabel";
import {
  isOtherProjectContext,
  resolveNotificationDestination,
  type NotificationDestination,
} from "@/lib/notificationDestination";

type NotificationContext = NotificationHistoryEntry["context"];

/**
 * Where a notification came from, in words: the project's name and the
 * worktree's. Never an id — a project id is a sha256, and one that names no
 * registered project is dropped rather than printed.
 */
export function useNotificationSource(context: NotificationContext): string {
  const projectId = context?.projectId;
  const worktreeId = context?.worktreeId;
  const projectName = useProjectStore((s) =>
    projectId ? s.projects.find((p) => p.id === projectId)?.name : undefined
  );
  // Optional: rows also render in isolation (tests, previews) and only enrich
  // themselves with the view's worktree names when a store is there to ask.
  const worktreeName = useWorktreeStoreOptional<string | undefined>(
    (s) => (worktreeId ? s.worktrees.get(worktreeId)?.name : undefined),
    undefined
  );
  return (
    formatNotificationSource(
      projectName ?? (projectId ? UNKNOWN_PROJECT_LABEL : undefined),
      worktreeId ? worktreeName?.trim() || worktreeNameFromId(worktreeId) : undefined
    ) ?? APP_SOURCE_LABEL
  );
}

/**
 * Whether this view still has the worktree: present in its inventory and not
 * one of the deleted worktrees whose terminals outlived them.
 */
export function useIsWorktreeLive(worktreeId: string | undefined): boolean {
  const inView = useWorktreeStoreOptional<boolean>(
    (s) => (worktreeId ? s.worktrees.has(worktreeId) : false),
    false
  );
  const deleted = useWorktreeSelectionStore((s) =>
    worktreeId ? s.deletedWorktrees.has(worktreeId) : false
  );
  return inView && !deleted;
}

/**
 * A section's worktree that this view no longer has. Only claimed for the
 * current project: another project's worktrees were never here to lose.
 */
export function useIsWorktreeUnavailable(
  worktreeId: string | undefined,
  projectId: string | undefined
): boolean {
  const live = useIsWorktreeLive(worktreeId);
  const ownerId = useViewOwnerId();
  if (!worktreeId || live) return false;
  return !isOtherProjectContext({ projectId }, ownerId);
}

/**
 * The workspace this view belongs to: its project, or a scratch workspace,
 * which has no `currentProject` but still owns the panels it records against
 * its own id.
 */
function useViewOwnerId(): string | undefined {
  const currentProjectId = useProjectStore((s) => s.currentProject?.id);
  return getViewWorkspaceId() ?? currentProjectId;
}

/**
 * The row's destination as it stands now, re-derived whenever the panel is
 * trashed or restored or the worktree comes or goes. Click time re-reads it
 * live (see notificationNavigation.ts) rather than trusting this render.
 */
export function useNotificationDestination(context: NotificationContext): NotificationDestination {
  const panelId = context?.panelId;
  const currentProjectId = useViewOwnerId();
  const panelLocation = usePanelStore((s) =>
    panelId ? s.panelsById[panelId]?.location : undefined
  );
  const panelWorktreeId = usePanelStore((s) =>
    panelId ? s.panelsById[panelId]?.worktreeId : undefined
  );
  const worktreeLive = useIsWorktreeLive(context?.worktreeId);
  return resolveNotificationDestination(context, {
    currentProjectId,
    panelLocation,
    panelWorktreeId,
    worktreeLive,
  });
}
