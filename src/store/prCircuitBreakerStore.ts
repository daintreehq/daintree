import { create } from "zustand";

interface PRCircuitBreakerState {
  /** True when PR detection is paused because the circuit breaker tripped. */
  tripped: boolean;
  setTripped: (tripped: boolean) => void;
}

/**
 * Service-wide PR detection circuit-breaker state. A single `PullRequestService`
 * runs per project view, so this is global rather than per-worktree — when it
 * trips, every PR badge in the sidebar is potentially stale at once.
 */
export const usePRCircuitBreakerStore = create<PRCircuitBreakerState>((set) => ({
  tripped: false,
  setTripped: (tripped) => set({ tripped }),
}));
