import { create } from "zustand";
import type { ProjectPulse, PulseRangeDays } from "@shared/types";
import { actionService } from "@/services/ActionService";

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 2000;
const RETRY_MAX_DELAY = 30000;

interface PulseState {
  pulses: Map<string, ProjectPulse>;
  loading: Map<string, boolean>;
  errors: Map<string, string | null>;
  rangeDays: PulseRangeDays;
  requestIds: Map<string, number>;
  retryCount: Map<string, number>;
  lastRetryTimestamp: Map<string, number>;
  retryTimers: Map<string, ReturnType<typeof setTimeout>>;
}

interface PulseActions {
  fetchPulse: (
    worktreeId: string,
    forceRefresh?: boolean,
    isRetry?: boolean
  ) => Promise<ProjectPulse | null>;
  setRangeDays: (days: PulseRangeDays) => void;
  invalidate: (worktreeId: string) => void;
  invalidateAll: () => void;
  getPulse: (worktreeId: string) => ProjectPulse | undefined;
  isLoading: (worktreeId: string) => boolean;
  getError: (worktreeId: string) => string | null | undefined;
  getRetryCount: (worktreeId: string) => number;
  clearRetryTimer: (worktreeId: string) => void;
}

function getUserFriendlyError(technicalError: string): string | null {
  if (technicalError.includes("Not a git repository")) {
    return "This directory is not a git repository";
  }
  if (technicalError.includes("does not exist")) {
    return "The worktree path no longer exists";
  }
  const noCommitsSignals = [
    "HEAD",
    "Repository has no commits",
    "does not have any commits yet",
    "no commits yet",
  ];
  if (noCommitsSignals.some((s) => technicalError.toLowerCase().includes(s.toLowerCase()))) {
    return null;
  }
  return "Unable to load activity data";
}

type PulseStore = PulseState & PulseActions;

const DEFAULT_RANGE_DAYS: PulseRangeDays = 60;

