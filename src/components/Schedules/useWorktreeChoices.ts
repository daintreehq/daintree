import { useMemo } from "react";
import { useWorktrees } from "@/hooks/useWorktrees";
import { worktreeDisplayName } from "@/utils/recipeScope";
import type { WorktreeChoice } from "./ScheduleEditor";

/**
 * Where a schedule can run, as the editor offers it (the main checkout first),
 * and each other worktree's label by id, as the list and history name it.
 */
export function useWorktreeChoices() {
  const { worktrees, isInitialized, isLoading, isReconnecting, error } = useWorktrees();
  const choices = useMemo<WorktreeChoice[]>(() => {
    const main = worktrees.find((worktree) => worktree.isMainWorktree);
    const others = worktrees.filter((worktree) => !worktree.isMainWorktree);
    const mainBranch = main?.branch ? ` · ${main.branch}` : "";
    return [
      { id: null, label: `Main checkout${mainBranch}` },
      ...others.map((worktree) => ({
        id: worktree.id,
        label: worktreeDisplayName(worktree) ?? worktree.path,
      })),
    ];
  }, [worktrees]);
  const labels = useMemo(
    () =>
      new Map(choices.flatMap((choice) => (choice.id ? [[choice.id, choice.label] as const] : []))),
    [choices]
  );
  // Null until the project's worktrees are known, as a landing judges it
  // (`knowsWorktrees`): the main checkout is always listed, so an empty list only
  // says the host hasn't reported, and a reconnecting one may be out of date.
  const known = isInitialized && !isLoading && !isReconnecting && error === null;
  const ids = useMemo(
    () =>
      known && worktrees.length > 0 ? new Set(worktrees.map((worktree) => worktree.id)) : null,
    [worktrees, known]
  );
  return { choices, labels, ids };
}
