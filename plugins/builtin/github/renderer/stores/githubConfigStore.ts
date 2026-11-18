import { create } from "zustand";
import type { GitHubTokenConfig } from "../../shared/types.js";
import { BUILTIN_GITHUB_PROVIDER_ID } from "@shared/utils/forgeProviderIds";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  ENTERPRISE_CHANNELS,
  GITHUB_PLUGIN_ID,
  type EnterpriseStatus,
} from "../../shared/enterprise.js";

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

// Credential presence flows through the host's provider-keyed forge surface
// (the durable `forgeCredentials` store) rather than the legacy github:*
// channels. Identity fields (`username`, `avatarUrl`) are not part of the
// credential-status payload — consumers that need the authenticated user
// resolve it per-repo via `forge.getCurrentUser`.
async function loadConfig(): Promise<GitHubTokenConfig> {
  const [status, hasEnterpriseToken] = await Promise.all([
    window.electron.forge.getCredentialStatus(BUILTIN_GITHUB_PROVIDER_ID),
    loadHasEnterpriseToken(),
  ]);
  return { hasToken: status.hasCredential, hasEnterpriseToken };
}

// The Enterprise Server token is the plugin's own, not a host forge
// credential. An unreachable plugin reads as no token rather than failing the
// whole load: github.com's state still stands.
async function loadHasEnterpriseToken(): Promise<boolean> {
  try {
    const status = (await window.electron.plugin.invoke(
      GITHUB_PLUGIN_ID,
      ENTERPRISE_CHANNELS.status
    )) as EnterpriseStatus | null;
    return status?.hasToken === true;
  } catch {
    return false;
  }
}

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

        const config = await loadConfig();
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
      const config = await loadConfig();
      set({ config });
    } catch (e) {
      set({ error: formatErrorMessage(e, "Failed to refresh GitHub config") });
    }
  },

  // Callers report what changed for github.com; the Enterprise Server's
  // presence stays as last read unless they name it.
  updateConfig: (config: GitHubTokenConfig) => {
    const previous = get().config?.hasEnterpriseToken;
    set({
      config:
        config.hasEnterpriseToken === undefined && previous !== undefined
          ? { ...config, hasEnterpriseToken: previous }
          : config,
      error: null,
    });
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
