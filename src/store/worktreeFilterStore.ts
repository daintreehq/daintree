import { create, useStore } from "zustand";
import { persist } from "zustand/middleware";
import {
  createSafeJSONStorage,
  readLocalStorageItemSafely,
  safeJSONParse,
} from "./persistence/safeStorage";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";
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

/**
 * Fields that are user preferences and persist across all projects. These live
 * in the global store (`daintree-worktree-filters`).
 */
interface GlobalPrefsState {
  orderBy: OrderBy;
  groupByType: boolean;
  alwaysShowActive: boolean;
  alwaysShowWaiting: boolean;
  hideMainWorktree: boolean;
}

/**
 * Fields that are query-shaped or identity-scoped — they must not leak across
 * projects. These live in the per-project store
 * (`daintree-worktree-filters:{projectId}`). `quickStateFilter` is transient
 * (not persisted) but is also scoped to the current project's in-memory state.
 */
interface ProjectScopedState {
  query: string;
  statusFilters: Set<StatusFilter>;
  typeFilters: Set<TypeFilter>;
  githubFilters: Set<GitHubFilter>;
  sessionFilters: Set<SessionFilter>;
  activityFilters: Set<ActivityFilter>;
  pinnedWorktrees: string[];
  collapsedWorktrees: string[];
  manualOrder: string[];
  quickStateFilter: QuickStateFilter;
}

interface GlobalPersistedShape {
  orderBy: OrderBy;
  groupByType: boolean;
  alwaysShowActive: boolean;
  alwaysShowWaiting: boolean;
  hideMainWorktree: boolean;
}

interface ProjectPersistedShape {
  query: string;
  statusFilters: StatusFilter[];
  typeFilters: TypeFilter[];
  githubFilters: GitHubFilter[];
  sessionFilters: SessionFilter[];
  activityFilters: ActivityFilter[];
  pinnedWorktrees: string[];
  collapsedWorktrees: string[];
  manualOrder: string[];
}

/**
 * Shape of the legacy combined persist blob from before issue #5366.
 */
interface LegacyPersistedShape extends GlobalPersistedShape, ProjectPersistedShape {}

const GLOBAL_KEY = "daintree-worktree-filters";

/**
 * Resolve the current renderer's projectId synchronously from the URL query
 * string. `ProjectViewManager` loads each `WebContentsView` with
 * `?projectId=...`, so this is available at module-evaluation time. Fallback
 * to `"default"` for test environments (jsdom defaults `window.location.search`
 * to `""`) and for any shell view that has no projectId scope.
 */
function resolveProjectIdFromUrl(): string {
  if (typeof window === "undefined") return "default";
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("projectId");
    return fromUrl && fromUrl.length > 0 ? fromUrl : "default";
  } catch {
    return "default";
  }
}

const _projectId = resolveProjectIdFromUrl();
const PROJECT_KEY = `${GLOBAL_KEY}:${_projectId}`;

const GLOBAL_FIELD_KEYS = new Set<keyof WorktreeFilterStore>([
  "orderBy",
  "groupByType",
  "alwaysShowActive",
  "alwaysShowWaiting",
  "hideMainWorktree",
]);

function isGlobalField(key: string): boolean {
  return GLOBAL_FIELD_KEYS.has(key as keyof WorktreeFilterStore);
}

function arrayOrUndefined<T>(value: unknown): T[] | undefined {
  return Array.isArray(value) ? (value as T[]) : undefined;
}

/**
 * One-time migration seed: when the per-project key does not yet exist (or is
 * unparseable), but a legacy combined blob is present under the global key,
 * copy the per-project fields out of it so existing pins/order survive the
 * upgrade. The global key is left intact — the global store's versioned
 * `migrate` trims the stale per-project fields from it on its own first
 * hydrate.
 *
 * The "scoped key exists" gate checks parseability, not raw presence — a
 * corrupt scoped blob would otherwise silently suppress legacy recovery.
 */
