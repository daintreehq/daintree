import type { Worktree, WorktreeState } from "@shared/types/worktree";
import { BRANCH_PREFIX_MAP } from "@shared/config/branchPrefixes";
import { parseExactNumber } from "@/lib/parseExactNumber";
import type {
  OrderBy,
  StatusFilter,
  TypeFilter,
  PrIssueFilter,
  SessionFilter,
  ActivityFilter,
  DevServerFilter,
} from "@/store/worktreeFilterStore";
import type { ChipState } from "@/components/Worktree/utils/computeChipState";
import type { DevPreviewSessionState, DevPreviewSessionStatus } from "@shared/types/ipc/devPreview";
import { isValidPastTimestamp } from "@/utils/timestamps";

export interface DerivedWorktreeMeta {
  terminalCount: number;
  hasWorkingAgent: boolean;
  hasWaitingAgent: boolean;
  hasCompletedAgent: boolean;
  hasExitedAgent: boolean;
  hasMergeConflict: boolean;
  chipState: ChipState;
}

export type QuickStateFilter = "all" | "working" | "waiting" | "finished";

export function matchesQuickStateFilter(
  filter: QuickStateFilter,
  meta: DerivedWorktreeMeta
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "working":
      return meta.hasWorkingAgent && meta.chipState === null;
    case "waiting":
      return meta.chipState === "waiting";
    case "finished":
      return meta.chipState === "complete" || meta.chipState === "cleanup";
  }
}

/**
 * A dev-server status the worktree row surfaces as a live signal. `stopped`,
 * `restored-stopped`, and the transient `stopping` render nothing, so both the
 * row indicator and the dev-server facet filter treat them as "no live server".
 */
export function isLiveDevServerStatus(status: DevPreviewSessionStatus): boolean {
  return (
    status === "running" || status === "starting" || status === "installing" || status === "error"
  );
}

export function matchesDevServerFilter(
  filter: DevServerFilter,
  session: DevPreviewSessionState | undefined
): boolean {
  if (!session) return false;
  switch (filter) {
    case "running":
      return session.status === "running";
    case "starting":
      return session.status === "starting" || session.status === "installing";
    case "error":
      return session.status === "error";
    case "hasDevServer":
      return isLiveDevServerStatus(session.status);
  }
}

export type WorktreeTypeId =
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

export function getWorktreeType(worktree: Worktree | WorktreeState): WorktreeTypeId {
  if (worktree.isMainWorktree) return "main";
  if (worktree.isDetached || !worktree.branch) return "detached";

  const branch = worktree.branch.toLowerCase();
  const prefix = branch.split(/[/-]/)[0];
  if (!prefix) return "other";

  const branchType = BRANCH_PREFIX_MAP[prefix];
  if (branchType) {
    return branchType.id as WorktreeTypeId;
  }

  return "other";
}

// Module-scoped collator for natural-numeric, case-insensitive name ordering.
// `numeric: true` makes "feature-2" sort before "feature-10".
const WORKTREE_NAME_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function compareWorktreeNames(a: string, b: string): number {
  return WORKTREE_NAME_COLLATOR.compare(a, b);
}

function scoreField(field: string, query: string, startsWith: number, contains: number): number {
  if (!field) return 0;
  if (field.startsWith(query)) return startsWith;
  if (field.includes(query)) return contains;
  return 0;
}

export function scoreWorktree(worktree: Worktree | WorktreeState, query: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;

  const name = worktree.name.toLowerCase();
  const branch = (worktree.branch ?? "").toLowerCase();
  const issueTitle = (worktree.issueTitle ?? "").toLowerCase();
  const prTitle = (worktree.linked?.pr?.title ?? "").toLowerCase();

  return Math.max(
    scoreField(issueTitle, q, 4, 3),
    scoreField(name, q, 4, 3),
    scoreField(branch, q, 2, 1),
    scoreField(prTitle, q, 2, 1)
  );
}

