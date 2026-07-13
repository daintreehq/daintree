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

    // Pinned worktrees come before unpinned (after main)
    const aPinned = pinnedIndex.has(a.id);
    const bPinned = pinnedIndex.has(b.id);
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
  // Stable sort preserves sortWorktrees order as tiebreaker
  return [...sorted].sort((a, b) => scores.get(b.id)! - scores.get(a.id)!);
}

export interface GroupedSection<T> {
  type: WorktreeTypeId;
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

  for (const worktree of worktrees) {
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

export function filterTriageWorktrees<T extends Worktree | WorktreeState>(
  worktrees: T[],
  derivedMetaMap: Map<string, DerivedWorktreeMeta>,
  mainWorktreeId: string | undefined,
  integrationWorktreeId: string | undefined,
  query: string
): T[] {
  const nonMain = worktrees.filter(
    (w) => w.id !== mainWorktreeId && w.id !== integrationWorktreeId
  );
  return nonMain.filter((w) => {
    const meta = derivedMetaMap.get(w.id);
    if (!meta) return false;
    const qualifies = meta.hasWaitingAgent || meta.hasMergeConflict;
    if (!qualifies) return false;
    if (query.trim().length > 0) {
      const exactNum = parseExactNumber(query);
      if (exactNum !== null) {
        return w.issueNumber === exactNum || w.linked?.pr?.ref.number === exactNum;
      }
      return scoreWorktree(w, query) > 0;
    }
    return true;
  });
}

export const INTEGRATION_BRANCH_NAMES = ["develop", "trunk", "next"] as const;

export function findIntegrationWorktree<T extends Worktree | WorktreeState>(
  worktrees: T[],
  mainWorktreeId: string | undefined
): T | null {
  return (
    worktrees.find(
      (w) =>
        w.id !== mainWorktreeId &&
        !w.isMainWorktree &&
        w.branch != null &&
        (INTEGRATION_BRANCH_NAMES as readonly string[]).includes(w.branch.toLowerCase())
    ) ?? null
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

function withoutGroup<K extends keyof FilterState>(filters: FilterState, group: K): FilterState {
  return { ...filters, [group]: new Set() };
}

export function computeChipCounts(
  worktrees: readonly (Worktree | WorktreeState)[],
  derivedMetaMap: Map<string, DerivedWorktreeMeta>,
  activeWorktreeId: string | null,
  filters: FilterState,
  sessionsByWorktreeId?: Record<string, DevPreviewSessionState>
): ChipCounts {
  const counts = emptyChipCounts();
  const now = Date.now();

  const baseIsActive = (w: (typeof worktrees)[number]) => w.id === activeWorktreeId;
  const getDerived = (id: string) => derivedMetaMap.get(id) ?? DEFAULT_DERIVED_META;
  const matchesGroup = (w: (typeof worktrees)[number], groupFilters: FilterState) =>
    matchesFilters(w, groupFilters, getDerived(w.id), baseIsActive(w), sessionsByWorktreeId);

  // Build base set per group — filtered by all OTHER groups + query. The
  // group-excluded filter variants depend only on `filters`, so hoist them out
  // of the per-worktree callbacks.
  const statusVariant = withoutGroup(filters, "statusFilters");
  const typeVariant = withoutGroup(filters, "typeFilters");
  const prIssueVariant = withoutGroup(filters, "prIssueFilters");
  const sessionsVariant = withoutGroup(filters, "sessionFilters");
  const activityVariant = withoutGroup(filters, "activityFilters");
  const devServerVariant = withoutGroup(filters, "devServerFilters");

  const statusBase = worktrees.filter((w) => matchesGroup(w, statusVariant));
  const typeBase = worktrees.filter((w) => matchesGroup(w, typeVariant));
  const prIssueBase = worktrees.filter((w) => matchesGroup(w, prIssueVariant));
  const sessionsBase = worktrees.filter((w) => matchesGroup(w, sessionsVariant));
  const activityBase = worktrees.filter((w) => matchesGroup(w, activityVariant));
  const devServerBase = worktrees.filter((w) => matchesGroup(w, devServerVariant));

  for (const w of statusBase) {
    const statuses = computeStatus(w, baseIsActive(w));
    for (const status of statuses) counts.status[status]++;
  }

  for (const w of typeBase) {
    counts.branchType[getWorktreeType(w)]++;
  }

  for (const w of prIssueBase) {
    if (w.issueNumber) counts.prIssue.hasIssue++;
    if (w.linked?.pr) counts.prIssue.hasPR++;
    if (w.linked?.pr?.state === "open") counts.prIssue.prOpen++;
    if (w.linked?.pr?.state === "merged") counts.prIssue.prMerged++;
    if (w.linked?.pr?.state === "closed" || w.linked?.pr?.state === "declined")
      counts.prIssue.prClosed++;
  }

  for (const w of sessionsBase) {
    const meta = getDerived(w.id);
    if (meta.terminalCount > 0) counts.sessions.hasTerminals++;
    if (meta.hasWorkingAgent) counts.sessions.working++;
    if (meta.hasWaitingAgent) counts.sessions.waiting++;
    if (meta.hasCompletedAgent) counts.sessions.completed++;
    if (meta.hasExitedAgent) counts.sessions.exited++;
  }

  for (const w of activityBase) {
    const lastActivity = w.lastActivityTimestamp;
    if (!isValidPastTimestamp(lastActivity, now)) continue;
    const elapsed = now - lastActivity;
    for (const key of ACTIVITY_KEYS) {
      if (elapsed < ACTIVITY_WINDOW_MS[key]) counts.activity[key]++;
    }
  }

  for (const w of devServerBase) {
    const session = sessionsByWorktreeId?.[w.id];
    if (!session) continue;
    for (const key of DEV_SERVER_KEYS) {
      if (matchesDevServerFilter(key, session)) counts.devServer[key]++;
    }
  }

  return counts;
}