function loadLegacySeedForProject(): Partial<ProjectPersistedShape> {
  const scopedRaw = readLocalStorageItemSafely(PROJECT_KEY);
  if (scopedRaw !== null) {
    const scopedParsed = safeJSONParse<{ state?: unknown } | null>(
      scopedRaw,
      { store: "worktreeFilterStore", key: PROJECT_KEY },
      null
    );
    if (scopedParsed && scopedParsed.state && typeof scopedParsed.state === "object") {
      return {};
    }
    // Fall through — scoped blob was corrupt, try legacy seed instead.
  }

  const raw = readLocalStorageItemSafely(GLOBAL_KEY);
  if (raw === null) return {};

  const parsed = safeJSONParse<{ state?: Partial<LegacyPersistedShape> } | null>(
    raw,
    { store: "worktreeFilterStore", key: GLOBAL_KEY },
    null
  );
  const state = parsed?.state;
  if (!state || typeof state !== "object") return {};

  return {
    query: typeof state.query === "string" ? state.query : undefined,
    statusFilters: arrayOrUndefined<StatusFilter>(state.statusFilters),
    typeFilters: arrayOrUndefined<TypeFilter>(state.typeFilters),
    githubFilters: arrayOrUndefined<GitHubFilter>(state.githubFilters),
    sessionFilters: arrayOrUndefined<SessionFilter>(state.sessionFilters),
    activityFilters: arrayOrUndefined<ActivityFilter>(state.activityFilters),
    pinnedWorktrees: arrayOrUndefined<string>(state.pinnedWorktrees),
    collapsedWorktrees: arrayOrUndefined<string>(state.collapsedWorktrees),
    manualOrder: arrayOrUndefined<string>(state.manualOrder),
  };
}

const _legacySeed = loadLegacySeedForProject();

const _globalPrefsStore = create<GlobalPrefsState>()(
  persist(
    (): GlobalPrefsState => ({
      orderBy: "created",
      groupByType: false,
      alwaysShowActive: true,
      alwaysShowWaiting: true,
      hideMainWorktree: false,
    }),
    {
      name: GLOBAL_KEY,
      version: 1,
      storage: createSafeJSONStorage(),
      partialize: (state): GlobalPersistedShape => ({
        orderBy: state.orderBy,
        groupByType: state.groupByType,
        alwaysShowActive: state.alwaysShowActive,
        alwaysShowWaiting: state.alwaysShowWaiting,
        hideMainWorktree: state.hideMainWorktree,
      }),
      migrate: (persistedState, version) => {
        // Legacy (version 0 / undefined) wrote a combined blob — strip the
        // per-project fields and keep only global prefs.
        if (version < 1) {
          const legacy = (persistedState ?? {}) as Partial<LegacyPersistedShape>;
          return {
            orderBy: legacy.orderBy ?? "created",
            groupByType: legacy.groupByType ?? false,
            alwaysShowActive: legacy.alwaysShowActive ?? true,
            alwaysShowWaiting: legacy.alwaysShowWaiting ?? true,
            hideMainWorktree: legacy.hideMainWorktree ?? false,
          } satisfies GlobalPrefsState;
        }
        return persistedState as GlobalPrefsState;
      },
      merge: (persisted, current) => {
        const p = persisted as Partial<GlobalPersistedShape> | undefined;
        const groupByType = p?.groupByType ?? current.groupByType;
        const rawOrderBy = p?.orderBy ?? current.orderBy;
        // Normalize invalid combination: manual + groupByType
        const orderBy = groupByType && rawOrderBy === "manual" ? "created" : rawOrderBy;
        return {
          ...current,
          orderBy,
          groupByType,
          alwaysShowActive: p?.alwaysShowActive ?? current.alwaysShowActive,
          alwaysShowWaiting: p?.alwaysShowWaiting ?? current.alwaysShowWaiting,
          hideMainWorktree: p?.hideMainWorktree ?? current.hideMainWorktree,
        };
      },
    }
  )
);