export function computeStatus(
  worktree: Worktree | WorktreeState,
  isActive: boolean
): StatusFilter[] {
  const statuses: StatusFilter[] = [];

  if (isActive) statuses.push("active");

  const changedFileCount = worktree.worktreeChanges?.changedFileCount ?? 0;
  if (changedFileCount > 0) statuses.push("dirty");

  if (worktree.mood === "stale") statuses.push("stale");

  // Idle = no special status or only active
  if (statuses.length === 0 || (statuses.length === 1 && statuses[0] === "active")) {
    statuses.push("idle");
  }

  return statuses;
}

export interface FilterState {
  query: string;
  statusFilters: Set<StatusFilter>;
  typeFilters: Set<TypeFilter>;
  prIssueFilters: Set<PrIssueFilter>;
  sessionFilters: Set<SessionFilter>;
  activityFilters: Set<ActivityFilter>;
  devServerFilters: Set<DevServerFilter>;
}

export function matchesFilters(
  worktree: Worktree | WorktreeState,
  filters: FilterState,
  derived: DerivedWorktreeMeta,
  isActive: boolean,
  sessionsByWorktreeId?: Record<string, DevPreviewSessionState>
): boolean {
  // Text search
  if (filters.query.length > 0) {
    const exactNum = parseExactNumber(filters.query);
    if (exactNum !== null) {
      if (worktree.issueNumber !== exactNum && worktree.linked?.pr?.ref.number !== exactNum) {
        return false;
      }
    } else {
      if (scoreWorktree(worktree, filters.query) === 0) {
        return false;
      }
    }
  }

  // Status filters (OR within category)
  if (filters.statusFilters.size > 0) {
    const statuses = computeStatus(worktree, isActive);
    const hasMatch = statuses.some((s) => filters.statusFilters.has(s));
    if (!hasMatch) return false;
  }

  // Type filters (OR within category)
  if (filters.typeFilters.size > 0) {
    const type = getWorktreeType(worktree);
    if (!filters.typeFilters.has(type)) return false;
  }

  // PR/issue filters (OR within category)
  if (filters.prIssueFilters.size > 0) {
    let hasMatch = false;

    if (filters.prIssueFilters.has("hasIssue") && worktree.issueNumber) hasMatch = true;
    if (filters.prIssueFilters.has("hasPR") && worktree.linked?.pr) hasMatch = true;
    if (filters.prIssueFilters.has("prOpen") && worktree.linked?.pr?.state === "open")
      hasMatch = true;
    if (filters.prIssueFilters.has("prMerged") && worktree.linked?.pr?.state === "merged")
      hasMatch = true;
    if (
      filters.prIssueFilters.has("prClosed") &&
      (worktree.linked?.pr?.state === "closed" || worktree.linked?.pr?.state === "declined")
    )
      hasMatch = true;

    if (!hasMatch) return false;
  }

  // Session filters (OR within category)
  if (filters.sessionFilters.size > 0) {
    let hasMatch = false;

    if (filters.sessionFilters.has("hasTerminals") && derived.terminalCount > 0) hasMatch = true;
    if (filters.sessionFilters.has("working") && derived.hasWorkingAgent) hasMatch = true;
    if (filters.sessionFilters.has("waiting") && derived.hasWaitingAgent) hasMatch = true;
    if (filters.sessionFilters.has("completed") && derived.hasCompletedAgent) hasMatch = true;
    if (filters.sessionFilters.has("exited") && derived.hasExitedAgent) hasMatch = true;

    if (!hasMatch) return false;
  }

  // Activity filters (OR within category)
  if (filters.activityFilters.size > 0) {
    const now = Date.now();
    const lastActivity = worktree.lastActivityTimestamp;
    let hasMatch = false;

    if (!isValidPastTimestamp(lastActivity, now)) return false;

    if (filters.activityFilters.has("last15m") && now - lastActivity < 15 * 60 * 1000)
      hasMatch = true;
    if (filters.activityFilters.has("last1h") && now - lastActivity < 60 * 60 * 1000)
      hasMatch = true;
    if (filters.activityFilters.has("last24h") && now - lastActivity < 24 * 60 * 60 * 1000)
      hasMatch = true;
    if (filters.activityFilters.has("last7d") && now - lastActivity < 7 * 24 * 60 * 60 * 1000)
      hasMatch = true;

    if (!hasMatch) return false;
  }

  // Dev-server filters (OR within category)
  if (filters.devServerFilters.size > 0) {
    const session = sessionsByWorktreeId?.[worktree.id];
    let hasMatch = false;
    for (const filter of filters.devServerFilters) {
      if (matchesDevServerFilter(filter, session)) {
        hasMatch = true;
        break;
      }
    }
    if (!hasMatch) return false;
  }

  return true;
}