export const usePulseStore = create<PulseStore>()((set, get) => ({
  pulses: new Map(),
  loading: new Map(),
  errors: new Map(),
  rangeDays: DEFAULT_RANGE_DAYS,
  requestIds: new Map(),
  retryCount: new Map(),
  lastRetryTimestamp: new Map(),
  retryTimers: new Map(),

  fetchPulse: async (worktreeId: string, forceRefresh = false, isRetry = false) => {
    const state = get();

    if (state.loading.get(worktreeId)) {
      return state.pulses.get(worktreeId) ?? null;
    }

    const retries = state.retryCount.get(worktreeId) ?? 0;

    if (isRetry && retries > 0) {
      const lastRetry = state.lastRetryTimestamp.get(worktreeId) ?? 0;
      const delay = Math.min(RETRY_BASE_DELAY * Math.pow(2, retries - 1), RETRY_MAX_DELAY);
      if (Date.now() - lastRetry < delay) {
        return null;
      }
    }

    if (forceRefresh) {
      get().clearRetryTimer(worktreeId);
      set((prev) => ({
        retryCount: new Map(prev.retryCount).set(worktreeId, 0),
      }));
    }

    const requestId = Date.now();
    const requestedRangeDays = state.rangeDays;

    set((prev) => ({
      loading: new Map(prev.loading).set(worktreeId, true),
      errors: new Map(prev.errors).set(worktreeId, null),
      requestIds: new Map(prev.requestIds).set(worktreeId, requestId),
    }));

    try {
      const result = await actionService.dispatch(
        "git.getProjectPulse",
        {
          worktreeId,
          rangeDays: requestedRangeDays,
          includeDelta: true,
          includeRecentCommits: false,
          forceRefresh,
        },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      const pulse = result.result as ProjectPulse;

      const currentState = get();
      if (
        currentState.requestIds.get(worktreeId) === requestId &&
        currentState.rangeDays === requestedRangeDays
      ) {
        get().clearRetryTimer(worktreeId);
        set((prev) => ({
          pulses: new Map(prev.pulses).set(worktreeId, pulse),
          loading: new Map(prev.loading).set(worktreeId, false),
          retryCount: new Map(prev.retryCount).set(worktreeId, 0),
        }));
        return pulse;
      }

      return null;
    } catch (error) {
      const technicalMessage =
        error instanceof Error ? error.message : "Failed to fetch pulse data";
      const userMessage = getUserFriendlyError(technicalMessage);
      const currentRetries = get().retryCount.get(worktreeId) ?? 0;
      const currentState = get();

      if (currentState.requestIds.get(worktreeId) === requestId) {
        const shouldRetry = currentRetries < MAX_RETRIES && !forceRefresh && userMessage !== null;

        set((prev) => ({
          errors: new Map(prev.errors).set(worktreeId, userMessage),
          loading: new Map(prev.loading).set(worktreeId, false),
          retryCount: shouldRetry
            ? new Map(prev.retryCount).set(worktreeId, currentRetries + 1)
            : new Map(prev.retryCount).set(worktreeId, 0),
          lastRetryTimestamp: shouldRetry
            ? new Map(prev.lastRetryTimestamp).set(worktreeId, Date.now())
            : prev.lastRetryTimestamp,
        }));

        if (shouldRetry) {
          get().clearRetryTimer(worktreeId);
          const delay = Math.min(RETRY_BASE_DELAY * Math.pow(2, currentRetries), RETRY_MAX_DELAY);
          const timer = setTimeout(() => {
            set((prev) => {
              const retryTimers = new Map(prev.retryTimers);
              retryTimers.delete(worktreeId);
              return { retryTimers };
            });
            get().fetchPulse(worktreeId, false, true);
          }, delay);

          set((prev) => ({
            retryTimers: new Map(prev.retryTimers).set(worktreeId, timer),
          }));
        } else {
          get().clearRetryTimer(worktreeId);
        }
      }
      return null;
    }
  },

  setRangeDays: (days: PulseRangeDays) => {
    if (days === get().rangeDays) return;

    const state = get();
    state.retryTimers.forEach((timer) => clearTimeout(timer));

    set({
      rangeDays: days,
      pulses: new Map(),
      loading: new Map(),
      errors: new Map(),
      requestIds: new Map(),
      retryCount: new Map(),
      lastRetryTimestamp: new Map(),
      retryTimers: new Map(),
    });
  },

  invalidate: (worktreeId: string) => {
    const timer = get().retryTimers.get(worktreeId);
    if (timer) clearTimeout(timer);

    set((prev) => {
      const pulses = new Map(prev.pulses);
      const loading = new Map(prev.loading);
      const errors = new Map(prev.errors);
      const retryCount = new Map(prev.retryCount);
      const lastRetryTimestamp = new Map(prev.lastRetryTimestamp);
      const retryTimers = new Map(prev.retryTimers);
      const requestIds = new Map(prev.requestIds);

      pulses.delete(worktreeId);
      loading.delete(worktreeId);
      errors.delete(worktreeId);
      retryCount.delete(worktreeId);
      lastRetryTimestamp.delete(worktreeId);
      retryTimers.delete(worktreeId);
      requestIds.delete(worktreeId);

      return { pulses, loading, errors, retryCount, lastRetryTimestamp, retryTimers, requestIds };
    });
  },

  invalidateAll: () => {
    const state = get();
    state.retryTimers.forEach((timer) => clearTimeout(timer));

    set({
      pulses: new Map(),
      loading: new Map(),
      errors: new Map(),
      retryCount: new Map(),
      lastRetryTimestamp: new Map(),
      retryTimers: new Map(),
      requestIds: new Map(),
    });
  },

  getPulse: (worktreeId: string) => get().pulses.get(worktreeId),
  isLoading: (worktreeId: string) => get().loading.get(worktreeId) ?? false,
  getError: (worktreeId: string) => get().errors.get(worktreeId),
  getRetryCount: (worktreeId: string) => get().retryCount.get(worktreeId) ?? 0,

  clearRetryTimer: (worktreeId: string) => {
    const timer = get().retryTimers.get(worktreeId);
    if (timer) {
      clearTimeout(timer);
      set((prev) => {
        const retryTimers = new Map(prev.retryTimers);
        retryTimers.delete(worktreeId);
        return { retryTimers };
      });
    }
  },
}));