const _projectStore = create<ProjectScopedState>()(
  persist(
    (): ProjectScopedState => ({
      query: _legacySeed.query ?? "",
      statusFilters: new Set<StatusFilter>(_legacySeed.statusFilters ?? []),
      typeFilters: new Set<TypeFilter>(_legacySeed.typeFilters ?? []),
      githubFilters: new Set<GitHubFilter>(_legacySeed.githubFilters ?? []),
      sessionFilters: new Set<SessionFilter>(_legacySeed.sessionFilters ?? []),
      activityFilters: new Set<ActivityFilter>(_legacySeed.activityFilters ?? []),
      pinnedWorktrees: _legacySeed.pinnedWorktrees ?? [],
      collapsedWorktrees: _legacySeed.collapsedWorktrees ?? [],
      manualOrder: _legacySeed.manualOrder ?? [],
      quickStateFilter: "all",
    }),
    {
      name: PROJECT_KEY,
      storage: createSafeJSONStorage(),
      partialize: (state): ProjectPersistedShape => ({
        query: state.query,
        statusFilters: Array.from(state.statusFilters),
        typeFilters: Array.from(state.typeFilters),
        githubFilters: Array.from(state.githubFilters),
        sessionFilters: Array.from(state.sessionFilters),
        activityFilters: Array.from(state.activityFilters),
        pinnedWorktrees: state.pinnedWorktrees,
        collapsedWorktrees: state.collapsedWorktrees,
        manualOrder: state.manualOrder,
      }),
      merge: (persisted, current) => {
        const p = persisted as Partial<ProjectPersistedShape> | undefined;
        return {
          ...current,
          query: p?.query ?? current.query,
          statusFilters: new Set(p?.statusFilters ?? Array.from(current.statusFilters)),
          typeFilters: new Set(p?.typeFilters ?? Array.from(current.typeFilters)),
          githubFilters: new Set(p?.githubFilters ?? Array.from(current.githubFilters)),
          sessionFilters: new Set(p?.sessionFilters ?? Array.from(current.sessionFilters)),
          activityFilters: new Set(p?.activityFilters ?? Array.from(current.activityFilters)),
          pinnedWorktrees: p?.pinnedWorktrees ?? current.pinnedWorktrees,
          collapsedWorktrees: p?.collapsedWorktrees ?? current.collapsedWorktrees,
          manualOrder: p?.manualOrder ?? current.manualOrder,
        };
      },
    }
  )
);

/**
 * Module-scope, stable action references. Consumers in `useCallback`/`useEffect`
 * dep arrays rely on these not changing identity across renders.
 */
