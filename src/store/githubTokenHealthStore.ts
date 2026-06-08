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
  /** User dismissed the banner for the current unhealthy episode. */
  isDismissed: boolean;
  /** Hide the banner until the token recovers or expires afresh. */
  dismiss: () => void;
}

const setUnhealthy = (value: boolean): void =>
  useForgeProviderHealthStore.getState().setTokenUnhealthy(BUILTIN_GITHUB_PROVIDER_ID, value);

const dismiss = (): void =>
  useForgeProviderHealthStore.getState().dismissTokenBanner(BUILTIN_GITHUB_PROVIDER_ID);

export function useGitHubTokenHealthStore<T>(selector: (state: GitHubTokenHealthState) => T): T {
  return useForgeProviderHealthStore((s) => {
    const p = s.providers[BUILTIN_GITHUB_PROVIDER_ID] ?? DEFAULT_PROVIDER_HEALTH;
    return selector({
      isUnhealthy: p.tokenUnhealthy,
      setUnhealthy,
      isDismissed: p.tokenBannerDismissed,
      dismiss,
    });
  });
}

useGitHubTokenHealthStore.getState = (): GitHubTokenHealthState => {
  const p =
    useForgeProviderHealthStore.getState().providers[BUILTIN_GITHUB_PROVIDER_ID] ??
    DEFAULT_PROVIDER_HEALTH;
  return {
    isUnhealthy: p.tokenUnhealthy,
    setUnhealthy,
    isDismissed: p.tokenBannerDismissed,
    dismiss,
  };
};

/**
 * Test/imperative compatibility with the previous real Zustand store. Existing
 * suites call `.setState({ isUnhealthy })` for setup; delegate to the backing
 * keyed store's `setTokenUnhealthy` for GitHub.
 */
useGitHubTokenHealthStore.setState = (
  partial: Partial<Pick<GitHubTokenHealthState, "isUnhealthy">>
): void => {
  if (partial.isUnhealthy === undefined) return;
  useForgeProviderHealthStore
    .getState()
    .setTokenUnhealthy(BUILTIN_GITHUB_PROVIDER_ID, partial.isUnhealthy);
};
