import { useCallback } from "react";
import type { WorktreeSnapshot, WorktreeState } from "@shared/types";
import { compareWorktreeNames } from "@/lib/worktreeFilters";
import { useWorktreeStore } from "./useWorktreeStore";

export interface UseWorktreesReturn {
  worktrees: WorktreeState[];
  worktreeMap: Map<string, WorktreeState>;
  activeId: string | null;
  isLoading: boolean;
  isInitialized: boolean;
  isReconnecting: boolean;
  reconnectingAt: number | null;
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

// Keyed by store Map identity so the normalize-clone + sort happens once per
// store update and is shared across every mounted useWorktrees consumer.
const normalizedCache = new WeakMap<
  Map<string, WorktreeSnapshot>,
  { normalizedMap: Map<string, WorktreeState>; worktrees: WorktreeState[] }
>();

function getNormalized(worktreeMap: Map<string, WorktreeSnapshot>): {
  normalizedMap: Map<string, WorktreeState>;
  worktrees: WorktreeState[];
} {
  let cached = normalizedCache.get(worktreeMap);
  if (!cached) {
    const normalizedMap = new Map<string, WorktreeState>();
    for (const [id, snap] of worktreeMap) {
      normalizedMap.set(id, normalizeSnapshot(snap));
    }
    const worktrees = Array.from(normalizedMap.values()).sort((a, b) => {
      if (a.isMainWorktree && !b.isMainWorktree) return -1;
      if (!a.isMainWorktree && b.isMainWorktree) return 1;

      const timeA = a.lastActivityTimestamp ?? 0;
      const timeB = b.lastActivityTimestamp ?? 0;
      if (timeA !== timeB) {
        return timeB - timeA;
      }

      return compareWorktreeNames(a.name, b.name);
    });
    cached = { normalizedMap, worktrees };
    normalizedCache.set(worktreeMap, cached);
  }
  return cached;
}

export function useWorktrees(): UseWorktreesReturn {
  const worktreeMap = useWorktreeStore((state) => state.worktrees);
  const isLoading = useWorktreeStore((state) => state.isLoading);
  const isInitialized = useWorktreeStore((state) => state.isInitialized);
  const isReconnecting = useWorktreeStore((state) => state.isReconnecting);
  const reconnectingAt = useWorktreeStore((state) => state.reconnectingAt);
  const error = useWorktreeStore((state) => state.error);

  const refresh = useCallback(async () => {
    await window.electron.worktreePort.request("refresh");
  }, []);

  const setActive = useCallback((id: string) => {
    window.electron.worktreePort.request("set-active", { worktreeId: id }).catch(() => {});
  }, []);

  const { normalizedMap, worktrees } = getNormalized(worktreeMap);

  return {
    worktrees,
    worktreeMap: normalizedMap,
    activeId: worktrees.length > 0 ? worktrees[0]!.id : null,
    isLoading,
    isInitialized,
    isReconnecting,
    reconnectingAt,
    error,
    refresh,
    setActive,
  };
}

export function useWorktree(worktreeId: string): WorktreeState | null {
  const snap = useWorktreeStore((state) => state.worktrees.get(worktreeId));
  return snap ? normalizeSnapshot(snap) : null;
}