const _actions: WorktreeFilterActions = {
  setQuery: (query) => {
    _projectStore.setState({ query });
  },
  setOrderBy: (orderBy) => {
    _globalPrefsStore.setState({ orderBy });
  },
  setGroupByType: (enabled) => {
    const currentOrderBy = _globalPrefsStore.getState().orderBy;
    _globalPrefsStore.setState({
      groupByType: enabled,
      orderBy: enabled && currentOrderBy === "manual" ? "created" : currentOrderBy,
    });
  },
  toggleStatusFilter: (filter) => {
    _projectStore.setState((state) => {
      const next = new Set(state.statusFilters);
      if (next.has(filter)) next.delete(filter);
      else next.add(filter);
      return { statusFilters: next };
    });
  },
  toggleTypeFilter: (filter) => {
    _projectStore.setState((state) => {
      const next = new Set(state.typeFilters);
      if (next.has(filter)) next.delete(filter);
      else next.add(filter);
      return { typeFilters: next };
    });
  },
  toggleGitHubFilter: (filter) => {
    _projectStore.setState((state) => {
      const next = new Set(state.githubFilters);
      if (next.has(filter)) next.delete(filter);
      else next.add(filter);
      return { githubFilters: next };
    });
  },
  toggleSessionFilter: (filter) => {
    _projectStore.setState((state) => {
      const next = new Set(state.sessionFilters);
      if (next.has(filter)) next.delete(filter);
      else next.add(filter);
      return { sessionFilters: next };
    });
  },
  toggleActivityFilter: (filter) => {
    _projectStore.setState((state) => {
      const next = new Set(state.activityFilters);
      if (next.has(filter)) next.delete(filter);
      else next.add(filter);
      return { activityFilters: next };
    });
  },
  setAlwaysShowActive: (enabled) => {
    _globalPrefsStore.setState({ alwaysShowActive: enabled });
  },
  setAlwaysShowWaiting: (enabled) => {
    _globalPrefsStore.setState({ alwaysShowWaiting: enabled });
  },
  setHideMainWorktree: (enabled) => {
    _globalPrefsStore.setState({ hideMainWorktree: enabled });
  },
  pinWorktree: (id) => {
    _projectStore.setState((state) => {
      if (state.pinnedWorktrees.includes(id)) return state;
      return { pinnedWorktrees: [...state.pinnedWorktrees, id] };
    });
  },
  unpinWorktree: (id) => {
    _projectStore.setState((state) => ({
      pinnedWorktrees: state.pinnedWorktrees.filter((wId) => wId !== id),
    }));
  },
  isWorktreePinned: (id) => _projectStore.getState().pinnedWorktrees.includes(id),
  collapseWorktree: (id) => {
    _projectStore.setState((state) => {
      if (state.collapsedWorktrees.includes(id)) return state;
      return { collapsedWorktrees: [...state.collapsedWorktrees, id] };
    });
  },
  expandWorktree: (id) => {
    _projectStore.setState((state) => ({
      collapsedWorktrees: state.collapsedWorktrees.filter((wId) => wId !== id),
    }));
  },
  toggleWorktreeCollapsed: (id) => {
    if (_projectStore.getState().collapsedWorktrees.includes(id)) {
      _actions.expandWorktree(id);
    } else {
      _actions.collapseWorktree(id);
    }
  },
  isWorktreeCollapsed: (id) => _projectStore.getState().collapsedWorktrees.includes(id),
  setManualOrder: (order) => {
    _projectStore.setState({ manualOrder: order });
  },
  setQuickStateFilter: (quickStateFilter) => {
    _projectStore.setState({ quickStateFilter });
  },
  clearAll: () => {
    _projectStore.setState({
      query: "",
      statusFilters: new Set(),
      typeFilters: new Set(),
      githubFilters: new Set(),
      sessionFilters: new Set(),
      activityFilters: new Set(),
      quickStateFilter: "all",
    });
    _globalPrefsStore.setState({ hideMainWorktree: false });
  },
  getActiveFilterCount: () => {
    const p = _projectStore.getState();
    const hasQuery = p.query.trim().length > 0;
    return (
      (hasQuery ? 1 : 0) +
      p.statusFilters.size +
      p.typeFilters.size +
      p.githubFilters.size +
      p.sessionFilters.size +
      p.activityFilters.size +
      (p.quickStateFilter !== "all" ? 1 : 0)
    );
  },
  hasActiveFilters: () => {
    const p = _projectStore.getState();
    const hasQuery = p.query.trim().length > 0;
    return (
      hasQuery ||
      p.statusFilters.size > 0 ||
      p.typeFilters.size > 0 ||
      p.githubFilters.size > 0 ||
      p.sessionFilters.size > 0 ||
      p.activityFilters.size > 0 ||
      p.quickStateFilter !== "all"
    );
  },
};

/**
 * Merged view of both backing stores plus actions. Cached so that repeated
 * `getState()` calls return the same reference until one of the backing stores
 * changes — this is what `useSyncExternalStore` inside Zustand's `useStore`
 * relies on to detect changes.
 */
let _cachedMergedState: WorktreeFilterStore | null = null;

function _computeMergedState(): WorktreeFilterStore {
  const g = _globalPrefsStore.getState();
  const p = _projectStore.getState();
  return {
    query: p.query,
    orderBy: g.orderBy,
    groupByType: g.groupByType,
    statusFilters: p.statusFilters,
    typeFilters: p.typeFilters,
    githubFilters: p.githubFilters,
    sessionFilters: p.sessionFilters,
    activityFilters: p.activityFilters,
    alwaysShowActive: g.alwaysShowActive,
    alwaysShowWaiting: g.alwaysShowWaiting,
    hideMainWorktree: g.hideMainWorktree,
    pinnedWorktrees: p.pinnedWorktrees,
    collapsedWorktrees: p.collapsedWorktrees,
    manualOrder: p.manualOrder,
    quickStateFilter: p.quickStateFilter,
    ..._actions,
  };
}

