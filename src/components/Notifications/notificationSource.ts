import { useProjectStore } from "@/store/projectStore";
import { useWorktreeStoreOptional } from "@/hooks/useWorktreeStore";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";
import {
  APP_SOURCE_LABEL,
  UNKNOWN_PROJECT_LABEL,
  formatNotificationSource,
  worktreeNameFromId,
} from "@/lib/notificationSourceLabel";

type NotificationContext = NotificationHistoryEntry["context"];

/**
 * Where a notification came from, in words: the other host's name when it
 * came from one, then the project's name and the worktree's. Never an id — a project id is a sha256, and one that names no
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
      worktreeId ? worktreeName?.trim() || worktreeNameFromId(worktreeId) : undefined,
      context?.hostName
    ) ?? APP_SOURCE_LABEL
  );
}
