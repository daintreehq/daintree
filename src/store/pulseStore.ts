import { create } from "zustand";
import type { ProjectPulse, PulseRangeDays } from "@shared/types";
import { actionService } from "@/services/ActionService";

interface PulseState {
  pulses: Map<string, ProjectPulse>;
  loading: Map<string, boolean>;
  errors: Map<string, string>;
  rangeDays: PulseRangeDays;
  requestIds: Map<string, number>;
}

interface PulseActions {
  fetchPulse: (worktreeId: string, forceRefresh?: boolean) => Promise<ProjectPulse | null>;
  setRangeDays: (days: PulseRangeDays) => void;
  invalidate: (worktreeId: string) => void;
  invalidateAll: () => void;
  getPulse: (worktreeId: string) => ProjectPulse | undefined;
  isLoading: (worktreeId: string) => boolean;
  getError: (worktreeId: string) => string | undefined;
}

type PulseStore = PulseState & PulseActions;

const DEFAULT_RANGE_DAYS: PulseRangeDays = 60;

export const usePulseStore = create<PulseStore>()((set, get) => ({
  pulses: new Map(),
  loading: new Map(),
  errors: new Map(),
  rangeDays: DEFAULT_RANGE_DAYS,
  requestIds: new Map(),

  fetchPulse: async (worktreeId: string, forceRefresh = false) => {
    const state = get();

    if (state.loading.get(worktreeId)) {
      return state.pulses.get(worktreeId) ?? null;
    }

    const requestId = Date.now();
    const requestedRangeDays = state.rangeDays;

    set((prev) => ({
      loading: new Map(prev.loading).set(worktreeId, true),
      errors: new Map(prev.errors).set(worktreeId, ""),
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
        set((prev) => ({
          pulses: new Map(prev.pulses).set(worktreeId, pulse),
          loading: new Map(prev.loading).set(worktreeId, false),
        }));
        return pulse;
      }

      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to fetch pulse data";
      const currentState = get();
      if (currentState.requestIds.get(worktreeId) === requestId) {
        set((prev) => ({
          loading: new Map(prev.loading).set(worktreeId, false),
          errors: new Map(prev.errors).set(worktreeId, message),
        }));
      }
      return null;
    }
  },

  setRangeDays: (days: PulseRangeDays) => {
    if (days === get().rangeDays) return;

    set({
      rangeDays: days,
      pulses: new Map(),
      loading: new Map(),
      errors: new Map(),
    });
  },

  invalidate: (worktreeId: string) => {
    set((prev) => {
      const pulses = new Map(prev.pulses);
      const loading = new Map(prev.loading);
      const errors = new Map(prev.errors);
      pulses.delete(worktreeId);
      loading.delete(worktreeId);
      errors.delete(worktreeId);
      return { pulses, loading, errors };
    });
  },

  invalidateAll: () => {
    set({
      pulses: new Map(),
      loading: new Map(),
      errors: new Map(),
    });
  },

  getPulse: (worktreeId: string) => get().pulses.get(worktreeId),
  isLoading: (worktreeId: string) => get().loading.get(worktreeId) ?? false,
  getError: (worktreeId: string) => get().errors.get(worktreeId),
}));
