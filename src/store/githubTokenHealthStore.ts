import { create } from "zustand";

interface GitHubTokenHealthState {
  isUnhealthy: boolean;
  setUnhealthy: (value: boolean) => void;
}

export const useGitHubTokenHealthStore = create<GitHubTokenHealthState>((set) => ({
  isUnhealthy: false,
  setUnhealthy: (isUnhealthy) => set({ isUnhealthy }),
}));
