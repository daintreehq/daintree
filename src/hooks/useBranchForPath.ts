import { useMemo } from "react";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";

export function useBranchForPath(rootPath: string): string | undefined {
  const worktrees = useWorktreeDataStore((s) => s.worktrees);
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
