import type { EventFilterOptions } from "@/store/eventStore";

export type ContextFilterKey = keyof Pick<
  EventFilterOptions,
  "worktreeId" | "agentId" | "runId" | "terminalId" | "issueNumber" | "prNumber"
>;

export interface ContextFilterFacet {
  key: ContextFilterKey;
  /** Visible facet name: the Context row label and the bar token's prefix. */
  label: string;
  /** Lowercase name for hints: "Filter by {noun}", "Clear {noun} filter". */
  noun: string;
}

/**
 * The event context values a filter can be set from, in the order the
 * Context section lists them. The detail pane's chips and the filter bar's
 * applied tokens both read this, so a facet is named the same in both places.
 */
export const CONTEXT_FILTER_FACETS: readonly ContextFilterFacet[] = [
  { key: "worktreeId", label: "Worktree", noun: "worktree" },
  { key: "agentId", label: "Agent", noun: "agent" },
  { key: "runId", label: "Run", noun: "run" },
  { key: "terminalId", label: "Terminal", noun: "terminal" },
  { key: "issueNumber", label: "Issue", noun: "issue" },
  { key: "prNumber", label: "PR", noun: "PR" },
];

/** Issue and PR numbers read as `#482`, the way GitHub writes them. */
export function formatContextValue(key: ContextFilterKey, value: string | number): string {
  return key === "issueNumber" || key === "prNumber" ? `#${value}` : String(value);
}

export function activeContextFilters(
  filters: EventFilterOptions
): Array<ContextFilterFacet & { value: string | number }> {
  return CONTEXT_FILTER_FACETS.flatMap((facet) => {
    const value = filters[facet.key];
    return value === undefined || value === "" ? [] : [{ ...facet, value }];
  });
}

/** Any filter the Events tab's controls can set, in the bar or from Context. */
export function hasActiveEventFilters(filters: EventFilterOptions): boolean {
  return (
    !!filters.search ||
    !!filters.traceId ||
    !!filters.category ||
    (filters.categories?.length ?? 0) > 0 ||
    (filters.types?.length ?? 0) > 0 ||
    activeContextFilters(filters).length > 0
  );
}