/**
 * Only an explicit `true` counts. `undefined` means the workspace host couldn't
 * determine the containment boundary, and treating that as external would demote
 * every worktree in the project on a transient path-resolution failure (#2251).
 */
export function isExternalWorktree(worktree: Worktree | WorktreeState): boolean {
  return worktree.isExternal === true;
}

/**
 * The branch name a worktree can offer to copy, or null when it has none to
 * give. `isDetached` has to count alongside `branch`: the status pass only
 * overwrites `branch` when it reads a new one, so a worktree that detaches
 * keeps its pre-detach branch on the snapshot — a name it no longer has
 * checked out. Same pairing `getWorktreeType` uses to classify "detached".
 */
export function copyableBranchName(worktree: Worktree | WorktreeState): string | null {
  if (worktree.isDetached || !worktree.branch) return null;
  return worktree.branch;
}

export function sortWorktrees<T extends Worktree | WorktreeState>(
  worktrees: T[],
  orderBy: OrderBy,
  pinnedWorktrees: string[] = [],
  manualOrder: string[] = []
): T[] {
  const pinnedIndex = new Map(pinnedWorktrees.map((id, i) => [id, i]));
  const manualIndex = new Map(manualOrder.map((id, i) => [id, i]));
  const now = Date.now();

  return [...worktrees].sort((a, b) => {
    // Main worktree always first
    if (a.isMainWorktree && !b.isMainWorktree) return -1;
    if (!a.isMainWorktree && b.isMainWorktree) return 1;

    // Worktrees git reports from outside the project sink below everything the
    // project owns. Ahead of the pin check on purpose: a stale pin entry (or one
    // added before the worktree was classified) must not lift an external
    // worktree into the pinned area at the top (#11434).
    const aExternal = isExternalWorktree(a);
    const bExternal = isExternalWorktree(b);
    if (aExternal !== bExternal) return aExternal ? 1 : -1;

    // Pinned worktrees come before unpinned (after main)
    const aPinned = pinnedIndex.has(a.id) && !aExternal;
    const bPinned = pinnedIndex.has(b.id) && !bExternal;
    if (aPinned && !bPinned) return -1;
    if (!aPinned && bPinned) return 1;

    // If both are pinned, maintain pin order
    if (aPinned && bPinned) {
      return pinnedIndex.get(a.id)! - pinnedIndex.get(b.id)!;
    }

    // Apply normal sorting to unpinned worktrees
    switch (orderBy) {
      case "manual": {
        // Items not in manualOrder go to the end
        const aPos = manualIndex.get(a.id) ?? manualOrder.length;
        const bPos = manualIndex.get(b.id) ?? manualOrder.length;
        if (aPos !== bPos) return aPos - bPos;
        return compareWorktreeNames(a.name, b.name);
      }
      case "recent": {
        const activityA = isValidPastTimestamp(a.lastActivityTimestamp, now)
          ? a.lastActivityTimestamp
          : 0;
        const activityB = isValidPastTimestamp(b.lastActivityTimestamp, now)
          ? b.lastActivityTimestamp
          : 0;
        const timeA = Math.max(activityA, a.createdAt ?? 0);
        const timeB = Math.max(activityB, b.createdAt ?? 0);
        if (timeA !== timeB) return timeB - timeA;
        return compareWorktreeNames(a.name, b.name);
      }
      case "created": {
        const createdA = a.createdAt ?? 0;
        const createdB = b.createdAt ?? 0;
        if (createdA !== createdB) return createdB - createdA;
        return compareWorktreeNames(a.name, b.name);
      }
      case "alpha":
        return compareWorktreeNames(a.name, b.name);
      default:
        return 0;
    }
  });
}

