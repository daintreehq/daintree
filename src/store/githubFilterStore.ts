import { create } from "zustand";

export type IssueStateFilter = "open" | "closed" | "all";
export type PRStateFilter = "open" | "closed" | "merged" | "all";

interface GitHubFilterState {
  issueFilter: IssueStateFilter;
  prFilter: PRStateFilter;
  issueSearchQuery: string;
  prSearchQuery: string;
  setIssueFilter: (filter: IssueStateFilter) => void;
  setPrFilter: (filter: PRStateFilter) => void;
  setIssueSearchQuery: (query: string) => void;
  setPrSearchQuery: (query: string) => void;
}

export const useGitHubFilterStore = create<GitHubFilterState>()((set) => ({
  issueFilter: "open",
  prFilter: "open",
  issueSearchQuery: "",
  prSearchQuery: "",
  setIssueFilter: (filter) => set({ issueFilter: filter }),
  setPrFilter: (filter) => set({ prFilter: filter }),
  setIssueSearchQuery: (query) => set({ issueSearchQuery: query }),
  setPrSearchQuery: (query) => set({ prSearchQuery: query }),
}));

export function resetGitHubFilterStore() {
  useGitHubFilterStore.setState({
    issueFilter: "open",
    prFilter: "open",
    issueSearchQuery: "",
    prSearchQuery: "",
  });
}
