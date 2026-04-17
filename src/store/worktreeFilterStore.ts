import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import type { QuickStateFilter } from "@/lib/worktreeFilters";

export type OrderBy = "recent" | "created" | "alpha" | "manual";

export type StatusFilter = "active" | "dirty" | "stale" | "idle";
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
  | "completed"
  | "exited";
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
  alwaysShowWaiting: boolean;
  hideMainWorktree: boolean;
  pinnedWorktrees: string[];
  collapsedWorktrees: string[];
  manualOrder: string[];
  /** Transient session-only quick-state chip filter (not persisted). */
  quickStateFilter: QuickStateFilter;
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
  setAlwaysShowWaiting: (enabled: boolean) => void;
  setHideMainWorktree: (enabled: boolean) => void;
  pinWorktree: (id: string) => void;
  unpinWorktree: (id: string) => void;
  isWorktreePinned: (id: string) => boolean;
  collapseWorktree: (id: string) => void;
  expandWorktree: (id: string) => void;
  toggleWorktreeCollapsed: (id: string) => void;
  isWorktreeCollapsed: (id: string) => boolean;
  setManualOrder: (order: string[]) => void;
  setQuickStateFilter: (filter: QuickStateFilter) => void;
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
  alwaysShowWaiting: boolean;
  hideMainWorktree: boolean;
  pinnedWorktrees: string[];
  collapsedWorktrees: string[];
  manualOrder: string[];
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
      alwaysShowWaiting: true,
      hideMainWorktree: false,
      pinnedWorktrees: [],
      collapsedWorktrees: [],
      manualOrder: [],
      quickStateFilter: "all",

      setQuery: (query) => set({ query }),
      setOrderBy: (orderBy) => set({ orderBy }),
      setGroupByType: (enabled) =>
        set((state) => ({
          groupByType: enabled,
          orderBy: enabled && state.orderBy === "manual" ? "created" : state.orderBy,
        })),

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
      setAlwaysShowWaiting: (enabled) => set({ alwaysShowWaiting: enabled }),
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

      collapseWorktree: (id) =>
        set((state) => {
          if (state.collapsedWorktrees.includes(id)) {
            return state;
          }
          return { collapsedWorktrees: [...state.collapsedWorktrees, id] };
        }),

      expandWorktree: (id) =>
        set((state) => ({
          collapsedWorktrees: state.collapsedWorktrees.filter((wId) => wId !== id),
        })),

      toggleWorktreeCollapsed: (id) => {
        if (get().collapsedWorktrees.includes(id)) {
          get().expandWorktree(id);
        } else {
          get().collapseWorktree(id);
        }
      },

      isWorktreeCollapsed: (id) => get().collapsedWorktrees.includes(id),

      setManualOrder: (order) => set({ manualOrder: order }),

      setQuickStateFilter: (quickStateFilter) => set({ quickStateFilter }),

      clearAll: () =>
        set({
          query: "",
          statusFilters: new Set(),
          typeFilters: new Set(),
          githubFilters: new Set(),
          sessionFilters: new Set(),
          activityFilters: new Set(),
          hideMainWorktree: false,
          quickStateFilter: "all",
        }),

      getActiveFilterCount: () => {
        const state = get();
        const hasQuery = state.query.trim().length > 0;
        return (
          (hasQuery ? 1 : 0) +
          state.statusFilters.size +
          state.typeFilters.size +
          state.githubFilters.size +
          state.sessionFilters.size +
          state.activityFilters.size +
          (state.quickStateFilter !== "all" ? 1 : 0)
        );
      },

      hasActiveFilters: () => {
        const state = get();
        const hasQuery = state.query.trim().length > 0;
        return (
          hasQuery ||
          state.statusFilters.size > 0 ||
          state.typeFilters.size > 0 ||
          state.githubFilters.size > 0 ||
          state.sessionFilters.size > 0 ||
          state.activityFilters.size > 0 ||
          state.quickStateFilter !== "all"
        );
      },
    }),
    {
      name: "daintree-worktree-filters",
      storage: createSafeJSONStorage(),
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
        alwaysShowWaiting: state.alwaysShowWaiting,
        hideMainWorktree: state.hideMainWorktree,
        pinnedWorktrees: state.pinnedWorktrees,
        collapsedWorktrees: state.collapsedWorktrees,
        manualOrder: state.manualOrder,
      }),
      merge: (persisted, current) => {
        const p = persisted as PersistedState | undefined;
        const groupByType = p?.groupByType ?? false;
        const rawOrderBy = p?.orderBy ?? "created";
        // Normalize invalid combination: manual + groupByType
        const orderBy = groupByType && rawOrderBy === "manual" ? "created" : rawOrderBy;
        return {
          ...current,
          query: p?.query ?? "",
          orderBy,
          groupByType,
          statusFilters: new Set(p?.statusFilters ?? []),
          typeFilters: new Set(p?.typeFilters ?? []),
          githubFilters: new Set(p?.githubFilters ?? []),
          sessionFilters: new Set(p?.sessionFilters ?? []),
          activityFilters: new Set(p?.activityFilters ?? []),
          alwaysShowActive: p?.alwaysShowActive ?? true,
          alwaysShowWaiting: p?.alwaysShowWaiting ?? true,
          hideMainWorktree: p?.hideMainWorktree ?? false,
          pinnedWorktrees: p?.pinnedWorktrees ?? [],
          collapsedWorktrees: p?.collapsedWorktrees ?? [],
          manualOrder: p?.manualOrder ?? [],
        };
      },
    }
  )
);