export function sortWorktreesByRelevance<T extends Worktree | WorktreeState>(
  worktrees: T[],
  query: string,
  orderBy: OrderBy,
  pinnedWorktrees: string[] = [],
  manualOrder: string[] = []
): T[] {
  const sorted = sortWorktrees(worktrees, orderBy, pinnedWorktrees, manualOrder);
  if (!query.trim()) return sorted;

  const scores = new Map(sorted.map((w) => [w.id, scoreWorktree(w, query)]));
  // Stable sort preserves sortWorktrees order as tiebreaker. The external
  // partition is re-applied as the primary key: a strong query match must not
  // pull an outside-the-project worktree back above the project's own (#11434).
  return [...sorted].sort((a, b) => {
    const aExternal = isExternalWorktree(a);
    const bExternal = isExternalWorktree(b);
    if (aExternal !== bExternal) return aExternal ? 1 : -1;
    return scores.get(b.id)! - scores.get(a.id)!;
  });
}

/**
 * Section identity for grouped mode. `"external"` is a location bucket, not a
 * branch type — `getWorktreeType` never returns it, so it stays outside
 * `WorktreeTypeId` (which the type filters and display-name table exhaust).
 */
export type WorktreeGroupId = WorktreeTypeId | "external";

export interface GroupedSection<T> {
  type: WorktreeGroupId;
  displayName: string;
  worktrees: T[];
}

const TYPE_ORDER: WorktreeTypeId[] = [
  "main",
  "feature",
  "bugfix",
  "refactor",
  "chore",
  "docs",
  "test",
  "release",
  "ci",
  "deps",
  "perf",
  "style",
  "wip",
  "detached",
  "other",
];

const TYPE_DISPLAY_NAMES: Record<WorktreeTypeId, string> = {
  main: "Main",
  feature: "Features",
  bugfix: "Bugfixes",
  refactor: "Refactors",
  chore: "Chores",
  docs: "Documentation",
  test: "Tests",
  release: "Releases",
  ci: "CI/Build",
  deps: "Dependencies",
  perf: "Performance",
  style: "Style",
  wip: "Work in Progress",
  detached: "Detached HEAD",
  other: "Other",
};

export function groupByType<T extends Worktree | WorktreeState>(
  worktrees: T[],
  orderBy: OrderBy,
  pinnedWorktrees: string[] = []
): GroupedSection<T>[] {
  const groups = new Map<WorktreeTypeId, T[]>();
  // Pulled out before branch grouping: section order outranks the per-group
  // comparator, so an external feature worktree left in "Features" would still
  // render above the project's own bugfixes (#11434).
  const external: T[] = [];

  for (const worktree of worktrees) {
    if (isExternalWorktree(worktree)) {
      external.push(worktree);
      continue;
    }
    const type = getWorktreeType(worktree);
    const existing = groups.get(type) ?? [];
    existing.push(worktree);
    groups.set(type, existing);
  }

  // Sort within each group according to orderBy
  for (const [type, items] of groups) {
    groups.set(type, sortWorktrees(items, orderBy, pinnedWorktrees));
  }

  // Build sections in predefined order
  const sections: GroupedSection<T>[] = [];
  for (const type of TYPE_ORDER) {
    const items = groups.get(type);
    if (items && items.length > 0) {
      sections.push({
        type,
        displayName: TYPE_DISPLAY_NAMES[type],
        worktrees: items,
      });
    }
  }

  if (external.length > 0) {
    sections.push({
      type: "external",
      displayName: "Outside the project",
      worktrees: sortWorktrees(external, orderBy, pinnedWorktrees),
    });
  }

  return sections;
}

export function hasAnyFilters(filters: FilterState): boolean {
  return (
    filters.query.length > 0 ||
    filters.statusFilters.size > 0 ||
    filters.typeFilters.size > 0 ||
    filters.prIssueFilters.size > 0 ||
    filters.sessionFilters.size > 0 ||
    filters.activityFilters.size > 0 ||
    filters.devServerFilters.size > 0
  );
}

export interface ChipCounts {
  status: Record<StatusFilter, number>;
  branchType: Record<TypeFilter, number>;
  prIssue: Record<PrIssueFilter, number>;
  sessions: Record<SessionFilter, number>;
  activity: Record<ActivityFilter, number>;
  devServer: Record<DevServerFilter, number>;
}

