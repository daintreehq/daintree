import { create, useStore } from "zustand";
import { persist } from "zustand/middleware";
import type { StorageValue } from "zustand/middleware";
import {
  createSafeJSONStorage,
  createDebouncedSafeJSONStorage,
  readLocalStorageItemSafely,
  safeJSONParse,
} from "./persistence/safeStorage";
import {
  pickFieldByWriterDelta,
  type PersistWriteMergeContext,
} from "./persistence/persistWriteMerge";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";
import type { QuickStateFilter } from "@/lib/worktreeFilters";
import { isWorktreeTypeId, type WorktreeTypeId } from "@/lib/worktreeTypes";
import { isWorktreeLabelToken, type WorktreeLabelToken } from "@shared/theme/worktreeColors";
import {
  isWorktreeCustomTitleTooLong,
  normalizeWorktreeCustomTitle,
} from "@shared/utils/worktreeCustomTitle";
import type { WorktreeTitlesSnapshot } from "@shared/types/ipc/worktreeTitles";
import { logWarn } from "@/utils/logger";
import { hostScopedKey } from "@/hooks/useHostPlatform";
import { onHostResync } from "./hostResyncSignal";

export type OrderBy = "recent" | "created" | "alpha" | "manual";

export type StatusFilter = "active" | "dirty" | "stale" | "idle";
export type TypeFilter = WorktreeTypeId;
export type PrIssueFilter = "hasIssue" | "hasPR" | "prOpen" | "prMerged" | "prClosed";
export type SessionFilter = "hasTerminals" | "working" | "waiting" | "completed" | "exited";
export type ActivityFilter = "last15m" | "last1h" | "last24h" | "last7d";
export type DevServerFilter = "running" | "starting" | "hasDevServer" | "error";
/** How much room each sidebar worktree card takes: one line per fact, or tight rows. */
export type CardDensity = "comfortable" | "compact";

const PR_ISSUE_FILTER_VALUES: ReadonlySet<string> = new Set<PrIssueFilter>([
  "hasIssue",
  "hasPR",
  "prOpen",
  "prMerged",
  "prClosed",
]);
function isPrIssueFilter(value: unknown): value is PrIssueFilter {
  return typeof value === "string" && PR_ISSUE_FILTER_VALUES.has(value);
}

interface WorktreeFilterState {
  /** Persisted, debounced search query — the source of truth restored across sessions. */
  query: string;
  /**
   * Transient, instant-updating search query that drives the visible filter and
   * input display. Updated on every keystroke; `query` is written behind a
   * debounce so only the localStorage write is throttled, not the filtering.
   * Not persisted (seeded from `query` on hydrate).
   */
  liveQuery: string;
  orderBy: OrderBy;
  groupByType: boolean;
  statusFilters: Set<StatusFilter>;
  typeFilters: Set<TypeFilter>;
  prIssueFilters: Set<PrIssueFilter>;
  sessionFilters: Set<SessionFilter>;
  /**
   * Keep only worktrees with at least one agent pane, whatever its state. A
   * facet of its own rather than a Sessions value: Sessions ORs its values, so
   * "Has an agent" + "Waiting" would collapse back to every agent worktree.
   */
  hasAgentFilter: boolean;
  activityFilters: Set<ActivityFilter>;
  /** Transient session-only dev-server facet filter (not persisted). */
  devServerFilters: Set<DevServerFilter>;
  alwaysShowActive: boolean;
  alwaysShowWaiting: boolean;
  hideMainWorktree: boolean;
  cardDensity: CardDensity;
  pinnedWorktrees: string[];
  collapsedWorktrees: string[];
  /** Worktree id → label colour token. Absent means no label (#13408). */
  worktreeLabelColors: Record<string, WorktreeLabelToken>;
  /** Worktree id → custom title, normalised. Absent means the computed headline (#13409). */
  worktreeCustomTitles: Record<string, string>;
  manualOrder: string[];
  /** Transient session-only quick-state chip filter (not persisted). */
  quickStateFilter: QuickStateFilter;
}

interface WorktreeFilterActions {
  setQuery: (query: string) => void;
  setLiveQuery: (query: string) => void;
  setOrderBy: (orderBy: OrderBy) => void;
  setGroupByType: (enabled: boolean) => void;
  toggleStatusFilter: (filter: StatusFilter) => void;
  toggleTypeFilter: (filter: TypeFilter) => void;
  togglePrIssueFilter: (filter: PrIssueFilter) => void;
  toggleSessionFilter: (filter: SessionFilter) => void;
  setHasAgentFilter: (enabled: boolean) => void;
  toggleActivityFilter: (filter: ActivityFilter) => void;
  toggleDevServerFilter: (filter: DevServerFilter) => void;
  setAlwaysShowActive: (enabled: boolean) => void;
  setAlwaysShowWaiting: (enabled: boolean) => void;
  setHideMainWorktree: (enabled: boolean) => void;
  setCardDensity: (density: CardDensity) => void;
  pinWorktree: (id: string) => void;
  unpinWorktree: (id: string) => void;
  isWorktreePinned: (id: string) => boolean;
  collapseWorktree: (id: string) => void;
  expandWorktree: (id: string) => void;
  toggleWorktreeCollapsed: (id: string) => void;
  /** Collapse every listed card in one write; the list-level fold. */
  collapseWorktrees: (ids: readonly string[]) => void;
  /** Expand every card in one write. */
  expandAllWorktrees: () => void;
  isWorktreeCollapsed: (id: string) => boolean;
  setWorktreeLabelColor: (id: string, token: WorktreeLabelToken | null) => void;
  /**
   * Normalises the title; an empty or over-length result is the caller's to
   * reject, null or blank clears. Resolves once main has recorded it (#14022),
   * and rejects when it could not.
   */
  setWorktreeCustomTitle: (id: string, title: string | null) => Promise<void>;
  setManualOrder: (order: string[]) => void;
  pruneStaleWorktreeIds: (validIds: ReadonlySet<string>) => void;
  setQuickStateFilter: (filter: QuickStateFilter) => void;
  clearQuickStateFilter: () => void;
  clearStatusFilters: () => void;
  clearTypeFilters: () => void;
  clearPrIssueFilters: () => void;
  clearSessionFilters: () => void;
  clearActivityFilters: () => void;
  clearDevServerFilters: () => void;
  clearAll: () => void;
  getActiveFilterCount: () => number;
  hasActiveFilters: () => boolean;
  hasFacetFilters: () => boolean;
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
  cardDensity: CardDensity;
}

