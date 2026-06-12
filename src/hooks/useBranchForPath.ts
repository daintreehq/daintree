import { useWorktreeStore } from "@/hooks/useWorktreeStore";

// Selects the derived branch string rather than the worktrees Map: the Map's
// identity changes on every value-changed snapshot merge from the polling
// stream, which would re-render the diff/file-viewer modals consuming this
// hook on every unrelated worktree delta. A primitive selection re-renders
// only when the resolved branch actually changes.
export function useBranchForPath(rootPath: string): string | undefined {
  return useWorktreeStore((s) => {
    if (!rootPath) return undefined;
    const normalized = rootPath.endsWith("/") ? rootPath.slice(0, -1) : rootPath;
    for (const wt of s.worktrees.values()) {
      const wtPath = wt.path.endsWith("/") ? wt.path.slice(0, -1) : wt.path;
      if (wtPath === normalized) return wt.branch;
    }
    return undefined;
  });
}