function _getMergedState(): WorktreeFilterStore {
  if (_cachedMergedState === null) {
    _cachedMergedState = _computeMergedState();
  }
  return _cachedMergedState;
}

// First subscribers on each backing store — run before any external subscriber,
// so by the time external listeners re-read via `_getMergedState()`, the cache
// has been invalidated and a fresh merged object is produced.
_globalPrefsStore.subscribe(() => {
  _cachedMergedState = null;
});
_projectStore.subscribe(() => {
  _cachedMergedState = null;
});

const _mergedApi = {
  getState: _getMergedState,
  getInitialState: _getMergedState,
  subscribe: (listener: (state: WorktreeFilterStore, prev: WorktreeFilterStore) => void) => {
    let prev = _getMergedState();
    const notify = () => {
      const next = _getMergedState();
      if (next === prev) return;
      const old = prev;
      prev = next;
      listener(next, old);
    };
    const unsubGlobal = _globalPrefsStore.subscribe(notify);
    const unsubProject = _projectStore.subscribe(notify);
    return () => {
      unsubGlobal();
      unsubProject();
    };
  },
};

type SetStatePatch =
  | Partial<WorktreeFilterStore>
  | ((state: WorktreeFilterStore) => Partial<WorktreeFilterStore>);

function _routedSetState(update: SetStatePatch): void {
  const patch = typeof update === "function" ? update(_getMergedState()) : update;
  const globalPatch: Partial<GlobalPrefsState> = {};
  const projectPatch: Partial<ProjectScopedState> = {};
  let hasGlobal = false;
  let hasProject = false;

  for (const key of Object.keys(patch) as Array<keyof WorktreeFilterStore>) {
    const value = patch[key];
    if (isGlobalField(key)) {
      (globalPatch as Record<string, unknown>)[key] = value;
      hasGlobal = true;
    } else if (key in _projectStore.getState()) {
      (projectPatch as Record<string, unknown>)[key] = value;
      hasProject = true;
    }
    // Action functions in the patch (e.g. from a full-state reset object) are
    // ignored — they live on the facade, not in either backing store.
  }

  if (hasGlobal) _globalPrefsStore.setState(globalPatch);
  if (hasProject) _projectStore.setState(projectPatch);
}

interface UseWorktreeFilterStoreHook {
  (): WorktreeFilterStore;
  <U>(selector: (state: WorktreeFilterStore) => U): U;
  getState: () => WorktreeFilterStore;
  getInitialState: () => WorktreeFilterStore;
  setState: (update: SetStatePatch) => void;
  subscribe: (typeof _mergedApi)["subscribe"];
  persist: (typeof _globalPrefsStore)["persist"];
}

function identitySelector(state: WorktreeFilterStore): WorktreeFilterStore {
  return state;
}

function useWorktreeFilterStoreHook(): WorktreeFilterStore;
function useWorktreeFilterStoreHook<U>(selector: (state: WorktreeFilterStore) => U): U;
function useWorktreeFilterStoreHook<U>(
  selector?: (state: WorktreeFilterStore) => U
): U | WorktreeFilterStore {
  const resolved = (selector ?? identitySelector) as (state: WorktreeFilterStore) => U;
  return useStore(_mergedApi, resolved);
}

const hook = useWorktreeFilterStoreHook as UseWorktreeFilterStoreHook;
hook.getState = _getMergedState;
hook.getInitialState = _getMergedState;
hook.setState = _routedSetState;
hook.subscribe = _mergedApi.subscribe;
hook.persist = _globalPrefsStore.persist;

export const useWorktreeFilterStore: UseWorktreeFilterStoreHook = hook;

registerPersistedStore({
  storeId: "worktreeFilterStore",
  store: _globalPrefsStore,
  persistedStateType: "GlobalPersistedShape",
});