/**
 * Fields that are query-shaped or identity-scoped — they must not leak across
 * projects. These live in the per-project store
 * (`daintree-worktree-filters:{projectId}`). `quickStateFilter` and
 * `devServerFilters` are transient (not persisted) but are also scoped to the
 * current project's in-memory state. `devServerFilters` is deliberately session
 * -only: a persisted "running" filter would show an empty worktree list on the
 * next launch (no servers are running yet) until the user noticed and cleared it.
 */
interface ProjectScopedState {
  query: string;
  /** Transient session-only instant query (not persisted; seeded from `query`). */
  liveQuery: string;
  statusFilters: Set<StatusFilter>;
  typeFilters: Set<TypeFilter>;
  prIssueFilters: Set<PrIssueFilter>;
  sessionFilters: Set<SessionFilter>;
  hasAgentFilter: boolean;
  activityFilters: Set<ActivityFilter>;
  pinnedWorktrees: string[];
  collapsedWorktrees: string[];
  /** Worktree id → label colour token. Absent means no label (#13408). */
  worktreeLabelColors: Record<string, WorktreeLabelToken>;
  /** Worktree id → custom title, normalised. Absent means the computed headline (#13409). */
  worktreeCustomTitles: Record<string, string>;
  manualOrder: string[];
  quickStateFilter: QuickStateFilter;
  devServerFilters: Set<DevServerFilter>;
}

interface GlobalPersistedShape {
  orderBy: OrderBy;
  groupByType: boolean;
  alwaysShowActive: boolean;
  alwaysShowWaiting: boolean;
  hideMainWorktree: boolean;
  cardDensity: CardDensity;
}

interface ProjectPersistedShape {
  query: string;
  statusFilters: StatusFilter[];
  typeFilters: TypeFilter[];
  prIssueFilters: PrIssueFilter[];
  sessionFilters: SessionFilter[];
  hasAgentFilter: boolean;
  activityFilters: ActivityFilter[];
  pinnedWorktrees: string[];
  collapsedWorktrees: string[];
  /** Worktree id → label colour token. Absent means no label (#13408). */
  worktreeLabelColors: Record<string, WorktreeLabelToken>;
  /** Worktree id → custom title, normalised. Absent means the computed headline (#13409). */
  worktreeCustomTitles: Record<string, string>;
  manualOrder: string[];
}

/**
 * Shape of the legacy combined persist blob from before issue #5366.
 * Listed explicitly rather than extending ProjectPersistedShape so the
 * legacy JSON key `githubFilters` is preserved verbatim.
 */
interface LegacyPersistedShape extends GlobalPersistedShape {
  query: string;
  statusFilters: StatusFilter[];
  typeFilters: TypeFilter[];
  githubFilters: PrIssueFilter[];
  sessionFilters: SessionFilter[];
  activityFilters: ActivityFilter[];
  pinnedWorktrees: string[];
  collapsedWorktrees: string[];
  manualOrder: string[];
}

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
  // Prefer the id seeded by preload via additionalArguments (#9162); preload
  // runs before this module evaluates, so the global is available. Fall back to
  // the `?projectId=` query string (initial-window load) and finally "default".
  const seeded = window.__DAINTREE_INITIAL_PROJECT__?.id;
  if (seeded && seeded.length > 0) return seeded;
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("projectId");
    return fromUrl && fromUrl.length > 0 ? fromUrl : "default";
  } catch {
    return "default";
  }
}

const _projectId = resolveProjectIdFromUrl();
// Host-scoped, because a remote host's project can carry the same id as a local
// one and every view shares this storage; bare locally. Custom titles make it
// load-bearing: a remote view's copy of its host's titles must never become the
// hand-over a local view of the same id gives this machine's main (#14022).
const PROJECT_KEY = `${GLOBAL_KEY}:${hostScopedKey(_projectId)}`;
/** Where a remote view's state lived before the key was host-scoped. */
const BARE_PROJECT_KEY = `${GLOBAL_KEY}:${_projectId}`;

const GLOBAL_FIELD_KEYS = new Set<keyof WorktreeFilterStore>([
  "orderBy",
  "groupByType",
  "alwaysShowActive",
  "alwaysShowWaiting",
  "hideMainWorktree",
  "cardDensity",
]);

