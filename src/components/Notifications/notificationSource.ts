import { useProjectStore } from "@/store/projectStore";
import { useWorktreeStoreOptional } from "@/hooks/useWorktreeStore";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";
import { formatNotificationSource, worktreeNameFromId } from "@/lib/notificationSourceLabel";

type NotificationContext = NotificationHistoryEntry["context"];

/**
 * Where a notification came from, in words: the project's name and the
 * worktree's. Never an id — a project id is a sha256, and one that names no
 * registered project is dropped rather than printed.
 */
export function useNotificationSource(context: NotificationContext): string | null {
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
  return formatNotificationSource(
    projectName,
    worktreeId ? worktreeName?.trim() || worktreeNameFromId(worktreeId) : undefined
  );
}
