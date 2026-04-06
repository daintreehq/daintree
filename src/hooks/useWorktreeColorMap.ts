import { useRef } from "react";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { computeWorktreeColorMap } from "@shared/theme/worktreeColors";

/**
 * Returns a stable worktree-id → CSS color variable map, or null when
 * there is only one worktree (single-worktree suppression).
 *
 * The selector recomputes only when the set of worktree IDs changes
 * (not on every poll cycle that updates other fields).
 */
export function useWorktreeColorMap(): Record<string, string> | null {
  const prevKeysRef = useRef<string>("");
  const prevMapRef = useRef<Record<string, string> | null>(null);

  return useWorktreeStore((state) => {
    const worktrees = state.worktrees;
    if (worktrees.size <= 1) {
      prevKeysRef.current = "";
      prevMapRef.current = null;
      return null;
    }

    // Build a cache key from sorted worktree IDs
    const ids: string[] = [];
    for (const id of worktrees.keys()) {
      ids.push(id);
    }
    ids.sort();
    const keysStr = ids.join("\0");

    if (keysStr === prevKeysRef.current) {
      return prevMapRef.current;
    }

    prevKeysRef.current = keysStr;
    prevMapRef.current = computeWorktreeColorMap(worktrees);
    return prevMapRef.current;
  });
}