function isGlobalField(key: string): boolean {
  return GLOBAL_FIELD_KEYS.has(key as keyof WorktreeFilterStore);
}

function arrayOrUndefined<T>(value: unknown): T[] | undefined {
  return Array.isArray(value) ? (value as T[]) : undefined;
}

/** Keeps only entries whose value is a known label token, so a retired or hand-edited colour drops out rather than reaching the card as a bare var(). */
function labelColorsOrUndefined(value: unknown): Record<string, WorktreeLabelToken> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, WorktreeLabelToken> = {};
  for (const [id, token] of Object.entries(value)) {
    if (isWorktreeLabelToken(token)) result[id] = token;
  }
  return result;
}

/** Keeps only titles that still normalise to something within the limit, so a hand-edited entry can't put a blank or oversized headline on a card. */
function customTitlesOrUndefined(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (typeof raw !== "string") continue;
    const title = normalizeWorktreeCustomTitle(raw);
    if (title && !isWorktreeCustomTitleTooLong(title)) result[id] = title;
  }
  return result;
}

/**
 * Strip the retired "running" session filter from a persisted list. The
 * adjacent "working" option semantically covers its former intent — see
 * issue #5810.
 */
function stripLegacySessionFilters(
  values: SessionFilter[] | undefined
): SessionFilter[] | undefined {
  if (!values) return undefined;
  return values.filter((v) => (v as string) !== "running");
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

  // A remote view kept its state under the bare key until it was host-scoped
  // (#14022). Its pins, filters and labels carry over; its titles don't, since
  // they come from the host's main and the bare copy may be this machine's.
  if (PROJECT_KEY !== BARE_PROJECT_KEY) {
    const bareRaw = readLocalStorageItemSafely(BARE_PROJECT_KEY);
    const bare =
      bareRaw === null
        ? null
        : safeJSONParse<{ state?: Partial<ProjectPersistedShape> } | null>(
            bareRaw,
            { store: "worktreeFilterStore", key: BARE_PROJECT_KEY },
            null
          );
    if (bare?.state && typeof bare.state === "object") {
      const { worktreeCustomTitles: _titles, ...carried } = toProjectFiltersPersisted(bare.state);
      return carried;
    }
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
    typeFilters: arrayOrUndefined<unknown>(state.typeFilters)?.filter(isWorktreeTypeId),
    prIssueFilters: arrayOrUndefined<PrIssueFilter>(state.githubFilters),
    sessionFilters: stripLegacySessionFilters(
      arrayOrUndefined<SessionFilter>(state.sessionFilters)
    ),
    activityFilters: arrayOrUndefined<ActivityFilter>(state.activityFilters),
    pinnedWorktrees: arrayOrUndefined<string>(state.pinnedWorktrees),
    collapsedWorktrees: arrayOrUndefined<string>(state.collapsedWorktrees),
    manualOrder: arrayOrUndefined<string>(state.manualOrder),
  };
}

const _legacySeed = loadLegacySeedForProject();

const GLOBAL_PREFS_PERSISTED_DEFAULTS: GlobalPersistedShape = {
  orderBy: "created",
  groupByType: false,
  alwaysShowActive: true,
  alwaysShowWaiting: true,
  hideMainWorktree: false,
  cardDensity: "comfortable",
};

function isCardDensity(value: unknown): value is CardDensity {
  return value === "comfortable" || value === "compact";
}

function isOrderBy(value: unknown): value is OrderBy {
  return value === "recent" || value === "created" || value === "alpha" || value === "manual";
}

function toGlobalPrefsPersisted(
  state: Partial<GlobalPrefsState> | null | undefined
): GlobalPersistedShape {
  const raw = (state ?? {}) as Record<string, unknown>;
  const d = GLOBAL_PREFS_PERSISTED_DEFAULTS;
  return {
    orderBy: isOrderBy(raw.orderBy) ? raw.orderBy : d.orderBy,
    groupByType: typeof raw.groupByType === "boolean" ? raw.groupByType : d.groupByType,
    alwaysShowActive:
      typeof raw.alwaysShowActive === "boolean" ? raw.alwaysShowActive : d.alwaysShowActive,
    alwaysShowWaiting:
      typeof raw.alwaysShowWaiting === "boolean" ? raw.alwaysShowWaiting : d.alwaysShowWaiting,
    hideMainWorktree:
      typeof raw.hideMainWorktree === "boolean" ? raw.hideMainWorktree : d.hideMainWorktree,
    cardDensity: isCardDensity(raw.cardDensity) ? raw.cardDensity : d.cardDensity,
  };
}

/**
 * Baseline-aware three-way merge for the GLOBAL worktree-filter prefs across
 * project views (issue #11351). These five fields share one literal key
 * (`daintree-worktree-filters`) and are set independently, so each defers to a
 * sibling's on-disk value unless this writer changed it. The per-project store
 * (`_projectStore`) has its own reconciler below — its key embeds the project id,
 * so it's immune to cross-project clobber, but two windows on the same project
 * still share it. After merging, we reapply the `merge()`-time invariant that
 * `manual` order is invalid while grouping (a cross-view merge could otherwise
 * recombine them).
 */
