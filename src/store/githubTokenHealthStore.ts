import { BUILTIN_GITHUB_PROVIDER_ID } from "@shared/utils/forgeProviderIds";
import {
  useForgeProviderHealthStore,
  DEFAULT_PROVIDER_HEALTH,
} from "@/store/forgeProviderHealthStore";

/**
 * GitHub-scoped convenience over the provider-keyed
 * {@link useForgeProviderHealthStore}. Thin read/write shim preserving the old
 * `{ isUnhealthy, setUnhealthy }` API for existing GitHub consumers; the forge
 * store owns the state.
 */
export interface GitHubTokenHealthState {
  isUnhealthy: boolean;
  setUnhealthy: (value: boolean) => void;
}

const setUnhealthy = (value: boolean): void =>
  useForgeProviderHealthStore.getState().setTokenUnhealthy(BUILTIN_GITHUB_PROVIDER_ID, value);

export function useGitHubTokenHealthStore<T>(selector: (state: GitHubTokenHealthState) => T): T {
  return useForgeProviderHealthStore((s) => {
    const p = s.providers[BUILTIN_GITHUB_PROVIDER_ID] ?? DEFAULT_PROVIDER_HEALTH;
    return selector({ isUnhealthy: p.tokenUnhealthy, setUnhealthy });
  });
}

useGitHubTokenHealthStore.getState = (): GitHubTokenHealthState => {
  const p =
    useForgeProviderHealthStore.getState().providers[BUILTIN_GITHUB_PROVIDER_ID] ??
    DEFAULT_PROVIDER_HEALTH;
  return { isUnhealthy: p.tokenUnhealthy, setUnhealthy };
};
