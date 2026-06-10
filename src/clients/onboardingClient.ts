import type { OnboardingState } from "@shared/types";

let inflight: Promise<OnboardingState> | null = null;

/**
 * Same-tick deduped read of onboarding state. The two `isStateLoaded`
 * consumers (`useGettingStartedChecklist`, `useAgentWaitingNudge`) fire in the
 * same effect flush, so sharing the promise for the current microtask
 * checkpoint collapses their duplicate `onboarding:get` IPC into one with
 * zero staleness surface — the cache is cleared before the round-trip even
 * resolves, so any later caller (e.g. `OnboardingFlow` mutating onboarding
 * mid-session) always refetches.
 */
export function getOnboardingState(): Promise<OnboardingState> {
  if (inflight) return inflight;
  const promise = window.electron.onboarding.get();
  inflight = promise;
  queueMicrotask(() => {
    if (inflight === promise) inflight = null;
  });
  return promise;
}