function mergeGlobalPrefsPersistedWrite({
  baseline,
  onDisk,
  incoming,
}: PersistWriteMergeContext<GlobalPersistedShape>): StorageValue<GlobalPersistedShape> {
  if (!onDisk || onDisk.version !== incoming.version) return incoming;
  const disk = toGlobalPrefsPersisted(onDisk.state);
  const inc = toGlobalPrefsPersisted(incoming.state);
  if (baseline && typeof baseline.version === "number" && baseline.version !== incoming.version) {
    return { version: incoming.version, state: disk };
  }
  const base = toGlobalPrefsPersisted(baseline?.state);
  const groupByType = pickFieldByWriterDelta(base.groupByType, inc.groupByType, disk.groupByType);
  const rawOrderBy = pickFieldByWriterDelta(base.orderBy, inc.orderBy, disk.orderBy);
  const orderBy: OrderBy = groupByType && rawOrderBy === "manual" ? "created" : rawOrderBy;
  return {
    version: incoming.version,
    state: {
      orderBy,
      groupByType,
      alwaysShowActive: pickFieldByWriterDelta(
        base.alwaysShowActive,
        inc.alwaysShowActive,
        disk.alwaysShowActive
      ),
      alwaysShowWaiting: pickFieldByWriterDelta(
        base.alwaysShowWaiting,
        inc.alwaysShowWaiting,
        disk.alwaysShowWaiting
      ),
      hideMainWorktree: pickFieldByWriterDelta(
        base.hideMainWorktree,
        inc.hideMainWorktree,
        disk.hideMainWorktree
      ),
      cardDensity: pickFieldByWriterDelta(base.cardDensity, inc.cardDensity, disk.cardDensity),
    },
  };
}

const _globalPrefsStore = create<GlobalPrefsState>()(
  persist(
    (): GlobalPrefsState => ({
      orderBy: "created",
      groupByType: false,
      alwaysShowActive: true,
      alwaysShowWaiting: true,
      hideMainWorktree: false,
      cardDensity: "comfortable",
    }),
    {
      name: GLOBAL_KEY,
      version: 1,
      storage: createSafeJSONStorage<GlobalPersistedShape>({
        mergeOnWrite: mergeGlobalPrefsPersistedWrite,
      }),
      partialize: (state): GlobalPersistedShape => ({
        orderBy: state.orderBy,
        groupByType: state.groupByType,
        alwaysShowActive: state.alwaysShowActive,
        alwaysShowWaiting: state.alwaysShowWaiting,
        hideMainWorktree: state.hideMainWorktree,
        cardDensity: state.cardDensity,
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
            cardDensity: "comfortable",
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
          cardDensity: isCardDensity(p?.cardDensity) ? p.cardDensity : current.cardDensity,
        };
      },
    }
  )
);

/**
 * Coerce a persisted (or baseline) per-project blob to the exact
 * `ProjectPersistedShape`, substituting the store's defaults for any field with
 * the wrong runtime type. Mirrors `toGlobalPrefsPersisted`: without it a corrupt
 * on-disk field (e.g. `statusFilters` stored as a string) would be treated as
 * "unchanged by this writer" and written straight back on every write, so the
 * blob never self-heals and the bad value reaches `new Set(...)` at hydration.
 */
function toProjectFiltersPersisted(
  state: Partial<ProjectPersistedShape> | null | undefined
): ProjectPersistedShape {
  const raw = (state ?? {}) as Record<string, unknown>;
  return {
    query: typeof raw.query === "string" ? raw.query : "",
    statusFilters: arrayOrUndefined<StatusFilter>(raw.statusFilters) ?? [],
    typeFilters: arrayOrUndefined<unknown>(raw.typeFilters)?.filter(isWorktreeTypeId) ?? [],
    prIssueFilters: arrayOrUndefined<PrIssueFilter>(raw.prIssueFilters) ?? [],
    sessionFilters: arrayOrUndefined<SessionFilter>(raw.sessionFilters) ?? [],
    hasAgentFilter: raw.hasAgentFilter === true,
    activityFilters: arrayOrUndefined<ActivityFilter>(raw.activityFilters) ?? [],
    pinnedWorktrees: arrayOrUndefined<string>(raw.pinnedWorktrees) ?? [],
    collapsedWorktrees: arrayOrUndefined<string>(raw.collapsedWorktrees) ?? [],
    worktreeLabelColors: labelColorsOrUndefined(raw.worktreeLabelColors) ?? {},
    worktreeCustomTitles: customTitlesOrUndefined(raw.worktreeCustomTitles) ?? {},
    manualOrder: arrayOrUndefined<string>(raw.manualOrder) ?? [],
  };
}

/**
 * Baseline-aware three-way merge for the PER-PROJECT worktree-filter state
 * (issue #11351). Its storage key already embeds the project id
 * (`daintree-worktree-filters:{projectId}`), so it's immune to CROSS-project
 * clobber — but two windows showing the SAME project share this key (see
 * `ProjectViewManager`), and a stale window's write (even the transient
 * `setLiveQuery` on every keystroke persists this partialized snapshot) would
 * otherwise wipe a sibling window's pin/filter. Each persisted field defers to a
 * sibling's on-disk value unless this writer changed it; divergent filter/list
 * values across two windows can't be element-merged, so it's whole-value
 * last-writer-wins on a genuine concurrent edit.
 */
