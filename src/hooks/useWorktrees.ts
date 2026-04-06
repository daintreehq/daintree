import { useCallback, useMemo } from "react";
import type { WorktreeSnapshot, WorktreeState } from "@shared/types";
import { useWorktreeStore } from "./useWorktreeStore";

export interface UseWorktreesReturn {
  worktrees: WorktreeState[];
  worktreeMap: Map<string, WorktreeState>;
  activeId: string | null;
  isLoading: boolean;
  isInitialized: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setActive: (id: string) => void;
}

function normalizeSnapshot(s: WorktreeSnapshot): WorktreeState {
  return {
    ...s,
    worktreeChanges: s.worktreeChanges ?? null,
    lastActivityTimestamp: s.lastActivityTimestamp ?? null,
  } as WorktreeState;
}

export function useWorktrees(): UseWorktreesReturn {
  const worktreeMap = useWorktreeStore((state) => state.worktrees);
  const isLoading = useWorktreeStore((state) => state.isLoading);
  const isInitialized = useWorktreeStore((state) => state.isInitialized);
  const error = useWorktreeStore((state) => state.error);

  const refresh = useCallback(async () => {
    await window.electron.worktreePort.request("refresh");
  }, []);

  const setActive = useCallback((id: string) => {
    window.electron.worktreePort.request("set-active", { worktreeId: id }).catch(() => {});
  }, []);

  const normalizedMap = useMemo(() => {
    const map = new Map<string, WorktreeState>();
    for (const [id, snap] of worktreeMap) {
      map.set(id, normalizeSnapshot(snap));
    }
    return map;
  }, [worktreeMap]);

  const worktrees = useMemo(() => {
    return Array.from(normalizedMap.values()).sort((a, b) => {
      if (a.isMainWorktree && !b.isMainWorktree) return -1;
      if (!a.isMainWorktree && b.isMainWorktree) return 1;

      const timeA = a.lastActivityTimestamp ?? 0;
      const timeB = b.lastActivityTimestamp ?? 0;
      if (timeA !== timeB) {
        return timeB - timeA;
      }

      return a.name.localeCompare(b.name);
    });
  }, [normalizedMap]);

  return {
    worktrees,
    worktreeMap: normalizedMap,
    activeId: worktrees.length > 0 ? worktrees[0].id : null,
    isLoading,
    isInitialized,
    error,
    refresh,
    setActive,
  };
}

export function useWorktree(worktreeId: string): WorktreeState | null {
  const snap = useWorktreeStore((state) => state.worktrees.get(worktreeId));
  return snap ? normalizeSnapshot(snap) : null;
}
