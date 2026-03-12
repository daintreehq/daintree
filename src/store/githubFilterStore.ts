import { create } from "zustand";

export type IssueStateFilter = "open" | "closed" | "all";
export type PRStateFilter = "open" | "closed" | "merged" | "all";

interface GitHubFilterState {
  issueFilter: IssueStateFilter;
  prFilter: PRStateFilter;
  setIssueFilter: (filter: IssueStateFilter) => void;
  setPrFilter: (filter: PRStateFilter) => void;
}

export const useGitHubFilterStore = create<GitHubFilterState>()((set) => ({
  issueFilter: "open",
  prFilter: "open",
  setIssueFilter: (filter) => set({ issueFilter: filter }),
  setPrFilter: (filter) => set({ prFilter: filter }),
}));

export function resetGitHubFilterStore() {
  useGitHubFilterStore.setState({ issueFilter: "open", prFilter: "open" });
}
