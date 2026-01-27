import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";

const memoryStorage: StateStorage = (() => {
  const storage = new Map<string, string>();
  return {
    getItem: (name) => storage.get(name) ?? null,
    setItem: (name, value) => {
      storage.set(name, value);
    },
    removeItem: (name) => {
      storage.delete(name);
    },
  };
})();

function getSafeStorage(): StateStorage {
  if (typeof localStorage !== "undefined") {
    return localStorage;
  }
  return memoryStorage;
}

export type OrderBy = "recent" | "created" | "alpha";

export type StatusFilter = "active" | "dirty" | "error" | "stale" | "idle";
export type TypeFilter =
  | "feature"
  | "bugfix"
  | "refactor"
  | "chore"
  | "docs"
  | "test"
  | "release"
  | "ci"
  | "deps"
  | "perf"
  | "style"
  | "wip"
  | "main"
  | "detached"
  | "other";
export type GitHubFilter = "hasIssue" | "hasPR" | "prOpen" | "prMerged" | "prClosed";
export type SessionFilter =
  | "hasTerminals"
  | "working"
  | "running"
  | "waiting"
  | "failed"
  | "completed";
export type ActivityFilter = "last15m" | "last1h" | "last24h" | "last7d";

interface WorktreeFilterState {
  query: string;
  orderBy: OrderBy;
  groupByType: boolean;
  statusFilters: Set<StatusFilter>;
  typeFilters: Set<TypeFilter>;
  githubFilters: Set<GitHubFilter>;
  sessionFilters: Set<SessionFilter>;
  activityFilters: Set<ActivityFilter>;
  alwaysShowActive: boolean;
  hideMainWorktree: boolean;
  pinnedWorktrees: string[];
}

interface WorktreeFilterActions {
  setQuery: (query: string) => void;
  setOrderBy: (orderBy: OrderBy) => void;
  setGroupByType: (enabled: boolean) => void;
  toggleStatusFilter: (filter: StatusFilter) => void;
  toggleTypeFilter: (filter: TypeFilter) => void;
  toggleGitHubFilter: (filter: GitHubFilter) => void;
  toggleSessionFilter: (filter: SessionFilter) => void;
  toggleActivityFilter: (filter: ActivityFilter) => void;
  setAlwaysShowActive: (enabled: boolean) => void;
  setHideMainWorktree: (enabled: boolean) => void;
  pinWorktree: (id: string) => void;
  unpinWorktree: (id: string) => void;
  isWorktreePinned: (id: string) => boolean;
  clearAll: () => void;
  getActiveFilterCount: () => number;
  hasActiveFilters: () => boolean;
}

type WorktreeFilterStore = WorktreeFilterState & WorktreeFilterActions;

interface PersistedState {
  query: string;
  orderBy: OrderBy;
  groupByType: boolean;
  statusFilters: StatusFilter[];
  typeFilters: TypeFilter[];
  githubFilters: GitHubFilter[];
  sessionFilters: SessionFilter[];
  activityFilters: ActivityFilter[];
  alwaysShowActive: boolean;
  hideMainWorktree: boolean;
  pinnedWorktrees: string[];
}

