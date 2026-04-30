import { create } from "zustand";
import type { GitHubSortOrder } from "@shared/types/github";

export type IssueStateFilter = "open" | "closed" | "all";
export type PRStateFilter = "open" | "closed" | "merged" | "all";

interface GitHubFilterState {
  issueFilter: IssueStateFilter;
  prFilter: PRStateFilter;
  issueSearchQuery: string;
  prSearchQuery: string;
  issueSortOrder: GitHubSortOrder;
  prSortOrder: GitHubSortOrder;
  setIssueFilter: (filter: IssueStateFilter) => void;
  setPrFilter: (filter: PRStateFilter) => void;
  setIssueSearchQuery: (query: string) => void;
  setPrSearchQuery: (query: string) => void;
  setIssueSortOrder: (order: GitHubSortOrder) => void;
  setPrSortOrder: (order: GitHubSortOrder) => void;
}

export const useGitHubFilterStore = create<GitHubFilterState>()((set) => ({
  issueFilter: "open",
  prFilter: "open",
  issueSearchQuery: "",
  prSearchQuery: "",
  issueSortOrder: "created",
  prSortOrder: "created",
  setIssueFilter: (filter) => set({ issueFilter: filter }),
  setPrFilter: (filter) => set({ prFilter: filter }),
  setIssueSearchQuery: (query) => set({ issueSearchQuery: query }),
  setPrSearchQuery: (query) => set({ prSearchQuery: query }),
  setIssueSortOrder: (order) => set({ issueSortOrder: order }),
  setPrSortOrder: (order) => set({ prSortOrder: order }),
}));

export function resetGitHubFilterStore() {
  useGitHubFilterStore.setState({
    issueFilter: "open",
    prFilter: "open",
    issueSearchQuery: "",
    prSearchQuery: "",
    issueSortOrder: "created",
    prSortOrder: "created",
  });
}
