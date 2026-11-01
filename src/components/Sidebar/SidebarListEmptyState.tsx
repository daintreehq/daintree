import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { AGENT_BUCKET_LABEL } from "@/lib/agentStateVocabulary";
import { pluralNoun } from "@/lib/pluralize";
import type { QuickStateFilter } from "@/lib/worktreeFilters";

type QuickStateBucket = Exclude<QuickStateFilter, "all">;

const NO_MATCH_QUERY_MAX = 40;

/** Mirrors `QuickStateFilterBar`'s own labels — see the rationale there. */
const QUICK_STATE_LABELS: Record<QuickStateBucket, string> = {
  working: AGENT_BUCKET_LABEL.working,
  waiting: AGENT_BUCKET_LABEL.attention,
  finished: AGENT_BUCKET_LABEL.finished,
};

// A tab that emptied while it was selected is news about the agents, not a
// filter to recover from — the tab strip one row up is the way out — so each
// reads as a quiet statement in the register of "All caught up".
// Finished names the bucket rather than claiming work is done: an agent at its
// prompt is also what a missed approval or an Esc interrupt looks like.
const DRAINED_TITLES: Record<QuickStateBucket, string> = {
  working: "No agents working",
  waiting: "All caught up",
  finished: "Nothing in Finished",
};

// The tab counts leave main out, and main is exempt from the tab, so main can
// be on screen in the very state its tab reads as empty.
const MAIN_ONLY_TITLES: Record<QuickStateBucket, string> = {
  working: "Only the main worktree is working",
  waiting: "Only the main worktree needs attention",
  finished: "Only the main worktree is in Finished",
};

/**
 * Why the list under the tab strip is empty, which decides what it says:
 *
 * - `drained` — a state tab with nothing in it and no search or facet on. Quiet,
 *   no action.
 * - `hidden-by-tab` — the search or facets did find worktrees, all of them in
 *   other states. Says how many, and widens the tab without dropping the
 *   criteria that found them.
 * - `no-match` — nothing matches the search or facets in any state, or only the
 *   main card above does. Clears whatever is narrowing the list.
 */
export type SidebarListEmpty =
  | { kind: "drained"; bucket: QuickStateBucket; mainInBucket: boolean }
  | { kind: "hidden-by-tab"; bucket: QuickStateBucket; hiddenCount: number; mainVisible: boolean }
  | { kind: "no-match"; query: string; hasFacets: boolean; mainVisible: boolean };

export function resolveSidebarListEmpty({
  filteredCount,
  hasNonMainWorktrees,
  quickStateFilter,
  hasQuery,
  hasFacets,
  resultsWithoutQuickStateCount,
  mainVisible,
  mainInQuickState,
  displayQuery,
}: {
  filteredCount: number;
  hasNonMainWorktrees: boolean;
  quickStateFilter: QuickStateFilter;
  hasQuery: boolean;
  hasFacets: boolean;
  resultsWithoutQuickStateCount: number;
  mainVisible: boolean;
  mainInQuickState: boolean;
  displayQuery: string;
}): SidebarListEmpty | null {
  if (filteredCount > 0) return null;
  const isNarrowed = hasQuery || hasFacets;
  // No feature worktrees: nothing to say unless a filter is what hid main, in
  // which case the user needs the way back.
  if (!hasNonMainWorktrees && (mainVisible || (!isNarrowed && quickStateFilter === "all"))) {
    return null;
  }
  if (quickStateFilter !== "all") {
    if (!isNarrowed) {
      return { kind: "drained", bucket: quickStateFilter, mainInBucket: mainInQuickState };
    }
    if (resultsWithoutQuickStateCount > 0) {
      return {
        kind: "hidden-by-tab",
        bucket: quickStateFilter,
        hiddenCount: resultsWithoutQuickStateCount,
        mainVisible,
      };
    }
  }
  if (!isNarrowed) return null;
  return { kind: "no-match", query: displayQuery.trim(), hasFacets, mainVisible };
}

function truncateSearchQuery(trimmedQuery: string) {
  const codepoints = Array.from(trimmedQuery);
  return codepoints.length > NO_MATCH_QUERY_MAX
    ? `${codepoints.slice(0, NO_MATCH_QUERY_MAX).join("")}…`
    : trimmedQuery;
}

/** The empty state's title, which is also what the sidebar announces. */
export function sidebarListEmptyTitle(empty: SidebarListEmpty): string {
  switch (empty.kind) {
    case "drained":
      return empty.mainInBucket ? MAIN_ONLY_TITLES[empty.bucket] : DRAINED_TITLES[empty.bucket];
    case "hidden-by-tab": {
      const noun = pluralNoun(empty.hiddenCount, "match", "matches");
      // "more" because the main card above is a match too.
      const more = empty.mainVisible ? "more " : "";
      return `${empty.hiddenCount.toLocaleString()} ${more}${noun} outside ${QUICK_STATE_LABELS[empty.bucket]}`;
    }
    case "no-match": {
      // "other" because a visible main card is a match the list never holds.
      const other = empty.mainVisible ? "other " : "";
      if (!empty.query) return `No ${other}worktrees match these filters`;
      const facets = empty.hasFacets ? " with these filters" : "";
      return `No ${other}matches for "${truncateSearchQuery(empty.query)}"${facets}`;
    }
  }
}

interface SidebarListEmptyStateProps {
  empty: SidebarListEmpty;
  onShowAllMatches: () => void;
  onClearSearch: () => void;
  onClearAllFilters: () => void;
}

export function SidebarListEmptyState({
  empty,
  onShowAllMatches,
  onClearSearch,
  onClearAllFilters,
}: SidebarListEmptyStateProps) {
  const title = sidebarListEmptyTitle(empty);
  if (empty.kind === "drained") {
    return <EmptyState variant="user-cleared" scale="sidebar" title={title} />;
  }
  // One action, and it undoes only the constraint that emptied the list: a tab
  // that is hiding matches widens and keeps the search, and a search that
  // matched nothing clears and keeps the user's preferences.
  const action =
    empty.kind === "hidden-by-tab" ? (
      <Button variant="subtle" size="sm" onClick={onShowAllMatches}>
        Show all matches
      </Button>
    ) : empty.hasFacets ? (
      <Button variant="subtle" size="sm" onClick={onClearAllFilters}>
        Clear all filters
      </Button>
    ) : (
      <Button variant="subtle" size="sm" onClick={onClearSearch}>
        Clear search
      </Button>
    );
  return (
    <EmptyState variant="filtered-empty" scale="sidebar" instant title={title} action={action} />
  );
}
