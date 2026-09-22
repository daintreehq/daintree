import type {
  ActivityFilter,
  DevServerFilter,
  OrderBy,
  PrIssueFilter,
  SessionFilter,
  StatusFilter,
  TypeFilter,
} from "@/store/worktreeFilterStore";

/**
 * The facet vocabulary — the labels the user reads for every filter value.
 *
 * These lived inside `WorktreeFilterPopover`, which meant the sidebar could
 * report *how many* filters were on but never *which*, because it had no way to
 * turn a stored `"dirty"` into the word "Dirty". Naming the active filters
 * outside the closed popover is the whole point of an applied-filters summary,
 * so the vocabulary has to sit where both can reach it.
 */
export interface FilterOption<T extends string> {
  value: T;
  label: string;
}

export const STATUS_OPTIONS: readonly FilterOption<StatusFilter>[] = [
  { value: "active", label: "Active" },
  { value: "dirty", label: "Dirty" },
  { value: "stale", label: "Stale" },
  { value: "idle", label: "Idle" },
];

export const TYPE_OPTIONS: readonly FilterOption<TypeFilter>[] = [
  { value: "feature", label: "Feature" },
  { value: "bugfix", label: "Bugfix" },
  { value: "refactor", label: "Refactor" },
  { value: "chore", label: "Chore" },
  { value: "docs", label: "Docs" },
  { value: "test", label: "Test" },
  { value: "release", label: "Release" },
  { value: "ci", label: "CI" },
  { value: "deps", label: "Deps" },
  { value: "perf", label: "Perf" },
  { value: "style", label: "Style" },
  { value: "wip", label: "WIP" },
  { value: "main", label: "Main" },
  { value: "detached", label: "Detached" },
  { value: "other", label: "Other" },
];

export const PR_ISSUE_OPTIONS: readonly FilterOption<PrIssueFilter>[] = [
  { value: "hasIssue", label: "Has issue" },
  { value: "hasPR", label: "Has PR" },
  { value: "prOpen", label: "PR open" },
  { value: "prMerged", label: "PR merged" },
  { value: "prClosed", label: "PR closed" },
];

export const SESSION_OPTIONS: readonly FilterOption<SessionFilter>[] = [
  { value: "hasTerminals", label: "Has terminals" },
  { value: "working", label: "Working" },
  { value: "waiting", label: "Waiting" },
  { value: "completed", label: "Completed" },
  { value: "exited", label: "Exited" },
];

export const ACTIVITY_OPTIONS: readonly FilterOption<ActivityFilter>[] = [
  { value: "last15m", label: "15m" },
  { value: "last1h", label: "1h" },
  { value: "last24h", label: "24h" },
  { value: "last7d", label: "7d" },
];

export const DEV_SERVER_OPTIONS: readonly FilterOption<DevServerFilter>[] = [
  { value: "hasDevServer", label: "Has server" },
  { value: "running", label: "Running" },
  { value: "starting", label: "Starting" },
  { value: "error", label: "Error" },
];

export const ORDER_OPTIONS: readonly FilterOption<OrderBy>[] = [
  { value: "created", label: "Date created" },
  { value: "recent", label: "Recently updated" },
  { value: "alpha", label: "Alphabetical" },
  { value: "manual", label: "Custom order" },
];

/** The active facets, in the order the popover lists them. */
export interface ActiveFacets {
  statusFilters: ReadonlySet<StatusFilter>;
  typeFilters: ReadonlySet<TypeFilter>;
  prIssueFilters: ReadonlySet<PrIssueFilter>;
  sessionFilters: ReadonlySet<SessionFilter>;
  activityFilters: ReadonlySet<ActivityFilter>;
  devServerFilters: ReadonlySet<DevServerFilter>;
}

function facetPhrase<T extends string>(
  title: string,
  options: readonly FilterOption<T>[],
  selected: ReadonlySet<T>
): string | null {
  if (selected.size === 0) return null;
  // Option order, not selection order, so the phrase is stable as the user
  // toggles values on and off.
  const labels = options.filter((o) => selected.has(o.value)).map((o) => o.label);
  if (labels.length === 0) return null;
  return `${title}: ${labels.join(", ")}`;
}

/**
 * Names the active facet filters, e.g. `Status: Dirty · Branch type: Feature`.
 *
 * A count alone ("3") tells the user their list is cut down but not what cut
 * it, so a sparse sidebar still reads as a sidebar with nothing in it. Returns
 * an empty string when nothing is active.
 */
export function describeActiveFacets(facets: ActiveFacets): string {
  return [
    facetPhrase("Status", STATUS_OPTIONS, facets.statusFilters),
    facetPhrase("Branch type", TYPE_OPTIONS, facets.typeFilters),
    facetPhrase("Issues & PRs", PR_ISSUE_OPTIONS, facets.prIssueFilters),
    facetPhrase("Sessions", SESSION_OPTIONS, facets.sessionFilters),
    facetPhrase("Activity", ACTIVITY_OPTIONS, facets.activityFilters),
    facetPhrase("Dev server", DEV_SERVER_OPTIONS, facets.devServerFilters),
  ]
    .filter(Boolean)
    .join(" · ");
}
