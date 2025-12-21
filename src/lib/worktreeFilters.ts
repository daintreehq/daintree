import type { Worktree, WorktreeState } from "@shared/types/domain";
import { BRANCH_PREFIX_MAP } from "@shared/config/branchPrefixes";
import type {
  OrderBy,
  StatusFilter,
  TypeFilter,
  GitHubFilter,
  SessionFilter,
  ActivityFilter,
} from "@/store/worktreeFilterStore";

export interface DerivedWorktreeMeta {
  hasErrors: boolean;
  terminalCount: number;
  hasWorkingAgent: boolean;
  hasRunningAgent: boolean;
  hasWaitingAgent: boolean;
  hasFailedAgent: boolean;
  hasCompletedAgent: boolean;
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

  const branchType = BRANCH_PREFIX_MAP[prefix];
  if (branchType) {
    return branchType.id as WorktreeTypeId;
  }

  return "other";
}

export function buildSearchableText(worktree: Worktree | WorktreeState): string {
  const parts = [
    worktree.name,
    worktree.branch ?? "",
    worktree.path,
    worktree.issueNumber ? `#${worktree.issueNumber}` : "",
    worktree.prNumber ? `#${worktree.prNumber}` : "",
    worktree.summary ?? "",
    worktree.aiNote ?? "",
  ];

  return parts.filter(Boolean).join(" ").toLowerCase();
}

export function computeStatus(
  worktree: Worktree | WorktreeState,
  isActive: boolean,
  hasErrors: boolean
): StatusFilter[] {
  const statuses: StatusFilter[] = [];

  if (isActive) statuses.push("active");

  const changedFileCount = worktree.worktreeChanges?.changedFileCount ?? 0;
  if (changedFileCount > 0) statuses.push("dirty");

  if (worktree.mood === "error" || hasErrors) statuses.push("error");
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
  githubFilters: Set<GitHubFilter>;
  sessionFilters: Set<SessionFilter>;
  activityFilters: Set<ActivityFilter>;
}

export function matchesFilters(
  worktree: Worktree | WorktreeState,
  filters: FilterState,
  derived: DerivedWorktreeMeta,
  isActive: boolean
): boolean {
  // Text search
  if (filters.query.length > 0) {
    const searchable = buildSearchableText(worktree);
    if (!searchable.includes(filters.query.toLowerCase())) {
      return false;
    }
  }

  // Status filters (OR within category)
  if (filters.statusFilters.size > 0) {
    const statuses = computeStatus(worktree, isActive, derived.hasErrors);
    const hasMatch = statuses.some((s) => filters.statusFilters.has(s));
    if (!hasMatch) return false;
  }

  // Type filters (OR within category)
  if (filters.typeFilters.size > 0) {
    const type = getWorktreeType(worktree);
    if (!filters.typeFilters.has(type)) return false;
  }

  // GitHub filters (OR within category)
  if (filters.githubFilters.size > 0) {
    let hasMatch = false;

    if (filters.githubFilters.has("hasIssue") && worktree.issueNumber) hasMatch = true;
    if (filters.githubFilters.has("hasPR") && worktree.prNumber) hasMatch = true;
    if (filters.githubFilters.has("prOpen") && worktree.prState === "open") hasMatch = true;
    if (filters.githubFilters.has("prMerged") && worktree.prState === "merged") hasMatch = true;
    if (filters.githubFilters.has("prClosed") && worktree.prState === "closed") hasMatch = true;

    if (!hasMatch) return false;
  }

  // Session filters (OR within category)
  if (filters.sessionFilters.size > 0) {
    let hasMatch = false;

    if (filters.sessionFilters.has("hasTerminals") && derived.terminalCount > 0) hasMatch = true;
    if (filters.sessionFilters.has("working") && derived.hasWorkingAgent) hasMatch = true;
    if (filters.sessionFilters.has("running") && derived.hasRunningAgent) hasMatch = true;
    if (filters.sessionFilters.has("waiting") && derived.hasWaitingAgent) hasMatch = true;
    if (filters.sessionFilters.has("failed") && derived.hasFailedAgent) hasMatch = true;
    if (filters.sessionFilters.has("completed") && derived.hasCompletedAgent) hasMatch = true;

    if (!hasMatch) return false;
  }

  // Activity filters (OR within category)
  if (filters.activityFilters.size > 0) {
    const now = Date.now();
    const lastActivity = worktree.lastActivityTimestamp ?? 0;
    let hasMatch = false;

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

  return true;
}

export function sortWorktrees<T extends Worktree | WorktreeState>(
  worktrees: T[],
  orderBy: OrderBy
): T[] {
  return [...worktrees].sort((a, b) => {
    // Main worktree always first
    if (a.isMainWorktree && !b.isMainWorktree) return -1;
    if (!a.isMainWorktree && b.isMainWorktree) return 1;

    switch (orderBy) {
      case "recent": {
        const timeA = a.lastActivityTimestamp ?? 0;
        const timeB = b.lastActivityTimestamp ?? 0;
        if (timeA !== timeB) return timeB - timeA;
        return a.name.localeCompare(b.name);
      }
      case "created": {
        const createdA = a.createdAt ?? 0;
        const createdB = b.createdAt ?? 0;
        if (createdA !== createdB) return createdB - createdA;
        return a.name.localeCompare(b.name);
      }
      case "alpha":
        return a.name.localeCompare(b.name);
      default:
        return 0;
    }
  });
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
  orderBy: OrderBy
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
    groups.set(type, sortWorktrees(items, orderBy));
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
    filters.githubFilters.size > 0 ||
    filters.sessionFilters.size > 0 ||
    filters.activityFilters.size > 0
  );
}