function mergeProjectFiltersPersistedWrite({
  baseline,
  onDisk,
  incoming,
}: PersistWriteMergeContext<ProjectPersistedShape>): StorageValue<ProjectPersistedShape> {
  if (!onDisk || onDisk.version !== incoming.version) return incoming;
  const disk = toProjectFiltersPersisted(onDisk.state);
  const inc = toProjectFiltersPersisted(incoming.state);
  if (baseline && typeof baseline.version === "number" && baseline.version !== incoming.version) {
    return { version: incoming.version, state: disk };
  }
  const base = toProjectFiltersPersisted(baseline?.state);
  return {
    version: incoming.version,
    state: {
      query: pickFieldByWriterDelta(base.query, inc.query, disk.query),
      statusFilters: pickFieldByWriterDelta(
        base.statusFilters,
        inc.statusFilters,
        disk.statusFilters
      ),
      typeFilters: pickFieldByWriterDelta(base.typeFilters, inc.typeFilters, disk.typeFilters),
      prIssueFilters: pickFieldByWriterDelta(
        base.prIssueFilters,
        inc.prIssueFilters,
        disk.prIssueFilters
      ),
      sessionFilters: pickFieldByWriterDelta(
        base.sessionFilters,
        inc.sessionFilters,
        disk.sessionFilters
      ),
      hasAgentFilter: pickFieldByWriterDelta(
        base.hasAgentFilter,
        inc.hasAgentFilter,
        disk.hasAgentFilter
      ),
      activityFilters: pickFieldByWriterDelta(
        base.activityFilters,
        inc.activityFilters,
        disk.activityFilters
      ),
      pinnedWorktrees: pickFieldByWriterDelta(
        base.pinnedWorktrees,
        inc.pinnedWorktrees,
        disk.pinnedWorktrees
      ),
      collapsedWorktrees: pickFieldByWriterDelta(
        base.collapsedWorktrees,
        inc.collapsedWorktrees,
        disk.collapsedWorktrees
      ),
      worktreeLabelColors: pickFieldByWriterDelta(
        base.worktreeLabelColors,
        inc.worktreeLabelColors,
        disk.worktreeLabelColors
      ),
      worktreeCustomTitles: pickFieldByWriterDelta(
        base.worktreeCustomTitles,
        inc.worktreeCustomTitles,
        disk.worktreeCustomTitles
      ),
      manualOrder: pickFieldByWriterDelta(base.manualOrder, inc.manualOrder, disk.manualOrder),
    },
  };
}

const _projectStore = create<ProjectScopedState>()(
  persist(
    (): ProjectScopedState => ({
      query: _legacySeed.query ?? "",
      liveQuery: _legacySeed.query ?? "",
      statusFilters: new Set<StatusFilter>(_legacySeed.statusFilters ?? []),
      typeFilters: new Set<TypeFilter>(_legacySeed.typeFilters ?? []),
      prIssueFilters: new Set<PrIssueFilter>(_legacySeed.prIssueFilters ?? []),
      sessionFilters: new Set<SessionFilter>(_legacySeed.sessionFilters ?? []),
      hasAgentFilter: _legacySeed.hasAgentFilter ?? false,
      activityFilters: new Set<ActivityFilter>(_legacySeed.activityFilters ?? []),
      pinnedWorktrees: _legacySeed.pinnedWorktrees ?? [],
      collapsedWorktrees: _legacySeed.collapsedWorktrees ?? [],
      worktreeLabelColors: _legacySeed.worktreeLabelColors ?? {},
      worktreeCustomTitles: {},
      manualOrder: _legacySeed.manualOrder ?? [],
      quickStateFilter: "all",
      devServerFilters: new Set<DevServerFilter>(),
    }),
    {
      name: PROJECT_KEY,
      version: 2,
      storage: createDebouncedSafeJSONStorage<ProjectPersistedShape>(300, {
        mergeOnWrite: mergeProjectFiltersPersistedWrite,
      }),
      partialize: (state): ProjectPersistedShape => ({
        query: state.query,
        statusFilters: Array.from(state.statusFilters),
        typeFilters: Array.from(state.typeFilters),
        prIssueFilters: Array.from(state.prIssueFilters),
        sessionFilters: Array.from(state.sessionFilters),
        hasAgentFilter: state.hasAgentFilter,
        activityFilters: Array.from(state.activityFilters),
        pinnedWorktrees: state.pinnedWorktrees,
        collapsedWorktrees: state.collapsedWorktrees,
        worktreeLabelColors: state.worktreeLabelColors,
        worktreeCustomTitles: state.worktreeCustomTitles,
        manualOrder: state.manualOrder,
      }),
      migrate: (persistedState, version) => {
        // Chain v1 → v2 migrations through a property bag so each step can
        // destructure/spread without re-casting; final cast lands at the end.
        const initial: Partial<ProjectPersistedShape> & {
          githubFilters?: unknown;
        } = persistedState && typeof persistedState === "object" ? { ...persistedState } : {};
        let result: Partial<ProjectPersistedShape> & { githubFilters?: unknown } = initial;
        // v1 retires the "running" SessionFilter (#5810).
        if (version < 1) {
          const cleaned = stripLegacySessionFilters(result.sessionFilters);
          result = { ...result, sessionFilters: cleaned };
        }
        // v2 renames `githubFilters` → `prIssueFilters` (#8461).
        if (version < 2) {
          const { githubFilters, ...rest } = result;
          const raw = Array.isArray(githubFilters) ? githubFilters : [];
          const valid = raw.filter(isPrIssueFilter);
          result = { ...rest, prIssueFilters: valid };
        }
        return result as ProjectPersistedShape;
      },
      merge: (persisted, current) => {
        const p = persisted as Partial<ProjectPersistedShape> | undefined;
        const persistedSessionFilters = stripLegacySessionFilters(p?.sessionFilters);
        const restoredQuery = p?.query ?? current.query;
        return {
          ...current,
          query: restoredQuery,
          // Seed the transient live query from the persisted value so a restored
          // search shows in the input and filter immediately after hydration.
          liveQuery: restoredQuery,
          statusFilters: new Set(p?.statusFilters ?? Array.from(current.statusFilters)),
          // Filtered on every load, not in a migration: a type id leaves the
          // registry without a version bump, and a stale id in the set would
          // hide every worktree.
          typeFilters: new Set(
            Array.isArray(p?.typeFilters)
              ? p.typeFilters.filter(isWorktreeTypeId)
              : Array.from(current.typeFilters)
          ),
          prIssueFilters: new Set(p?.prIssueFilters ?? Array.from(current.prIssueFilters)),
          sessionFilters: new Set(persistedSessionFilters ?? Array.from(current.sessionFilters)),
          hasAgentFilter:
            typeof p?.hasAgentFilter === "boolean" ? p.hasAgentFilter : current.hasAgentFilter,
          activityFilters: new Set(p?.activityFilters ?? Array.from(current.activityFilters)),
          pinnedWorktrees: p?.pinnedWorktrees ?? current.pinnedWorktrees,
          collapsedWorktrees: p?.collapsedWorktrees ?? current.collapsedWorktrees,
          worktreeLabelColors:
            labelColorsOrUndefined(p?.worktreeLabelColors) ?? current.worktreeLabelColors,
          worktreeCustomTitles:
            customTitlesOrUndefined(p?.worktreeCustomTitles) ?? current.worktreeCustomTitles,
          manualOrder: p?.manualOrder ?? current.manualOrder,
        };
      },
    }
  )
);

