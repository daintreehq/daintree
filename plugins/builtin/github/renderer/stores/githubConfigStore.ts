import { create } from "zustand";
import type { GitHubTokenConfig } from "@/types";
import { githubClient } from "@/clients";
import { formatErrorMessage } from "@shared/utils/errorMessage";

interface GitHubConfigState {
  config: GitHubTokenConfig | null;
  isLoading: boolean;
  error: string | null;
  isInitialized: boolean;
}

interface GitHubConfigActions {
  initialize: () => Promise<void>;
  refresh: () => Promise<void>;
  updateConfig: (config: GitHubTokenConfig) => void;
}

type GitHubConfigStore = GitHubConfigState & GitHubConfigActions;

let initPromise: Promise<void> | null = null;

export const useGitHubConfigStore = create<GitHubConfigStore>()((set, get) => ({
  config: null,
  isLoading: true,
  error: null,
  isInitialized: false,

  initialize: () => {
    if (get().isInitialized) return Promise.resolve();
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        set({ isLoading: true, error: null });

        const config = await githubClient.getConfig();
        set({ config, isLoading: false, isInitialized: true });
      } catch (e) {
        set({
          error: formatErrorMessage(e, "Failed to load GitHub config"),
          isLoading: false,
          isInitialized: true,
        });
      }
    })();

    return initPromise;
  },

  refresh: async () => {
    try {
      set({ error: null });
      const config = await githubClient.getConfig();
      set({ config });
    } catch (e) {
      set({ error: formatErrorMessage(e, "Failed to refresh GitHub config") });
    }
  },

  updateConfig: (config: GitHubTokenConfig) => {
    set({ config, error: null });
  },
}));

export function cleanupGitHubConfigStore() {
  initPromise = null;
  useGitHubConfigStore.setState({
    config: null,
    isLoading: true,
    error: null,
    isInitialized: false,
  });
}