export const useWorktreeFilterStore = create<WorktreeFilterStore>()(
  persist(
    (set, get) => ({
      query: "",
      orderBy: "created",
      groupByType: false,
      statusFilters: new Set<StatusFilter>(),
      typeFilters: new Set<TypeFilter>(),
      githubFilters: new Set<GitHubFilter>(),
      sessionFilters: new Set<SessionFilter>(),
      activityFilters: new Set<ActivityFilter>(),
      alwaysShowActive: true,
      hideMainWorktree: true,
      pinnedWorktrees: [],

      setQuery: (query) => set({ query }),
      setOrderBy: (orderBy) => set({ orderBy }),
      setGroupByType: (enabled) => set({ groupByType: enabled }),

      toggleStatusFilter: (filter) =>
        set((state) => {
          const newSet = new Set(state.statusFilters);
          if (newSet.has(filter)) {
            newSet.delete(filter);
          } else {
            newSet.add(filter);
          }
          return { statusFilters: newSet };
        }),

      toggleTypeFilter: (filter) =>
        set((state) => {
          const newSet = new Set(state.typeFilters);
          if (newSet.has(filter)) {
            newSet.delete(filter);
          } else {
            newSet.add(filter);
          }
          return { typeFilters: newSet };
        }),

      toggleGitHubFilter: (filter) =>
        set((state) => {
          const newSet = new Set(state.githubFilters);
          if (newSet.has(filter)) {
            newSet.delete(filter);
          } else {
            newSet.add(filter);
          }
          return { githubFilters: newSet };
        }),

      toggleSessionFilter: (filter) =>
        set((state) => {
          const newSet = new Set(state.sessionFilters);
          if (newSet.has(filter)) {
            newSet.delete(filter);
          } else {
            newSet.add(filter);
          }
          return { sessionFilters: newSet };
        }),

      toggleActivityFilter: (filter) =>
        set((state) => {
          const newSet = new Set(state.activityFilters);
          if (newSet.has(filter)) {
            newSet.delete(filter);
          } else {
            newSet.add(filter);
          }
          return { activityFilters: newSet };
        }),

      setAlwaysShowActive: (enabled) => set({ alwaysShowActive: enabled }),
      setHideMainWorktree: (enabled) => set({ hideMainWorktree: enabled }),

      pinWorktree: (id) =>
        set((state) => {
          if (state.pinnedWorktrees.includes(id)) {
            return state;
          }
          return { pinnedWorktrees: [...state.pinnedWorktrees, id] };
        }),

      unpinWorktree: (id) =>
        set((state) => ({
          pinnedWorktrees: state.pinnedWorktrees.filter((wId) => wId !== id),
        })),

      isWorktreePinned: (id) => get().pinnedWorktrees.includes(id),

      clearAll: () =>
        set({
          query: "",
          statusFilters: new Set(),
          typeFilters: new Set(),
          githubFilters: new Set(),
          sessionFilters: new Set(),
          activityFilters: new Set(),
          hideMainWorktree: true,
        }),

      getActiveFilterCount: () => {
        const state = get();
        return (
          (state.query.length > 0 ? 1 : 0) +
          state.statusFilters.size +
          state.typeFilters.size +
          state.githubFilters.size +
          state.sessionFilters.size +
          state.activityFilters.size
        );
      },

      hasActiveFilters: () => {
        const state = get();
        return (
          state.query.length > 0 ||
          state.statusFilters.size > 0 ||
          state.typeFilters.size > 0 ||
          state.githubFilters.size > 0 ||
          state.sessionFilters.size > 0 ||
          state.activityFilters.size > 0
        );
      },
    }),
    {
      name: "canopy-worktree-filters",
      storage: createJSONStorage(() => getSafeStorage()),
      partialize: (state): PersistedState => ({
        query: state.query,
        orderBy: state.orderBy,
        groupByType: state.groupByType,
        statusFilters: Array.from(state.statusFilters),
        typeFilters: Array.from(state.typeFilters),
        githubFilters: Array.from(state.githubFilters),
        sessionFilters: Array.from(state.sessionFilters),
        activityFilters: Array.from(state.activityFilters),
        alwaysShowActive: state.alwaysShowActive,
        hideMainWorktree: state.hideMainWorktree,
        pinnedWorktrees: state.pinnedWorktrees,
      }),
      merge: (persisted, current) => {
        const p = persisted as PersistedState | undefined;
        return {
          ...current,
          query: p?.query ?? "",
          orderBy: p?.orderBy ?? "created",
          groupByType: p?.groupByType ?? false,
          statusFilters: new Set(p?.statusFilters ?? []),
          typeFilters: new Set(p?.typeFilters ?? []),
          githubFilters: new Set(p?.githubFilters ?? []),
          sessionFilters: new Set(p?.sessionFilters ?? []),
          activityFilters: new Set(p?.activityFilters ?? []),
          alwaysShowActive: p?.alwaysShowActive ?? true,
          hideMainWorktree: p?.hideMainWorktree ?? true,
          pinnedWorktrees: p?.pinnedWorktrees ?? [],
        };
      },
    }
  )
);