/**
 * Custom titles live in main (#14022), so the worktree snapshots plugins read
 * carry them; `worktreeCustomTitles` above is this view's copy of main's. The
 * localStorage blob stays as that copy's cache and as the hand-over: this
 * view's first pull gives main the titles kept here before it held any.
 */
let titlesRevision = 0;
let titlesHandedOver = false;
let titlesPull: Promise<void> | null = null;
// Snapshots adopted so far. A pull that saw none land while it was in flight
// is the newest word there is, so it may move the revision down — the way back
// for a view whose main store was reset under it.
let titlesAdoptions = 0;
// A push that arrived before the hand-over landed, held until it does:
// adopting it first would replace the copy the hand-over is made from.
let titlesHeldPush: WorktreeTitlesSnapshot | null = null;
// A relaunch restores the last project before main has registered its view,
// and a slow start can register it well after the renderer loaded.
const TITLES_PULL_RETRY_MS = [250, 1000, 3000, 10_000, 30_000] as const;

/** Main has no project for this view yet, or never will (a view with no project open). */
class WorktreeTitlesUnboundError extends Error {
  constructor() {
    super("Worktree titles aren't available until the project finishes opening");
  }
}

function worktreeTitlesBridge() {
  return typeof window === "undefined" ? undefined : window.electron?.worktreeTitles;
}

function sameTitles(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((id) => Object.hasOwn(b, id) && a[id] === b[id]);
}

function adoptWorktreeTitles(snapshot: WorktreeTitlesSnapshot, authoritative = false): void {
  if (!authoritative && snapshot.revision < titlesRevision) return;
  ++titlesAdoptions;
  titlesRevision = snapshot.revision;
  const next = customTitlesOrUndefined(snapshot.titles) ?? {};
  if (sameTitles(_projectStore.getState().worktreeCustomTitles, next)) return;
  _projectStore.setState({ worktreeCustomTitles: next });
}

function receiveWorktreeTitlesPush(snapshot: WorktreeTitlesSnapshot): void {
  if (titlesHandedOver) {
    adoptWorktreeTitles(snapshot);
    return;
  }
  if (titlesHeldPush === null || snapshot.revision >= titlesHeldPush.revision) {
    titlesHeldPush = snapshot;
  }
}

/**
 * Read main's titles and adopt them; the first pull that lands also hands over
 * this view's copy. Shared while in flight; rejects on an unbound or failed
 * read so the caller can retry. The persisted copy has hydrated by now: the
 * storage reads synchronously.
 */
function pullWorktreeTitles(): Promise<void> {
  if (titlesPull) return titlesPull;
  const api = worktreeTitlesBridge();
  if (typeof api?.hydrate !== "function") return Promise.resolve();
  const adoptionsAtStart = titlesAdoptions;
  const legacyTitles = titlesHandedOver ? {} : { ..._projectStore.getState().worktreeCustomTitles };
  const attempt = api.hydrate(legacyTitles).then(
    (snapshot) => {
      if (titlesPull === attempt) titlesPull = null;
      // `== null`: a stubbed bridge answers `undefined`.
      if (snapshot == null) throw new WorktreeTitlesUnboundError();
      adoptWorktreeTitles(snapshot, titlesAdoptions === adoptionsAtStart);
      titlesHandedOver = true;
      const held = titlesHeldPush;
      titlesHeldPush = null;
      if (held) adoptWorktreeTitles(held);
    },
    (error: unknown) => {
      if (titlesPull === attempt) titlesPull = null;
      throw error;
    }
  );
  titlesPull = attempt;
  return attempt;
}

