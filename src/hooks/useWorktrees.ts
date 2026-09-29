import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import type { WorktreeSnapshot, WorktreeState } from "@shared/types";
import { compareWorktreeNames } from "@/lib/worktreeFilters";
import { isValidPastTimestamp } from "@/utils/timestamps";
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

// Store snapshots are immutable and replaced per worktree on change, so caching
// by snapshot identity keeps every untouched worktree's normalized object
// stable across Map updates — sidebar cards and other per-worktree consumers
// then see unchanged props and skip re-rendering.
const normalizedBySnapshot = new WeakMap<WorktreeSnapshot, WorktreeState>();

function normalizeSnapshot(s: WorktreeSnapshot): WorktreeState {
  let normalized = normalizedBySnapshot.get(s);
  if (!normalized) {
    normalized = {
      ...s,
      worktreeChanges: s.worktreeChanges ?? null,
      lastActivityTimestamp: s.lastActivityTimestamp ?? null,
    } as WorktreeState;
    normalizedBySnapshot.set(s, normalized);
  }
  return normalized;
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
    const now = Date.now();
    const worktrees = Array.from(normalizedMap.values()).sort((a, b) => {
      if (a.isMainWorktree && !b.isMainWorktree) return -1;
      if (!a.isMainWorktree && b.isMainWorktree) return 1;

      const timeA = isValidPastTimestamp(a.lastActivityTimestamp, now)
        ? a.lastActivityTimestamp
        : 0;
      const timeB = isValidPastTimestamp(b.lastActivityTimestamp, now)
        ? b.lastActivityTimestamp
        : 0;
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

/** The normalized view of a store worktree Map, shared with `useWorktrees`. */
export function getNormalizedWorktreeMap(
  worktreeMap: Map<string, WorktreeSnapshot>
): Map<string, WorktreeState> {
  return getNormalized(worktreeMap).normalizedMap;
}

/** The normalized, sorted list of a store worktree Map — `useWorktrees().worktrees`. */
export function getNormalizedWorktreeList(
  worktreeMap: Map<string, WorktreeSnapshot>
): WorktreeState[] {
  return getNormalized(worktreeMap).worktrees;
}

// Stable sentinel for gated consumers — getNormalized caches per Map identity,
// so a disabled subscription yields the same empty outputs every render.
const EMPTY_WORKTREES = new Map<string, WorktreeSnapshot>();

export function useWorktrees(options?: { enabled?: boolean }): UseWorktreesReturn {
  // `enabled: false` swaps the Map subscription for a stable empty sentinel so
  // always-mounted consumers that only need the data while visible (e.g. the
  // quick switcher while open) stop re-rendering on every worktree-map change.
  const enabled = options?.enabled ?? true;
  const worktreeMap = useWorktreeStore((state) => (enabled ? state.worktrees : EMPTY_WORKTREES));
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

function selectWorktreeNames(state: { worktrees: Map<string, WorktreeSnapshot> }) {
  const names = new Map<string, string>();
  for (const [id, snap] of state.worktrees) names.set(id, snap.name);
  return names;
}

/**
 * Worktree id → display name, for surfaces that only label rows with a
 * worktree's name. Shallow-compared, so git-status and activity updates — which
 * replace a snapshot without renaming it — do not re-render the consumer.
 */
export function useWorktreeNames(): ReadonlyMap<string, string> {
  return useWorktreeStore(useShallow(selectWorktreeNames));
}
