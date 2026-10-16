import { useMemo, useRef } from "react";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { applyWorktreeLabelColors, computeWorktreeColorMap } from "@shared/theme/worktreeColors";

/**
 * The automatic half: recomputes only when the set of worktree IDs changes
 * (not on every poll cycle that updates other fields).
 */
function useAutomaticWorktreeColorMap(): Record<string, string> | null {
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

/**
 * Returns a stable worktree-id → CSS color variable map, or null when there is
 * only one worktree and nothing is labelled (single-worktree suppression).
 *
 * A user label overrides the automatic colour, so a worktree never shows two
 * colours across the surfaces that read this map (#13408).
 */
export function useWorktreeColorMap(): Record<string, string> | null {
  const automatic = useAutomaticWorktreeColorMap();
  const labels = useWorktreeFilterStore((state) => state.worktreeLabelColors);
  return useMemo(() => applyWorktreeLabelColors(automatic, labels), [automatic, labels]);
}
