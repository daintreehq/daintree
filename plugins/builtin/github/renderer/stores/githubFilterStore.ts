import { create } from "zustand";
import type { GitHubSortOrder } from "../../shared/types.js";

export type IssueStateFilter = "open" | "closed" | "all";
export type PRStateFilter = "open" | "closed" | "merged" | "all";
export type PRScopeFilter = "all" | "mine" | "needs-review";

// `@me` is resolved by GitHub's search against the token's own user, so the
// renderer never needs to know the login.
const PR_SCOPE_QUALIFIERS: Record<PRScopeFilter, string> = {
  all: "",
  mine: "author:@me",
  "needs-review": "review-requested:@me",
};

export function prScopeQualifier(scope: PRScopeFilter): string {
  return PR_SCOPE_QUALIFIERS[scope];
}

interface GitHubFilterState {
  issueFilter: IssueStateFilter;
  prFilter: PRStateFilter;
  prScope: PRScopeFilter;
  issueSearchQuery: string;
  prSearchQuery: string;
  issueSortOrder: GitHubSortOrder;
  prSortOrder: GitHubSortOrder;
  setIssueFilter: (filter: IssueStateFilter) => void;
  setPrFilter: (filter: PRStateFilter) => void;
  setPrScope: (scope: PRScopeFilter) => void;
  setIssueSearchQuery: (query: string) => void;
  setPrSearchQuery: (query: string) => void;
  setIssueSortOrder: (order: GitHubSortOrder) => void;
  setPrSortOrder: (order: GitHubSortOrder) => void;
  /** Back to the open, unscoped view of one resource; leaves its query and sort alone. */
  clearFilters: (type: "issue" | "pr") => void;
}

export const useGitHubFilterStore = create<GitHubFilterState>()((set) => ({
  issueFilter: "open",
  prFilter: "open",
  prScope: "all",
  issueSearchQuery: "",
  prSearchQuery: "",
  issueSortOrder: "created",
  prSortOrder: "created",
  setIssueFilter: (filter) => set({ issueFilter: filter }),
  setPrFilter: (filter) => set({ prFilter: filter }),
  setPrScope: (scope) => set({ prScope: scope }),
  setIssueSearchQuery: (query) => set({ issueSearchQuery: query }),
  setPrSearchQuery: (query) => set({ prSearchQuery: query }),
  setIssueSortOrder: (order) => set({ issueSortOrder: order }),
  setPrSortOrder: (order) => set({ prSortOrder: order }),
  clearFilters: (type) =>
    set(type === "issue" ? { issueFilter: "open" } : { prFilter: "open", prScope: "all" }),
}));

export function resetGitHubFilterStore() {
  useGitHubFilterStore.setState({
    issueFilter: "open",
    prFilter: "open",
    prScope: "all",
    issueSearchQuery: "",
    prSearchQuery: "",
    issueSortOrder: "created",
    prSortOrder: "created",
  });
}