async function pruneWorktreeTitlesInMain(staleTitleIds: string[]): Promise<void> {
  const api = worktreeTitlesBridge();
  if (typeof api?.prune !== "function") return;
  if (!titlesHandedOver) await pullWorktreeTitles();
  adoptWorktreeTitles(await api.prune(staleTitleIds));
}

/**
 * Follow main's titles for this view: pull once (retrying an unbound read),
 * adopt every push, and pull again when a remote view's link comes back, since
 * pushes sent while it was down are gone. Returns the disposer.
 */
export function startWorktreeCustomTitlesSync(): () => void {
  const api = worktreeTitlesBridge();
  if (typeof api?.onChanged !== "function") return () => {};
  let disposed = false;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  // Main sends to every view of the project and only to them.
  const unsubscribe = api.onChanged(receiveWorktreeTitlesPush);
  const pull = (): void => {
    pullWorktreeTitles().catch((error: unknown) => {
      if (disposed || titlesHandedOver) return;
      const delay = TITLES_PULL_RETRY_MS[retries++];
      if (delay === undefined) {
        // Still unbound after the retries is a view with no project, not a fault.
        if (!(error instanceof WorktreeTitlesUnboundError)) {
          logWarn("[worktreeFilterStore] Failed to read worktree titles", { error });
        }
        return;
      }
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!disposed) pull();
      }, delay);
    });
  };
  const offResync = onHostResync(() => {
    if (disposed) return;
    // A pull already in flight may have been answered before the lost pushes,
    // so read once more after it settles rather than joining it.
    const inFlight = titlesPull;
    const pullAfter = inFlight
      ? inFlight.catch(() => undefined).then(() => pullWorktreeTitles())
      : pullWorktreeTitles();
    pullAfter.catch((error: unknown) => {
      logWarn("[worktreeFilterStore] Failed to read worktree titles after reconnecting", {
        error,
      });
    });
  });
  pull();
  return () => {
    disposed = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    unsubscribe();
    offResync();
  };
}

/**
 * Module-scope, stable action references. Consumers in `useCallback`/`useEffect`
 * dep arrays rely on these not changing identity across renders.
 */