const STATUS_KEYS: StatusFilter[] = ["active", "dirty", "stale", "idle"];
const TYPE_KEYS: TypeFilter[] = [
  "feature",
  "bugfix",
  "refactor",
  "chore",
  "docs",
  "test",
  "release",
  "ci",
  "deps",
  "perf",
  "style",
  "wip",
  "main",
  "detached",
  "other",
];
const PR_ISSUE_KEYS: PrIssueFilter[] = ["hasIssue", "hasPR", "prOpen", "prMerged", "prClosed"];
const SESSION_KEYS: SessionFilter[] = ["hasTerminals", "working", "waiting", "completed", "exited"];
const ACTIVITY_KEYS: ActivityFilter[] = ["last15m", "last1h", "last24h", "last7d"];
const DEV_SERVER_KEYS: DevServerFilter[] = ["running", "starting", "hasDevServer", "error"];

const ACTIVITY_WINDOW_MS: Record<ActivityFilter, number> = {
  last15m: 15 * 60 * 1000,
  last1h: 60 * 60 * 1000,
  last24h: 24 * 60 * 60 * 1000,
  last7d: 7 * 24 * 60 * 60 * 1000,
};

function emptyRecord<K extends string>(keys: readonly K[]): Record<K, number> {
  const result = {} as Record<K, number>;
  for (const key of keys) result[key] = 0;
  return result;
}

export function emptyChipCounts(): ChipCounts {
  return {
    status: emptyRecord(STATUS_KEYS),
    branchType: emptyRecord(TYPE_KEYS),
    prIssue: emptyRecord(PR_ISSUE_KEYS),
    sessions: emptyRecord(SESSION_KEYS),
    activity: emptyRecord(ACTIVITY_KEYS),
    devServer: emptyRecord(DEV_SERVER_KEYS),
  };
}

const DEFAULT_DERIVED_META: DerivedWorktreeMeta = {
  terminalCount: 0,
  hasWorkingAgent: false,
  hasWaitingAgent: false,
  hasCompletedAgent: false,
  hasExitedAgent: false,
  hasMergeConflict: false,
  chipState: null,
};

const STATUS_FACET = 1 << 0;
const TYPE_FACET = 1 << 1;
const PR_ISSUE_FACET = 1 << 2;
const SESSION_FACET = 1 << 3;
const ACTIVITY_FACET = 1 << 4;
const DEV_SERVER_FACET = 1 << 5;

