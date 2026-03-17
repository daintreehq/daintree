import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSafeJSONStorage } from "./persistence/safeStorage";

export interface TwoPaneSplitConfig {
  enabled: boolean;
  defaultRatio: number;
  preferPreview: boolean;
}

export interface WorktreeRatioEntry {
  ratio: number;
  panels: [string | null, string | null];
}

export function resolveEffectiveRatio(
  entry: WorktreeRatioEntry | undefined,
  currentLeft: string,
  currentRight: string
): number | undefined {
  if (!entry) return undefined;
  const [storedLeft, storedRight] = entry.panels;
  if (
    storedLeft !== null &&
    storedRight !== null &&
    storedLeft !== currentLeft &&
    storedLeft === currentRight &&
    storedRight === currentLeft
  ) {
    return 1 - entry.ratio;
  }
  return entry.ratio;
}

interface TwoPaneSplitState {
  config: TwoPaneSplitConfig;
  ratioByWorktreeId: Record<string, WorktreeRatioEntry>;

  setEnabled: (enabled: boolean) => void;
  setDefaultRatio: (ratio: number) => void;
  setPreferPreview: (prefer: boolean) => void;
  setWorktreeRatio: (
    worktreeId: string,
    ratio: number,
    panels: [string | null, string | null]
  ) => void;
  commitRatioIfChanged: (
    worktreeId: string,
    pendingRatio: number | null,
    panels: [string | null, string | null]
  ) => void;
  getWorktreeRatio: (worktreeId: string | null) => number;
  resetWorktreeRatio: (worktreeId: string) => void;
  resetAllWorktreeRatios: () => void;
}

const DEFAULT_CONFIG: TwoPaneSplitConfig = {
  enabled: true,
  defaultRatio: 0.5,
  preferPreview: false,
};

export const useTwoPaneSplitStore = create<TwoPaneSplitState>()(
  persist(
    (set, get) => ({
      config: DEFAULT_CONFIG,
      ratioByWorktreeId: {},

      setEnabled: (enabled) =>
        set((state) => ({
          config: { ...state.config, enabled },
        })),

      setDefaultRatio: (ratio) =>
        set((state) => ({
          config: { ...state.config, defaultRatio: Math.max(0.2, Math.min(0.8, ratio)) },
        })),

      setPreferPreview: (prefer) =>
        set((state) => ({
          config: { ...state.config, preferPreview: prefer },
        })),

      setWorktreeRatio: (worktreeId, ratio, panels) =>
        set((state) => ({
          ratioByWorktreeId: {
            ...state.ratioByWorktreeId,
            [worktreeId]: { ratio: Math.max(0.2, Math.min(0.8, ratio)), panels },
          },
        })),

      commitRatioIfChanged: (worktreeId, pendingRatio, panels) => {
        if (pendingRatio === null || !Number.isFinite(pendingRatio)) return;
        const state = get();
        const current = state.ratioByWorktreeId[worktreeId];
        const clampedRatio = Math.max(0.2, Math.min(0.8, pendingRatio));
        if (
          current?.ratio !== clampedRatio ||
          current?.panels[0] !== panels[0] ||
          current?.panels[1] !== panels[1]
        ) {
          set((state) => ({
            ratioByWorktreeId: {
              ...state.ratioByWorktreeId,
              [worktreeId]: { ratio: clampedRatio, panels },
            },
          }));
        }
      },

      getWorktreeRatio: (worktreeId) => {
        const state = get();
        if (worktreeId && worktreeId in state.ratioByWorktreeId) {
          return state.ratioByWorktreeId[worktreeId].ratio;
        }
        return state.config.defaultRatio;
      },

      resetWorktreeRatio: (worktreeId) =>
        set((state) => {
          const { [worktreeId]: _, ...rest } = state.ratioByWorktreeId;
          return { ratioByWorktreeId: rest };
        }),

      resetAllWorktreeRatios: () => set({ ratioByWorktreeId: {} }),
    }),
    {
      name: "canopy-two-pane-split",
      version: 1,
      storage: createSafeJSONStorage(),
      migrate: (persisted: unknown, fromVersion: number) => {
        if (fromVersion === 0) {
          const old = persisted as { ratioByWorktreeId?: Record<string, number> } & Record<
            string,
            unknown
          >;
          const entries = old.ratioByWorktreeId ?? {};
          const migrated: Record<string, WorktreeRatioEntry> = {};
          for (const [id, scalar] of Object.entries(entries)) {
            migrated[id] = { ratio: scalar, panels: [null, null] };
          }
          return { ...old, ratioByWorktreeId: migrated };
        }
        return persisted;
      },
    }
  )
);