const _actions: WorktreeFilterActions = {
  setQuery: (query) => {
    _projectStore.setState({ query });
  },
  setLiveQuery: (liveQuery) => {
    _projectStore.setState({ liveQuery });
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
  togglePrIssueFilter: (filter) => {
    _projectStore.setState((state) => {
      const next = new Set(state.prIssueFilters);
      if (next.has(filter)) next.delete(filter);
      else next.add(filter);
      return { prIssueFilters: next };
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
  setHasAgentFilter: (enabled) => {
    _projectStore.setState({ hasAgentFilter: enabled });
  },
  toggleActivityFilter: (filter) => {
    _projectStore.setState((state) => {
      const next = new Set(state.activityFilters);
      if (next.has(filter)) next.delete(filter);
      else next.add(filter);
      return { activityFilters: next };
    });
  },
  toggleDevServerFilter: (filter) => {
    _projectStore.setState((state) => {
      const next = new Set(state.devServerFilters);
      if (next.has(filter)) next.delete(filter);
      else next.add(filter);
      return { devServerFilters: next };
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
  setCardDensity: (density) => {
    _globalPrefsStore.setState({ cardDensity: density });
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
  collapseWorktrees: (ids) => {
    _projectStore.setState((state) => {
      const missing = ids.filter((id) => !state.collapsedWorktrees.includes(id));
      if (missing.length === 0) return state;
      return { collapsedWorktrees: [...state.collapsedWorktrees, ...missing] };
    });
  },
  expandAllWorktrees: () => {
    _projectStore.setState((state) =>
      state.collapsedWorktrees.length === 0 ? state : { collapsedWorktrees: [] }
    );
  },
  isWorktreeCollapsed: (id) => _projectStore.getState().collapsedWorktrees.includes(id),
  setWorktreeLabelColor: (id, token) => {
    _projectStore.setState((state) => {
      const current = state.worktreeLabelColors[id];
      if (token === null) {
        if (current === undefined) return state;
        const { [id]: _removed, ...rest } = state.worktreeLabelColors;
        return { worktreeLabelColors: rest };
      }
      if (current === token) return state;
      return { worktreeLabelColors: { ...state.worktreeLabelColors, [id]: token } };
    });
  },
  setWorktreeCustomTitle: async (id, title) => {
    const next = title === null ? "" : normalizeWorktreeCustomTitle(title);
    if (isWorktreeCustomTitleTooLong(next)) return;
    const api = worktreeTitlesBridge();
    if (typeof api?.set === "function") {
      // Not applied ahead of the round trip: main pushes each write to every
      // view of the project before replying, so they all stay in step with it.
      if (!titlesHandedOver) await pullWorktreeTitles();
      adoptWorktreeTitles(await api.set(id, next || null));
      return;
    }
    _projectStore.setState((state) => {
      const current = state.worktreeCustomTitles[id];
      if (!next) {
        if (current === undefined) return state;
        const { [id]: _removed, ...rest } = state.worktreeCustomTitles;
        return { worktreeCustomTitles: rest };
      }
      if (current === next) return state;
      return { worktreeCustomTitles: { ...state.worktreeCustomTitles, [id]: next } };
    });
  },
  setManualOrder: (order) => {
    _projectStore.setState({ manualOrder: order });
  },
  pruneStaleWorktreeIds: (validIds) => {
    // Main holds the titles, so a stale one is cleared there, once the
    // workspace host confirms the worktree is gone, and comes back to this view
    // (and every other view of the project) in main's push.
    const titlesInMain = typeof worktreeTitlesBridge()?.prune === "function";
    if (titlesInMain) {
      const staleTitleIds = Object.keys(_projectStore.getState().worktreeCustomTitles).filter(
        (id) => !validIds.has(id)
      );
      if (staleTitleIds.length > 0) {
        pruneWorktreeTitlesInMain(staleTitleIds).catch((error: unknown) => {
          logWarn("[worktreeFilterStore] Failed to clear stale worktree titles", { error });
        });
      }
    }
    _projectStore.setState((state) => {
      const pinned = state.pinnedWorktrees.filter((id) => validIds.has(id));
      const collapsed = state.collapsedWorktrees.filter((id) => validIds.has(id));
      const pinnedChanged = pinned.length !== state.pinnedWorktrees.length;
      const collapsedChanged = collapsed.length !== state.collapsedWorktrees.length;
      const labelIds = Object.keys(state.worktreeLabelColors);
      const keptLabelIds = labelIds.filter((id) => validIds.has(id));
      const labelsChanged = keptLabelIds.length !== labelIds.length;
      const titleIds = titlesInMain ? [] : Object.keys(state.worktreeCustomTitles);
      const keptTitleIds = titleIds.filter((id) => validIds.has(id));
      const titlesChanged = keptTitleIds.length !== titleIds.length;
      if (!pinnedChanged && !collapsedChanged && !labelsChanged && !titlesChanged) return state;
      const patch: Partial<ProjectScopedState> = {};
      if (pinnedChanged) patch.pinnedWorktrees = pinned;
      if (collapsedChanged) patch.collapsedWorktrees = collapsed;
      if (labelsChanged) {
        const labels: Record<string, WorktreeLabelToken> = {};
        for (const id of keptLabelIds) labels[id] = state.worktreeLabelColors[id]!;
        patch.worktreeLabelColors = labels;
      }
      if (titlesChanged) {
        const titles: Record<string, string> = {};
        for (const id of keptTitleIds) titles[id] = state.worktreeCustomTitles[id]!;
        patch.worktreeCustomTitles = titles;
      }
      return patch;
    });
  },
  setQuickStateFilter: (quickStateFilter) => {
    _projectStore.setState({ quickStateFilter });
  },
  clearQuickStateFilter: () => {
    _projectStore.setState({ quickStateFilter: "all" });
  },
  clearStatusFilters: () => {
    _projectStore.setState({ statusFilters: new Set() });
  },
  clearTypeFilters: () => {
    _projectStore.setState({ typeFilters: new Set() });
  },
  clearPrIssueFilters: () => {
    _projectStore.setState({ prIssueFilters: new Set() });
  },
  clearSessionFilters: () => {
    _projectStore.setState({ sessionFilters: new Set() });
  },
  clearActivityFilters: () => {
    _projectStore.setState({ activityFilters: new Set() });
  },
  clearDevServerFilters: () => {
    _projectStore.setState({ devServerFilters: new Set() });
  },
  clearAll: () => {
    _projectStore.setState({
      query: "",
      liveQuery: "",
      statusFilters: new Set(),
      typeFilters: new Set(),
      prIssueFilters: new Set(),
      sessionFilters: new Set(),
      hasAgentFilter: false,
      activityFilters: new Set(),
      quickStateFilter: "all",
      devServerFilters: new Set(),
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
      p.prIssueFilters.size +
      p.sessionFilters.size +
      (p.hasAgentFilter ? 1 : 0) +
      p.activityFilters.size +
      p.devServerFilters.size +
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
      p.prIssueFilters.size > 0 ||
      p.sessionFilters.size > 0 ||
      p.hasAgentFilter ||
      p.activityFilters.size > 0 ||
      p.devServerFilters.size > 0 ||
      p.quickStateFilter !== "all"
    );
  },
  hasFacetFilters: () => {
    const p = _projectStore.getState();
    return (
      p.statusFilters.size > 0 ||
      p.typeFilters.size > 0 ||
      p.prIssueFilters.size > 0 ||
      p.sessionFilters.size > 0 ||
      p.hasAgentFilter ||
      p.activityFilters.size > 0 ||
      p.devServerFilters.size > 0
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
    liveQuery: p.liveQuery,
    orderBy: g.orderBy,
    groupByType: g.groupByType,
    statusFilters: p.statusFilters,
    typeFilters: p.typeFilters,
    prIssueFilters: p.prIssueFilters,
    sessionFilters: p.sessionFilters,
    hasAgentFilter: p.hasAgentFilter,
    activityFilters: p.activityFilters,
    devServerFilters: p.devServerFilters,
    alwaysShowActive: g.alwaysShowActive,
    alwaysShowWaiting: g.alwaysShowWaiting,
    hideMainWorktree: g.hideMainWorktree,
    cardDensity: g.cardDensity,
    pinnedWorktrees: p.pinnedWorktrees,
    collapsedWorktrees: p.collapsedWorktrees,
    worktreeLabelColors: p.worktreeLabelColors,
    worktreeCustomTitles: p.worktreeCustomTitles,
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
  Partial<WorktreeFilterStore> | ((state: WorktreeFilterStore) => Partial<WorktreeFilterStore>);

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