export function computeChipCounts(
  worktrees: readonly (Worktree | WorktreeState)[],
  derivedMetaMap: Map<string, DerivedWorktreeMeta>,
  activeWorktreeId: string | null,
  filters: FilterState,
  sessionsByWorktreeId?: Record<string, DevPreviewSessionState>
): ChipCounts {
  const counts = emptyChipCounts();
  const now = Date.now();
  const hasQuery = filters.query.length > 0;
  const exactQuery = hasQuery ? parseExactNumber(filters.query) : null;

  for (const worktree of worktrees) {
    if (hasQuery) {
      const matchesQuery =
        exactQuery === null
          ? scoreWorktree(worktree, filters.query) > 0
          : worktree.issueNumber === exactQuery || worktree.linked?.pr?.ref.number === exactQuery;
      if (!matchesQuery) continue;
    }

    const isActive = worktree.id === activeWorktreeId;
    const derived = derivedMetaMap.get(worktree.id) ?? DEFAULT_DERIVED_META;
    const session = sessionsByWorktreeId?.[worktree.id];
    const lastActivity = worktree.lastActivityTimestamp;
    const activityElapsed = isValidPastTimestamp(lastActivity, now) ? now - lastActivity : null;
    let statuses: StatusFilter[] | undefined;
    let type: WorktreeTypeId | undefined;
    let failedFacets = 0;

    // A row contributes to a facet when every other active facet passed. One
    // failure therefore admits it only to that facet; multiple failures admit
    // it to none. This preserves the six disjunctive bases without six sweeps.
    if (filters.statusFilters.size > 0) {
      statuses = computeStatus(worktree, isActive);
      if (!statuses.some((status) => filters.statusFilters.has(status))) {
        failedFacets |= STATUS_FACET;
      }
    }

    if (filters.typeFilters.size > 0) {
      type = getWorktreeType(worktree);
      if (!filters.typeFilters.has(type)) failedFacets |= TYPE_FACET;
    }

    if (filters.prIssueFilters.size > 0) {
      const prState = worktree.linked?.pr?.state;
      const matchesPrIssue =
        (filters.prIssueFilters.has("hasIssue") && Boolean(worktree.issueNumber)) ||
        (filters.prIssueFilters.has("hasPR") && Boolean(worktree.linked?.pr)) ||
        (filters.prIssueFilters.has("prOpen") && prState === "open") ||
        (filters.prIssueFilters.has("prMerged") && prState === "merged") ||
        (filters.prIssueFilters.has("prClosed") &&
          (prState === "closed" || prState === "declined"));
      if (!matchesPrIssue) failedFacets |= PR_ISSUE_FACET;
    }

    if (filters.sessionFilters.size > 0) {
      const matchesSession =
        (filters.sessionFilters.has("hasTerminals") && derived.terminalCount > 0) ||
        (filters.sessionFilters.has("working") && derived.hasWorkingAgent) ||
        (filters.sessionFilters.has("waiting") && derived.hasWaitingAgent) ||
        (filters.sessionFilters.has("completed") && derived.hasCompletedAgent) ||
        (filters.sessionFilters.has("exited") && derived.hasExitedAgent);
      if (!matchesSession) failedFacets |= SESSION_FACET;
    }

    if (filters.activityFilters.size > 0) {
      let matchesActivity = false;
      if (activityElapsed !== null) {
        for (const key of filters.activityFilters) {
          if (activityElapsed < ACTIVITY_WINDOW_MS[key]) {
            matchesActivity = true;
            break;
          }
        }
      }
      if (!matchesActivity) failedFacets |= ACTIVITY_FACET;
    }

    if (filters.devServerFilters.size > 0) {
      let matchesDevServer = false;
      for (const key of filters.devServerFilters) {
        if (matchesDevServerFilter(key, session)) {
          matchesDevServer = true;
          break;
        }
      }
      if (!matchesDevServer) failedFacets |= DEV_SERVER_FACET;
    }

    if (failedFacets === 0 || failedFacets === STATUS_FACET) {
      statuses ??= computeStatus(worktree, isActive);
      for (const status of statuses) counts.status[status]++;
    }

    if (failedFacets === 0 || failedFacets === TYPE_FACET) {
      type ??= getWorktreeType(worktree);
      counts.branchType[type]++;
    }

    if (failedFacets === 0 || failedFacets === PR_ISSUE_FACET) {
      if (worktree.issueNumber) counts.prIssue.hasIssue++;
      if (worktree.linked?.pr) counts.prIssue.hasPR++;
      if (worktree.linked?.pr?.state === "open") counts.prIssue.prOpen++;
      if (worktree.linked?.pr?.state === "merged") counts.prIssue.prMerged++;
      if (worktree.linked?.pr?.state === "closed" || worktree.linked?.pr?.state === "declined") {
        counts.prIssue.prClosed++;
      }
    }

    if (failedFacets === 0 || failedFacets === SESSION_FACET) {
      if (derived.terminalCount > 0) counts.sessions.hasTerminals++;
      if (derived.hasWorkingAgent) counts.sessions.working++;
      if (derived.hasWaitingAgent) counts.sessions.waiting++;
      if (derived.hasCompletedAgent) counts.sessions.completed++;
      if (derived.hasExitedAgent) counts.sessions.exited++;
    }

    if (failedFacets === 0 || failedFacets === ACTIVITY_FACET) {
      if (activityElapsed !== null) {
        for (const key of ACTIVITY_KEYS) {
          if (activityElapsed < ACTIVITY_WINDOW_MS[key]) counts.activity[key]++;
        }
      }
    }

    if ((failedFacets === 0 || failedFacets === DEV_SERVER_FACET) && session) {
      for (const key of DEV_SERVER_KEYS) {
        if (matchesDevServerFilter(key, session)) counts.devServer[key]++;
      }
    }
  }

  return counts;
}
