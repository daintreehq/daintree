import { useMemo } from "react";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";

export function useBranchForPath(rootPath: string): string | undefined {
  const worktrees = useWorktreeStore((s) => s.worktrees);
  return useMemo(() => {
    if (!rootPath) return undefined;
    const normalized = rootPath.endsWith("/") ? rootPath.slice(0, -1) : rootPath;
    for (const wt of worktrees.values()) {
      const wtPath = wt.path.endsWith("/") ? wt.path.slice(0, -1) : wt.path;
      if (wtPath === normalized) return wt.branch;
    }
    return undefined;
  }, [worktrees, rootPath]);
}
